# Zotero 面完备性 / 轻量化审计

审计时间：2026-10-10 · 环境：Zotero 10.0.5 + 本地 API `http://localhost:23119/api` · DSH 0.2.0-rc.2（profile `core-020`）
所有结论均来自本机实测（工具注册表、插件包内容、技能仓库文件），非推测。

## 1. 现状清单

### 1.1 本插件（dsh-lit-full-search v1.1.0，启用中，`link:` 到本仓库）

| 工具 | 方向 | 说明 |
|---|---|---|
| `lit_search` / `lit_abstract` / `lit_cited_by` | 外网 → 模型 | OpenAlex（+S2 双源）/ 摘要 / 被引 |
| `zotero_search` | 本地读 | 库内关键词检索（`library` 支持群组库） |
| `zotero_collections` | 本地读 | 库与收藏夹清单（key / 路径 / 条目数） |
| `zotero_save` | 外网 → 本地写 | 单条 DOI/标题 → 建条目（DOI 查重） |
| `lit_to_zotero` | 外网 → 本地写 | **批量**写回：三级元数据链 + 去重（跳过/加挂/新建）+ `itemTypes` 白名单 + `dryRun` + 可选挂 OA PDF |
| `zotero_enrich` | 本地读 | **单点查**深度记录：书目字段 / 标签 / 收藏夹（名称+路径）/ 笔记 / 全部附件（可选磁盘路径与存在性）/ 批注 / Zotero 全文索引缓存 |

### 1.2 `dsh-zotero` 0.12.1（已安装，**禁用**）

`profiles/core-020/cordis.patch.yml` 中 `- id: zotero / disabled: true`。它提供 8 个读工具
（`zotero_search` / `zotero_get` / `zotero_browse` / `zotero_children` / `zotero_retrieve` / `zotero_changes` / `zotero_attachment` / `zotero_export`）
与 8 个写工具（`writeEnabled` 后开启：建条目/改条目/建合集/标签与合集归属/删合集/删标签）。
其自述限制：**只访问 loopback，无外部网络访问**（`README.md` 权限段）。

### 1.3 父项目 `literature-search-agent/core/zotero`（TS 代码库，非插件）

`client.ts` / `locate.ts` / `match.ts` / `save.ts`：本机脚本可复用（`zotero_import` 迁移期曾用它，
现插件已零依赖自足）。

### 1.4 与 Zotero 有关的技能（全部在第三方仓库 `Yuan1z0825/nature-skills`）

| 技能 | 涉及 Zotero 的位置 | 结论 |
|---|---|---|
| `nature-ref-verifier` | `SKILL.md` L6 / L24 / L38 / L55 / L134–140 / L192–193 | **过时**，见 §5 |
| `nature-literature-pipeline` | `SKILL.md` 的 `related_skills: [..., zotero]` | **悬空引用**：仓库内无 `zotero` 技能 |
| `nature-citation` | 仅「RIS / EndNote / Zotero RDF 导出」参考文档 | 无需改 |
| 其他（`lit-search`、`paper-digest`、`pdf-download` 等） | 未提及 Zotero | 不涉及 |

## 2. 硬约束：两个 Zotero 插件互斥

`dsh-zotero` 的第一个工具同样叫 **`zotero_search`**，而 DSH 的工具注册表对同名是**硬报错**：

> `tool "zotero_search" is already registered in this scope`
> —— `@deepseek-ai/dsh-tools` 的 `NamedEntries`（重复名抛错，非静默覆盖）

因此本插件与 `dsh-zotero` **不能同时启用**。本机选择保持 `dsh-zotero` 禁用、由本插件自给自足；
插件 README 已写明该约束。**若将来要启用 `dsh-zotero`，必须先改名本插件的 `zotero_search`。**

## 3. 完备性缺口（本轮明确**不做**）

按性价比排序，全部属于「本地 Zotero 深度」一侧，且 `dsh-zotero` 已有成熟实现：

