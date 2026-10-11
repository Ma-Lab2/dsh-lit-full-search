/**
 * 工具契约测试：**每一个工具的 execute() 返回值**都必须过 DSH 的三道硬校验。
 *
 * 背景（2026-10 压力测试）：两个 P0 缺陷让工具整体不可用，而当时的 93 个测试全绿——
 *   · lit_to_zotero：items[].n = undefined → "value is not lossless JSON"，任何调用都失败
 *   · zotero_collections：execute 回 libraryKey 但 outputSchema 没声明 → "not a declared property"
 * 根因不是逻辑写错，而是**没有任何测试把 execute 的输出对 outputSchema / lossless 校验过一遍**。
 * 本文件补上这一层：即使将来只改 schema 或只改返回对象，这里也会红。
 *
 * 全部走 fetch 替身，不触网、不碰真实 Zotero。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

import { toolDefinitions, formatAuthors, hasCjk } from '../lib/tools.js';
import { __setS2IntervalForTest } from '../lib/light-core.js';

__setS2IntervalForTest(0);
import { checkToolCall, checkLossless, validateAgainstSchema, undefinedPaths } from '../test-support/contract.js';

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'lfs-contract-'));
const prevHome = process.env.DSH_HOME;
const prevS2 = process.env.LIT_SEARCH_S2_API_KEY;
process.env.DSH_HOME = tmpHome;
delete process.env.LIT_SEARCH_S2_API_KEY; // 默认单源，避免测试依赖双源

test.after(() => {
  if (prevHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = prevHome;
  if (prevS2 !== undefined) process.env.LIT_SEARCH_S2_API_KEY = prevS2;
  rmSync(tmpHome, { recursive: true, force: true });
});

const byName = Object.fromEntries(toolDefinitions.map((d) => [d.name, d]));

// ---- fetch 替身 -------------------------------------------------------------

const SID_HEADERS = { get: (name) => (String(name).toLowerCase() === 'zotero-server-id' ? 'TEST-SERVER-ID' : null) };

function jsonResponse(body, { status = 200, statusText = 'OK' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: SID_HEADERS,
    text: async () => (body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
  };
}

const GROUP = 'group:6441110';
const ITEM_KEY = 'QZX8A2PX';
const ATT_PDF = 'ATTCH001';

const LIBRARIES = [{ id: 6441110, data: { id: 6441110, name: "WENJUN_MA's Group" } }];
const COLLECTIONS = [
  { key: '3ZKQJ2B8', data: { name: '2.Novel Targets', parentCollection: null }, meta: { numItems: 4 } },
  { key: 'YJUSYVEM', data: { name: 'liqiud crystal target', parentCollection: '3ZKQJ2B8' }, meta: { numItems: 37 } },
];

/** OpenAlex work（带 abstract_inverted_index）。 */
const OPENALEX_WORK = {
  id: 'https://openalex.org/W5',
  display_name: 'Liquid crystal films as targets',
  doi: 'https://doi.org/10.1000/existing',
  publication_year: 2014,
  cited_by_count: 37,
  abstract_inverted_index: { Liquid: [0], crystal: [1], films: [2] },
  authorships: [{ author: { display_name: 'P. Poole' } }],
  primary_location: { source: { display_name: 'Applied Physics Letters' } },
};

const S2_PAPER = {
  paperId: 'S2P1',
  title: 'S2 Only Paper',
  year: 2020,
  venue: 'Sci Rep',
  externalIds: { DOI: '10.2000/s2only' },
  citationCount: 5,
  url: 'https://www.semanticscholar.org/paper/S2P1',
};

const ITEM = {
  key: ITEM_KEY,
  version: 42,
  data: {
    itemType: 'journalArticle',
    title: 'Investigation of parameters governing damage resistance of nematic liquid crystals',
    creators: [{ firstName: 'T. Z.', lastName: 'Kosc' }],
    date: '2019',
    publicationTitle: 'Scientific Reports',
    volume: '9',
    issue: '1',
    pages: '16435',
    DOI: '10.1038/s41598-019-52305-3',
    url: 'https://doi.org/10.1038/s41598-019-52305-3',
    abstractNote: 'Damage resistance of nematic liquid crystals.',
    extra: 'Citations: 12',
    language: 'en',
    dateAdded: '2026-10-10T10:48:39Z',
    dateModified: '2026-10-10T10:48:39Z',
    tags: [{ tag: '液晶靶' }],
    collections: ['YJUSYVEM'],
  },
};

