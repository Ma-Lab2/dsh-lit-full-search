/**
 * lit-to-zotero 引擎测试：全部本地（注入全局 fetch 替身），不触碰网络与真实 Zotero。
 *
 * 覆盖：参考文献行解析、作者串解析、库/收藏夹名解析与歧义报错、元数据链、
 * itemType 白名单、去重三分支（exists/added/created）、写请求路径与载荷、上限与错误隔离。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_IMPORT_REFS,
  crossrefTypeToZotero,
  fromCrossref,
  guessItemType,
  importReferences,
  normalizeTitle,
  parseReferenceLine,
  resolveCollection,
  resolveLibraryKey,
  splitApaAuthors,
} from '../lib/lit-to-zotero.js';

// ---- fetch 替身 -------------------------------------------------------------

const SID_HEADERS = { get: (name) => (String(name).toLowerCase() === 'zotero-server-id' ? 'TEST-SERVER-ID' : null) };

function jsonResponse(body, { status = 200, statusText = 'OK' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: SID_HEADERS,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
    json: async () => body,
  };
}

/** 二进制响应（PDF 下载用）：text() 给原文，arrayBuffer() 给字节。 */
function binaryResponse(text, { status = 200, statusText = 'OK' } = {}) {
  const bytes = new TextEncoder().encode(text);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: SID_HEADERS,
    text: async () => text,
    arrayBuffer: async () => bytes.buffer,
  };
}

const LIBRARIES = [
  { id: 6441110, data: { id: 6441110, name: "WENJUN_MA's Group" } },
  { id: 6646099, data: { id: 6646099, name: 'LDIA library' } },
];

const COLLECTIONS = [
  { key: '3ZKQJ2B8', data: { name: '2.Novel Targets' }, meta: { numItems: 4 } },
  { key: 'YJUSYVEM', data: { name: 'liqiud crystal target', parentCollection: '3ZKQJ2B8' }, meta: { numItems: 1 } },
];

const IN_COLLECTION = {
  key: 'EXISTKEY',
  data: { itemType: 'journalArticle', title: 'Liquid crystal films as on-demand targets', DOI: '10.1063/1.4885100' },
};

const IN_LIBRARY_ELSEWHERE = {
  key: 'ELSEKEY',
  data: { itemType: 'journalArticle', title: 'Design and Characterization of a Fully Automated Free-Standing Liquid Crystal Film Holder', DOI: '10.3390/liquids6010007' },
};

/** 记录请求的 fetch 替身；返回 calls 供断言。 */
function installFetch(overrides = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, method: init.method ?? 'GET', body: init.body ?? null, headers: init.headers ?? {} });
    for (const [pattern, respond] of overrides.routes ?? []) {
      if (pattern.test(href)) return respond(href, init);
    }
    if (/\/api\/?$/.test(href)) return jsonResponse('Nothing to see here.');
    if (href.includes('/users/0/groups')) return jsonResponse(LIBRARIES);
    if (href.includes('/collections?limit=100')) return jsonResponse(COLLECTIONS);
    if (href.includes('/collections/YJUSYVEM/items/top')) return jsonResponse([IN_COLLECTION]);
    if (href.includes('/items/ELSEKEY') && (init.method ?? 'GET') === 'GET') {
      return jsonResponse({ key: 'ELSEKEY', version: 7, data: { ...IN_LIBRARY_ELSEWHERE.data, collections: [] } });
    }
    if (href.includes('/items?q=')) {
      if (href.includes('10.3390%2Fliquids6010007') || href.includes('10.3390/liquids6010007')) return jsonResponse([IN_LIBRARY_ELSEWHERE]);
      return jsonResponse([]);
    }
    if (/api\.crossref\.org/.test(href)) return jsonResponse({ status: 'ok', message: overrides.crossrefMessage ?? crossrefMessage() });
    if (init.method === 'POST' && href.includes('/items')) return jsonResponse({ successful: { 0: { key: 'NEWKEY' } }, failed: {} });
    if (init.method === 'PATCH' && href.includes('/items/')) return jsonResponse({ successful: { 0: { key: 'ELSEKEY' } } });
    throw new Error(`未预期的请求：${init.method ?? 'GET'} ${href}`);
  };
  return calls;
}

function crossrefMessage() {
  return {
    type: 'journal-article',
    title: ['Investigation of parameters governing damage resistance of nematic liquid crystals'],
    author: [{ family: 'Kosc', given: 'T. Z.' }, { family: 'Kozlov', given: 'A. A.' }],
    'container-title': ['Scientific Reports'],
    volume: '9',
    issue: '1',
    page: '16435',
    ISSN: ['2045-2322'],
    issued: { 'date-parts': [[2019]] },
    URL: 'https://doi.org/10.1038/s41598-019-52305-3',
    DOI: '10.1038/s41598-019-52305-3',
    abstract: '<jats:p>Damage resistance of nematic liquid crystals.</jats:p>',
  };
}

