# 目标位置与重复分析（实测记录）

实测时间：2026-10-10 · Zotero 10.0.5 · 本地 API `http://localhost:23119/api`

## 1. 库与收藏夹

| 库 | libraryKey | 说明 |
|---|---|---|
| 我的文库 | `user` | 本地 id 19678363，顶层条目 160 |
| LDIA library | `group:6646099` | 顶层条目 105 |
| WENJUN_MA's Group | `group:6441110` | 顶层条目数千，收藏夹 **248 个** |

目标路径：

```
WENJUN_MA's Group (group:6441110)
└─ 2.Novel Targets            key = 3ZKQJ2B8
   ├─ Cluster & 0D …
   ├─ liqiud crystal target   key = YJUSYVEM   ← 目标（注意拼写 liqiud），实测 31 条顶层条目
   └─ …
```

同名/近似名消歧（重要）：

| 名称 | key | 位置 | 条目 |
|---|---|---|---|
| `liqiud crystal target` | `YJUSYVEM` | WENJUN_MA's Group > 2.Novel Targets | 31 |
| `liquid crystal target for LIA` | `5IRF556Z` | LDIA library | 18 |
| `液晶靶` | `X9ZD5WYQ` | WENJUN_MA's Group > 其他液态靶 | 20 |
| `2.Liquid targets` | `672C7RNC` | WENJUN_MA's Group（顶层） | 6 |

→ 工具必须支持「库名 + 收藏夹路径」双重限定，否则单靠 `liquid crystal target` 之名会歧义或错拼失配。

## 2. 57 条参考文献的落点分类（筛选前）

| 分类 | 条数 | 编号 |
|---|---|---|
| 已在目标收藏夹 | 15 | #1 #3 #5 #6 #7 #8 #9 #10 #12 #14 #15 #16 #45 #46 #47 |
| 在群组内其它位置 | 17 | #20 #25 #27 #28 #30 #31 #32 #33 #34 #35 #36 #37 #38 #39 #40 #42 #43 |
| 群组内没有 | 25 | #2 #4 #11 #13 #17 #18 #19 #21 #22 #23 #24 #26 #29 #41 #44 #48 #49 #50 #51 #52–#57 |

方法：目标收藏夹顶层条目一次性取回；其余按 DOI（无 DOI 按规范化标题）在 `group:6441110`
内 `qmode=everything` 精确检索。

## 3. 筛选后的落点（本次导入的实际输入）

保留 16 条：`#1 #3 #5 #6 #7 #8 #9 #12 #13 #14 #15 #21 #22 #23 #24 #25`

| 动作 | 条数 | 编号 |
|---|---|---|
| 无（已在目标收藏夹） | 10 | #1 #3 #5 #6 #7 #8 #9 #12 #14 #15 |
| 加挂到目标收藏夹 | 1 | #25 |
| 新建（含收藏夹归属） | 5 | #13 #21 #22 #23 #24 |
| 丢弃 | 41 | 其余 |

预期收藏夹条目数：31 → **37**。

## 3b. 执行结果（2026-10-10 已完成）

- `--dry-run`：新建 5 · 加挂 1 · 已存在 10 · 失败 0（与上表一致）。
- `--apply`：预检 #13 通过 → 新建 4（#21 #22 #23 #24）+ 加挂 1（#25）；itemKey 见 `README.md`。
- `--verify`：exists **16/16**；收藏夹 `numItems` = **37**。
- 字段复核（只读回查 5 条新建条目）：itemType 均为 journalArticle，标题/作者/年/期刊/卷/期/DOI/ISSN 齐全，
  摘要 4 条有（#23 ACS 未向 Crossref 存摘要）、页码 2 条缺失（Crossref 未给页码）。

## 4. 已知环境坑

- Zotero 内嵌服务器是 HTTP/1.0：所有请求必须带 `Connection: close`，否则 undici 复用已关闭 socket 报 `fetch failed`。
- Zotero 10+ 写请求必须先拿到 `Zotero-Server-ID`（否则 428）。
- PowerShell 的 `Invoke-WebRequest` 打 Zotero 本地 API 会失败（连接层），用 node/undici 才稳。
- 收藏夹现有条目里有 4 条带 `【00xx】` 前缀（属另一套编号流程）；目标收藏夹 `liqiud crystal target` 的名称拼写错误不要"修正"，那是真实 key 所在。