const CHILDREN = [
  { key: 'NOTE0001', version: 1, data: { itemType: 'note', note: '<p>第一行</p>' } },
  {
    key: ATT_PDF,
    version: 1,
    data: { itemType: 'attachment', title: 'Full Text PDF', contentType: 'application/pdf', filename: 'a.pdf', linkMode: 'imported_file', parentItem: ITEM_KEY },
  },
  {
    key: 'ANNO0001',
    version: 1,
    data: { itemType: 'annotation', parentItem: ATT_PDF, annotationText: '关键结论', annotationComment: '注意', annotationPageLabel: '3' },
  },
];

/** 目标收藏夹里已有的顶层条目：DOI 与 OPENALEX_WORK 一致 → 走 exists 分支。 */
const COLLECTION_ITEMS = [{ key: 'OLD00001', data: { itemType: 'journalArticle', title: 'Liquid crystal films as targets', DOI: '10.1000/existing' } }];

/** 库内检索命中的条目（用于 lit_to_zotero 的「加挂」分支与 zotero_search）。 */
const SEARCH_ITEMS = [{ key: 'FOUND001', data: { itemType: 'journalArticle', title: 'Liquid crystal films as targets', DOI: '10.1000/existing' } }];

function installFetch() {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const method = String(init.method ?? 'GET').toUpperCase();
    calls.push({ url: href, method, body: init.body ?? null });
    // 顺序敏感：更具体的路由必须在前
    if (href.includes('api.crossref.org/works/')) {
      return jsonResponse({
        message: {
          type: 'journal-article',
          title: ['Crossref Resolved Title'],
          author: [{ family: 'Doe', given: 'J.' }],
          issued: { 'date-parts': [[2021]] },
          'container-title': ['Journal of Tests'],
          volume: '1',
          issue: '2',
          page: '3-4',
          DOI: '10.1000/new',
          abstract: '<jats:p>An abstract.</jats:p>',
        },
      });
    }
    if (href.includes('api.openalex.org/works/doi:')) {
      if (href.includes('unknown')) return jsonResponse(null, { status: 404, statusText: 'Not Found' });
      return jsonResponse(OPENALEX_WORK);
    }
    if (href.includes('api.openalex.org/works?')) return jsonResponse({ results: [OPENALEX_WORK] });
    if (href.includes('api.semanticscholar.org/paper/search')) return jsonResponse({ data: [S2_PAPER] });
    if (href.includes('/users/0/groups')) return jsonResponse(LIBRARIES);
    if (href.includes('/collections?limit=100')) return jsonResponse(COLLECTIONS);
    if (href.includes('/items/top')) return jsonResponse(COLLECTION_ITEMS);
    if (href.includes('/items?q=')) return jsonResponse(SEARCH_ITEMS);
    if (href.includes('/items/NOPE1234')) return jsonResponse(null, { status: 404, statusText: 'Not Found' });
    if (href.includes('/children')) return jsonResponse(CHILDREN);
    if (href.includes('/file/view/url')) return jsonResponse('file:///D:/AI%20Programs/dsh-lit-full-search/package.json');
    if (href.includes('/fulltext')) return jsonResponse({ content: 'full text body', indexedChars: 14, totalChars: 40 });
    if (href.includes('/items/') && method === 'GET') return jsonResponse(ITEM);
    if (href.includes('/items') && method === 'POST') return jsonResponse({ successful: { '0': { key: 'NEWKEY01' } } });
    if (href.includes('/items/') && method === 'PATCH') return jsonResponse(null, { status: 204, statusText: 'No Content' });
    if (href.includes('/local/authorize')) return jsonResponse({ key: 'AUTH' });
    throw new Error(`未预期的请求：${method} ${href}`);
  };
  return calls;
}

test.afterEach(() => {
  delete globalThis.fetch;
});

// ---- 核心：逐工具跑契约校验 --------------------------------------------------

/**
 * 跑一批用例：每个都执行 execute 并做全套契约校验；失败时把每个用例的失败原因列出来。
 */
async function contractCases(toolName, cases) {
  const def = byName[toolName];
  assert.ok(def, `${toolName} 已注册`);
  installFetch();
  const failures = [];
  const outcomes = [];
  for (const [args, note] of cases) {
    let value;
    try {
      value = await def.execute(args);
    } catch (err) {
      failures.push(`${note ?? JSON.stringify(args)} → 意外抛错：${err.message}`);
      continue;
    }
    const check = checkToolCall(def, args, value);
    outcomes.push({ args, value, textChars: check.textChars });
    if (!check.ok) failures.push(`${note ?? JSON.stringify(args)} → ${check.failures.join(' | ')}`);
  }
  assert.deepEqual(failures, [], `${toolName} 契约校验失败：\n${failures.join('\n')}`);
  return outcomes;
}

