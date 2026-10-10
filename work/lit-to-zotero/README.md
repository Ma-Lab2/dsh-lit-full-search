# work/lit-to-zotero —— 插件新工具工作目录

> 这是 `dsh-lit-full-search` 的开发沙盒：把「批量把文献写回指定 Zotero 库/收藏夹（含群组库）」
> 从设计做到可用。`package.json` 的 `files` 白名单不含 `work/`，所以这里的东西不会被发布。

## 目标

给插件新增三个 model 工具：

| 工具 | 类型 | 职责 |
|---|---|---|
| `zotero_collections` | 只读 | 列出库与收藏夹（key / 名称 / 完整路径 / 条目数），用于定位与消歧 |
| `lit_to_zotero` | 写 | 批量把检索到的文献（DOI / 标题 / 整行）写入指定库 + 收藏夹：元数据解析 → 去重 → 新建或加挂（可选挂 OA PDF）→ 报告 |
| `zotero_enrich` | 只读 | **单点查**：按 item key / DOI / 标题 / `zotero://` 引用读深一个条目——字段 / 标签 / 收藏夹（名称+路径）/ 笔记 / 全部附件（可选磁盘路径与存在性）/ 批注 / 全文索引缓存 |

三者都有会话内卡片（客户端 `tool.call.toolview` keyed 槽位，按 wire 工具名分发）。
`lit_to_zotero` 与 `zotero_enrich` 构成「**落库** ↔ **读深**」的一对：前者外网→本地，后者本地→模型。

背景缺口：插件原有的 `zotero_search` / `zotero_save` 全部硬编码 `/users/0/items`（个人库），
**完全不支持群组库**，也没有收藏夹定位与「读深单条」的能力。

> 完整的 Zotero 工具面审计（与已禁用的 `dsh-zotero` 的对比、完备性缺口、轻量化结论、技能面补丁草案）
> 见 [`design/zotero-surface-audit.md`](design/zotero-surface-audit.md)。

## 首个真实用例

把《液晶靶激光离子加速综述》（`D:\AI Programs\literature-search-agent\液晶靶激光离子加速综述.md`）
的 57 条参考文献，**筛选后**写进：

```
WENJUN_MA's Group (group:6441110)
└─ 2.Novel Targets (3ZKQJ2B8)
   └─ liqiud crystal target (YJUSYVEM)     ← 目标收藏夹（Zotero 里名字就是拼错的 liqiud），实测 31 条
```

筛选规则（用户给定）：**去掉背景文献与会议文章，只保留与液晶靶「基础知识 / 制备 / 表征 / 打靶实验」
相关的期刊论文** → 57 条中保留 16 条、丢弃 41 条。

实测落点（见 `data/target-analysis.md`）：

| 分类 | 条数 | 动作 |
|---|---|---|
| 保留且已在目标收藏夹 | 10 | 无 |
| 保留、在群组内但不在该收藏夹 | 1（#25 Bürkle 液晶膜架） | 加挂 |
| 保留、群组内没有 | 5（#13 #21 #22 #23 #24） | 新建 |
| 丢弃（会议/预印本/非期刊/背景） | 41 | 无 |

> 保留集 = `#1 #3 #5 #6 #7 #8 #9 #12 #13 #14 #15 #21 #22 #23 #24 #25`（16 条）
> = 已在收藏夹 10 条 + 加挂 1 条 + 新建 5 条。

## 目录

```
work/lit-to-zotero/
├─ README.md                        本文件：目标 / 用例 / 决策 / 进度
├─ design/tool-spec.md              新工具接口契约（参数、返回、错误、边界）
├─ design/engine-changes.md         lib/ 层改造清单
├─ data/refs-lc-review-2026.json    57 条参考文献 + 筛选结论（keep/drop/reason）★筛选事实来源
├─ data/extract-refs.mjs            综述 md → refs json（可复用；决策表在脚本内）
├─ data/target-analysis.md          目标位置与重复分析实测记录
└─ run-lit-to-zotero.mjs                   调用 lib/ 引擎跑真实导入（--dry-run / --apply / --verify / --rollback）
```

## 进度

- [x] 目标位置与重复分析（2026-10-10 实测）
- [x] 57 条参考文献解析与筛选结论落盘（keep 16 / drop 41）
- [x] `lib/light-core.js` 库路径参数化 + 收藏夹读写 + 授权
- [x] `lib/lit-to-zotero.js` 引擎（含可选挂 OA PDF）
- [x] `lib/tools.js` 三个工具定义
- [x] 客户端卡片（`tool.call.toolview` 按 wire 工具名注册）
- [x] 修 OpenAlex key 未生效缺陷（`resolveAuth().apiKey`）＋ 回归用例
- [x] dry-run 核对 → apply → verify
- [x] 改名 `zotero_import` → `lit_to_zotero`（wire 名用下划线）
- [x] 面板 CSS 换到现行 `--dsw-alias-*` 主题 token（＋护栏测试）
- [x] `zotero_enrich` 单点查（4 个只读引擎函数 + 卡片）＋ 真实数据自测
- [x] Zotero 工具面审计（`design/zotero-surface-audit.md`）＋ 本机技能 `~/.dsh/skills/lit-zotero/`
- [x] 测试与文档（`npm test` 90 项全绿，`npm run check` 通过）

## 执行结果（2026-10-10）

```
--dry-run   新建 5 · 加挂 1 · 已存在 10 · 跳过 0 · 失败 0   （收藏夹当时 31 条）
--apply     预检 #13 成功 → 新建 4 · 加挂 1 · 已存在 11 · 失败 0
--verify    exists 16/16
```

| 动作 | 条目 | itemKey |
|---|---|---|
| 新建 | #13 Cochran PIC 液晶等离子体镜建模 | `J4XRRNA9` |
| 新建 | #21 Kosc 向列液晶损伤参数 | `QZX8A2PX` |
| 新建 | #22 Ramousse 液晶飞秒损伤阈值 | `RY77HDNL` |
| 新建 | #23 Wallace 玻璃态液晶膜 | `UDCEYKHY` |
| 新建 | #24 Maingot 液晶非线性折射率 | `YLCK7TDN` |
| 加挂 | #25 Bürkle 全自动液晶膜架（原在群组别处） | `FIT6MIJR`（未变） |

目标收藏夹条目数 **31 → 37**。报告：`data/import-report-2026-10-10T10-48-39-414Z.json`。
写授权使用面板里已配置的 `zoteroKey` 一次通过（未触发授权弹窗）。

回滚：`node work/lit-to-zotero/run-lit-to-zotero.mjs --rollback data/import-report-*.json`

## zotero_enrich 真实数据自测（2026-10-10）

| 样本 | 结果 |
|---|---|
| `XJJK3AH4`（群组 6441110，带 PDF，`include` 含 attachments/fulltext + `paths`） | 附件 1 个：`D:\Program Files (x86)\Zotero\storage\JLK3ERJG\…pdf`，`exists: true`；全文索引 40315 字；收藏夹 `0.课题组发表论文（通讯）` |
| `QZX8A2PX`（本轮新建的液晶靶文献） | 无附件（`attachments: []`）、无笔记/批注；收藏夹映射为 `2.Novel Targets > liqiud crystal target` |
| `zotero://group/6441110/item/QZX8A2PX` | 命中，库锁定为群组库 |
| `zotero://user/0/item/QZX8A2PX` | `found:false`（该条目不在个人库）——证明 `zotero://` 的库限定生效 |
| `ZZZZZZZZ` | `found:false` + 提示，不抛错 |
