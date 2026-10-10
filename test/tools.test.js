import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

import { toolDefinitions, compileParams, wrapToolError, mergeSearchResults, LIMIT_CAP, sourceFailureNote } from '../lib/tools.js';
import { __setS2IntervalForTest } from '../lib/light-core.js';

// 关掉 S2 节流与 429 退避，避免拖慢套件（节流行为在 light-core.test.js 单独测）。
__setS2IntervalForTest(0);

test('sourceFailureNote：只在有源失败时输出警告，并带上错误信息', () => {
  assert.equal(sourceFailureNote(undefined), '');
  assert.equal(sourceFailureNote({ openalex: { ok: true }, semanticscholar: { ok: true } }), '');
  const note = sourceFailureNote({ openalex: { ok: true }, semanticscholar: { ok: false, error: 'HTTP 429 Too Many Requests' } });
  assert.match(note, /Semantic Scholar（HTTP 429 Too Many Requests）/);
  assert.doesNotMatch(note, /OpenAlex/);
});

test('lit_search render：S2 失败时在模型可见文本里给出警告', () => {
  const value = {
    items: [{ title: 'T', authors: ['A'], year: 2020, doi: '', source: 'openalex', url: 'u' }],
    diagnostics: { openalex: { ok: true, count: 1 }, semanticscholar: { ok: false, error: 'HTTP 429' } },
  };
  const text = toolDefinitions.find((d) => d.name === 'lit_search').render({ query: 'q' }, value)[0].text;
  assert.match(text, /⚠ 以下数据源本次失败.*Semantic Scholar（HTTP 429）/);
});

// 工具测试环境隔离：DSH_HOME 指向临时目录，保证 loadConfig 落到默认预算（不读真实用户配置）。
const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'lfs-tools-'));
const prevHome = process.env.DSH_HOME;
process.env.DSH_HOME = tmpHome;

test.after(() => {
  if (prevHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = prevHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

/** 记录请求并返回预置响应的全局 fetch 替身。 */
function stubFetch(respond) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const body = typeof respond === 'function' ? respond(calls.length - 1, String(url), init) : respond;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => (body === null ? '' : JSON.stringify(body)),
    };
  };
  return calls;
}

test.afterEach(() => {
  delete globalThis.fetch;
});

test('toolDefinitions：8 个全局工具，名字与规格一致', () => {
  assert.deepEqual(
    toolDefinitions.map((d) => d.name),
    ['lit_search', 'lit_abstract', 'lit_cited_by', 'zotero_search', 'zotero_collections', 'lit_to_zotero', 'zotero_enrich', 'zotero_abstract']
  );
  for (const def of toolDefinitions) {
    assert.equal(typeof def.execute, 'function', `${def.name} execute`);
    assert.equal(typeof def.render, 'function', `${def.name} render`);
    assert.equal(typeof def.presentationMeta, 'function', `${def.name} presentationMeta`);
    // outputSchema 根 object 必须显式 additionalProperties:false（DSH JSON Schema 子集要求）
    assert.equal(def.outputSchema.type, 'object');
    assert.equal(def.outputSchema.additionalProperties, false, `${def.name} outputSchema.additionalProperties`);
  }
});