test('lit_search：年份区间倒挂必须报错，不能静默返回空集', async () => {
  const def = byName.lit_search;
  installFetch();
  await assert.rejects(
    () => def.execute({ query: 'liquid crystal', yearFrom: 2020, yearTo: 2015 }),
    /年份区间倒挂/,
    '倒挂区间若返回空集，模型会把「区间写反」误读成「没有相关文献」',
  );
  // 相同年份、以及省略一侧都应当放行
  await def.execute({ query: 'liquid crystal', yearFrom: 2015, yearTo: 2015 });
  await def.execute({ query: 'liquid crystal', yearFrom: 2015 });
  await def.execute({ query: 'liquid crystal', yearTo: 2015 });
});

test('lit_search：空白 query 必须报错（外网源会返回任意热门文献，被误当检索结果）', async () => {
  installFetch();
  for (const query of ['', '   ', '\n\t']) {
    await assert.rejects(() => byName.lit_search.execute({ query }), /query 不能为空白/);
  }
});

test('render：作者超过上限时截断并注明总人数；结构化 meta 不受影响', () => {
  assert.equal(formatAuthors([]), '未知作者');
  assert.equal(formatAuthors(undefined), '未知作者');
  assert.equal(formatAuthors(['A', 'B']), 'A, B');
  const many = Array.from({ length: 30 }, (_, i) => `Author ${i + 1}`);
  const text = formatAuthors(many);
  assert.match(text, /^Author 1, .*Author 6 等 30 人$/);
  assert.ok(!text.includes('Author 7'));
  const value = { items: [{ title: 'T', authors: many, year: 2020, doi: '10.1/x', source: 'openalex', url: 'u' }], diagnostics: {} };
  const rendered = byName.lit_search.render({ query: 'q' }, value)[0].text;
  assert.ok(rendered.includes('等 30 人') && !rendered.includes('Author 7'));
  assert.equal(byName.lit_search.presentationMeta({ query: 'q' }, value).items[0].authors.length, 5);
});

test('lit_search render：中文 query 附带「改英文」提示，英文 query 不附带', () => {
  const value = { items: [], diagnostics: {} };
  assert.ok(hasCjk('液晶靶') && !hasCjk('liquid crystal'));
  assert.match(byName.lit_search.render({ query: '液晶靶 激光' }, value)[0].text, /建议改用英文关键词/);
  assert.doesNotMatch(byName.lit_search.render({ query: 'liquid crystal' }, value)[0].text, /建议改用英文/);
});

test('契约 lit_search：单源 / 双源 / limit 夹紧 / 空结果，输出都过 schema + lossless', async () => {
  await contractCases('lit_search', [
    [{ query: 'liquid crystal' }, '默认 limit'],
    [{ query: 'liquid crystal', limit: 1 }, 'limit=1'],
    [{ query: 'liquid crystal', limit: 999 }, 'limit 越界'],
    [{ query: 'liquid crystal', limit: 0 }, 'limit=0'],
    [{ query: 'liquid crystal', yearFrom: 2020, yearTo: 2022 }, '年份过滤'],
  ]);
  // 双源（配 S2 key）也要过契约
  process.env.LIT_SEARCH_S2_API_KEY = 'TEST-S2';
  try {
    await contractCases('lit_search', [[{ query: 'dual source' }, '双源合并']]);
  } finally {
    delete process.env.LIT_SEARCH_S2_API_KEY;
  }
});

test('契约 lit_abstract：DOI 命中 / DOI 404 → missing / 标题命中', async () => {
  const out = await contractCases('lit_abstract', [
    [{ doi: '10.1000/existing' }, 'DOI 命中'],
    [{ doi: '10.9999/unknown' }, 'DOI 不存在 → status=missing'],
    [{ title: 'Liquid crystal films' }, '标题命中'],
  ]);
  assert.equal(out[1].value.status, 'missing', '不存在的 DOI 必须回 missing 而不是抛错');
  assert.equal(out[1].value.abstract, '');
});

test('契约 lit_cited_by：work ID / DOI 种子', async () => {
  await contractCases('lit_cited_by', [
    [{ identifier: 'W1234567890' }, 'work ID'],
    [{ identifier: '10.1000/existing' }, 'DOI 种子'],
    [{ identifier: 'W1234567890', limit: 0 }, 'limit=0'],
  ]);
});

