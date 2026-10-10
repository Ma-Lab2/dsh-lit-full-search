# 工具契约：`zotero_collections` / `lit_to_zotero`

面向 model 的参数语义、返回结构、错误语义与边界。实现在 `lib/tools.js`（工具层）+
`lib/lit-to-zotero.js`（编排）+ `lib/light-core.js`（Zotero 本地 API）。

## 共同概念

| 概念 | 取值 |
|---|---|
| `library` | 省略 / `'user'` = 个人库（`/users/0`，旧行为）；`'group:<id>'` 或纯数字 = 群组库；否则按**库名**解析（精确 → 包含；多义报错并列出候选） |
| `collection` | 收藏夹 **key** / **名称** / `'父 > 子'` 路径（逐段允许包含匹配；多义报错） |
| `itemType` | Zotero 类型；本插件写入白名单：`journalArticle`、`conferencePaper`、`preprint`、`report`、`thesis`、`dataset`、`bookSection` |

## `zotero_collections`（只读）

参数（全可选）：

| 参数 | 说明 |
|---|---|
| `library` | 省略 → 只返回库列表；给出 → 返回该库收藏夹（含 `path` 与 `itemCount`） |
| `query` | 按名称/路径做不区分大小写的包含过滤 |

返回：`{ libraries, library, collectionCount, collections[] }`；`collections[] = { key, name, path, itemCount }`。

用途：把「收藏夹名」变成 key，并在同名/近似名之间消歧。真实歧义示例：
`liqiud crystal target`（WENJUN_MA's Group，错拼）与 `liquid crystal target for LIA`（LDIA library）。

## `lit_to_zotero`（写，批量）

| 参数 | 必填 | 说明 |
|---|---|---|
| `refs` | ✔ | 字符串数组；每项 = DOI / 标题 / 整行参考文献（自动抽 DOI）。单次 ≤ 200 条 |
| `library` | | 目标库，缺省个人库 |
| `collection` | | 目标收藏夹；省略则只入目标库（不指定收藏夹） |
| `itemTypes` | | 允许的 Zotero itemType 白名单，如 `['journalArticle']`；不在白名单记 `skipped` |
| `dryRun` | | `true` = 只出计划，**不发起任何写请求** |
| `attachPdf` | | `true` = 新建条目后尝试把 OpenAlex `best_oa_location` 的 OA PDF 挂为附件；失败只记 `pdf/pdfError` |

返回：

```json
{
  "dryRun": false,
  "library": "WENJUN_MA's Group", "libraryKey": "group:6441110",
  "collection": "2.Novel Targets > liqiud crystal target", "collectionKey": "YJUSYVEM",
  "collectionSizeBefore": 31,
  "counts": { "created": 5, "added": 1, "exists": 10, "skipped": 0, "failed": 0 },
  "items": [{ "n": 21, "doi": "…", "title": "…", "itemType": "journalArticle", "action": "created", "itemKey": "QZX8A2PX", "error": "" }]
}
```

`action` 语义（逐条，按判定顺序）：

| action | 判定 | 副作用 |
|---|---|---|
| `skipped` | `itemTypes` 白名单拦截（按调用方给定的类型提示，或元数据解析后的真实类型） | 无 |
| `exists` | 目标收藏夹已有同 DOI（无 DOI 按标题归一化）条目 | 无 |
| `added` | 目标库内已有该条目，但不在目标收藏夹 | `PATCH` 条目 `collections` 取并集（乐观锁，412 重试一次；已在收藏夹则不发请求） |
| `created` | 目标库内没有 → 建条目并直接归入目标收藏夹 | `POST <prefix>/items` |
| `failed` | 该条自身出错（网络/HTTP/字段），不中断其余条目 | 无 |

每条记录还带可选的 `pdf`（仅 `attachPdf: true` 时出现）：
`attached`（已挂）/ `exists`（同 md5 已在库里，未重传）/ `none`（OpenAlex 无 OA 直链）/ `skipped`（无 DOI）/
`planned`（dry-run）/ `failed`（失败原因见 `pdfError`）。PDF 任何环节失败都**不改变** `action`。

