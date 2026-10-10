/**
 * zotero_enrich 引擎测试：全部本地（注入全局 fetch 替身），不触碰网络与真实 Zotero。
 *
 * 覆盖：ref 四种解析、纯函数（HTML 清洗/标签/收藏夹映射/子对象分组）、默认 include 的请求数、
 * 懒取子对象、附件磁盘路径（Windows 盘符还原 + 存在性 + linked_url）、批注、全文索引、截断、
 * 未命中不抛错、单臂失败只记 warning、zotero:// 附件 ref 转父条目。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  enrichItem,
  getAbstract,
  groupChildren,
  mapCollections,
  mapTags,
  normalizeAbstract,
  parseEnrichRef,
  stripHtml,
} from '../lib/zotero-enrich.js';

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

const ITEM_KEY = 'QZX8A2PX';
const ATT_PDF = 'ATTCH001';
const ATT_LINK = 'ATTCH002';

const LIBRARIES = [
  { id: 6441110, data: { id: 6441110, name: "WENJUN_MA's Group" } },
];

const COLLECTIONS = [
  { key: '3ZKQJ2B8', data: { name: '2.Novel Targets', parentCollection: null }, meta: { numItems: 4 } },
  { key: 'YJUSYVEM', data: { name: 'liqiud crystal target', parentCollection: '3ZKQJ2B8' }, meta: { numItems: 37 } },
];

const ITEM = {
  key: ITEM_KEY,
  version: 42,
  data: {
    itemType: 'journalArticle',
    title: 'Investigation of parameters governing damage resistance of nematic liquid crystals',
    creators: [
      { firstName: 'T. Z.', lastName: 'Kosc' },
      { firstName: 'A. A.', lastName: 'Kozlov' },
    ],
    date: '2019',
    publicationTitle: 'Scientific Reports',
    volume: '9',
    issue: '1',
    pages: '16435',
    DOI: '10.1038/s41598-019-52305-3',
    url: 'https://doi.org/10.1038/s41598-019-52305-3',
    abstractNote: 'Damage resistance of nematic liquid crystals under high-power irradiation.',
    extra: 'Citations (openalex): 12',
    language: 'en',
    dateAdded: '2026-10-10T10:48:39Z',
    dateModified: '2026-10-10T10:48:39Z',
    tags: [{ tag: '液晶靶' }, { tag: '损伤阈值' }],
    collections: ['YJUSYVEM'],
  },
};

const CHILDREN = [
  { key: 'NOTE0001', version: 1, data: { itemType: 'note', note: '<p>第一行</p><p>第二行 <b>加粗</b></p>' } },
  {
    key: ATT_PDF,
    version: 1,
    data: { itemType: 'attachment', title: 'Full Text PDF', contentType: 'application/pdf', filename: 'kosc.pdf', linkMode: 'imported_file', parentItem: ITEM_KEY },
  },
  {
    key: ATT_LINK,
    version: 1,
    data: { itemType: 'attachment', title: 'Publisher page', contentType: 'text/html', filename: '', linkMode: 'linked_url', parentItem: ITEM_KEY },
  },
];

const ANNOTATIONS = [
  {
    key: 'ANNO0001',
    version: 1,
    data: { itemType: 'annotation', parentItem: ATT_PDF, annotationText: '关键结论：损伤阈值随温度下降', annotationComment: '注意剂量单位', annotationPageLabel: '3', annotationColor: '#ffd400' },
  },
];

/** 真实存在/不存在的两个 file:// 路径，用于验证 existsSync 分支。 */
const EXISTING_FILE_URL = 'file:///D:/AI%20Programs/dsh-lit-full-search/package.json';
const MISSING_FILE_URL = 'file:///D:/no-such-dir/nope.pdf';