test('zotero_enrich 的 fields 投影与 zotero_abstract 的窄输出（render 冒烟）', () => {
  const enrich = toolDefinitions.find((d) => d.name === 'zotero_enrich');
  const abs = toolDefinitions.find((d) => d.name === 'zotero_abstract');
  assert.ok(enrich && abs);
  assert.equal(abs.parameters.ref.required, true);
  assert.deepEqual(compileParams(abs.parameters).required, ['ref']);
  assert.equal('fields' in abs.parameters, false, '窄工具不暴露字段投影');

  // 投影：只要 abstractNote → render 只有标题行 + 摘要行
  const item = {
    key: 'K1',
    itemType: 'journalArticle',
    title: 'Paper A',
    date: '2019',
    DOI: '10.1/a',
    abstractNote: 'Abstract body.',
  };
  const only = enrich.render({ ref: 'K1', fields: ['abstractNote'] }, { found: true, ref: 'K1', resolvedBy: 'key', library: 'L', libraryKey: 'user', item, counts: { notes: 0, attachments: 0, annotations: 0, fulltext: 0 } });
  const text = only[0].text;
  assert.match(text, /Paper A/);
  assert.match(text, /Abstract body\./);
  assert.ok(!text.includes('作者：'), '未请求 creators 不应出现作者行');
  assert.ok(!text.includes('来源：'), '未请求 publicationTitle 不应出现来源行');
  assert.ok(!text.includes('DOI:'), '未请求 DOI 不应出现 DOI 行');

  // 省略 fields → 保持既有输出
  const full = enrich.render({}, { found: true, ref: 'K1', resolvedBy: 'key', library: 'L', libraryKey: 'user', item: { ...item, creators: [{ firstName: 'A', lastName: 'B' }], publicationTitle: 'Sci Rep' }, counts: {} });
  assert.match(full[0].text, /作者：A B/);
  assert.match(full[0].text, /来源：Sci Rep · 2019/);
  assert.match(full[0].text, /DOI: 10\.1\/a/);

  // zotero_abstract：命中 / 本地无摘要 / 未命中
  const hit = abs.render({}, { found: true, ref: 'K1', library: 'L', libraryKey: 'user', key: 'K1', title: 'Paper A', DOI: '10.1/a', abstractNote: 'Abstract body.', chars: 14, truncated: false });
  assert.equal(hit[0].text.split('\n').length, 2, '命中时只有出处 + 摘要两行');
  assert.match(hit[0].text, /Paper A（K1 · L · 10\.1\/a）/);
  const empty = abs.render({}, { found: true, ref: 'K1', library: 'L', libraryKey: 'user', key: 'K1', title: 'Paper A', DOI: '', abstractNote: '', chars: 0, truncated: false });
  assert.match(empty[0].text, /abstractNote 为空/);
  assert.match(empty[0].text, /lit_abstract/);
  const miss = abs.render({ ref: 'NOPE' }, { found: false, ref: 'NOPE', library: 'L', libraryKey: 'user', hint: 'hint' });
  assert.match(miss[0].text, /未在「L」/);
});

test('新增工具：zotero_collections / lit_to_zotero 的参数 schema 与 render 冒烟', () => {
  const cols = toolDefinitions.find((d) => d.name === 'zotero_collections');
  const imp = toolDefinitions.find((d) => d.name === 'lit_to_zotero');
  assert.ok(cols, 'zotero_collections 已注册');
  assert.ok(imp, 'lit_to_zotero 已注册');

  assert.equal(imp.parameters.refs.type, 'array');
  assert.equal(imp.parameters.refs.required, true);
  const schema = compileParams(imp.parameters);
  assert.deepEqual(schema.required, ['refs']);
  assert.equal('additionalProperties' in schema, false);
  assert.equal(schema.properties.refs.items.type, 'string');
  const colsSchema = compileParams(cols.parameters);
  assert.equal('required' in colsSchema, false, 'zotero_collections 参数全可选');

  const libList = cols.render({}, { libraries: [{ name: '我的文库', libraryKey: 'user', type: 'user' }], library: '', collections: [] });
  assert.match(libList[0].text, /Zotero 库/);
  const colList = cols.render(
    { library: 'LDIA library' },
    { libraries: [], library: 'LDIA library', libraryKey: 'group:6646099', collectionCount: 1, collections: [{ key: 'K', name: 'liquid crystal target for LIA', path: 'liquid crystal target for LIA', itemCount: 18 }] }
  );
  assert.match(colList[0].text, /liquid crystal target for LIA/);
  assert.match(colList[0].text, /18 条/);

  const dryText = imp.render({}, {
    dryRun: true,
    library: 'L',
    collection: 'C',
    counts: { created: 2, added: 1, exists: 3, skipped: 0, failed: 0 },
    items: [{ n: 21, action: 'created', title: 'T', itemKey: '' }],
    collectionSizeBefore: 31,
  })[0].text;
  assert.match(dryText, /导入预演/);
  assert.match(dryText, /新建 2 · 加挂 1 · 已存在 3/);
});

test('compileParams：作者 DSL → DSH 参数 schema（required 收集到根，无 additionalProperties）', () => {
  const schema = compileParams({
    query: { type: 'string', required: true, description: 'q' },
    limit: { type: 'integer', description: 'l' },
  });
  assert.deepEqual(schema, {
    type: 'object',
    properties: { query: { type: 'string', description: 'q' }, limit: { type: 'integer', description: 'l' } },
    required: ['query'],
  });
  assert.equal('additionalProperties' in schema, false);
});

