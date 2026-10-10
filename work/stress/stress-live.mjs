/**
 * dsh-lit-full-search 真实链路压力测试（打真实 OpenAlex / S2 / 本地 Zotero）。
 *
 * 每个 case：调用 tool.execute(args) → 跑 DSH 双硬校验（lossless JSON + outputSchema）+ render 校验，
 * 并记录 render 文本长度（模型实际要吃的上下文体量）与耗时。
 *
 * 写入类工具（lit_to_zotero）**一律 dryRun:true**，不碰真实库。
 */
import { toolDefinitions } from '../../lib/tools.js';
import { checkToolCall } from '../../test-support/contract.js';

const byName = Object.fromEntries(toolDefinitions.map((d) => [d.name, d]));

const GROUP = 'group:6441110';
const KEY = 'J4XRRNA9'; // Cochran 2019, 在 2.Novel Targets > liqiud crystal target
const NO_ABS_KEY = 'FVV6IFBD'; // 个人库/群组库里的另一条（可能无摘要，用来说明 missing 分支）

/** @type {{tool:string,args:object,expect?:'ok'|'throw',note?:string}[]} */
const cases = [
  // ---- lit_search：limit 夹紧 / 年份 / 输入边界 ----
  { tool: 'lit_search', args: { query: 'liquid crystal target', limit: 1 }, note: 'limit=1 单源 1 条' },
  { tool: 'lit_search', args: { query: 'liquid crystal target', limit: 0 }, note: 'limit=0 → 夹到 1' },
  { tool: 'lit_search', args: { query: 'liquid crystal target', limit: -5 }, note: 'limit=-5 → 夹到 1' },
  { tool: 'lit_search', args: { query: 'liquid crystal target', limit: 2.5 }, note: 'limit=2.5 非整数 → 回落预算' },
  { tool: 'lit_search', args: { query: 'liquid crystal target', limit: 999 }, note: 'limit=999 → 夹到 25/预算' },
  { tool: 'lit_search', args: { query: 'laser ion acceleration', yearFrom: 2020 }, note: '仅 yearFrom' },
  { tool: 'lit_search', args: { query: 'laser ion acceleration', yearTo: 2015 }, note: '仅 yearTo' },
  { tool: 'lit_search', args: { query: 'liquid crystal target', yearFrom: 2020, yearTo: 2015 }, expect: 'throw', note: '年份倒挂 → 必须报错（不能静默空集）' },
  { tool: 'lit_search', args: { query: '   ' }, expect: 'throw', note: '空白 query → 必须报错' },
  { tool: 'lit_search', args: { query: 'zzzqqqxxyy nonsense 12345' }, note: '无结果' },
  { tool: 'lit_search', args: { query: 'crystal "target" AND (laser OR ion) -foo' }, note: '布尔/引号/特殊字符' },
  { tool: 'lit_search', args: { query: 'a'.repeat(400) }, note: '超长 query（400 字符）' },
  { tool: 'lit_search', args: { query: 'laser-driven ion acceleration 激光 靶' }, note: '中英混合' },

  // ---- lit_abstract ----
  { tool: 'lit_abstract', args: { doi: '10.1063/1.4885100' }, note: '裸 DOI' },
  { tool: 'lit_abstract', args: { doi: 'https://doi.org/10.1063/1.4885100' }, note: 'DOI URL 前缀' },
  { tool: 'lit_abstract', args: { doi: '10.1063/1.4885100'.toUpperCase() }, note: '大写 DOI' },
  { tool: 'lit_abstract', args: { doi: '10.9999/nonexistent.xyz.999' }, note: '不存在的 DOI → missing' },
  { tool: 'lit_abstract', args: { title: 'Liquid crystal films as on-demand, variable thickness' }, note: '仅标题' },
  { tool: 'lit_abstract', args: {}, expect: 'throw', note: '两者都缺 → 抛错' },

  // ---- lit_cited_by ----
  { tool: 'lit_cited_by', args: { identifier: '10.1063/1.4885100', limit: 3 }, note: 'DOI 作种子' },
  { tool: 'lit_cited_by', args: { identifier: 'W2075372708', limit: 2 }, note: 'OpenAlex work ID' },
  { tool: 'lit_cited_by', args: { identifier: 'w2075372708', limit: 2 }, note: '小写 work ID' },
  { tool: 'lit_cited_by', args: { identifier: '10.9999/nonexistent.xyz.999' }, expect: 'throw', note: '不存在的种子' },
  { tool: 'lit_cited_by', args: { identifier: '10.1063/1.4885100', limit: 0 }, note: 'limit=0 → 夹到 1' },

  // ---- zotero_search ----
  { tool: 'zotero_search', args: { query: 'liquid crystal', library: GROUP }, note: '群组库检索' },
  { tool: 'zotero_search', args: { query: 'liquid crystal', library: GROUP, qmode: 'titleCreatorYear' }, note: 'qmode 合法值' },
  { tool: 'zotero_search', args: { query: 'liquid crystal', library: GROUP, qmode: 'bogus' }, note: 'qmode 非法值（静默回落）' },
  { tool: 'zotero_search', args: { query: 'liquid crystal', library: GROUP, limit: 0 }, note: 'limit=0' },
  { tool: 'zotero_search', args: { query: 'liquid crystal', library: GROUP, limit: 999 }, note: 'limit=999' },
  { tool: 'zotero_search', args: { query: '液晶', library: GROUP }, note: 'CJK 检索' },
  { tool: 'zotero_search', args: { query: 'zzzqqqxxyy' }, note: '无结果' },
  { tool: 'zotero_search', args: { query: 'liquid crystal', library: "WENJUN_MA's Group" }, note: '按库名解析' },
  { tool: 'zotero_search', args: { query: 'liquid crystal', library: '6441110' }, note: '纯数字群组 id' },
  { tool: 'zotero_search', args: { query: 'x', library: 'No Such Library' }, expect: 'throw', note: '库不存在' },

  // ---- zotero_collections ----
  { tool: 'zotero_collections', args: {}, note: '只列库' },
  { tool: 'zotero_collections', args: { library: 'user' }, note: '个人库收藏夹' },
  { tool: 'zotero_collections', args: { library: GROUP, query: 'crystal' }, note: '群组库 + 过滤' },
  { tool: 'zotero_collections', args: { library: GROUP, query: 'zzz-nomatch' }, note: '过滤无命中' },
  { tool: 'zotero_collections', args: { library: 'No Such Library' }, expect: 'throw', note: '库不存在' },

  // ---- zotero_enrich ----
  { tool: 'zotero_enrich', args: { ref: KEY, library: GROUP }, note: 'key 命中' },
  { tool: 'zotero_enrich', args: { ref: '10.1063/1.5109683', library: GROUP }, note: 'DOI 命中' },
  { tool: 'zotero_enrich', args: { ref: `zotero://group/6441110/item/${KEY}` }, note: 'zotero:// 引用' },
  { tool: 'zotero_enrich', args: { ref: 'Modeling pulse-cleaning plasma mirrors', library: GROUP }, note: '标题命中' },
  { tool: 'zotero_enrich', args: { ref: KEY, library: GROUP, fields: [] }, note: 'fields=[] 仅标识' },
  { tool: 'zotero_enrich', args: { ref: KEY, library: GROUP, fields: ['creators', 'DOI'] }, note: 'fields 投影' },
  { tool: 'zotero_enrich', args: { ref: KEY, library: GROUP, fields: ['title', 'nonsenseField'] }, note: 'fields 含未知名' },
  { tool: 'zotero_enrich', args: { ref: KEY, library: GROUP, include: ['tags'] }, note: 'include=tags' },
  { tool: 'zotero_enrich', args: { ref: KEY, library: GROUP, include: ['notes', 'attachments'], paths: true }, note: '附件路径解析' },
  { tool: 'zotero_enrich', args: { ref: KEY, library: GROUP, include: ['fulltext'], maxChars: 500 }, note: '全文索引' },
  { tool: 'zotero_enrich', args: { ref: KEY, library: GROUP, maxChars: 200 }, note: 'maxChars 下界' },
  { tool: 'zotero_enrich', args: { ref: KEY, library: GROUP, maxChars: 20000 }, note: 'maxChars 上界' },
  { tool: 'zotero_enrich', args: { ref: KEY, library: GROUP, maxChars: 0 }, note: 'maxChars=0 → 夹到 200' },
  { tool: 'zotero_enrich', args: { ref: KEY, library: GROUP, maxChars: 'abc' }, note: 'maxChars 非数字' },
  { tool: 'zotero_enrich', args: { ref: 'NO-SUCH-ITEM-XYZ', library: GROUP }, note: '未命中 → found:false' },
  { tool: 'zotero_enrich', args: { ref: '', library: GROUP }, expect: 'throw', note: '空 ref' },

  // ---- zotero_abstract ----
  { tool: 'zotero_abstract', args: { ref: KEY, library: GROUP }, note: 'key 命中' },
  { tool: 'zotero_abstract', args: { ref: '10.1063/1.5109683', library: GROUP }, note: 'DOI 命中' },
  { tool: 'zotero_abstract', args: { ref: 'NO-SUCH-ITEM-XYZ', library: GROUP }, note: '未命中' },
  { tool: 'zotero_abstract', args: { ref: KEY, library: GROUP, maxChars: 0 }, note: 'maxChars=0 → 夹到 200' },
  { tool: 'zotero_abstract', args: { ref: KEY, library: GROUP, maxChars: 999999 }, note: 'maxChars 超上界' },

  // ---- lit_to_zotero（全部 dryRun，绝不写库）----
  { tool: 'lit_to_zotero', args: { refs: ['10.1063/1.4885100'], library: GROUP, collection: 'liqiud crystal target', dryRun: true }, note: '单 DOI 预演' },
  { tool: 'lit_to_zotero', args: { refs: ['Liquid crystal films as on-demand, variable thickness (50–5000 nm) targets for intense lasers'], library: GROUP, collection: 'liqiud crystal target', dryRun: true }, note: '标题预演' },
  {
    tool: 'lit_to_zotero',
    args: { refs: ['21. Poole, P. L., Andereck, C. D., & Schumacher, D. W. (2014). *Liquid crystal films as on-demand targets*. Applied Physics Letters, 104(19), 194102.'], library: GROUP, collection: 'liqiud crystal target', dryRun: true },
    note: '整行 APA 参考文献',
  },
  { tool: 'lit_to_zotero', args: { refs: ['10.1063/1.4885100'], library: GROUP, collection: 'liqiud crystal target', itemTypes: ['journalArticle'], dryRun: true }, note: 'itemTypes 白名单' },
  { tool: 'lit_to_zotero', args: { refs: ['10.1063/1.4885100'], library: GROUP, collection: 'liqiud crystal target', itemTypes: ['conferencePaper'], dryRun: true }, note: 'itemTypes 排除' },
  { tool: 'lit_to_zotero', args: { refs: ['10.9999/nonexistent.xyz.999', 'not a real reference at all'], library: GROUP, dryRun: true }, note: '解析失败的条目' },
  { tool: 'lit_to_zotero', args: { refs: [], library: GROUP }, expect: 'throw', note: '空 refs' },
  { tool: 'lit_to_zotero', args: { refs: ['10.1063/1.4885100'], library: 'No Such Library', dryRun: true }, expect: 'throw', note: '库不存在' },
  { tool: 'lit_to_zotero', args: { refs: ['10.1063/1.4885100'], library: GROUP, collection: 'zzz-nope', dryRun: true }, expect: 'throw', note: '收藏夹不存在' },
  { tool: 'lit_to_zotero', args: { refs: Array.from({ length: 201 }, (_, i) => `10.1000/x${i}`), dryRun: true }, expect: 'throw', note: '超过 200 条上限' },
];