function installFetch(overrides = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const method = init.method ?? 'GET';
    calls.push({ url: href, method, body: init.body ?? null, headers: init.headers ?? {} });
    for (const [pattern, respond] of overrides.routes ?? []) {
      if (pattern.test(href)) return respond(href, init);
    }
    if (href.includes('/users/0/groups')) return jsonResponse(LIBRARIES);
    if (href.includes('/collections?limit=100')) return jsonResponse(COLLECTIONS);
    if (href.includes(`/items/${ATT_PDF}/children`)) return jsonResponse(ANNOTATIONS);
    if (href.includes(`/items/${ATT_LINK}/children`)) return jsonResponse([]);
    if (href.includes(`/items/${ITEM_KEY}/children`)) return jsonResponse(CHILDREN);
    if (href.includes(`/items/${ATT_PDF}/file/view/url`)) return jsonResponse(EXISTING_FILE_URL);
    if (href.includes(`/items/${ATT_LINK}/file/view/url`)) return jsonResponse('https://example.org/publisher');
    if (href.includes(`/items/${ATT_PDF}/fulltext`)) return jsonResponse({ content: 'x'.repeat(5000), indexedChars: 5000, totalChars: 9000 });
    if (href.includes(`/items/${ATT_LINK}/fulltext`)) return jsonResponse({ status: 404 }, { status: 404, statusText: 'Not Found' });
    if (href.includes(`/items/${ITEM_KEY}`)) return jsonResponse(ITEM);
    if (href.includes('/items?q=')) return jsonResponse([{ key: ITEM_KEY, data: { itemType: 'journalArticle', title: ITEM.data.title, DOI: ITEM.data.DOI } }]);
    throw new Error(`未预期的请求：${method} ${href}`);
  };
  return calls;
}

test.afterEach(() => {
  delete globalThis.fetch;
});

// ---- 纯函数 -----------------------------------------------------------------

test('parseEnrichRef：key / zotero:// / DOI / 标题 四种解析', () => {
  assert.deepEqual(parseEnrichRef('QZX8A2PX'), { kind: 'key', key: 'QZX8A2PX' });
  assert.deepEqual(parseEnrichRef('zotero://user/0/item/QZX8A2PX'), { kind: 'zotero', key: 'QZX8A2PX', refKind: 'item', libraryKey: 'user' });
  assert.deepEqual(parseEnrichRef('zotero://group/6441110/attachment/FIT6MIJR'), {
    kind: 'zotero',
    key: 'FIT6MIJR',
    refKind: 'attachment',
    libraryKey: 'group:6441110',
  });
  assert.deepEqual(parseEnrichRef('https://doi.org/10.1038/s41598-019-52305-3'), { kind: 'doi', doi: '10.1038/s41598-019-52305-3' });
  assert.deepEqual(parseEnrichRef('10.1063/1.4885100'), { kind: 'doi', doi: '10.1063/1.4885100' });
  assert.deepEqual(parseEnrichRef('Liquid crystal films as on-demand targets'), {
    kind: 'title',
    title: 'Liquid crystal films as on-demand targets',
  });
  assert.throws(() => parseEnrichRef('   '), /ref 不能为空/);
});

test('normalizeAbstract：折叠来源网页的换行/缩进，去掉开头的 Abstract 段标签', () => {
  // 真实样本（Yogo 2017）：939 字符里 219 个是空白，上标被拆成 4 行
  const raw = 'Abstract\n            \n              Using one of the world most powerful laser facility. By extending the pulse duration from 1.5 to 6 ps with fixed laser intensity of 10\n              18\n               W cm\n              −2\n              , the maximum proton energy is improved more than twice.';
  const out = normalizeAbstract(raw);
  assert.equal([...raw].length > [...out].length, true);
  assert.equal(out.startsWith('Using one of the world'), true, '应去掉 Abstract 标签');
  assert.equal(out.includes('\n'), false, '应折叠所有换行');
  assert.equal(out.includes('  '), false, '不应留连续空格');
  assert.equal(out, 'Using one of the world most powerful laser facility. By extending the pulse duration from 1.5 to 6 ps with fixed laser intensity of 10 18 W cm −2 , the maximum proton energy is improved more than twice.');
  // 无标签 / 空值 / 中文标签
  assert.equal(normalizeAbstract('Plain abstract text.'), 'Plain abstract text.');
  assert.equal(normalizeAbstract(''), '');
  assert.equal(normalizeAbstract(undefined), '');
  assert.equal(normalizeAbstract('摘要：中文摘要内容。'), '中文摘要内容。');
});

