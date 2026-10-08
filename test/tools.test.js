import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

import { toolDefinitions, compileParams, wrapToolError } from '../lib/tools.js';

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

test('toolDefinitions：5 个全局工具，名字与规格一致', () => {
  assert.deepEqual(
    toolDefinitions.map((d) => d.name),
    ['lit_search', 'lit_abstract', 'lit_cited_by', 'zotero_search', 'zotero_save']
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
  const str = wrapToolError('zotero_save', 'naked-string');
  assert.equal(str.message, 'zotero_save 执行失败：naked-string');
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

test('zotero_save：查重命中 exists / 未命中 created / 无法解析抛错', async () => {
  const def = toolDefinitions.find((d) => d.name === 'zotero_save');

  // 已存在 → exists（幂等，不再建条目）
  let seq = 0;
  stubFetch(() => {
    seq += 1;
    // 第 1 次调用 = lookupOpenAlexByDoi（work）
    // 第 2 次调用 = zoteroFindByDoi（命中 K1）
    if (seq === 1) return mapOpenAlexWorkShim({ title: 'Paper', abstract: 'a b c', doi: '10.1/paper' });
    return [
      { key: 'K1', data: { itemType: 'journalArticle', title: 'Paper', creators: [], date: '', DOI: '10.1/paper', url: '' } },
    ];
  });
  const exists = await def.execute({ doi: '10.1/paper' });
  assert.equal(exists.outcome, 'exists');
  assert.equal(exists.itemKey, 'K1');
  assert.equal(seq, 2); // 没有第 3 次（未建条目）

  // 未命中 → created
  seq = 0;
  stubFetch(() => {
    seq += 1;
    if (seq === 1) return mapOpenAlexWorkShim({ title: 'New Paper', abstract: 'x y z', doi: '10.1/new' });
    if (seq === 2) return []; // zoteroFindByDoi 未命中
    return { successful: { '0': { key: 'NEWK1' } } }; // zoteroCreateItem 成功
  });
  const created = await def.execute({ doi: '10.1/new' });
  assert.equal(created.outcome, 'created');
  assert.equal(created.itemKey, 'NEWK1');
});

test('zotero_save render：按 outcome 给出中文状态', () => {
  const def = toolDefinitions.find((d) => d.name === 'zotero_save');
  const blocks = def.render({}, { outcome: 'created', itemKey: 'A1', title: 'T', doi: 'd' });
  assert.match(blocks[0].text, /已创建/);
  const blocks2 = def.render({}, { outcome: 'exists', itemKey: 'A2', title: 'T2' });
  assert.match(blocks2[0].text, /已存在/);
  // render 空值不崩（outcome 缺省 → 回落「完成」）
  const blocks3 = def.render({}, {});
  assert.match(blocks3[0].text, /完成/);
});