| 缺口 | 对应 dsh-zotero 工具 | 本轮决定 |
|---|---|---|
| 引用导出（CSL / BibTeX / BibLaTeX / RIS / CSL JSON） | `zotero_export` | 不做 |
| 按问题取证据段落（BM25，跨附件/笔记） | `zotero_retrieve` | 不做 |
| 库结构浏览（合集树 / 保存搜索 / 标签分面） | `zotero_browse` | 不做（本插件 `zotero_collections` 已覆盖"找 key"这一最小需求） |
| 增量变更（版本感知） | `zotero_changes` | 不做 |
| 附件上传/下载（除已支持的挂 OA PDF） | 写入工具集 | 不做 |

理由：这些能力需要 BM25 索引、CSL 处理器、版本游标等重组件，与「零依赖轻量插件」的定位冲突；
一旦真需要，启用 `dsh-zotero` 是更省的路径（代价是 §2 的改名约束）。

## 4. 轻量化结论

1. **`zotero_save` 与 `lit_to_zotero` 重叠**：后者是前者的严格超集——单条 DOI 也能写，且额外支持
   群组库、收藏夹路径、`itemTypes` 白名单、`dryRun`、挂 OA PDF、批量与逐条报告。
   → **下一轮轻量化的首选删除项**（本轮保留，减少回归面）。删除后工具数 8 → 7。
2. **`zotero_search` 与 `zotero_enrich` 的分工已清晰**：前者薄（key/标题/作者/年/DOI/URL），后者深（一次一个条目）。
   两者不重叠，无需合并。
3. **卡片与面板**：三个 Zotero 工具各有会话卡片；面板 CSS 已从失效的 `--ds-color-*` 换到现行 `--dsw-alias-*`。
4. 本插件仍保持**零 npm 依赖**、无构建步骤（`node --check` + `node --test` 即可验证）。

## 5. 技能面：补丁草案（第三方仓库，本轮只审不改）

仓库 `origin = git@github.com:Yuan1z0825/nature-skills.git`（非本人仓库，有外部 PR 历史）→ 不擅自提交。
若要走 PR，建议改动如下：

**`skills/nature-ref-verifier/SKILL.md`**

| 行 | 现状 | 建议 |
|---|---|---|
| L136 | 「**Zotero 7 本地 HTTP API（localhost:23119）只读**——写操作返回 501」 | 改为：「Zotero **10+** 本地 API 支持写入（写请求需 `Zotero-Server-ID` 头，缺失会 428；首次写入会在 Zotero 弹窗请求授权）；Zotero 7 只读」 |
| L137 | 「批量写入首选 pyzotero Web 模式（需 userID + API key）」 | 补充本机可行路径：「本地 DSH 环境下可直接用 `lit_to_zotero`（批量、支持群组库与收藏夹）或 `zotero_save`；pyzotero 仍适用于脱离 DSH 的脚本」 |
| L55 | 「Zotero 本地库 (**zotero-mcp**)」 | 本机未安装 zotero-mcp；改为「Zotero 本地 API / `zotero_search` + `zotero_enrich`」 |
| L192–193 | 推荐 `pyzotero[cli]` / `zotero-cli` / `zotero-mcp` | 同上，补一句本机首选工具名 |
| L38 | 「或传入 Zotero item key」 | 可补：「用 `zotero_search` 拿 key，`zotero_enrich` 读完整记录（含标签/收藏夹/附件路径）」 |

**`skills/nature-literature-pipeline/SKILL.md`**

- `related_skills: [nature-academic-search, nature-citation, arxiv, zotero]` 中的 `zotero` 在仓库内不存在。
  建议改为本机技能名 `lit-zotero`（本仓库新建，见下），或删掉该条目。

## 6. 本机补口：`~/.dsh/skills/lit-zotero/SKILL.md`

不改第三方仓库也能补上「完备」：一个按需加载的本机技能，写清本插件三条链路的配合方式、
库/收藏夹定位、写授权、与 `dsh-zotero` 的互斥约束、以及实测踩过的坑（HTTP/1.0 连接、428、按需下载、拼写不可改）。
见该技能文件本身。