test.afterEach(() => {
  delete globalThis.fetch;
});

// ---- 纯函数 -----------------------------------------------------------------

test('parseReferenceLine：APA 整行解析出标题/期刊/卷期页/DOI/年份', () => {
  const parsed = parseReferenceLine(
    '21. Kosc, T. Z., Kozlov, A. A., Papernov, S., Kafka, K. R. P., Marshall, K. L., et al. (2019). Investigation of parameters governing damage resistance of nematic liquid crystals for high-power or peak-intensity laser applications. *Scientific Reports*, 9(1), 16435. https://doi.org/10.1038/s41598-019-52305-3',
  );
  assert.equal(parsed.year, '2019');
  assert.equal(parsed.title, 'Investigation of parameters governing damage resistance of nematic liquid crystals for high-power or peak-intensity laser applications');
  assert.equal(parsed.venue, 'Scientific Reports');
  assert.equal(parsed.volume, '9');
  assert.equal(parsed.issue, '1');
  assert.equal(parsed.pages, '16435');
  assert.equal(parsed.doi, '10.1038/s41598-019-52305-3');
  assert.match(parsed.authorsRaw, /Kosc, T\. Z\./);
});

test('parseReferenceLine：裸 DOI 与裸标题', () => {
  const doiOnly = parseReferenceLine('https://doi.org/10.1063/1.4885100');
  assert.equal(doiOnly.doi, '10.1063/1.4885100');
  assert.equal(doiOnly.title, '');

  // 回归：裸 DOI 开头的 "10." 不得被当成列表序号吃掉
  const bareDoi = parseReferenceLine('10.1063/1.4885100');
  assert.equal(bareDoi.doi, '10.1063/1.4885100');
  assert.equal(bareDoi.title, '');
  assert.equal(parseReferenceLine('10.1038/s41598-019-52305-3').doi, '10.1038/s41598-019-52305-3');
  assert.equal(parseReferenceLine('  12. 10.1234/abc.def').doi, '10.1234/abc.def');

  const titleOnly = parseReferenceLine('Liquid crystal films as on-demand variable thickness targets');
  assert.equal(titleOnly.doi, '');
  assert.equal(titleOnly.title, 'Liquid crystal films as on-demand variable thickness targets');
});

test('splitApaAuthors：姓, 名缩写 串 + et al. + 单名', () => {
  assert.deepEqual(splitApaAuthors('Poole, P. L., Andereck, C. D., Schumacher, D. W., et al.'), [
    { lastName: 'Poole', firstName: 'P. L.' },
    { lastName: 'Andereck', firstName: 'C. D.' },
    { lastName: 'Schumacher', firstName: 'D. W.' },
  ]);
  assert.deepEqual(splitApaAuthors('McMahon, M.'), [{ lastName: 'McMahon', firstName: 'M.' }]);
  assert.deepEqual(splitApaAuthors('Vázquez, J. M.'), [{ lastName: 'Vázquez', firstName: 'J. M.' }]);
  assert.deepEqual(splitApaAuthors(''), []);
});

test('crossrefTypeToZotero / guessItemType：类型映射', () => {
  assert.equal(crossrefTypeToZotero('journal-article'), 'journalArticle');
  assert.equal(crossrefTypeToZotero('proceedings-article'), 'conferencePaper');
  assert.equal(crossrefTypeToZotero('posted-content'), 'preprint');
  assert.equal(crossrefTypeToZotero('dataset'), 'dataset');
  assert.equal(crossrefTypeToZotero('report'), 'report');
  assert.equal(crossrefTypeToZotero('dissertation'), 'thesis');
  assert.equal(crossrefTypeToZotero('weird-thing'), 'journalArticle');
  assert.equal(guessItemType('APS Division of Plasma Physics Meeting 2020'), 'conferencePaper');
  assert.equal(guessItemType('M.S. thesis, The Ohio State University'), 'thesis');
  assert.equal(guessItemType('Physics of Plasmas'), 'journalArticle');
  assert.equal(guessItemType('Physics of Plasmas', 'preprint'), 'preprint');
});

