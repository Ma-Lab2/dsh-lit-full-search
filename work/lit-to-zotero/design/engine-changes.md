# lib/ 层改造清单

本次为支持「群组库 + 收藏夹」写入而做的改动。原则：**旧行为零破坏**（缺省仍是 `/users/0`），
新能力全部通过显式参数启用。

## `lib/light-core.js`（Zotero 部分）

新增：

| 导出 | 签名 | 说明 |
|---|---|---|
| `zoteroLibraryPrefix` | `(libraryKey = 'user') → '/users/0' \| '/groups/<id>'` | 库路径唯一来源；非法 key 抛错 |
| `zoteroAuthorize` | `async (appName?) → key` | `POST /local/authorize` 弹 Zotero 授权窗；本地实例签发、只在本地 API 有效 |
| `zoteroListLibraries` | `async () → [{ libraryKey, id, type, name }]` | 个人库 + `GET /users/0/groups`；群组读取失败时只返回个人库 |
| `zoteroListCollections` | `async ({ libraryKey }) → [{ key, name, parentKey, path, itemCount }]` | 分页取全量并补全 `父 > 子` 路径 |
| `zoteroAddToCollection` | `async (itemKey, collectionKey, { libraryKey, zoteroKey }) → { added, itemKey }` | 读当前 `collections` 取并集 + `If-Unmodified-Since-Version` 乐观锁；412 重读重试一次；已在收藏夹则 `{ added: false }` 不发请求 |
| `zoteroAttachPdf` | `async (parentItemKey, bytes, { libraryKey, zoteroKey, title, filename }) → { attachmentKey, duplicate }` | Zotero 四段上传：建 attachment 子条目 → `If-None-Match:*` 申请授权（同 md5 → `duplicate`）→ 直传字节 → 有 `uploadKey` 时注册 |

内部新增：

- `zoteroRequest(path, { method, body, headers, write, zoteroKey })`：请求底座——`Connection: close`、
  写请求自动补 `Zotero-Server-ID`（Zotero 10+ 缺它 428）、**401 时自动授权一次并重试**，返回原始 `Response`。
- `zoteroWrite(path, body, { method, zoteroKey, headers })`：JSON 写请求（`zoteroRequest` 之上）。

改动（向后兼容）：

| 函数 | 改动 |
|---|---|
| `zoteroSearch` | 新增 `options.libraryKey`，路径由 `zoteroLibraryPrefix` 生成；返回项的 `libraryKey` 如实回填（原先硬编码 `'user'`） |
| `zoteroFindByDoi` | 透传 `libraryKey`，注释明确「在指定库内查重」 |
| `zoteroCreateItem` | 走 `zoteroWrite`（获得 401 自动授权 + PATCH/POST 统一）；新增 `options.libraryKey`；新增 `metadata.fields`（按 itemType 白名单过滤后的额外字段） |

## `lib/lit-to-zotero.js`（新模块）

| 导出 | 说明 |
|---|---|
| `MAX_IMPORT_REFS = 200` | 单次上限 |
| `parseReferenceLine(raw)` | 整行参考文献 → `{ authorsRaw, year, title, venue, volume, issue, pages, doi }`；也吃裸 DOI / 裸标题 |
| `splitApaAuthors(raw)` | `'Poole, P. L., Andereck, C. D., et al.'` → `[{lastName, firstName}]`（丢 `et al.`，兼容 `'First Middle Last'`） |
| `splitFullName(fullName)` | `'First Middle Last'` → `{firstName, lastName}` |
| `crossrefTypeToZotero(type)` / `guessItemType(venue, hint)` | Crossref 类型与场馆名 → Zotero itemType |
| `fromCrossref(message, fallback)` / `fromOpenAlexWork(work, fallback)` / `fromParsedLine(parsed)` | 三级元数据 → `{ itemType, fields, creators, doi }` |
| `resolveLibraryKey(libraries, spec)` / `resolveCollection(collections, spec)` | 名称/路径 → key（精确 → 包含；多义报错列候选） |
| `resolveTarget({ library, collection })` | 库 + 收藏夹一次解析 |
| `normalizeTitle(title)` | 无 DOI 去重用的标题归一化 |
| `resolveMetadata(parsed, { mailto, auth })` | Crossref → OpenAlex(DOI) → OpenAlex(标题) → 行内解析 |
| `resolveOaPdfUrl(parsed, auth)` / `downloadPdf(url)` | OA PDF 直链解析（OpenAlex `best_oa_location`）与下载 + `%PDF` 魔数校验 |
| `importReferences(options)` | 批量编排 + 报告（幂等、单条失败隔离、`dryRun` 只读、`attachPdf` 可选） |

