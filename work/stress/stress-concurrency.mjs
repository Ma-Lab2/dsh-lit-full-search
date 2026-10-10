/**
 * 压力测试第二组：并发 + 结构化字段是否真的到达模型（render 是模型唯一能看到的输出）。
 */
import { toolDefinitions } from '../../lib/tools.js';
import { enrichItem } from '../../lib/zotero-enrich.js';

const byName = Object.fromEntries(toolDefinitions.map((d) => [d.name, d]));
const GROUP = 'group:6441110';
const KEY = 'J4XRRNA9';

/** 并发跑 N 次同一工具，统计成功/失败与耗时分布。 */
async function concurrency(label, tool, argsList) {
  const started = Date.now();
  const settled = await Promise.allSettled(argsList.map((args) => byName[tool].execute(args)));
  const ms = Date.now() - started;
  const ok = settled.filter((s) => s.status === 'fulfilled').length;
  const errs = settled.filter((s) => s.status === 'rejected').map((s) => String(s.reason?.message ?? s.reason).slice(0, 100));
  console.log(`${label}: 并发 ${argsList.length} · 成功 ${ok} · 失败 ${errs.length} · 总耗时 ${ms}ms`);
  for (const e of [...new Set(errs)]) console.log(`   ✗ ${e}`);
  return { ok, total: argsList.length, ms, errs };
}

console.log('=== 1) 并发：外网检索（8 路并发 lit_search）===');
const queries = [
  'liquid crystal target', 'laser ion acceleration', 'plasma mirror', 'target normal sheath acceleration',
  'cryogenic hydrogen jet', 'nanowire target', 'laser wakefield acceleration', 'proton acceleration',
];
const netConcurrency = await concurrency('lit_search', 'lit_search', queries.map((q) => ({ query: q, limit: 3 })));

console.log('\n=== 2) 并发：本地 Zotero（8 路并发 zotero_search，HTTP/1.0 单连接）===');
const zoteroConcurrency = await concurrency('zotero_search', 'zotero_search', queries.map((q) => ({ query: q, library: GROUP, limit: 5 })));

console.log('\n=== 3) 并发：混合读写 Zotero（enrich + search + collections 各 4 路）===');
const mixed = await concurrency('mixed', 'zotero_enrich', Array.from({ length: 8 }, () => ({ ref: KEY, library: GROUP })));

console.log('\n=== 4) unknownFields / warnings 是否到达模型（render）===');
const withUnknown = await enrichItem({ ref: KEY, library: GROUP, fields: ['title', 'nonsenseField', 'anotherBogus'] });
console.log('结构化 unknownFields:', JSON.stringify(withUnknown.unknownFields));
const def = byName.zotero_enrich;
const rendered = def.render({ ref: KEY, fields: ['title', 'nonsenseField', 'anotherBogus'] }, withUnknown)[0].text;
console.log('render 是否包含 unknownFields 的提示:', /nonsenseField|未知|unknown/i.test(rendered));
console.log('render 全文:\n' + rendered);

console.log('\n=== 5) warnings 分支（子对象读取失败）是否到达模型 ===');
const defRender = def.render({ ref: KEY }, {
  found: true, ref: KEY, resolvedBy: 'key', library: 'L', libraryKey: 'user',
  item: { key: KEY, itemType: 'journalArticle', title: 'T', tags: [], collections: [] },
  counts: {}, warnings: ['收藏夹映射失败：HTTP 500'],
})[0].text;
console.log('render 是否包含警告:', /警告/.test(defRender), '|', defRender.split('\n').filter((l) => l.includes('警告')).join(''));

console.log('\n=== 6) 同一工具结果被 render 多次调用是否幂等 ===');
const v = await enrichItem({ ref: KEY, library: GROUP });
const a = def.render({ ref: KEY }, v)[0].text;
const b = def.render({ ref: KEY }, v)[0].text;
console.log('幂等:', a === b);

console.log('\n===== 并发汇总 =====');
const all = [netConcurrency, zoteroConcurrency, mixed];
const total = all.reduce((n, r) => n + r.total, 0);
const ok = all.reduce((n, r) => n + r.ok, 0);
console.log(`并发请求 ${total} · 成功 ${ok} · 失败 ${total - ok}`);
process.exitCode = ok === total ? 0 : 1;