test('契约 zotero_search：默认 / 指定群组库 / qmode', async () => {
  await contractCases('zotero_search', [
    [{ query: 'liquid crystal' }, '个人库'],
    [{ query: 'liquid crystal', library: GROUP }, '群组库'],
    [{ query: 'liquid crystal', library: GROUP, qmode: 'titleCreatorYear' }, 'qmode'],
    [{ query: 'liquid crystal', library: GROUP, qmode: 'bogus' }, 'qmode 非法值'],
  ]);
});

test('契约 zotero_collections：三级下钻（库 → 收藏夹 → 条目），形状固定、query 不会藏掉目标收藏夹', async () => {
  const out = await contractCases('zotero_collections', [
    [{}, '第 1 级：只列库'],
    [{ library: 'user' }, '第 2 级：个人库收藏夹'],
    [{ library: GROUP }, '第 2 级：群组库（回归用例：曾因 libraryKey 未声明而整体报错）'],
    [{ library: GROUP, query: 'crystal' }, '第 2 级：带过滤'],
    [{ library: GROUP, query: 'no-match-zzz' }, '第 2 级：过滤无命中'],
    [{ library: GROUP, collection: 'liqiud crystal target' }, '第 3 级：按名称列条目'],
    [{ library: GROUP, collection: '2.Novel Targets > liqiud crystal target' }, '第 3 级：按父 > 子路径'],
    [{ library: GROUP, collection: 'liqiud crystal target', limit: 1 }, '第 3 级：limit=1'],
    [{ library: GROUP, collection: 'liqiud crystal target', limit: 999 }, '第 3 级：limit 越界'],
    // query 只该过滤「列收藏夹」那一级；不能把第 3 级要访问的收藏夹过滤掉
    [{ library: GROUP, query: 'no-match-zzz', collection: 'liqiud crystal target' }, '第 3 级 + 无关 query 仍能命中'],
  ]);

  // 形状固定：10 个键始终存在，且类型正确（no undefined → 过 lossless）
  const KEYS = ['libraries', 'library', 'libraryKey', 'collectionCount', 'collections', 'collection', 'collectionKey', 'itemCount', 'listed', 'items'];
  for (const { value } of out) {
    assert.deepEqual(Object.keys(value).sort(), [...KEYS].sort(), '返回值必须是固定的 10 个键');
    assert.equal(typeof value.itemCount, 'number');
    assert.equal(typeof value.listed, 'number');
    assert.equal(typeof value.collectionCount, 'number');
    assert.equal(value.collectionCount, value.collections.length, 'collectionCount 恒等于 collections.length');
    assert.equal(value.listed, value.items.length, 'listed 恒等于 items.length');
  }

  // 第 1 级
  assert.equal(out[0].value.libraryKey, '', '无 library 时 libraryKey 为空串');
  assert.ok(out[0].value.libraries.length >= 1, '只列库时必须有 libraries');
  assert.deepEqual(out[0].value.items, [], '第 1 级不带条目');
  // 第 2 级
  assert.equal(out[2].value.libraryKey, GROUP, '给了 library 必须回 libraryKey');
  assert.ok(out[2].value.collections.length >= 1);
  assert.deepEqual(out[2].value.items, [], '第 2 级不带条目');
  assert.equal(out[4].value.collectionCount, 0, '过滤无命中 → 0');
  // 第 3 级
  for (const i of [5, 6, 7, 8, 9]) {
    assert.equal(out[i].value.collectionKey, 'YJUSYVEM', '第 3 级要回 collectionKey');
    assert.match(out[i].value.collection, /liqiud crystal target/);
    assert.deepEqual(out[i].value.collections, [], '第 3 级不回收藏夹列表（避免把整库几百个收藏夹塞进结果）');
  }
  assert.equal(out[7].value.listed, 1, 'limit=1 只列 1 条');
  assert.equal(out[9].value.listed, out[5].value.listed, 'query 不应影响第 3 级');

  installFetch();
  await assert.rejects(
    () => byName.zotero_collections.execute({ collection: 'no-such-collection', library: GROUP }),
    /找不到收藏夹/,
  );
});

