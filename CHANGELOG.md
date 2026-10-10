# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog and this project follows Semantic Versioning.

## [Unreleased]

## [1.1.1] - 2026-10-11

压力测试发现两个工具在真实会话里**整体不可用**（模型只收到一条 Error），本版修复；同时补上让它们漏网的
测试层，并处理 Semantic Scholar 的限流与网络失败可见性。

### Fixed
- **`lit_to_zotero` 任何调用都失败**（P0）：逐条记录的 `n` 恒为 `undefined`（`parseReferenceLine` 对裸 DOI/裸标题
  不产出 `n`，而记录对象写死了 `n: parsed.n`），DSH 的 lossless JSON 校验会丢弃该键并判定往返不等，
  整个工具结果被拒（`value is not lossless JSON`），模型拿不到任何数据。现字符串条目回落到 1-based 序号，
  对象条目仍原样保留显式 `n`（对应综述里的参考文献序号）。
- **`zotero_collections` 只要带 `library` 就失败**（P0）：`execute` 返回 `libraryKey`，但 `outputSchema` 声明了
  `additionalProperties: false` 却没列出该字段，DSH 直接报 `"value.libraryKey" is not a declared property`。
  这是该工具的主要用法（列某个库的收藏夹），等于整体不可用。现补声明。
- `lit_abstract` 传不存在的 DOI 时抛错，且错误信息里夹带 OpenAlex 网关的 **404 HTML 整页**；其文档承诺的
  「无摘要返回 `status=missing`」从未生效。现 404 视为「未找到」→ `status=missing`；`lit_cited_by` 据此给出
  「无法解析「…」为 OpenAlex work ID」而不是 HTML 噪声。`fetchJson` 统一对错误响应体去标签并截断。
- `zotero_enrich` 的 `unknownFields` 只进结构化结果、**不进 `render`**，而模型只看得到 `render`：把
  `abstractNote` 误写成 `abstract` 时表现为「调用成功但没有摘要」，模型无从自我修正。现 render 明确列出
  被忽略的字段名。
- `lit_search` 年份区间倒挂（`yearFrom > yearTo`）时两个源都返回空集，渲染成「未找到相关文献」，会被模型
  误读为「该方向没有文献」。现直接报错并提示调换。
- `lit_search` 空白 query 不再透传给外网源（会返回任意热门文献，被模型当成检索结果），现直接报错。
- `zotero_collections` 的 `render` 在 value 缺字段时抛错（`Cannot read properties of undefined`）；现取默认值兜底。
- Semantic Scholar 失败过去被 `Promise.allSettled` 吞掉、只写进结构化 diagnostics，`render` 不显示，
  表现为「配了 key 但结果全是 openalex」。现在 `lit_search` 的 render 末尾会列出失败的数据源与错误原因。
- S2 个人 key 配额为全端点合计 1 次/秒：并发调用多个 `lit_search` 时第二个请求即 429。现所有 S2 请求
  串行排队、最小间隔 1.1 s，429 退避 2 s 后重试一次。
- S2 网络层失败（ECONNRESET / 连接超时等）先重试一次（走代理失败的那次改走直连），重试也失败才熔断 30 s，
  排队请求立即失败而不是逐个等连接超时（实测 5 个并发请求在 S2 不可达时从 53 s 降到 11 s）。

### Added
- 新增外网代理支持：面板「外网代理」字段 / `LIT_SEARCH_PROXY` / `HTTPS_PROXY`（优先级依次递减）。
  OpenAlex、Semantic Scholar、Crossref、OA PDF 下载与服务诊断经 HTTP CONNECT 隧道访问；本地 Zotero 不走代理；
  不修改全局 dispatcher（插件跑在 Host 进程内，不波及其它插件）。代理本身连不上时自动回落直连。
- 工具契约测试 `test/tool-contract.test.js` + 校验器 `test-support/contract.js`：对**每个工具**的 `execute()` 返回值
  复刻 DSH 的三道硬校验（lossless JSON 往返、`outputSchema` 封闭对象、`render` 形状），并逐工具跑分支用例。
  两个 P0 之所以能通过当时全绿的 93 项测试，根因就是**没有任何测试校验过 execute 输出与 schema/序列化的关系**。