const results = [];
console.log('tool'.padEnd(18), 'text chars'.padStart(10), 'ms'.padStart(7), '  verdict');
console.log('-'.repeat(100));

for (const c of cases) {
  const def = byName[c.tool];
  const started = Date.now();
  let value;
  let thrown = null;
  try {
    value = await def.execute(c.args);
  } catch (err) {
    thrown = err;
  }
  const ms = Date.now() - started;

  if (c.expect === 'throw') {
    const ok = thrown !== null;
    results.push({ ...c, ok, ms, thrown: thrown?.message ?? '' });
    console.log(c.tool.padEnd(18), ''.padStart(10), String(ms).padStart(7), ok ? ` OK 抛错：${thrown.message.slice(0, 60)}` : ' ❌ 期望抛错但成功返回');
    continue;
  }
  if (thrown) {
    results.push({ ...c, ok: false, ms, thrown: thrown.message });
    console.log(c.tool.padEnd(18), ''.padStart(10), String(ms).padStart(7), ` ❌ 意外抛错：${thrown.message.slice(0, 80)}`);
    continue;
  }
  const check = checkToolCall(def, c.args, value);
  results.push({ ...c, ok: check.ok, ms, textChars: check.textChars, failures: check.failures });
  const verdict = check.ok ? `OK${c.note ? ` · ${c.note}` : ''}` : `❌ ${check.failures.join(' | ')}`;
  console.log(c.tool.padEnd(18), String(check.textChars).padStart(10), String(ms).padStart(7), ` ${verdict}`);
}

const failed = results.filter((r) => !r.ok);
console.log('\n===== 汇总 =====');
console.log(`用例 ${results.length} · 通过 ${results.length - failed.length} · 失败 ${failed.length}`);
if (failed.length > 0) {
  console.log('\n失败明细：');
  for (const f of failed) console.log(`- ${f.tool} ${JSON.stringify(f.args).slice(0, 90)} → ${f.thrown ?? f.failures.join(' | ')}`);
}

const sizes = results.filter((r) => r.textChars).sort((a, b) => b.textChars - a.textChars);
console.log('\n渲染文本最大的 5 个用例（模型实际吃进去的字符数）：');
for (const s of sizes.slice(0, 5)) console.log(`- ${String(s.textChars).padStart(7)} 字  ${s.tool} ${JSON.stringify(s.args).slice(0, 70)}`);
const slow = [...results].sort((a, b) => b.ms - a.ms).slice(0, 5);
console.log('\n最慢的 5 个用例：');
for (const s of slow) console.log(`- ${String(s.ms).padStart(6)} ms  ${s.tool} ${JSON.stringify(s.args).slice(0, 70)}`);

process.exitCode = failed.length > 0 ? 1 : 0;