字段安全：`ALLOWED_FIELDS` 按 itemType 给字段白名单，避免写错字段被 Zotero 400 拒绝。

## `lib/tools.js`

- 新增 `zotero_collections`、`lit_to_zotero` 两个工具定义（schema/execute/render/presentationMeta）。
- `zotero_search` / `zotero_save` 新增可选 `library` 参数（缺省不变），让个人库之外的单条写入也能用。
- `lit_to_zotero` 的 `presentationMeta` 输出 `counts + items[]`（含 `pdf`），供客户端卡片消费。

## `lib/client.js`

- 新增 `tool.call.toolview` keyed 槽位注册（按 wire 工具名 `lit_to_zotero` / `zotero_collections`），
  用 `function* () { yield ctx.slots.register(...) }` 一次注入两个卡片；未注册/无 meta 时回落文本。
- 新增卡片 CSS（仅用 `--dsw-alias-*` 主题 token + 兜底色）。

## `lib/config.js`

- `resolveAuth()` 补 `apiKey` 别名（与 `openAlexApiKey` 同值）：light-core 的 OpenAlex 选项名是 `apiKey`，
  此前面板里设的 key 永远进不了请求 URL（`lit_search` / `lit_abstract` / `lit_cited_by` / `zotero_save` / 诊断全受影响）。

## `lib/index.js`

未改动：`apply()` 已按 `toolDefinitions` 数组循环注册，新增工具自动生效（需重启 DSH 清 ESM 缓存）。

## 测试

`test/lit-to-zotero.test.js`（新，14 项）：解析、作者串、类型映射、库/收藏夹解析与歧义、dry-run 三分支、
apply 的库路径与 POST/PATCH 载荷、`itemTypes` 双层过滤、失败隔离与标题去重、上限与目标解析报错。
`test/tools.test.js` / `test/index.test.js`：工具数 5 → 7 与新工具 schema/render 冒烟。

## v1.1.0 追加（改名 / 面板 / zotero_enrich）

- **改名**：`zotero_import` → `lit_to_zotero`（wire 名用下划线：DSH 工具名须匹配 `/^[\p{XID_Start}_]\p{XID_Continue}*$/`，
  连字符会破坏 PTC/typed-dict 派生）；文件 `lib/zotero-import.js` → `lib/lit-to-zotero.js`，
  工作目录 `work/zotero-import/` → `work/lit-to-zotero/`。
- **`lib/light-core.js` 新增 4 个只读函数**：`zoteroGetItem`（单条目，404→null）、`zoteroItemChildren`（子对象）、
  `zoteroResolveAttachmentPath`（`/file/view/url` → `file://` → 盘符还原 → `existsSync`；非 file 回 URL）、
  `zoteroAttachmentFulltext`（`/fulltext` → `.zotero-ft-cache`，未建索引为空）。
  另把写路径重构为 `zoteroRequest`（底座：`Connection: close` + `Zotero-Server-ID` + 401 授权重试）与 `zoteroWrite`（JSON 写）。
- **`lib/zotero-enrich.js`（新）**：ref 解析、字段/标签/收藏夹映射、按 `include` 懒取、`paths` 解析、
  `maxChars` 截断、单臂失败只记 warning。
- **`lib/client.js`**：面板 CSS 由失效的 `--ds-color-*` 换到现行 `--dsw-alias-*`（含品牌/状态色）；
  新增 `zotero_enrich` 卡片（`tool.call.toolview` key）。
- **`lib/config.js`**：`resolveAuth()` 补 `apiKey` 别名（与 `openAlexApiKey` 同值）。
- **测试**：`test/zotero-enrich.test.js`（12 项）+ 面板 token 护栏（`test/index.test.js`）；工具数 7 → 8。
