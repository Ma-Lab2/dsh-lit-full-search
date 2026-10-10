# dsh-lit-full-search 压力测试（2026-10-10）

目标：确认 8 个工具在真实链路上「好用」——正常输入能出结果、边界输入不崩、错误信息能自我修正、
并发不互相踩、返回体量不炸上下文。

## 怎么跑

```bash
node work/stress/stress-live.mjs         # 70 个用例，打真实 OpenAlex / S2 / 本地 Zotero
node work/stress/stress-concurrency.mjs  # 24 路并发 + render 幂等
```

前置：Zotero 已开启本地 API（设置 → 高级 → 安全 → 允许其他应用程序通过本地 API 访问 Zotero）。
`lit_to_zotero` 的用例**全部 `dryRun: true`**，不会写入真实库。

每个用例都会跑 DSH 的三道硬校验（见 `test-support/contract.js`）：lossless JSON、`outputSchema` 封闭对象、
`render` 形状；并打印渲染文本字符数与耗时。

## 结果

| 套件 | 结果 |
|---|---|
| 真实链路 `stress-live.mjs` | **70 / 70 通过** |
| 并发 `stress-concurrency.mjs` | **24 / 24 通过** |
| 单元测试 `npm test` | **111 / 111 通过**（第一轮新增 15 项契约测试，第二轮再加 4 项） |

## 找到并修掉的缺陷

### P0：工具整体不可用（模型只收到一条 Error，拿不到任何数据）

| # | 工具 | 现象 | 根因 |
|---|---|---|---|
| 1 | `lit_to_zotero` | 任何调用都报 `value is not lossless JSON` | 逐条记录写死 `n: parsed.n`，而 `parseReferenceLine` 对裸 DOI / 裸标题**不产出 `n`** → 键存在但值为 `undefined` → `JSON.stringify` 丢键 → 往返不等 |
| 2 | `zotero_collections` | 只要传 `library` 就报 `"value.libraryKey" is not a declared property` | `execute` 返回 `libraryKey`，但 `outputSchema` 声明了 `additionalProperties: false` 却没列出它。而「列某个库的收藏夹」正是该工具的主要用法 |

修法：#1 字符串条目回落到 1-based 序号（对象条目仍保留显式 `n`）；#2 补 `libraryKey` 声明。

### P1：静默错误 / 噪声

| # | 工具 | 现象 | 修法 |
|---|---|---|---|
| 3 | `lit_abstract` | 不存在的 DOI 抛错，错误里夹带 OpenAlex 网关的 **404 HTML 整页**；文档承诺的 `status=missing` 从未生效 | `lookupOpenAlexByDoi` 遇 404 返回 `null` → `status=missing`；`lit_cited_by` 据此给出「无法解析「…」为 OpenAlex work ID」 |
| 4 | 全部外网工具 | 任何 4xx 的错误体都会把 HTML 灌进模型上下文 | `fetchJson` 新增 `summarizeErrorBody()`：去 script/style/标签、压空白、截 200 字，并给 error 挂 `status` |
| 5 | `zotero_enrich` | `unknownFields` 只进结构化结果、**不进 `render`**，而模型只看得到 `render` | render 明确列出被忽略的字段名 |
| 6 | `lit_search` | `yearFrom > yearTo` 时两源都返回空集 → 渲染成「未找到相关文献」 | 直接报错并提示调换 |

### P2：防御性

| # | 工具 | 现象 | 修法 |
|---|---|---|---|
| 7 | `zotero_collections` | `render` 在 value 缺字段时抛 `Cannot read properties of undefined` | 取默认值兜底 |

### 顺带修掉（非工具逻辑）

- `package.json` 版本 `1.0.3` 与 `VERSION` 的 `1.1.0` 长期不一致——治理校验只看 `VERSION`，所以没人发现；
  已对齐为 `1.1.0`。（上游模板的 `prepare-release.sh` 只改 `VERSION`/`CHANGELOG`，不改 `package.json`，
  这是模板缺口，属 `.governance` 受锁文件，未改动。）

## 为什么原有 93 项测试全绿却漏掉了两个 P0

根因是**测试层次的缺口**：既有测试只断言「返回对象里的业务字段对不对」，从来没有把 `execute()` 的返回值
拿去对 `outputSchema` / 序列化做校验。而这两个 P0 恰恰不在业务逻辑里，在**工具契约**里。