test('wrapToolError：带工具名与 cause 的 Error（必须 throw 而非 isError 信封）', () => {
  const err = wrapToolError('lit_search', new Error('boom'));
  assert.equal(err.message, 'lit_search 执行失败：boom');
  assert.equal(err.cause.message, 'boom');
  const str = wrapToolError('lit_to_zotero', 'naked-string');
  assert.equal(str.message, 'lit_to_zotero 执行失败：naked-string');
});

test('lit_search：无参数时用预算默认，limit 被预算夹紧', async () => {
  const calls = stubFetch({ results: [] });
  const def = toolDefinitions.find((d) => d.name === 'lit_search');
  const res = await def.execute({ query: 'plasma' });
  let url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('per_page'), '10'); // 默认预算 searchLimit=10
  assert.equal(res.items.length, 0);
  assert.equal(res.diagnostics.openalex.ok, true);
  // limit=100 → 先夹到 25 再 min(预算 10)
  await def.execute({ query: 'x', limit: 100 });
  url = new URL(calls[1].url);
  assert.equal(url.searchParams.get('per_page'), '10');
  // yearFrom/yearTo → filter
  await def.execute({ query: 'x', yearFrom: 2020, yearTo: 2022 });
  url = new URL(calls[2].url);
  assert.equal(url.searchParams.get('filter'), 'publication_year:>2019,publication_year:<2023');
});

test('lit_search：OpenAlex key（环境/面板）真的进入请求 URL 的 api_key', async () => {
  const prev = process.env.LIT_SEARCH_OPENALEX_API_KEY;
  process.env.LIT_SEARCH_OPENALEX_API_KEY = 'TEST-OA-KEY';
  try {
    const calls = stubFetch({ results: [] });
    const def = toolDefinitions.find((d) => d.name === 'lit_search');
    await def.execute({ query: 'key-carried' });
    assert.ok(calls[0].url.includes('api_key=TEST-OA-KEY'), `请求未带 api_key：${calls[0].url}`);
  } finally {
    if (prev === undefined) delete process.env.LIT_SEARCH_OPENALEX_API_KEY;
    else process.env.LIT_SEARCH_OPENALEX_API_KEY = prev;
  }
});

test('lit_search：结果必须可无损 JSON 往返（模拟 DSH lossless 校验），且不含 abstract 键', async () => {
  const calls = stubFetch({
    results: [mapOpenAlexWorkShim({ title: 'Liquid Crystal', abstract: 'laser driven ion acceleration', doi: '10.1/lc' })],
  });
  const def = toolDefinitions.find((d) => d.name === 'lit_search');
  const res = await def.execute({ query: 'liquid crystal' });
  assert.equal(calls.length, 1);
  // abstract 必须整体剔除，绝不能是 undefined 值（undefined 会被 JSON.stringify 丢弃 → 往返不等）
  assert.ok(!('abstract' in res.items[0]), 'toTrimmedResult 应剔除 abstract 键');
  // lossless 往返：JSON.stringify → JSON.parse 后与原值深等
  assert.deepEqual(JSON.parse(JSON.stringify(res)), res);
});

test('mergeSearchResults：DOI 去重 + 交叉排序（OpenAlex 在前），不设合并总量上限', () => {
  const oa = {
    items: [
      { title: 'A', doi: '10.1/a', source: 'openalex' },
      { title: 'B', doi: '10.1/b', source: 'openalex' },
      { title: 'C', doi: '', year: 2020, source: 'openalex' },
    ],
    diagnostics: { openalex: { ok: true, count: 3 } },
  };
  const s2 = {
    items: [
      { title: 'A-s2-dup', doi: '10.1/A', source: 'semanticscholar' }, // DOI 大小写不敏感去重
      { title: 'D', doi: '10.1/d', source: 'semanticscholar' },
      { title: 'c', doi: '', year: 2020, source: 'semanticscholar' }, // 标题+年份去重（小写化）
    ],
    diagnostics: { semanticscholar: { ok: true, count: 3 } },
  };
  const merged = mergeSearchResults(oa, s2);
  assert.deepEqual(merged.items.map((i) => i.title), ['A', 'B', 'D', 'C']); // 去重项仍占槽位：round1 A/dup → round2 B/D → round3 C
  assert.equal(merged.diagnostics.openalex.ok, true);
  assert.equal(merged.diagnostics.semanticscholar.ok, true);
  // 不设合并总量上限：两源各 LIMIT_CAP 条 → 合并后 2×LIMIT_CAP 条
  const bigOa = {
    items: Array.from({ length: LIMIT_CAP }, (_, i) => ({ title: `OA${i}`, doi: `10.9/${i}` })),
    diagnostics: {},
  };
  const bigS2 = {
    items: Array.from({ length: LIMIT_CAP }, (_, i) => ({ title: `S2-${i}`, doi: `10.8/${i}` })),
    diagnostics: {},
  };
  const mergedBig = mergeSearchResults(bigOa, bigS2);
  assert.equal(mergedBig.items.length, LIMIT_CAP * 2);
  assert.deepEqual(mergedBig.items.slice(0, 2).map((i) => i.title), ['OA0', 'S2-0']); // 仍是交叉排序
});