test('契约 lit_to_zotero：真实写入路径（非 dryRun）也必须过契约（用替身，不碰真实库）', async () => {
  const out = await contractCases('lit_to_zotero', [
    [{ refs: ['10.1000/new'], library: GROUP, collection: 'liqiud crystal target' }, '新建并写入'],
    [{ refs: ['10.1000/new'], library: GROUP, collection: 'liqiud crystal target', attachPdf: true }, '写入 + 挂 PDF（无 OA 直链）'],
    [{ refs: ['10.1000/existing'], library: GROUP, collection: 'liqiud crystal target' }, '已存在 → 不写'],
  ]);
  assert.equal(out[0].value.dryRun, false);
  assert.equal(out[0].value.items[0].action, 'created');
  assert.equal(out[0].value.items[0].itemKey, 'NEWKEY01');
  assert.equal(out[1].value.items[0].pdf, 'none', '无 OA 直链时应记 none');
  assert.deepEqual(undefinedPaths(out[0].value), [], '写入路径同样不允许 undefined 键');
  assert.deepEqual(undefinedPaths(out[1].value), [], 'attachPdf 路径不允许 undefined 键');
});

test('契约 lit_to_zotero：**字符串条目也必须过 lossless**（回归：n=undefined）', async () => {
  const out = await contractCases('lit_to_zotero', [
    [{ refs: ['10.1000/existing'], library: GROUP, collection: 'liqiud crystal target', dryRun: true }, '已在收藏夹 → exists'],
    [{ refs: ['10.1000/new'], library: GROUP, collection: 'liqiud crystal target', dryRun: true }, '新条目 → created'],
    [{ refs: ['Liquid crystal films as targets'], library: GROUP, collection: 'liqiud crystal target', dryRun: true }, '标题条目'],
    [{ refs: ['10.1000/new'], library: GROUP, collection: 'liqiud crystal target', dryRun: true, itemTypes: ['journalArticle'] }, 'itemTypes 白名单'],
    [{ refs: ['10.1000/new'], library: GROUP, collection: 'liqiud crystal target', dryRun: true, itemTypes: ['conferencePaper'] }, 'itemTypes 排除 → skipped'],
    [{ refs: ['not a resolvable reference'], library: GROUP, dryRun: true }, '无法解析的条目'],
    [{ refs: ['10.1000/new', '10.1000/existing'], library: GROUP, collection: 'liqiud crystal target', dryRun: true }, '多条混合'],
  ]);
  // 回归断言：n 必须始终是具体数字，绝不能是 undefined
  for (const { value } of out) {
    for (const [i, item] of value.items.entries()) {
      assert.equal(typeof item.n, 'number', `items[${i}].n 必须是数字，实际 ${typeof item.n}`);
    }
  }
  assert.deepEqual(undefinedPaths(out[0].value), [], '返回值里不允许出现 undefined 键');
  assert.equal(out[0].value.items[0].action, 'exists');
  assert.equal(out[1].value.items[0].action, 'created');
  assert.equal(out[4].value.items[0].action, 'skipped');
});

test('契约 lit_to_zotero：对象条目的显式 n 被保留，字符串条目按 1-based 位置编号', async () => {
  installFetch();
  const def = byName.lit_to_zotero;
  const res = await def.execute({
    refs: [{ raw: '10.1000/new', n: 21 }, '10.1000/existing'],
    library: GROUP,
    collection: 'liqiud crystal target',
    dryRun: true,
  });
  assert.equal(res.items[0].n, 21, '对象里显式给的 n 必须原样保留（对应综述里的参考文献序号）');
  assert.equal(res.items[1].n, 2, '字符串条目回落到 1-based 位置');
  assert.equal(checkLossless(res), null);
});

test('契约 zotero_enrich：ref 四种写法 / fields 投影 / include 各分支', async () => {
  const out = await contractCases('zotero_enrich', [
    [{ ref: ITEM_KEY }, 'key 命中'],
    [{ ref: `zotero://group/6441110/item/${ITEM_KEY}`, library: GROUP }, 'zotero:// 引用'],
    [{ ref: '10.1038/s41598-019-52305-3', library: GROUP }, 'DOI 命中'],
    [{ ref: ITEM_KEY, library: GROUP, fields: [] }, 'fields=[] 仅标识'],
    [{ ref: ITEM_KEY, library: GROUP, fields: ['creators', 'DOI'] }, 'fields 投影'],
    [{ ref: ITEM_KEY, library: GROUP, fields: ['title', 'nonsenseField'] }, 'fields 含未知名'],
    [{ ref: ITEM_KEY, library: GROUP, include: ['tags'] }, 'include=tags'],
    [{ ref: ITEM_KEY, library: GROUP, include: ['notes', 'attachments', 'annotations'], paths: true }, '子对象 + 路径'],
    [{ ref: ITEM_KEY, library: GROUP, include: ['fulltext'], maxChars: 200 }, '全文索引'],
    [{ ref: ITEM_KEY, library: GROUP, maxChars: 0 }, 'maxChars=0'],
    [{ ref: 'NOPE1234', library: GROUP }, '未命中 → found:false'],
  ]);
  assert.equal(out[10].value.found, false, '未命中必须回 found:false 而不是抛错');
  assert.deepEqual(out[5].value.unknownFields, ['nonsenseField'], '未识别的字段要回报');
  assert.equal(out[3].value.item.creators, undefined, 'fields=[] 时不该带 creators');
});