test('stripHtml / mapTags / mapCollections / groupChildren：纯函数', () => {
  assert.equal(stripHtml('<p>第一行</p><p>第二行 <b>加粗</b></p>'), '第一行\n第二行 加粗');
  assert.equal(stripHtml('a &amp; b &lt;c&gt;'), 'a & b <c>');
  assert.deepEqual(mapTags(ITEM.data), ['液晶靶', '损伤阈值']);
  assert.deepEqual(mapTags({}), []);
  assert.deepEqual(mapCollections(['YJUSYVEM', 'UNKNOWN1'], [
    { key: '3ZKQJ2B8', name: '2.Novel Targets', path: '2.Novel Targets' },
    { key: 'YJUSYVEM', name: 'liqiud crystal target', path: '2.Novel Targets > liqiud crystal target' },
  ]), [
    { key: 'YJUSYVEM', name: 'liqiud crystal target', path: '2.Novel Targets > liqiud crystal target' },
    { key: 'UNKNOWN1', name: '', path: '' },
  ]);
  const grouped = groupChildren(CHILDREN);
  assert.equal(grouped.notes.length, 1);
  assert.equal(grouped.attachments.length, 2);
});

// ---- 主流程 -----------------------------------------------------------------

test('enrichItem：fields 投影——只回被点名的字段，未知名回报在 unknownFields', async () => {
  installFetch();
  const only = await enrichItem({ ref: ITEM_KEY, fields: ['abstractNote'] });
  assert.deepEqual(Object.keys(only.item).sort(), ['DOI', 'abstractNote', 'date', 'itemType', 'key', 'title', 'version'].sort());
  assert.equal(only.item.abstractNote, ITEM.data.abstractNote);
  assert.equal(only.item.publicationTitle, undefined, '未点名字段不得出现');
  assert.equal(only.unknownFields, undefined);

  // 空数组 = 只要标识字段
  const identity = await enrichItem({ ref: ITEM_KEY, fields: [] });
  assert.deepEqual(Object.keys(identity.item).sort(), ['DOI', 'date', 'itemType', 'key', 'title', 'version'].sort());

  // 标识字段出现在 fields 里不算未知
  const withIdentity = await enrichItem({ ref: ITEM_KEY, fields: ['DOI', 'title', 'volume'] });
  assert.equal(withIdentity.unknownFields, undefined);
  assert.equal(withIdentity.item.volume, '9');

  // 未知名 → 回报，不抛错，也不影响已知字段
  const unknown = await enrichItem({ ref: ITEM_KEY, fields: ['volume', 'notAField', 'notAField'] });
  assert.deepEqual(unknown.unknownFields, ['notAField']);
  assert.equal(unknown.item.volume, '9');

  // 省略 fields = 全部书目字段（回归）
  const all = await enrichItem({ ref: ITEM_KEY });
  assert.equal(all.unknownFields, undefined);
  assert.equal(all.item.publicationTitle, 'Scientific Reports');
  assert.equal(all.item.extra, 'Citations (openalex): 12');
  assert.equal(all.item.language, 'en');
});

test('getAbstract：只取本地摘要（窄结构），带截断与未命中', async () => {
  installFetch();
  const hit = await getAbstract(ITEM_KEY, { library: "WENJUN_MA's Group" });
  assert.equal(hit.found, true);
  assert.equal(hit.key, ITEM_KEY);
  assert.equal(hit.title, ITEM.data.title);
  assert.equal(hit.DOI, ITEM.data.DOI);
  assert.equal(hit.abstractNote, ITEM.data.abstractNote);
  assert.equal(hit.chars, ITEM.data.abstractNote.length);
  assert.equal(hit.truncated, false);
  assert.equal('item' in hit, false, '窄结构不带整条记录');

  // 截断：用长摘要（fixture 摘要仅 74 字符，低于 maxChars 下限 200）
  const longAbs = '乙'.repeat(500);
  installFetch({
    routes: [[/\/items\/QZX8A2PX$/, () => jsonResponse({ key: ITEM_KEY, version: 1, data: { ...ITEM.data, abstractNote: longAbs } })]],
  });
  const short = await getAbstract(ITEM_KEY, { maxChars: 200 });
  assert.equal(short.abstractNote.length, 200);
  assert.equal(short.truncated, true);
  assert.equal(short.chars, 500);

  // 未命中
  installFetch({ routes: [[/\/items\/NOPE1234/, () => jsonResponse({}, { status: 404, statusText: 'Not Found' })]] });
  const miss = await getAbstract('NOPE1234');
  assert.equal(miss.found, false);
  assert.match(miss.hint, /zotero_search/);
});