test('lit_search：配置 S2 密钥后双源检索，按 DOI 去重合并', async () => {
  const prevS2 = process.env.LIT_SEARCH_S2_API_KEY;
  process.env.LIT_SEARCH_S2_API_KEY = 'TEST-S2-KEY';
  try {
    const calls = stubFetch((_i, url) => {
      if (url.includes('semanticscholar.org')) {
        return { data: [{ paperId: 'P1', title: 'OA Title S2 副本', externalIds: { DOI: '10.1/dup' } }, { paperId: 'P2', title: 'S2 Only', externalIds: {} }] };
      }
      return { results: [mapOpenAlexWorkShim({ title: 'OA Title', abstract: 'a b', doi: '10.1/dup' })] };
    });
    const def = toolDefinitions.find((d) => d.name === 'lit_search');
    const res = await def.execute({ query: 'dual' });
    assert.equal(calls.length, 2); // OpenAlex + S2 各一次
    assert.ok(calls.some((c) => c.url.includes('semanticscholar.org')));
    const titles = res.items.map((i) => i.title);
    assert.deepEqual(titles, ['OA Title', 'S2 Only']); // DOI 重复项去重，OpenAlex 优先
    assert.equal(res.items[1].source, 'semanticscholar');
    assert.equal(res.diagnostics.semanticscholar.ok, true);
  } finally {
    if (prevS2 === undefined) delete process.env.LIT_SEARCH_S2_API_KEY;
    else process.env.LIT_SEARCH_S2_API_KEY = prevS2;
  }
});

test('lit_search：limit 是单源上限（limit=2 → 双源各 2 条，合计 4 条）', async () => {
  const prevS2 = process.env.LIT_SEARCH_S2_API_KEY;
  process.env.LIT_SEARCH_S2_API_KEY = 'TEST-S2-KEY';
  try {
    const calls = stubFetch((_i, url) => {
      if (url.includes('semanticscholar.org')) {
        return {
          data: [
            { paperId: 'S1', title: 'S2 A', externalIds: { DOI: '10.5/a' } },
            { paperId: 'S2', title: 'S2 B', externalIds: { DOI: '10.5/b' } },
          ],
        };
      }
      return { results: [mapOpenAlexWorkShim({ title: 'OA A', abstract: '', doi: '10.4/a' }), mapOpenAlexWorkShim({ title: 'OA B', abstract: '', doi: '10.4/b' })] };
    });
    const def = toolDefinitions.find((d) => d.name === 'lit_search');
    const res = await def.execute({ query: 'per-source', limit: 2 });
    assert.equal(calls.length, 2);
    assert.ok(calls.every((c) => /per_page=2|limit=2/.test(c.url)), '两个源各按单源上限请求 2 条');
    assert.equal(res.items.length, 4); // 合计 = 2 × limit，没有任何总量夹紧
  } finally {
    if (prevS2 === undefined) delete process.env.LIT_SEARCH_S2_API_KEY;
    else process.env.LIT_SEARCH_S2_API_KEY = prevS2;
  }
});

test('lit_search：无 S2 密钥时只走 OpenAlex（单源，兼容旧行为）', async () => {
  const prevS2 = process.env.LIT_SEARCH_S2_API_KEY;
  delete process.env.LIT_SEARCH_S2_API_KEY;
  try {
    const calls = stubFetch({ results: [] });
    const def = toolDefinitions.find((d) => d.name === 'lit_search');
    await def.execute({ query: 'single' });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('openalex.org'));
  } finally {
    if (prevS2 !== undefined) process.env.LIT_SEARCH_S2_API_KEY = prevS2;
  }
});

