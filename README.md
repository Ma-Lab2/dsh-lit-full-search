# dsh-lit-full-search

DSH 文献检索插件（轻量版，零 npm 依赖）。在**任何模式 / 任何 preset** 下注册 5 个全局
model 工具，并提供侧栏「全面搜索设置」面板（密钥、检索预算、服务诊断）。

直连 [OpenAlex](https://docs.openalex.org)、[Semantic Scholar](https://api.semanticscholar.org)
与本地 Zotero API（`http://localhost:23119`）。

## 安装

```bash
cd interfaces/dsh-lit-full-search
npm pack            # 生成 dsh-lit-full-search-1.0.1.tgz
dsh plugin --profile web add <绝对路径>/dsh-lit-full-search-1.0.1.tgz
# 重启 DSH（Host 端代码经 ESM 缓存，必须重启才重载）
```

## 工具（全局，任何模式下可见）

| 工具 | 说明 | 关键参数 |
| --- | --- | --- |
| `lit_search` | 学术文献检索：OpenAlex；配置 Semantic Scholar API Key 后**双源检索**，按 DOI 去重合并（单源失败不拖垮整体，记入 `diagnostics`） | `query`(必填), `limit`, `yearFrom`, `yearTo` |
| `lit_abstract` | 按 DOI 或标题取摘要（OpenAlex） | `doi` / `title` 至少其一 |
| `lit_cited_by` | 被引列表（DOI 或 OpenAlex work ID） | `identifier`(必填), `limit` |
| `zotero_search` | 检索本地 Zotero 库（只读） | `query`(必填), `limit`, `qmode` |
| `zotero_save` | 归档到 Zotero（DOI 查重，幂等） | `doi` / `title`, `collectionKey` |

> 结果统一带卡片渲染（`meta.card='literature'`），与 dsh-literature-search 0.3.0 的
> 浏览器端文献卡片渲染器兼容。

## 设置面板（「全面搜索设置」）

左侧栏「定时任务」下方的「全面搜索设置」图标打开设置页（main keyed 面板，
id `lit-full-search-settings`），分四段：

- **身份标识** —— `mailto`（OpenAlex 礼貌邮箱，提升限流配额；兜底 `LIT_SEARCH_MAILTO`）
- **密钥** —— 每项带「已设置 …尾4位 / 未设置」状态徽标：
  - `openAlexApiKey`（兜底 `LIT_SEARCH_OPENALEX_API_KEY`）
  - `s2ApiKey` —— 设置后 `lit_search` 双源检索（兜底 `LIT_SEARCH_S2_API_KEY`）
  - `zoteroKey` —— `zotero_save` 写操作需要（兜底 `LIT_SEARCH_ZOTERO_KEY`）

  输入框**留空即保持不变**，输入新值才覆盖；要删除密钥点「清除」（可撤销），保存后生效。
  GET 回显只含掩码与布尔状态，不下发明文。
- **检索预算**（防上下文爆炸，逐项带区间说明，失焦自动夹到合法范围）：
  - `searchLimit`（lit_search，1–25，默认 10）
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
node --check lib/*.js
node --test test/
```

测试全部本地（mock fetch / 注入 fetchImpl），不触碰网络与真实 Zotero。

## 认证优先级

文件配置（设置面板保存） > 环境变量 `LIT_SEARCH_*` > 默认值。
