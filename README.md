# dsh-lit-full-search

DSH 文献检索插件（轻量版，零 npm 依赖）。在**任何模式 / 任何 preset** 下注册 7 个全局
model 工具，并提供侧栏「全面文献搜索设置」面板（密钥、检索预算、服务诊断）。

直连 [OpenAlex](https://docs.openalex.org)、[Semantic Scholar](https://api.semanticscholar.org)
与本地 Zotero API（`http://localhost:23119`）。

## 安装

插件以 **profile bundle** 方式安装：包既要成为目标 profile 的依赖，包名也要出现在该 profile
`package.json` 的 `dsh.profile.bundles` 数组里（bundle 列表决定 `cordis.patch.yml` 是否被应用）。
桌面端用 `core-020` profile，web 端是另一个 profile（`web`）；装到哪个 profile 就只在那个 profile 生效。

### 开发安装（推荐：链接本地目录）

```bash
# profile 目录：~/.dsh/profiles/<name>
dsh plugin --profile core-020 add "link:D:/path/to/dsh-lit-full-search"
# 再把 "dsh-lit-full-search" 加入该 profile package.json 的 dsh.profile.bundles
# （从 DSH「插件管理」界面安装时会自动完成依赖与 bundle 列表这两步）
```

桌面端启动时的依赖恢复会卸载 `file:` / tarball 形式的依赖，**本地开发必须用 `link:`**，
否则每次启动都会被打回原状。

### 发布包安装

```bash
npm pack      # 生成 dsh-lit-full-search-<VERSION>.tgz
dsh plugin --profile core-020 add "<绝对路径>/dsh-lit-full-search-<VERSION>.tgz"
```

### 生效方式

Host 端代码（`lib/*.js`：工具与路由）改动后**通常即时生效**（本机桌面端实测：改完当轮工具行为即变，
疑似 dsh-tauri 的「运行中变更」监听在重载）；若工具表或路由没更新，**重启 DSH** 即可（Host 端有 ESM 缓存）。
客户端面板（`lib/client.js`）另需刷新页面。`/lit-full-search/api/*` 返回 404 通常是「改了但没重载」。

## 工具（全局，任何模式下可见）

| 工具 | 说明 | 关键参数 |
| --- | --- | --- |
| `lit_search` | 学术文献检索：OpenAlex；配置 Semantic Scholar API Key 后**双源检索**，按 DOI 去重合并（单源失败不拖垮整体，记入 `diagnostics`） | `query`(必填), `limit`, `yearFrom`, `yearTo` |
| `lit_abstract` | 按 DOI 或标题取摘要（OpenAlex） | `doi` / `title` 至少其一 |
| `lit_cited_by` | 被引列表（DOI 或 OpenAlex work ID） | `identifier`(必填), `limit` |
| `zotero_search` | 检索本地 Zotero 库（只读）；`library` 可指定群组库 | `query`(必填), `limit`, `qmode`, `library` |
| `zotero_collections` | 列出 Zotero 库与收藏夹（key / 名称 / 完整路径 / 条目数），用于定位写回目标 | `library`, `query` |
| `lit_to_zotero` | **批量**把检索到的文献写回指定库/收藏夹（支持群组库）：元数据解析 → 去重 → 新建/加挂（可选挂 OA PDF）→ 报告 | `refs`(必填), `library`, `collection`, `itemTypes`, `dryRun`, `attachPdf` |
| `zotero_enrich` | **单点查**：按 item key / DOI / 标题读深**一个** Zotero 条目（含群组库）——书目字段、标签、收藏夹（名称+路径）、笔记、全部附件（可选磁盘路径与存在性）、批注、全文索引缓存；`fields` 可只取指定字段 | `ref`(必填), `library`, `fields`, `include`, `paths`, `maxChars` |
| `zotero_abstract` | 取**本地 Zotero** 里存的单篇摘要（abstractNote）；只要摘要时用它（与 `lit_abstract` 的外网摘要对称） | `ref`(必填), `library`, `maxChars` |

> 结果统一带卡片渲染（`meta.card='literature'`）；`lit_to_zotero` / `zotero_collections` / `zotero_enrich`
> 三个 Zotero 工具另有会话卡片（`tool.call.toolview` 按 wire 工具名注册，无 meta 时回落文本结果）。

> **`limit` 的语义**：`lit_search` 的 `limit` 是**每个数据源**的上限 —— 只配 OpenAlex 时返回
> ≤ `limit` 条；配了 S2 密钥走双源时，两源各取 `limit` 条，按 DOI（无 DOI 按标题+年份）去重后
> 交叉合并，**合计最多 `2 × limit`**（去重只减不增），**不设合并总量上限**。
> `lit_cited_by`（≤25）与 `zotero_search`（≤100）是单源，`limit` 即总量上限。

## Zotero 库与收藏夹定位（群组库支持）

Zotero 本地 API（`http://localhost:23119/api`）与 Web API 路径同形：个人库固定 `users/0`，
群组库用 `groups/<id>`。插件里 `library` 参数统一表达目标库：

| 写法 | 含义 |
| --- | --- |
| 省略 / `'user'` | 个人库（`/users/0`），旧行为不变 |
| `'group:6441110'` / `'6441110'` | 群组库（`/groups/6441110`） |
| `"WENJUN_MA's Group"` | 按库名解析（精确 → 包含匹配；多义时报错并列出候选） |

`collection` 参数可以是收藏夹 key、名称，或 `'父收藏夹 > 子收藏夹'` 路径。**先定位再写**：

```text
zotero_collections({ library: "WENJUN_MA's Group", query: "crystal" })
  → 2.Novel Targets > liqiud crystal target  [YJUSYVEM] · 31 条
lit_to_zotero({ refs: [...], library: "WENJUN_MA's Group", collection: "2.Novel Targets > liqiud crystal target", itemTypes: ["journalArticle"] })
```

写回语义（`lit_to_zotero`）：
- 目标库内按 DOI（无 DOI 按标题归一化）去重：**已在目标收藏夹 → 跳过；在库但不在收藏夹 → 加挂；否则新建**。
- 元数据链 Crossref → OpenAlex → 引用行内解析，逐级降级不中断；单条失败只记 `failed`。
- `dryRun: true` 先看计划（`exists/added/created/skipped/failed` 计数）再实写。
- `attachPdf: true` 时，新建条目后尝试从 OpenAlex `best_oa_location` 取 OA PDF 并按 Zotero 四段上传挂为附件
  （校 `%PDF` 魔数；同 md5 已存在则不重传；**下载/上传失败只记录在该条 `pdf/pdfError`，不影响建档**）。
- 写请求需 Zotero 10+；首次 401 会弹 Zotero 授权窗（点一次「允许 / 始终允许」后自动重试）。
- 单次上限 200 条。

> 会话里的工具结果由客户端 `tool.call.toolview` 槽位按 wire 工具名渲染：`lit_to_zotero` 显示
> 「库 › 收藏夹 + 五类计数 + 逐条动作徽标（含 PDF 状态）」，`zotero_collections` 显示库/收藏夹清单；
> 结构化 meta 缺失时回落该工具自身的文本结果。

> 注意：个人库条目与群组库条目是**不同 library**，「个人库里已有」不会让群组库写入被跳过。

## 读深单条 Zotero 条目（`zotero_enrich`）

`zotero_search` 只回薄摘要（key/标题/作者/年/DOI/URL）；要读**一个**条目的完整本地记录用 `zotero_enrich`：

```text
zotero_search({ query: "liqiud crystal", library: "WENJUN_MA's Group" })   → 拿到 key
zotero_enrich({ ref: "QZX8A2PX", library: "WENJUN_MA's Group",
                include: ["fields","tags","collections","notes","attachments"], paths: true })
zotero_enrich({ ref: "QZX8A2PX", fields: ["abstractNote"] })              → 只要摘要（更短）
zotero_abstract({ ref: "QZX8A2PX", library: "WENJUN_MA's Group" })        → 只要摘要的最短路径
```

- `ref`：8 位 item key / DOI / 标题 / `zotero://user/0/item/<KEY>`（群组：`zotero://group/<id>/item/<KEY>`）。
- `fields`：**书目字段投影**（Zotero 原名：`abstractNote` / `creators` / `publicationTitle` / `volume` / `issue` / `pages` /
  `DOI` / `url` / `date` / `extra` / `language` / `dateAdded` / `dateModified`）。给了就只回/只打印这些；
  未知名回报在 `unknownFields`；省略 = 全部字段；`[]` = 只要标识字段。**给了 `fields` 时默认不再取 tags/collections**
  （要就显式写 `include`）。
- `include` 是**子对象组**：`tags` / `collections` / `notes` / `attachments` / `annotations` / `fulltext`，缺省 `tags+collections`；
  **只有点名 `notes`/`attachments`/`annotations`/`fulltext` 才会去读子对象**。
- `attachments` 返回该条目的**全部**附件（不只 PDF）；`paths: true` 才解析磁盘路径与存在性
  （走 `/items/<key>/file/view/url` → `file://` → 盘符还原 → `existsSync`；返回的路径属于跑 Zotero 的这台机器）。
- `fulltext` 读 Zotero 全文索引缓存（`.zotero-ft-cache`），PDF 未下载也能读正文；未建索引则为空。
- 未命中返回 `found: false` 与提示（不抛错）；某个子对象读取失败只进 `warnings`。
- Zotero「按需下载」未拉取文件时 `path=null, exists=false` —— 这是真实状态，不是错误。

> 与 `dsh-zotero` 插件（本机已禁用）**互斥**：它也有一个同名 `zotero_search`，DSH 对同名工具硬报错；
> 若要启用它，须先改名本插件的 `zotero_search`。详见 `work/lit-to-zotero/design/zotero-surface-audit.md`。

## 设置面板（「全面文献搜索设置」）

左侧栏「定时任务」下方的「全面文献搜索设置」图标打开设置页（main keyed 面板，
id `lit-full-search-settings`），分四段：

- **身份标识** —— `mailto`（OpenAlex 礼貌邮箱，提升限流配额；兜底 `LIT_SEARCH_MAILTO`）
- **密钥** —— 每项带「已设置 …尾4位 / 未设置」状态徽标：
  - `openAlexApiKey`（兜底 `LIT_SEARCH_OPENALEX_API_KEY`）
  - `s2ApiKey` —— 设置后 `lit_search` 双源检索（兜底 `LIT_SEARCH_S2_API_KEY`）
  - `zoteroKey` —— `lit_to_zotero` 写回需要（兜底 `LIT_SEARCH_ZOTERO_KEY`）

  输入框**留空即保持不变**，输入新值才覆盖；要删除密钥点「清除」（可撤销），保存后生效。
  GET 回显只含掩码与布尔状态，不下发明文。
- **检索预算**（防上下文爆炸，逐项带区间说明，失焦自动夹到合法范围）：
  - `searchLimit`（lit_search，1–25，默认 10；**每个数据源**的上限，双源时合计最多 2×，不设合并总量上限，见上方 `limit` 说明）
  - `citedByLimit`（lit_cited_by，1–25，默认 25）
  - `zoteroLimit`（zotero_search，1–100，默认 20）
  - `abstractChars`（lit_abstract 摘要字符上限，200–100000，默认 2000）
- **服务状态** —— 「运行系统诊断」按钮，逐项检测：
  - OpenAlex API 可达性、身份标识配置
  - Semantic Scholar API 可达性与密钥有效性（未配置则提示）
  - Zotero 本地 API 可达性（含版本号）、写密钥配置

底部为 sticky 操作条：「保存」/「放弃更改」仅在有未保存改动时可用，并显示保存状态。

配置保存到 `$DSH_HOME`（或 `~/.dsh`）下的 `lit-full-search.config.json`；
Host 端路由：`GET|POST /lit-full-search/api/config`（面板读写）、
`GET /lit-full-search/api/diagnose`（服务诊断，返回 `{ ranAt, checks }`）。
保存后立即生效（工具执行时实时读取配置）。

## 开发

```bash
npm run check      # node --check 逐个做语法检查
npm test           # node --test：自动发现 test/*.test.js
```

测试全部本地（mock fetch / 注入 fetchImpl），不触碰网络与真实 Zotero。

> 用 `node --test`（不带路径参数）而不是 `node --test test/`：后者在 Node 24 + Windows 下会把
> `test/` 当成模块路径解析，报 `Cannot find module ...\test`。

## 认证优先级

文件配置（设置面板保存） > 环境变量 `LIT_SEARCH_*` > 默认值。
