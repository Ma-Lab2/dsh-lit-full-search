/**
 * 从《液晶靶激光离子加速综述》抽取「## 参考文献」小节，生成结构化 JSON。
 *
 * 决策表 DECISIONS 是本项目对「保留/丢弃」的唯一人工事实来源：
 *   keep —— 与液晶靶基础知识 / 制备 / 表征 / 打靶实验相关的期刊论文
 *   drop —— 背景文献、会议文章、预印本、报告、学位论文、数据集
 * 改这里的 decision 后重跑即可刷新 data/refs-lc-review-2026.json。
 *
 * 用法：node data/extract-refs.mjs [综述.md 路径] [输出.json 路径]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REVIEW = process.argv[2] ?? 'D:/AI Programs/literature-search-agent/液晶靶激光离子加速综述.md';
const OUT = process.argv[3] ?? path.join(HERE, 'refs-lc-review-2026.json');

/** n → [decision, category, reason, itemType] */
const DECISIONS = {
  1: ['keep', 'basics+experiment', '液晶膜按需可变厚度靶的奠基工作，已在目标收藏夹', 'journalArticle'],
  2: ['drop', 'erratum', '#1 的勘误通知，无实质内容', 'journalArticle'],
  3: ['keep', 'fabrication+experiment', '中重频超强激光用液晶靶与光学，已在目标收藏夹', 'journalArticle'],
  4: ['drop', 'background', 'Scarlet 激光装置能力（设施背景，非液晶）', 'journalArticle'],
  5: ['keep', 'instrumentation', '共聚焦定位传感器：超强激光实验靶对准（已在目标收藏夹）', 'journalArticle'],
  6: ['keep', 'basics', '液晶靶与等离子体镜用于激光离子加速，已在目标收藏夹', 'journalArticle'],
  7: ['keep', 'experiment', '相对论透明区液晶靶 TNSA 打靶实验，已在目标收藏夹', 'journalArticle'],
  8: ['keep', 'characterization', '单等离子体镜时间对比度的 on-shot 表征，已在目标收藏夹', 'journalArticle'],
  9: ['keep', 'experiment', '晚形成弹道鞘场质子环（液晶靶打靶结果），已在目标收藏夹', 'journalArticle'],
  10: ['drop', 'conference', 'OSA HILAS 2020 会议论文', 'conferencePaper'],
  11: ['drop', 'background', 'TNSA 靶特征综述（通用背景，非液晶）', 'journalArticle'],
  12: ['keep', 'basics+experiment', '液晶等离子体镜实验+模拟（首个演示），已在目标收藏夹', 'journalArticle'],
  13: ['keep', 'basics', '液晶等离子体镜脉冲净化的 PIC 建模（液晶膜介电响应基础物理）', 'journalArticle'],
  14: ['keep', 'experiment', 'GeV 级 LPA 用薄膜等离子体镜发射度保持，已在目标收藏夹', 'journalArticle'],
  15: ['keep', 'fabrication+experiment', 'PW 级可再生双等离子体镜，已在目标收藏夹', 'journalArticle'],
  16: ['drop', 'conference', 'SPIE Liquid Crystals XXVIII 会议论文', 'conferencePaper'],
  17: ['drop', 'conference', 'SPIE Liquid Crystals XXIX 会议论文', 'conferencePaper'],
  18: ['drop', 'background', '飞秒激光等离子体膨胀运动学（通用过临界等离子体物理）', 'journalArticle'],
  19: ['drop', 'background', '流动液膜可再生等离子体镜（非液晶）', 'journalArticle'],
  20: ['drop', 'background', '层流水膜等离子体镜（非液晶）', 'journalArticle'],
  21: ['keep', 'characterization', '向列液晶大功率/高峰值功率损伤参数研究（液晶材料损伤）', 'journalArticle'],
  22: ['keep', 'characterization', '向列液晶 1030 nm 飞秒激光损伤阈值（液晶材料损伤）', 'journalArticle'],
  23: ['keep', 'fabrication', '高功率激光用玻璃态液晶膜（纳米–微米厚度制备）', 'journalArticle'],
  24: ['keep', 'characterization', '块体与液晶非线性折射率的非线性啁啾干涉测量', 'journalArticle'],
  25: ['keep', 'fabrication+characterization', '全自动自支撑液晶膜架的设计与表征', 'journalArticle'],
  26: ['drop', 'background', '亚微米介质靶激光击穿预测（通用超薄靶理论）', 'journalArticle'],
  27: ['drop', 'background', '超薄靶损伤阈值与激光对比度约束（通用超薄靶）', 'journalArticle'],
  28: ['drop', 'background', '高重频设施靶需求与挑战（综述背景）', 'journalArticle'],
  29: ['drop', 'background', '高重频 HED 科学发现速率（综述背景）', 'journalArticle'],
  30: ['drop', 'background', '液体微射流 kHz 靶与光学（非液晶）', 'journalArticle'],
  31: ['drop', 'background', 'kHz 超薄液片靶（非液晶）', 'journalArticle'],
  32: ['drop', 'background', '磁带驱动靶（非液晶）', 'journalArticle'],
  33: ['drop', 'background', '多发射靶轮组件（非液晶）', 'journalArticle'],
  34: ['drop', 'background', '低温氢带靶（非液晶）', 'journalArticle'],
  35: ['drop', 'background', '低温氢射流质子源（非液晶）', 'journalArticle'],
  36: ['drop', 'background', 'CLPU 薄水靶（非液晶）', 'journalArticle'],
  37: ['drop', 'background', '水叶靶（非液晶）', 'journalArticle'],
  38: ['drop', 'background', '相对论透明区激光等离子体透视（综述背景）', 'journalArticle'],
  39: ['drop', 'background', '全球 PW/EW 级激光器综述（设施背景）', 'journalArticle'],
  40: ['drop', 'background', 'J-KAREN-P 等离子体镜系统（非液晶）', 'journalArticle'],
  41: ['drop', 'conference', 'J. Phys. Conf. Ser. 会议论文（集成双等离子体镜靶）', 'conferencePaper'],
  42: ['drop', 'background', '靶递送与诊断自动化（工程背景）', 'journalArticle'],
  43: ['drop', 'background', '常温液体射流靶（非液晶）', 'journalArticle'],
  44: ['drop', 'background', '自支撑薄塑料膜离线制备（非液晶靶制备）', 'journalArticle'],
  45: ['drop', 'preprint', 'arXiv 预印本（液晶膜靶自动插换装置）', 'preprint'],
  46: ['drop', 'preprint', 'arXiv 预印本（可变厚度液晶靶的离子能量与空间分布）', 'preprint'],
  47: ['drop', 'preprint', 'arXiv 预印本（windmill 成型 8CB 膜稳定性与光学质量）', 'preprint'],
  48: ['drop', 'dataset', 'Zenodo 数据集', 'dataset'],
  49: ['drop', 'report', 'LaserNetUS / U.S. DOE 报告', 'report'],
  50: ['drop', 'thesis', '俄亥俄州立硕士论文（LSP 建模离子加速）', 'thesis'],
  51: ['drop', 'conference', 'Frontiers in Optics 2015 会议论文', 'conferencePaper'],
  52: ['drop', 'conference', 'APS DPP 2020 会议摘要', 'conferencePaper'],
  53: ['drop', 'conference', 'APS DPP 2018 会议摘要', 'conferencePaper'],
  54: ['drop', 'conference', 'APS DPP 2020 会议摘要', 'conferencePaper'],
  55: ['drop', 'conference', 'APS DPP 2016 会议摘要', 'conferencePaper'],
  56: ['drop', 'conference', 'APS DPP 2014 会议摘要', 'conferencePaper'],
  57: ['drop', 'conference', 'APS DPP 2017 会议摘要', 'conferencePaper'],
};