test('fromCrossref：字段白名单与作者映射（JATS 摘要被清洗）', () => {
  const item = fromCrossref(crossrefMessage(), {});
  assert.equal(item.itemType, 'journalArticle');
  assert.equal(item.fields.publicationTitle, 'Scientific Reports');
  assert.equal(item.fields.pages, '16435');
  assert.equal(item.fields.abstractNote, 'Damage resistance of nematic liquid crystals.');
  assert.deepEqual(item.creators, [{ lastName: 'Kosc', firstName: 'T. Z.' }, { lastName: 'Kozlov', firstName: 'A. A.' }]);
  assert.equal(item.doi, '10.1038/s41598-019-52305-3');
});

test('resolveLibraryKey：user / group:<id> / 纯数字 / 名称 / 多义与未知报错', () => {
  const libs = [
    { libraryKey: 'user', name: '我的文库' },
    { libraryKey: 'group:6441110', name: "WENJUN_MA's Group" },
    { libraryKey: 'group:6646099', name: 'LDIA library' },
  ];
  assert.equal(resolveLibraryKey(libs, 'user'), 'user');
  assert.equal(resolveLibraryKey(libs, ''), 'user');
  assert.equal(resolveLibraryKey(libs, 'group:6441110'), 'group:6441110');
  assert.equal(resolveLibraryKey(libs, '6441110'), 'group:6441110');
  assert.equal(resolveLibraryKey(libs, 'LDIA library'), 'group:6646099');
  assert.equal(resolveLibraryKey(libs, 'wenjun'), 'group:6441110');
  assert.throws(() => resolveLibraryKey(libs, '不存在的库'), /找不到库/);
  assert.throws(() => resolveLibraryKey([...libs, { libraryKey: 'group:1', name: 'LDIA library 2' }], 'LDIA'), /不唯一/);
});

test('resolveCollection：key / 名称 / 父 > 子 路径 / 歧义报错', () => {
  const cols = [
    { key: 'P1', name: '2.Novel Targets', parentKey: null, path: '2.Novel Targets' },
    { key: 'C1', name: 'liqiud crystal target', parentKey: 'P1', path: '2.Novel Targets > liqiud crystal target' },
    { key: 'C2', name: 'liquid crystal target for LIA', parentKey: null, path: 'liquid crystal target for LIA' },
  ];
  assert.equal(resolveCollection(cols, 'C1').key, 'C1');
  assert.equal(resolveCollection(cols, 'liqiud crystal target').key, 'C1');
  assert.equal(resolveCollection(cols, '2.Novel Targets > liqiud crystal target').key, 'C1');
  assert.equal(resolveCollection(cols, 'Novel Targets > liqiud').key, 'C1');
  // 真实歧义：'crystal target' 同时命中错拼的 liqiud 与 LDIA 群组里的 liquid crystal target for LIA
  assert.throws(() => resolveCollection(cols, 'crystal target'), /不唯一/);
  assert.equal(resolveCollection(cols, 'liqiud crystal').key, 'C1');
  assert.throws(() => resolveCollection(cols, '完全不存在'), /找不到收藏夹/);
});

test('normalizeTitle：大小写/标点归一，便于无 DOI 去重', () => {
  assert.equal(normalizeTitle('Liquid Crystal Films: As On-Demand, Targets!'), normalizeTitle('liquid crystal films as on demand targets'));
});

// ---- 编排 -------------------------------------------------------------------

const TARGET = { library: "WENJUN_MA's Group", collection: 'liqiud crystal target' };

test('importReferences dry-run：exists / added / created 三分支，且不发出任何写请求', async () => {
  const calls = installFetch();
  const report = await importReferences({
    dryRun: true,
    ...TARGET,
    refs: [
      { n: 1, doi: '10.1063/1.4885100', title: 'Liquid crystal films as on-demand targets' },
      { n: 25, doi: '10.3390/liquids6010007', title: 'Design and Characterization of a Fully Automated Free-Standing Liquid Crystal Film Holder' },
      { n: 21, doi: '10.1038/s41598-019-52305-3', title: 'Investigation of parameters governing damage resistance of nematic liquid crystals' },
    ],
  });

  assert.equal(report.libraryKey, 'group:6441110');
  assert.equal(report.collectionKey, 'YJUSYVEM');
  assert.equal(report.collection, '2.Novel Targets > liqiud crystal target');
  assert.equal(report.collectionSizeBefore, 1);
  assert.deepEqual(report.counts, { created: 1, added: 1, exists: 1, skipped: 0, failed: 0 });
  assert.deepEqual(report.items.map((i) => i.action), ['exists', 'added', 'created']);
  assert.equal(report.items[0].itemKey, '');
  assert.equal(report.items[1].itemKey, 'ELSEKEY');
  assert.equal(report.items[2].itemType, 'journalArticle');
  assert.ok(report.items[2].planned);
  assert.equal(calls.filter((c) => c.method !== 'GET').length, 0, 'dry-run 不得发出写请求');
});