- 真实链路压力测试 `work/stress/`：`stress-live.mjs` 用 70 个用例打真实 OpenAlex / Semantic Scholar / 本地 Zotero，
  逐例做契约校验并记录渲染体量（模型实际吃进的字符数）与耗时；`stress-concurrency.mjs` 做 24 路并发与 render 幂等检查。

### Changed
- `lit_search` / `lit_cited_by` / `zotero_search` 的 `render` 把作者裁到前 6 人并注明「等 N 人」
  （结构化结果与文献卡片不受影响）。压力测试中最大单次渲染 17,939 → 14,156 字符。
- `lit_search` 的 query 含中日韩字符时，`render` 末尾附「外网源对中文匹配差，建议改英文/中英混合」提示，
  避免模型把偏题结果当成该方向的真实文献面貌。
- `package.json` 的 `version` 与 `VERSION` 对齐（此前停留在 1.0.3；治理校验只读 `VERSION`，所以一直没被发现）。

## [1.1.0] - 2026-10-10

### Added
- 新工具 `lit_to_zotero`（原名 `zotero_import`，v1.1.0 起改名）：**批量**把检索到的文献写回指定 Zotero 库/收藏夹，
  **支持群组库**。元数据链 Crossref → OpenAlex → 引用行内解析；目标库内按 DOI（无 DOI 按标题归一化）去重：
  已存在但不在收藏夹 → 加挂，否则新建；支持 `itemTypes` 白名单、`dryRun` 预演、`attachPdf` 可选挂 OA PDF；
  单条失败不中断并逐条汇报。
- 新工具 `zotero_enrich`：**单点查**——按 item key / DOI / 标题 / `zotero://` 引用读深**一个**条目：
  书目字段、标签、所属收藏夹（含名称与路径）、笔记、该条目的**全部附件**（`paths: true` 时解析磁盘路径与存在性）、
  附件批注、Zotero 全文索引缓存。只读，不做库级枚举。
- 新工具 `zotero_abstract`：取**本地 Zotero** 里存的单篇摘要（`abstractNote`）——"只要摘要"的最短路径
  （`ref` + 可选 `library`/`maxChars`）；与 `lit_abstract`（外网 OpenAlex）对称，本地为空时描述会指向它。
- 新工具 `zotero_collections`：列出 Zotero 库与收藏夹（key / 名称 / 完整路径 / 条目数），
  用于定位目标并把收藏夹名解析成 key（名称歧义时列出候选）。
- `zotero_search` 新增可选 `library` 参数（`'user'` / `'group:<id>'` / 库名），可检索群组库。
- Zotero 本地 API 客户端：库路径参数化、收藏夹列表与加挂（乐观锁）、写请求 401 弹窗授权重试、OA PDF 四段上传、
  单条目/子对象读取、附件磁盘路径解析（`/file/view/url` + 盘符还原 + 存在性）、全文索引缓存读取。
- 会话内工具结果卡片（`tool.call.toolview` 按 wire 工具名注册）：`lit_to_zotero` 显示库/收藏夹、五类计数与
  逐条动作徽标（含 PDF 状态），`zotero_collections` 显示库/收藏夹清单，`zotero_enrich` 显示条目、计数与附件下载状态。

### Fixed
- 面板/环境里配置的 OpenAlex API Key 从未生效：`resolveAuth()` 返回 `openAlexApiKey`，而引擎读的是 `apiKey`，
  导致 `lit_search` / `lit_abstract` / `lit_cited_by` / `lit_to_zotero` 以及「服务诊断」的身份标识检查一直走匿名池；
  现补 `apiKey` 别名并加回归用例。
- 裸 DOI（如 `10.1063/1.4885100`）作为输入时，开头的 `10.` 被误当作列表序号剥掉，导致按错误标题检索到无关文献；
  现要求序号后必须有空白，并加回归用例。
- 面板 CSS 使用了已不存在的 `--ds-color-*` token（一直靠硬编码兜底色渲染，浅色主题下不协调）；
  现全部改用现行 `--dsw-alias-*` 主题 token，并加护栏测试。

### Removed
- 移除 `zotero_save`（单条归档）：`lit_to_zotero` 是它的严格超集——单条 DOI 同样可写，且额外支持收藏夹
  名称/`父 > 子` 路径、Crossref 类型映射与 `itemTypes` 白名单、`dryRun` 预演、挂 OA PDF、逐条报告。
  工具数 8 → 7。