元数据链（逐级降级，任一级成功即用）：**Crossref**（`mailto` 礼貌池，字段最全：卷/期/页/ISSN/摘要）→
**OpenAlex（按 DOI）** → **OpenAlex（按标题）** → **引用行内解析**（离线兜底）。

## 错误语义

| 情况 | 行为 |
|---|---|
| `refs` 为空 / 超过 200 | 抛错（工具层包装成 `lit_to_zotero 执行失败：…`） |
| 库名/收藏夹名找不到或多义 | 抛错，错误信息里列出候选（`名称 (key)` / `路径 (key)`） |
| 写请求 401 | 自动 `POST /local/authorize` 弹 Zotero 授权窗一次，用新 key 重试；仍失败则抛错 |
| 写请求 403 | 抛错（未开通本地通信或该库无写权限），不改其它条目 |
| 写请求 412 | 加挂路径自动重读重试一次 |
| 单条元数据解析失败 | 记 `failed` 继续（不影响其余条目） |
| 标题始终解析不出来 | 记 `failed`（`无法解析出标题`） |

## 边界与已知限制

- **PDF 只走 OpenAlex 的 OA 直链**（不做 Unpaywall 兜底、不驱动浏览器过付费墙）；Crossref 不提供 PDF 链接。
- **不写 note/tag**。
- 客户端卡片在 `tool.call.toolview` 里按 **wire 工具名**注册；若某个 session 记录里的 meta 缺失或格式不识别，
  自动回落工具自身的文本结果。
- 大库性能：去重 = 目标收藏夹整表一次 + 未命中条目逐条 `qmode=everything` 检索；库越大越慢，但仍只读。
- 个人库与群组库是不同 library，「个人库已有」不会让群组库写入被跳过。
- 群组库条目由 Zotero 自行同步到云端；本地 API 写入需 Zotero 10+。
- 无 DOI 条目按**标题归一化**（仅字母数字 + 中日韩字符、小写）去重，标题改写会产生重复，属已知取舍。

## `zotero_enrich`（单点查，v1.1.0 新增）

| 参数 | 必填 | 说明 |
|---|---|---|
| `ref` | ✔ | 8 位 item key / DOI / 标题 / `zotero://user/0/item/<KEY>`（群组 `zotero://group/<id>/item/<KEY>`，附件 ref 会转到父条目） |
| `library` | | `'user'`（默认）/ `'group:<id>'` / 库名 |
| `include` | | 子集 `fields`(默认) `tags`(默认) `collections`(默认) `notes` `attachments` `annotations` `fulltext`；**只有点名 notes/attachments/annotations/fulltext 才会读子对象** |
| `paths` | | `true` 时解析每个附件的磁盘路径与存在性（每条附件一次 `/file/view/url`） |
| `maxChars` | | 笔记/批注/全文/摘要单条截断，200–20000（默认 2000，越界夹紧、非整数回落默认） |

返回 `{ found, ref, resolvedBy, library, libraryKey, item, counts, warnings? }`；未命中为
`{ found:false, ref, library, libraryKey, hint }`（不抛错）。基础标识字段（key/itemType/title/date/DOI）总是返回，
`fields` 追加作者/年/期刊/卷期页/URL/摘要/extra/语言/dateAdded/dateModified。

请求预算：默认 3 个 GET（groups + collections + item）；`+notes/attachments` 加 1 次 children；
`+annotations` 每条附件 1 次；`+paths` 每条附件 1 次；`+fulltext` 每条附件 1 次。**不做库级枚举。**

边界：只读；附件返回该条目**全部**子附件（不只 PDF）；`paths:true` 时未下载文件为 `path=null/exists=false`（真实状态）；
`linked_url` 返回 URL；全文索引未建则为空；单个子对象失败只进 `warnings`；路径属于跑 Zotero 的这台机器。