test('importReferences apply：新建走群组库路径并带 collections；已有条目用 PATCH 加挂', async () => {
  const calls = installFetch();
  const report = await importReferences({
    ...TARGET,
    zoteroKey: 'TESTKEY',
    refs: [
      { n: 25, doi: '10.3390/liquids6010007', title: 'Design and Characterization of a Fully Automated Free-Standing Liquid Crystal Film Holder' },
      { n: 21, doi: '10.1038/s41598-019-52305-3', title: 'Investigation of parameters governing damage resistance of nematic liquid crystals' },
    ],
  });

  assert.deepEqual(report.counts, { created: 1, added: 1, exists: 0, skipped: 0, failed: 0 });

  const post = calls.find((c) => c.method === 'POST' && c.url.includes('/groups/6441110/items'));
  assert.ok(post, '应向群组库 POST 新条目');
  const payload = JSON.parse(post.body);
  assert.equal(payload[0].itemType, 'journalArticle');
  assert.equal(payload[0].collections[0], 'YJUSYVEM');
  assert.equal(payload[0].DOI, '10.1038/s41598-019-52305-3');
  assert.equal(payload[0].publicationTitle, 'Scientific Reports');
  assert.equal(payload[0].creators.length, 2);
  assert.equal(post.headers['Zotero-API-Key'], 'TESTKEY');
  assert.equal(post.headers['Zotero-Server-ID'], 'TEST-SERVER-ID');

  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch, '应 PATCH 已有条目以加入收藏夹');
  assert.equal(patch.url, 'http://localhost:23119/api/groups/6441110/items/ELSEKEY');
  assert.deepEqual(JSON.parse(patch.body), { collections: ['YJUSYVEM'] });

  assert.equal(report.items.find((i) => i.n === 21).itemKey, 'NEWKEY');
});

test('importReferences：itemTypes 白名单先按提示过滤，再按解析出的类型过滤', async () => {
  const calls = installFetch({
    routes: [[/api\.crossref\.org/, () => jsonResponse({ status: 'ok', message: { ...crossrefMessage(), type: 'proceedings-article', 'container-title': ['SPIE Proceedings'] } })]],
  });
  const report = await importReferences({
    dryRun: true,
    ...TARGET,
    itemTypes: ['journalArticle'],
    refs: [
      { n: 16, doi: '10.1117/12.3028421', title: 'Novel plasma mirrors', itemType: 'conferencePaper' },
      { n: 99, doi: '10.9999/unknown-type', title: 'Some proceedings paper' },
    ],
  });
  assert.deepEqual(report.items.map((i) => i.action), ['skipped', 'skipped']);
  assert.match(report.items[0].error, /不在白名单/);
  assert.match(report.items[1].error, /解析出 itemType conferencePaper/);
  assert.ok(calls.some((c) => /api\.crossref\.org/.test(c.url)));
});

test('importReferences：单条失败不中断，其余照常处理；无 DOI 条目按标题去重', async () => {
  const calls = installFetch({
    routes: [
      [/10\.1234%2Fboom|10\.1234\/boom/, () => jsonResponse(null, { status: 500, statusText: 'Server Error' })],
    ],
  });
  // Crossref 之外的兜底（OpenAlex）也会被打到，这里让它们返回空结果
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (/openalex\.org/.test(String(url))) return jsonResponse({ results: [] });
    return originalFetch(url, init);
  };

  const report = await importReferences({
    dryRun: true,
    ...TARGET,
    refs: [
      { n: 1, doi: '', title: 'Liquid crystal films as on-demand targets' }, // 标题命中收藏夹
      { n: 2, doi: '10.1234/boom', title: 'Boom paper' }, // Crossref 500 → OpenAlex 空 → 行内解析仍可建
      { n: 3, doi: '10.1038/s41598-019-52305-3', title: 'Investigation of parameters governing damage resistance of nematic liquid crystals' },
    ],
  });

  assert.equal(report.items[0].action, 'exists', '标题归一化后命中收藏夹');
  assert.equal(report.items[1].action, 'created');
  assert.equal(report.items[1].title, 'Boom paper');
  assert.equal(report.items[2].action, 'created');
  assert.equal(report.counts.failed, 0);
  assert.ok(calls.length > 0);
});