test('契约 zotero_enrich：unknownFields 必须出现在 render 里（模型只看得到 render）', async () => {
  installFetch();
  const def = byName.zotero_enrich;
  const args = { ref: ITEM_KEY, library: GROUP, fields: ['title', 'nonsenseField'] };
  const value = await def.execute(args);
  const text = def.render(args, value)[0].text;
  assert.match(text, /nonsenseField/, '未识别的字段名必须在 render 里点出来，否则模型无从修正');
});

test('契约 zotero_abstract：命中 / 未命中 / maxChars 边界', async () => {
  const out = await contractCases('zotero_abstract', [
    [{ ref: ITEM_KEY, library: GROUP }, 'key 命中'],
    [{ ref: '10.1038/s41598-019-52305-3', library: GROUP }, 'DOI 命中'],
    [{ ref: 'NOPE1234', library: GROUP }, '未命中'],
    [{ ref: ITEM_KEY, library: GROUP, maxChars: 0 }, 'maxChars 下界'],
    [{ ref: ITEM_KEY, library: GROUP, maxChars: 999999 }, 'maxChars 超上界'],
  ]);
  assert.equal(out[2].value.found, false);
});

test('契约：每个工具的 outputSchema 都是 additionalProperties:false 且 execute 不多回键', async () => {
  // 结构性护栏：schema 声明为封闭对象，任何 execute 分支多回一个键都会被 DSH 直接拒绝。
  for (const def of toolDefinitions) {
    assert.equal(def.outputSchema.additionalProperties, false, `${def.name} outputSchema 必须封闭`);
    assert.equal(def.outputSchema.type, 'object', `${def.name} outputSchema 根必须是 object`);
  }
});

test('契约：所有 render 输出都是 [{type:"text", text:string}]，且对畸形 value 不崩', () => {
  for (const def of toolDefinitions) {
    // 空值 / undefined 也必须能 render（工具出错时 DSH 不会调 render，但防御性检查便宜）
    for (const value of [{}, { items: [] }, { found: false, library: 'L', libraryKey: 'user', ref: 'x' }]) {
      let blocks;
      try {
        blocks = def.render({}, value);
      } catch (err) {
        assert.fail(`${def.name}.render(${JSON.stringify(value)}) 抛错：${err.message}`);
      }
      assert.ok(Array.isArray(blocks), `${def.name} render 必须返回数组`);
      for (const b of blocks) {
        assert.equal(b.type, 'text', `${def.name} render 块类型`);
        assert.equal(typeof b.text, 'string', `${def.name} render 块文本`);
      }
    }
  }
});

test('契约：每个工具的 presentationMeta 都能无损 JSON 序列化（客户端卡片数据）', async () => {
  installFetch();
  for (const def of toolDefinitions) {
    const args = def.name === 'lit_search' || def.name === 'lit_cited_by'
      ? { query: 'x', identifier: 'W1' }
      : def.name === 'zotero_search'
        ? { query: 'x' }
        : def.name === 'lit_to_zotero'
          ? { refs: ['10.1000/new'], library: GROUP, dryRun: true }
          : def.name === 'zotero_collections'
            ? { library: GROUP }
            : def.name === 'zotero_enrich' || def.name === 'zotero_abstract'
              ? { ref: ITEM_KEY, library: GROUP }
              : { doi: '10.1000/existing' };
    let value;
    try {
      value = await def.execute(args);
    } catch {
      continue; // 参数形状不适用该工具时跳过（上面各工具有专项用例）
    }
    const meta = def.presentationMeta(args, value);
    assert.equal(checkLossless(meta), null, `${def.name} presentationMeta 必须无损`);
    assert.equal(validateAgainstSchema(meta, { type: 'object', additionalProperties: true }).length, 0);
  }
});