test('enrichItem：默认 include（tags/collections）只打 3 个请求，不读子对象', async () => {
  const calls = installFetch();
  const report = await enrichItem({ ref: ITEM_KEY, library: "WENJUN_MA's Group" });

  assert.equal(report.found, true);
  assert.equal(report.resolvedBy, 'key');
  assert.equal(report.libraryKey, 'group:6441110');
  assert.equal(report.item.key, ITEM_KEY);
  assert.equal(report.item.itemType, 'journalArticle');
  assert.equal(report.item.year, 2019);
  assert.equal(report.item.publicationTitle, 'Scientific Reports');
  assert.equal(report.item.pages, '16435');
  assert.deepEqual(report.item.tags, ['液晶靶', '损伤阈值']);
  assert.deepEqual(report.item.collections, [
    { key: 'YJUSYVEM', name: 'liqiud crystal target', path: '2.Novel Targets > liqiud crystal target' },
  ]);
  assert.equal(report.item.notes, undefined, '未点名 notes 不应读取子对象');
  assert.equal(calls.length, 3, `应只发 3 个请求，实际 ${calls.map((c) => c.url).join(' | ')}`);
  assert.ok(calls.every((c) => c.method === 'GET'));
  assert.ok(calls.some((c) => c.url.includes('/groups/6441110/items/QZX8A2PX')));
});

test('enrichItem：DOI 与标题两种 ref 都能定位到条目', async () => {
  installFetch();
  const byDoi = await enrichItem({ ref: '10.1038/s41598-019-52305-3' });
  assert.equal(byDoi.found, true);
  assert.equal(byDoi.resolvedBy, 'doi');
  assert.equal(byDoi.libraryKey, 'user');

  const byTitle = await enrichItem({ ref: ITEM.data.title });
  assert.equal(byTitle.found, true);
  assert.equal(byTitle.resolvedBy, 'title');
});

test('enrichItem：include notes/attachments 才读子对象；笔记去 HTML 标签', async () => {
  const calls = installFetch();
  const report = await enrichItem({ ref: ITEM_KEY, include: ['notes', 'attachments'] });

  assert.equal(report.counts.notes, 1);
  assert.equal(report.counts.attachments, 2);
  assert.equal(report.item.notes[0].key, 'NOTE0001');
  assert.equal(report.item.notes[0].text, '第一行\n第二行 加粗');
  assert.equal(report.item.notes[0].truncated, false);
  assert.equal(report.item.notes[0].chars, stripHtml(CHILDREN[0].data.note).length);
  assert.deepEqual(
    report.item.attachments.map((a) => [a.key, a.contentType, a.linkMode]),
    [[ATT_PDF, 'application/pdf', 'imported_file'], [ATT_LINK, 'text/html', 'linked_url']],
  );
  assert.equal(report.item.attachments[0].path, undefined, '未开 paths 不给路径');
  assert.ok(calls.some((c) => c.url.includes(`/items/${ITEM_KEY}/children`)));
  assert.ok(!calls.some((c) => c.url.includes('/file/view/url')));
});

test('enrichItem：maxChars 生效并按 200–20000 夹紧', async () => {
  const longNote = '甲'.repeat(500);
  installFetch({
    routes: [
      [/\/items\/QZX8A2PX\/children/, () => jsonResponse([{ key: 'NOTE0009', version: 1, data: { itemType: 'note', note: `<p>${longNote}</p>` } }])],
    ],
  });
  const at200 = await enrichItem({ ref: ITEM_KEY, include: ['notes'], maxChars: 200 });
  assert.equal(at200.item.notes[0].text.length, 200);
  assert.equal(at200.item.notes[0].truncated, true);
  assert.equal(at200.item.notes[0].chars, 500);

  // 低于下限 → 夹到 200
  const clamped = await enrichItem({ ref: ITEM_KEY, include: ['notes'], maxChars: 5 });
  assert.equal(clamped.item.notes[0].text.length, 200);
  // 非整数 → 默认 2000
  const fallback = await enrichItem({ ref: ITEM_KEY, include: ['notes'], maxChars: 'abc' });
  assert.equal(fallback.item.notes[0].text.length, 500);
});