test('lit_search：S2 失败不拖垮 OpenAlex（记入 diagnostics），双源均失败才抛错', async () => {
  const prevS2 = process.env.LIT_SEARCH_S2_API_KEY;
  process.env.LIT_SEARCH_S2_API_KEY = 'TEST-S2-KEY';
  const realFetch = globalThis.fetch;
  try {
    // S2 401，OpenAlex 正常
    globalThis.fetch = async (url) => {
      if (String(url).includes('semanticscholar.org')) {
        return { ok: false, status: 401, statusText: 'Unauthorized', text: async () => 'bad key' };
      }
      return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ results: [mapOpenAlexWorkShim({ title: 'OA', abstract: 'a', doi: '' })] }) };
    };
    const def = toolDefinitions.find((d) => d.name === 'lit_search');
    const res = await def.execute({ query: 'degraded' });
    assert.equal(res.items.length, 1);
    assert.equal(res.diagnostics.semanticscholar.ok, false);
    assert.match(res.diagnostics.semanticscholar.error, /401/);
    // 双源均失败 → 抛错（由 index.js wrapToolError 包装）
    globalThis.fetch = async () => ({ ok: false, status: 500, statusText: 'Server Error', text: async () => '' });
    await assert.rejects(() => def.execute({ query: 'boom' }), /均失败/);
  } finally {
    globalThis.fetch = realFetch;
    if (prevS2 === undefined) delete process.env.LIT_SEARCH_S2_API_KEY;
    else process.env.LIT_SEARCH_S2_API_KEY = prevS2;
  }
});

test('lit_search render：空结果分支不崩', () => {
  const def = toolDefinitions.find((d) => d.name === 'lit_search');
  const blocks = def.render({ query: 'nothing' }, { items: [], diagnostics: {} });
  assert.match(blocks[0].text, /未找到/);
  const blocks2 = def.render({ query: 'q' }, undefined);
  assert.match(blocks2[0].text, /未找到/);
});

test('lit_abstract：缺参抛错、miss 返回 missing、命中裁剪摘要', async () => {
  const def = toolDefinitions.find((d) => d.name === 'lit_abstract');
  await assert.rejects(() => def.execute({}), /必须提供 doi 或 title 之一/);

  // 无 work → missing
  stubFetch({ results: [] });
  const miss = await def.execute({ title: 'ghost' });
  assert.equal(miss.status, 'missing');
  assert.equal(miss.abstract, '');

  // 命中 → abstract 裁剪到预算 abstractChars（默认 2000），且 execute 透出摘要供 agent 阅读
  stubFetch({
    results: [
      mapOpenAlexWorkShim({
        title: 'T',
        abstract: 'x'.repeat(5000),
      }),
    ],
  });
  const hit = await def.execute({ title: 'T' });
  assert.equal(hit.status, 'complete');
  assert.equal(hit.abstract.length, 2000);
});

/** 造一个带 abstract_inverted_index 的 work JSON。 */
function mapOpenAlexWorkShim({ title, abstract, doi }) {
  const index = {};
  abstract.split(' ').forEach((w, i) => {
    (index[w] = index[w] || []).push(i);
  });
  return { id: 'W1', display_name: title, abstract_inverted_index: index, ...(doi ? { doi: `https://doi.org/${doi}` } : {}) };
}

test('lit_cited_by：identifier 必填、limit 夹紧', async () => {
  const def = toolDefinitions.find((d) => d.name === 'lit_cited_by');
  const calls = stubFetch({ results: [] });
  await def.execute({ identifier: 'W123' });
  assert.equal(new URL(calls[0].url).searchParams.get('per_page'), '25'); // 默认预算 citedByLimit=25
  await def.execute({ identifier: 'W123', limit: 100 });
  assert.equal(new URL(calls[1].url).searchParams.get('per_page'), '25'); // min(25, 25)
});

test('zotero_search：limit 夹紧到预算', async () => {
  const def = toolDefinitions.find((d) => d.name === 'zotero_search');
  const calls = stubFetch([]);
  const res = await def.execute({ query: 'protein' });
  assert.equal(new URL(calls[0].url).searchParams.get('limit'), '20'); // 默认预算 zoteroLimit=20
  assert.deepEqual(res, { items: [] });
});

test('zotero_search render：库/条目列表不崩', () => {
  const def = toolDefinitions.find((d) => d.name === 'zotero_search');
  const blocks = def.render({ query: 'x' }, { items: [] });
  assert.match(blocks[0].text, /未找到/);
});