test('importReferences：attachPdf 走完 Zotero 四段上传，PDF 挂到新建条目上', async () => {
  const calls = installFetch({
    routes: [
      [/api\.openalex\.org/, () => jsonResponse({ best_oa_location: { pdf_url: 'https://example.org/oa.pdf' } })],
      [/example\.org\/oa\.pdf/, () => binaryResponse('%PDF-1.7 fake pdf')],
      [
        /\/items\/ATTACHKEY\/file/,
        (_href, init) => (init.headers['If-None-Match'] === '*' ? jsonResponse({ url: '/upload/tmp', uploadKey: 'UK' }) : jsonResponse(null, { status: 204 })),
      ],
      [/\/upload\/tmp/, () => jsonResponse(null, { status: 200 })],
      [
        /\/groups\/6441110\/items$/,
        (_href, init) => jsonResponse({ successful: { 0: { key: String(init.body).includes('attachment') ? 'ATTACHKEY' : 'NEWKEY' } }, failed: {} }),
      ],
    ],
  });

  const report = await importReferences({
    ...TARGET,
    zoteroKey: 'TESTKEY',
    attachPdf: true,
    refs: [{ n: 21, doi: '10.1038/s41598-019-52305-3', title: 'Investigation of parameters governing damage resistance of nematic liquid crystals' }],
  });

  const item = report.items[0];
  assert.equal(item.action, 'created');
  assert.equal(item.itemKey, 'NEWKEY');
  assert.equal(item.pdf, 'attached');

  // 建附件条目 → 申请授权（If-None-Match: *）→ 直传 → 注册上传
  const attachCreate = calls.find((c) => c.method === 'POST' && c.url.endsWith('/groups/6441110/items') && String(c.body).includes('attachment'));
  assert.ok(attachCreate, '应创建 attachment 子条目');
  assert.equal(JSON.parse(attachCreate.body)[0].parentItem, 'NEWKEY');
  assert.ok(calls.some((c) => c.url.endsWith('/items/ATTACHKEY/file') && c.headers['If-None-Match'] === '*'), '应申请上传授权');
  assert.ok(calls.some((c) => c.method === 'POST' && c.url.endsWith('/upload/tmp')), '应直传文件');
  assert.ok(calls.some((c) => c.url.endsWith('/items/ATTACHKEY/file') && !c.headers['If-None-Match']), '应注册上传完成');
});

test('importReferences：attachPdf 失败只记录在条目上，不影响建档', async () => {
  installFetch({
    routes: [
      [/api\.openalex\.org/, () => jsonResponse({ best_oa_location: { pdf_url: 'https://example.org/oa.pdf' } })],
      [/example\.org\/oa\.pdf/, () => jsonResponse({ error: 'not here' }, { status: 404, statusText: 'Not Found' })],
    ],
  });

  const report = await importReferences({
    ...TARGET,
    zoteroKey: 'TESTKEY',
    attachPdf: true,
    refs: [{ n: 21, doi: '10.1038/s41598-019-52305-3', title: 'Investigation of parameters governing damage resistance of nematic liquid crystals' }],
  });

  const item = report.items[0];
  assert.equal(item.action, 'created', 'PDF 失败不得改变建档结果');
  assert.equal(item.pdf, 'failed');
  assert.match(item.pdfError, /下载失败/);
  assert.equal(report.counts.failed, 0);
});

test('importReferences dry-run：attachPdf 只标 planned，不发任何写请求', async () => {
  const calls = installFetch();
  const report = await importReferences({
    dryRun: true,
    attachPdf: true,
    ...TARGET,
    refs: [{ n: 21, doi: '10.1038/s41598-019-52305-3', title: 'Investigation of parameters governing damage resistance of nematic liquid crystals' }],
  });
  assert.equal(report.items[0].action, 'created');
  assert.equal(report.items[0].pdf, 'planned');
  assert.equal(calls.filter((c) => c.method !== 'GET').length, 0);
});

test('importReferences：refs 为空或超过上限时报错', async () => {
  await assert.rejects(() => importReferences({ refs: [] }), /refs 不能为空/);
  await assert.rejects(
    () => importReferences({ refs: Array.from({ length: MAX_IMPORT_REFS + 1 }, (_, i) => `10.1/${i}`) }),
    /单次最多导入/,
  );
});

test('importReferences：目标库/收藏夹解析失败时给出可行动的错误', async () => {
  installFetch();
  await assert.rejects(() => importReferences({ refs: ['10.1063/1.4885100'], library: '不存在的库' }), /找不到库/);
  await assert.rejects(
    () => importReferences({ refs: ['10.1063/1.4885100'], library: "WENJUN_MA's Group", collection: '不存在的收藏夹' }),
    /找不到收藏夹/,
  );
});