现在补上 `test/tool-contract.test.js`（15 项），并且**验证过它能复现这两个 bug**：

```
回退 n 修复        → 2 项红（lit_to_zotero 的两个用例）
回退 libraryKey    → 1 项红（zotero_collections 的回归用例）
```

## 实测数字

### 渲染体量（模型实际吃进上下文的字符数）

| 用例 | 字符数 |
|---|---|
| `lit_search` 中英混合、25 条 × 双源 | **17,939** |
| `lit_search` limit=999（夹到 25） | 14,991 |
| `lit_search` 仅 `yearTo` | 12,822 |
| `zotero_search` qmode=titleCreatorYear | 5,538 |
| `zotero_enrich`（含摘要） | ~1,140 |
| `zotero_abstract` | 882 |
| `zotero_collections` | 103 |

`lit_search` 是唯一的大头，单次上限约 18k 字符（≈6k token）。主要成本是**作者全名列表**（每源最多 30 人/条，
50 条封顶）。

**第二轮已处理**：render 把作者裁到前 6 人并注明「等 N 人」（结构化结果与卡片不受影响），复跑后中英混合
用例 17,939 → **14,156** 字符，`limit=999` 14,991 → 14,672。

### 第二轮修正（同日）

- 空白 query（`'   '`）原先会透传给外网源并返回任意热门文献，现直接报错；对应用例改为 `expect: 'throw'`。
- query 含中日韩字符时 render 附「建议改英文/中英混合」提示（见下文「中文关键词检索质量差」）。
- 复跑：`stress-live.mjs` 70/70，`npm test` 111/111。

### 耗时（真实链路）

| 操作 | 耗时 |
|---|---|
| `lit_search`（双源） | 0.7 – 3.1 s |
| `lit_search` 空白 query / 无结果 | 0.7 – 0.9 s |
| `zotero_search`（本地） | 0.4 – 3.7 s |
| `zotero_enrich`（key 命中） | 10 – 100 ms |
| `zotero_collections` | 4 – 120 ms |
| `lit_to_zotero` dryRun 单条 | 0.2 s |
| `lit_to_zotero` 整行 APA 解析 | 5.4 s（Crossref 往返） |
| `lit_to_zotero` 无法解析的条目 | 6.9 s（Crossref → OpenAlex 逐个降级） |

### 并发

| 场景 | 结果 |
|---|---|
| 8 路并发 `lit_search` | 8/8 成功，4.3 s |
| 8 路并发 `zotero_search`（本地 API 是 HTTP/1.0 单连接） | 8/8 成功，10.6 s（排队但不失败） |
| 8 路并发 `zotero_enrich` | 8/8 成功，0.8 s |
| `render` 对同一 value 重复调用 | 幂等 |

## 不是缺陷（上游 / 用法注意）

- **中文关键词检索质量差**：`lit_search` 传「液晶靶 激光离子加速」返回 28 条，多是 LED 荧光粉、EUV、
  泡沫铝之类无关中文论文。这是 OpenAlex / S2 的中文全文匹配行为，插件只是如实转述。
  **建议**：中文场景用英文关键词，或中英混合。
- **`qmode` 非法值静默回落** `everything`；`limit` 非整数回落预算默认值。参数 schema 已声明 `type`，
  模型基本传不出非法值，静默兜底比报错更稳。
- **Zotero 并发排队**：本地 API 是 HTTP/1.0 单连接，8 路并发要 10.6 s，但没有失败（`Connection: close`
  的处理是对的）。

## 覆盖边界与未覆盖项

已覆盖：8 个工具 ×（正常 / 边界 / 非法 / 未命中 / 错误路径）；`limit` 的 0、负数、小数、超上限；
`maxChars` 的 0 / 上界 / 超上界 / 非数字；ref 四种写法；`fields` 投影含未知名；`include` 全部分组；
`itemTypes` 白名单与排除；库/收藏夹不存在；200 条上限；年份倒挂；CJK；空白；超长 query；特殊字符。

**未做真实写入验证**：`lit_to_zotero` 的非 dryRun 路径用替身做了契约校验（含 `attachPdf` 的 `none` 分支），
但没有往真实库里真建条目再删。真实写入的端到端验证仍建议在专用收藏夹里手工跑一次。