### Changed
- `zotero_enrich` 新增 **`fields` 书目字段投影**：给了就只回/只打印点名字段（未知名回报在 `unknownFields`），
  省略=全部字段，`[]`=只要标识字段；**给了 `fields` 时默认不再取 tags/collections**（要就显式写 `include`）。
  `include` 收敛为纯**子对象组**（`tags`/`collections`/`notes`/`attachments`/`annotations`/`fulltext`），
  去掉与之重叠的 `'fields'` token。工具数 7 → 8，schema 合计 3909 → 4845 字符（+936）。
- 重写 7 个工具描述：补「何时用」的场景触发词（文献调研/开题摸底/综述、审稿核对、写作/改稿、日常归档）与
  兄弟工具边界（`lit_search` 外网 vs `zotero_search` 本地 vs `zotero_enrich` 读深；`lit_abstract` vs 本地全文索引），
  并删掉可从报错学到的重复前提。**语言仍为中文**——已核实的实证不支持「改英文能提升被 LLM 使用概率」
  （描述语言不影响 tool-calling 准确率，掉分来自 prompt 语言）。descriptions 771 → 1143 字符。
- 工具改名：`zotero_import` → **`lit_to_zotero`**（wire 名用下划线：DSH 工具名须为标识符形状，连字符会破坏 PTC/typed-dict 派生）。
- `lit_search` 的 `limit` 明确为**每个数据源**的上限：双源各取 `limit` 条后按 DOI 去重交叉合并，
  合计最多 `2 × limit`，**不设合并总量上限**（原实现会把合并结果夹紧到 25）。
- 开发命令改用 `node --test`（自动发现测试），修复 Node 24 + Windows 下 `node --test test/` 报
  `Cannot find module ...\test` 的问题。
- README 安装段按实况重写：profile bundle + `link:` 安装（桌面端 `core-020`），并说明 Host 代码需重启 DSH 才生效。
- 新增工作目录 `work/lit-to-zotero/`（首个真实用例 + 设计文档 + Zotero 面审计）。

## [1.0.3] - 2026-10-10

### Changed
- 面板与侧栏标签改名为「全面文献搜索设置」。

## [1.0.2] - 2026-10-09

### Fixed
- 客户端诊断请求容错：非 JSON / 空响应体不再抛 `Unexpected end of JSON input`；404 时明确提示重启 DSH（Host 端 ESM 缓存需重启才注册新路由）。

## [1.0.1] - 2026-10-09

### Added
- Semantic Scholar API Key 字段（config 持久化 + 面板三态密钥框）；配置后 `lit_search` 走 OpenAlex + S2 双源并发检索，按 DOI/标题+年份去重合并，单源失败自动降级。
- 服务诊断：Host 新路由 `GET /lit-full-search/api/diagnose`（OpenAlex 可达性/身份、S2 密钥有效性、Zotero 本地 API 可达性与版本、Zotero 写密钥），面板新增「服务状态」区与「运行系统诊断」按钮。

### Changed
- 面板改名「全面搜索设置」。

### Notes
- 1.0.0 曾被打包但内容实为 0.1.3（同版本同路径 tarball 重装导致 `ambiguous-install`，管理器靠 manifest diff 识别安装目标），故跳到 1.0.1。

## [0.1.3] - 2026-10-09

### Fixed
- Zotero 10+ 写请求补 `Zotero-Server-ID` 握手（模块级缓存 + 写前 ping），修复 `zotero_save` HTTP 428；Zotero 请求统一 `Connection: close`。

## [0.1.2] - 2026-10-08

### Changed
- 移除 composer dock 快捷 chip。
- 重写引擎设置面板为三段式卡片（身份标识 / 密钥 / 检索预算）+ sticky 操作条。

### Fixed
- 表单异步加载后不回显的问题（改受控组件）；保存时误清空已存密钥的问题（密钥三态：留空保留 / 覆盖 / 显式清除）。

## 历史说明

0.1.2 之前的早期迭代（0.1.0 / 0.1.1）未纳入 git 版本管理。本仓库自 literature-search-agent 的
`interfaces/dsh-lit-full-search` 子目录拆分而来，0.1.2 起的提交历史完整保留。