test('enrichItem：paths 解析附件磁盘路径（Windows 盘符还原 / 存在性 / linked_url 走 URL）', async () => {
  const calls = installFetch();
  const report = await enrichItem({ ref: ITEM_KEY, include: ['attachments'], paths: true });

  const pdf = report.item.attachments.find((a) => a.key === ATT_PDF);
  const link = report.item.attachments.find((a) => a.key === ATT_LINK);
  assert.equal(pdf.path, 'D:\\AI Programs\\dsh-lit-full-search\\package.json');
  assert.equal(pdf.exists, true);
  assert.equal(link.path, null);
  assert.equal(link.url, 'https://example.org/publisher');
  assert.equal(calls.filter((c) => c.url.includes('/file/view/url')).length, 2);
});

test('enrichItem：paths 指向不存在的文件时 exists=false 且不报错', async () => {
  installFetch({
    routes: [[/\/items\/ATTCH001\/file\/view\/url/, () => jsonResponse(MISSING_FILE_URL)]],
  });
  const report = await enrichItem({ ref: ITEM_KEY, include: ['attachments'], paths: true });
  const pdf = report.item.attachments.find((a) => a.key === ATT_PDF);
  assert.equal(pdf.exists, false);
  assert.equal(pdf.path, 'D:\\no-such-dir\\nope.pdf');
  assert.equal(report.found, true);
});

test('enrichItem：annotations 读附件下的批注；fulltext 读 Zotero 全文索引并截断', async () => {
  const calls = installFetch();
  const report = await enrichItem({ ref: ITEM_KEY, include: ['attachments', 'annotations', 'fulltext'], maxChars: 2000 });

  assert.equal(report.counts.annotations, 1);
  assert.equal(report.item.annotations[0].text, '关键结论：损伤阈值随温度下降');
  assert.equal(report.item.annotations[0].comment, '注意剂量单位');
  assert.equal(report.item.annotations[0].page, '3');
  assert.equal(report.counts.fulltext, 1, 'linked_url 附件无全文索引 → 只 1 份');
  assert.equal(report.item.fulltext[0].attachmentKey, ATT_PDF);
  assert.equal(report.item.fulltext[0].truncated, true);
  assert.equal(report.item.fulltext[0].text.length, 2000);
  assert.equal(report.item.fulltext[0].totalChars, 9000);
  assert.equal(calls.filter((c) => c.url.includes('/fulltext')).length, 2);
});

test('enrichItem：未命中返回 found=false，不抛错', async () => {
  installFetch({
    routes: [[/\/items\/NOPE1234/, () => jsonResponse({}, { status: 404, statusText: 'Not Found' })]],
  });
  const report = await enrichItem({ ref: 'NOPE1234' });
  assert.equal(report.found, false);
  assert.equal(report.ref, 'NOPE1234');
  assert.match(report.hint, /zotero_search/);
});

test('enrichItem：zotero://…/attachment/KEY 会转到父条目', async () => {
  installFetch({
    routes: [
      [
        /\/items\/ATTCH001$/,
        () => jsonResponse({ key: ATT_PDF, version: 1, data: { itemType: 'attachment', parentItem: ITEM_KEY, title: 'Full Text PDF' } }),
      ],
    ],
  });
  const report = await enrichItem({ ref: `zotero://user/0/attachment/${ATT_PDF}` });
  assert.equal(report.found, true);
  assert.equal(report.resolvedBy, 'zotero-attachment');
  assert.equal(report.item.key, ITEM_KEY);
});

test('enrichItem：子对象读取失败只记 warning，主记录仍返回', async () => {
  installFetch({
    routes: [[/\/items\/QZX8A2PX\/children/, () => jsonResponse({ error: 'boom' }, { status: 500, statusText: 'Server Error' })]],
  });
  const report = await enrichItem({ ref: ITEM_KEY, include: ['notes'] });
  assert.equal(report.found, true);
  assert.equal(report.item.key, ITEM_KEY);
  assert.equal(report.counts.notes, 0);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /读取子条目失败/);
});

test('enrichItem：收藏夹映射失败降级为只回 key，并记 warning', async () => {
  installFetch({
    routes: [[/\/collections\?limit=100/, () => jsonResponse({ error: 'boom' }, { status: 500, statusText: 'Server Error' })]],
  });
  const report = await enrichItem({ ref: ITEM_KEY, include: ['collections'] });
  assert.equal(report.found, true);
  assert.deepEqual(report.item.collections, [{ key: 'YJUSYVEM', name: '', path: '' }]);
  assert.match(report.warnings[0], /收藏夹映射失败/);
});