const text = readFileSync(REVIEW, 'utf8');
const section = text.split(/^## 参考文献\s*$/m)[1];
if (!section) throw new Error('未找到「## 参考文献」小节');

const refs = [];
for (const line of section.split(/\r?\n/)) {
  const m = line.match(/^(\d+)\.\s+(.+)$/);
  if (!m) continue;
  const n = Number(m[1]);
  const body = m[2].trim();

  const head = body.match(/^(.*?)\s*\((\d{4}[a-z]?)\)\.\s*(.*)$/);
  if (!head) throw new Error(`#${n} 无法解析作者/年份：${body.slice(0, 60)}`);
  const [, authorRaw, year, rest] = head;

  const starred = rest.match(/^(.*?)\.\s+\*(.+?)\*(.*)$/);
  const title = (starred ? starred[1] : rest.replace(/\.\s*https?:\/\/\S+$/, '')).trim();
  const venue = starred ? starred[2].trim() : '';
  const tail = starred ? starred[3].trim() : '';

  const doiMatch = body.match(/https?:\/\/doi\.org\/(\S+)/);
  // 卷(期), 页 —— 例如 "21(6), 063109." / "7, e54." / "12(04), C04023."
  const loc = tail.match(/^,?\s*([0-9]+)\s*(?:\(([^)]+)\))?\s*,\s*([^.,]+)/);
  const decision = DECISIONS[n];
  if (!decision) throw new Error(`#${n} 缺少筛选决策`);

  refs.push({
    n,
    authors: authorRaw.trim(),
    year,
    title,
    venue,
    ...(loc ? { volume: loc[1], ...(loc[2] ? { issue: loc[2] } : {}), pages: loc[3].trim() } : {}),
    doi: doiMatch ? doiMatch[1].trim() : '',
    itemType: decision[3],
    decision: decision[0],
    category: decision[1],
    reason: decision[2],
  });
}

const missing = Object.keys(DECISIONS).map(Number).filter((n) => !refs.some((r) => r.n === n));
if (missing.length > 0) throw new Error(`决策表里的编号在综述中找不到：${missing.join(', ')}`);

const keep = refs.filter((r) => r.decision === 'keep');
const payload = {
  source: REVIEW,
  extractedAt: new Date().toISOString(),
  rule: '去掉背景文献与会议文章，只保留与液晶靶基础知识/制备/表征/打靶实验相关的期刊论文',
  counts: { total: refs.length, keep: keep.length, drop: refs.length - keep.length, withDoi: refs.filter((r) => r.doi).length },
  refs,
};

writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log(`已写出 ${OUT}`);
console.log(`总计 ${refs.length} 条：keep ${payload.counts.keep} / drop ${payload.counts.drop}（带 DOI ${payload.counts.withDoi}）`);
console.log('保留：' + keep.map((r) => `#${r.n}`).join(' '));
