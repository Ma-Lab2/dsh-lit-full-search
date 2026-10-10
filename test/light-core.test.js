import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OPENALEX_API_BASE,
  S2_API_BASE,
  ZOTERO_API_BASE,
  toSearchView,
  searchOpenAlex,
  searchSemanticScholar,
  lookupOpenAlexByDoi,
  citedByOpenAlex,
  mapOpenAlexWork,
  mapS2Paper,
  invertOpenAlexAbstract,
  normalizeDoi,
  zoteroSearch,
  zoteroFindByDoi,
  zoteroCreateItem,
  __setS2IntervalForTest,
  nextRedirectUrl,
} from '../lib/light-core.js';

// 单测里关掉 S2 节流（默认 1.1s 间隔会拖慢套件）；节流行为由专门用例开回来测。
__setS2IntervalForTest(0);

/** 覆盖全局 fetch 的测试替身：记录最后一次请求 {url, init}，返回给定 JSON。 */
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

test('normalizeDoi：去 doi.org 前缀与空白', () => {
  assert.equal(normalizeDoi('10.1103/RevModPhys.85.751'), '10.1103/RevModPhys.85.751');
  assert.equal(normalizeDoi('https://doi.org/10.1234/abc'), '10.1234/abc');
  assert.equal(normalizeDoi('https://dx.doi.org/10.1234/abc'), '10.1234/abc');
  assert.equal(normalizeDoi(''), '');
  assert.equal(normalizeDoi(undefined), '');
});

test('invertOpenAlexAbstract：重建摘要', () => {
  const index = { 'of': [1], 'science': [2], 'The': [0] };
  assert.equal(invertOpenAlexAbstract(index), 'The of science');
  assert.equal(invertOpenAlexAbstract({}), '');
});

test('mapOpenAlexWork：网络 JSON → 精简 WorkItem', () => {
  const work = {
    id: 'https://openalex.org/W123',
    display_name: 'A Title',
    publication_year: 2021,
    cited_by_count: 42,
    doi: 'https://doi.org/10.1/x',
    primary_location: { source: { display_name: 'Nature' }, landing_page_url: 'https://nature.example/x', pdf_url: 'https://pdf.example/x' },
    best_oa_location: { pdf_url: 'https://oa.example/x' },
    abstract_inverted_index: { 'Hello': [0], 'world': [1] },
    authorships: [
      { author: { display_name: 'Alice' } },
      { author: { display_name: 'Bob' } },
      { author: { display_name: 'Alice' } }, // 去重
    ],
  };
  const item = mapOpenAlexWork(work);
  assert.equal(item.title, 'A Title');
  assert.deepEqual(item.authors, ['Alice', 'Bob']);
  assert.equal(item.year, 2021);
  assert.equal(item.venue, 'Nature');
  assert.equal(item.doi, '10.1/x');
  assert.equal(item.abstract, 'Hello world');
  assert.equal(item.oaPdfUrl, 'https://oa.example/x');
  assert.equal(item.citationCount, 42);
  assert.equal(item.externalIds.openalex, 'https://openalex.org/W123');
});

test('mapOpenAlexWork：缺字段容错', () => {
  const item = mapOpenAlexWork({});
  assert.equal(item.title, '');
  assert.equal(item.year, null);
  assert.equal(item.doi, '');
  assert.equal(item.citationCount, null);
  assert.deepEqual(item.authors, []);
});

test('searchOpenAlex：URL 组装（search/per_page/filter/认证）', async () => {
  const calls = stubFetch({ results: [mapOpenAlexWork({ id: 'W1', display_name: 't' })] });
  const res = await searchOpenAlex('laser', { limit: 5, yearFrom: 2019, yearTo: 2021, mailto: 'me@x.y' });
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, OPENALEX_API_BASE + '/works');
  assert.equal(url.searchParams.get('search'), 'laser');
  assert.equal(url.searchParams.get('per_page'), '5');
  assert.equal(url.searchParams.get('filter'), 'publication_year:>2018,publication_year:<2022');
  assert.equal(url.searchParams.get('mailto'), 'me@x.y');
  assert.equal(res.diagnostics.openalex.ok, true);
  assert.equal(res.items.length, 1);
});

test('searchOpenAlex：per_page 夹紧 1..25、api_key 优先于 mailto', async () => {
  const calls = stubFetch({ results: [] });
  await searchOpenAlex('x', { limit: 999, apiKey: 'K', mailto: 'm@x.y' });
  let url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('per_page'), '25');
  assert.equal(url.searchParams.get('api_key'), 'K');
  assert.equal(url.searchParams.get('mailto'), null);
  await searchOpenAlex('x', { limit: 0 });
  url = new URL(calls[1].url);
  assert.equal(url.searchParams.get('per_page'), '1');
});

test('lookupOpenAlexByDoi：按 DOI 查询', async () => {
  const calls = stubFetch({ id: 'W5', display_name: 'Ada' });
  const item = await lookupOpenAlexByDoi('10.1/abc');
  assert.match(calls[0].url, /works\/doi:10\.1%2Fabc/);
  assert.equal(item.title, 'Ada');
  // 404 → fetchJson 抛错（light-core 不吞）；工具层用 catch 处理
});

test('citedByOpenAlex：DOI 先 lookup 再 filter=cites；work ID 直查', async () => {
  let n = 0;
  const calls = stubFetch(() => {
    n += 1;
    if (n === 1) return { id: 'https://openalex.org/W9', display_name: 'seed' };
    return { results: [] };
  });
  await citedByOpenAlex('10.1/seed', { limit: 3 });
  // URLSearchParams 会把 filter 值里的 : / 编码为 %3A %2F
  assert.equal(decodeURIComponent(new URL(calls[1].url).searchParams.get('filter')), 'cites:https://openalex.org/W9');
  assert.equal(new URL(calls[1].url).searchParams.get('per_page'), '3');

  n = 0;
  const calls2 = stubFetch({ results: [] });
  await citedByOpenAlex('W42', { limit: 10 });
  assert.equal(new URL(calls2[0].url).searchParams.get('filter'), 'cites:W42');
});

test('citedByOpenAlex：解析不出 work ID 时抛错', async () => {
  stubFetch({});
  await assert.rejects(() => citedByOpenAlex('10.1/none'), /无法解析/);
});

test('mapS2Paper：网络 JSON → 精简 WorkItem（与 core mapS2Paper 对齐）', () => {
  const paper = {
    paperId: 'S2PID',
    title: 'S2 Paper',
    authors: [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Alice' }],
    year: 2022,
    venue: 'NeurIPS',
    externalIds: { DOI: 'https://doi.org/10.2/s2' },
    abstract: '  hello   world  ',
    citationCount: 7,
    openAccessPdf: { url: 'https://oa.example/s2.pdf' },
    url: 'https://semanticscholar.example/p/S2PID',
  };
  const item = mapS2Paper(paper);
  assert.equal(item.title, 'S2 Paper');
  assert.deepEqual(item.authors, ['Alice', 'Bob']);
  assert.equal(item.year, 2022);
  assert.equal(item.doi, '10.2/s2');
  assert.equal(item.abstract, 'hello world');
  assert.equal(item.oaPdfUrl, 'https://oa.example/s2.pdf');
  assert.equal(item.source, 'semanticscholar');
  assert.equal(item.externalIds.s2, 'S2PID');
  // 无标题条目丢弃
  assert.equal(mapS2Paper({ paperId: 'X' }), null);
  assert.equal(mapS2Paper(null), null);
});

test('searchSemanticScholar：并发请求串行排队并保持最小间隔（S2 个人 key 配额 1 rps）', async () => {
  __setS2IntervalForTest(80);
  try {
    const times = [];
    stubFetch(() => (times.push(Date.now()), { data: [] }));
    await Promise.all([searchSemanticScholar('a', { s2ApiKey: 'K' }), searchSemanticScholar('b', { s2ApiKey: 'K' }), searchSemanticScholar('c', { s2ApiKey: 'K' })]);
    assert.equal(times.length, 3);
    for (let i = 1; i < times.length; i += 1) assert.ok(times[i] - times[i - 1] >= 70, `间隔过短：${times[i] - times[i - 1]}ms`);
  } finally {
    __setS2IntervalForTest(0);
  }
});

test('searchSemanticScholar：429 退避后重试一次；二次 429 才抛错', async () => {
  let n = 0;
  globalThis.fetch = async () => {
    n += 1;
    if (n === 1) return { ok: false, status: 429, statusText: 'Too Many Requests', headers: new Map(), text: async () => '{"message":"Too Many Requests"}' };
    return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ data: [{ paperId: 'P', title: 'T', externalIds: {} }] }) };
  };
  const res = await searchSemanticScholar('x', { s2ApiKey: 'K' });
  assert.equal(n, 2);
  assert.equal(res.items.length, 1);

  n = 0;
  globalThis.fetch = async () => {
    n += 1;
    return { ok: false, status: 429, statusText: 'Too Many Requests', headers: new Map(), text: async () => '' };
  };
  await assert.rejects(() => searchSemanticScholar('x', { s2ApiKey: 'K' }), /429/);
  assert.equal(n, 2);
  // 失败不能卡住队列
  stubFetch({ data: [] });
  assert.equal((await searchSemanticScholar('y', { s2ApiKey: 'K' })).items.length, 0);
});

test('searchSemanticScholar：瞬时网络失败（如 ECONNRESET）重试一次即恢复，不熔断', async () => {
  let n = 0;
  globalThis.fetch = async () => {
    n += 1;
    if (n === 1) throw new TypeError('read ECONNRESET');
    return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ data: [{ paperId: 'P', title: 'T', externalIds: {} }] }) };
  };
  const res = await searchSemanticScholar('x', { s2ApiKey: 'K' });
  assert.equal(n, 2);
  assert.equal(res.items.length, 1);
  // 未熔断：下一次请求照常发出
  await searchSemanticScholar('y', { s2ApiKey: 'K' });
  assert.equal(n, 3);
});

test('searchSemanticScholar：网络层失败后熔断，后续请求不再逐个等连接超时', async () => {
  let n = 0;
  globalThis.fetch = async () => {
    n += 1;
    throw new TypeError('fetch failed');
  };
  await assert.rejects(() => searchSemanticScholar('a', { s2ApiKey: 'K' }), /网络请求失败/);
  await assert.rejects(() => searchSemanticScholar('b', { s2ApiKey: 'K' }), /网络不可达/);
  assert.equal(n, 2, '首次网络失败重试一次（代理→直连），之后熔断期间不再发请求');
  __setS2IntervalForTest(0); // 重置熔断，避免影响后续用例
});

test('nextRedirectUrl：跟随 301/302/303/307/308，其余不跟随（回归：代理曾完全不跟随重定向，OA PDF 全挂）', () => {
  const base = 'https://www.frontiersin.org/articles/x/pdf';
  for (const status of [301, 302, 303, 307, 308]) {
    assert.equal(nextRedirectUrl(status, 'https://cdn.example/f.pdf', base), 'https://cdn.example/f.pdf', `status ${status} 应跟随`);
  }
  assert.equal(nextRedirectUrl(301, '/local/f.pdf', base), 'https://www.frontiersin.org/local/f.pdf', '相对 Location 按 base 解析');
  for (const status of [200, 204, 400, 404, 500]) {
    assert.equal(nextRedirectUrl(status, 'https://cdn.example/f.pdf', base), null, `status ${status} 不应跟随`);
  }
  assert.equal(nextRedirectUrl(301, null, base), null, '无 Location 不跟随');
  assert.equal(nextRedirectUrl(301, '', base), null, '空 Location 不跟随');
  assert.equal(nextRedirectUrl(301, 'https://x/y', base, 0), null, '跳数用尽不跟随');
  assert.equal(nextRedirectUrl(301, '//cdn.example/f.pdf', base), 'https://cdn.example/f.pdf', '协议相对 Location 继承 base 协议');
});

test('proxyFetch：经 CONNECT 隧道发请求；代理不可达时给出明确错误', async () => {
  const { default: http } = await import('node:http');
  const { default: net } = await import('node:net');
  const { proxyFetch } = await import('../lib/light-core.js');
  // 本地 CONNECT 代理：记录隧道目标后直接拒绝（不出网，验证请求确实经过代理）
  const seen = [];
  const server = http.createServer();
  server.on('connect', (req, socket) => {
    seen.push(req.url);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    await assert.rejects(() => proxyFetch('https://api.semanticscholar.org/x', {}, `http://127.0.0.1:${port}`), /拒绝隧道：HTTP 403/);
    assert.deepEqual(seen, ['api.semanticscholar.org:443']);
  } finally {
    await new Promise((r) => server.close(r));
  }
  // 取一个空闲端口后关闭，确保无人监听
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const dead = probe.address().port;
  await new Promise((r) => probe.close(r));
  await assert.rejects(() => proxyFetch('https://example.org/', {}, `http://127.0.0.1:${dead}`), /代理 127\.0\.0\.1:\d+ 不可用/);

  // externalFetch：代理本身连不上 → 回落直连
  const { externalFetch } = await import('../lib/light-core.js');
  const direct = [];
  globalThis.fetch = async (u) => (direct.push(u), { ok: true, status: 200, headers: new Map(), text: async () => '{}' });
  const res = await externalFetch('https://example.org/', {}, `http://127.0.0.1:${dead}`);
  assert.equal(res.status, 200);
  assert.deepEqual(direct, ['https://example.org/']);
});

test('searchSemanticScholar：URL 组装（query/limit/fields/year）+ x-api-key 头', async () => {
  const calls = stubFetch({ data: [{ paperId: 'P1', title: 'Hit', externalIds: {} }] });
  const res = await searchSemanticScholar('laser', { limit: 5, yearFrom: 2019, yearTo: 2021, s2ApiKey: 'S2K' });
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, S2_API_BASE + '/paper/search');
  assert.equal(url.searchParams.get('query'), 'laser');
  assert.equal(url.searchParams.get('limit'), '5');
  assert.equal(url.searchParams.get('year'), '2019-2021');
  assert.ok(url.searchParams.get('fields').includes('externalIds'));
  assert.equal(calls[0].init.headers['x-api-key'], 'S2K');
  assert.equal(res.diagnostics.semanticscholar.ok, true);
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].source, 'semanticscholar');
  // limit 夹紧 1..25；无密钥则不带 x-api-key 头
  const calls2 = stubFetch({ data: [] });
  await searchSemanticScholar('x', { limit: 999 });
  assert.equal(new URL(calls2[0].url).searchParams.get('limit'), '25');
  assert.equal(calls2[0].init.headers['x-api-key'], undefined);
});

test('zoteroSearch：本地 API 查询 + 映射 + 过滤附件/笔记/空壳', async () => {
  const calls = stubFetch([
    {
      key: 'K1',
      data: { itemType: 'journalArticle', title: 'Paper A', creators: [{ firstName: 'Alice', lastName: 'Smith' }], date: '2020-05-01', DOI: 'https://doi.org/10.1/a', url: 'https://x.a' },
    },
    { key: 'K2', data: { itemType: 'attachment', title: '', creators: [], date: '' } }, // 附件子条目，应被过滤
    // 回归：Zotero 里把 PDF 拖进来会变成 title='PDF' 的顶层附件，按论文标题检索会命中它（全文索引匹配）
    { key: 'K3', data: { itemType: 'attachment', title: 'PDF', creators: [], date: '' } },
    { key: 'K4', data: { itemType: 'note', title: 'AI4Paper 精读', creators: [], date: '' } },
    { key: 'K5', data: { itemType: 'journalArticle', title: '', creators: [], date: '' } }, // 无标题无 DOI 的空壳
  ]);
  const items = await zoteroSearch('paper');
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, ZOTERO_API_BASE + '/users/0/items');
  assert.equal(url.searchParams.get('q'), 'paper');
  assert.equal(url.searchParams.get('qmode'), 'everything');
  assert.equal(url.searchParams.get('limit'), '20');
  assert.equal(url.searchParams.get('itemType'), '-attachment || -note || -annotation');
  assert.deepEqual(items.map((i) => i.key), ['K1'], '只应返回顶层文献条目');
  assert.equal(items[0].authors[0], 'Alice Smith');
  assert.equal(items[0].year, '2020');
  assert.equal(items[0].doi, '10.1/a');
  assert.equal(items[0].libraryKey, 'user');
});

test('zoteroFindByDoi：归一化比较精确查重', async () => {
  stubFetch([
    { key: 'K1', data: { itemType: 'journalArticle', title: 'Paper A', creators: [], date: '', DOI: 'https://doi.org/10.1/a', url: '' } },
    { key: 'K2', data: { itemType: 'journalArticle', title: 'Paper B', creators: [], date: '', DOI: '10.1/b', url: '' } },
  ]);
  const found = await zoteroFindByDoi('https://doi.org/10.1/a');
  assert.equal(found.key, 'K1');
  const none = await zoteroFindByDoi('10.1/zzz');
  assert.equal(none, null);
});

test('zoteroCreateItem：成功读 successful.key，失败读 failed.message', async () => {
  stubFetch({ successful: { '0': { key: 'NEWK' } } });
  const res = await zoteroCreateItem({ title: 'T', doi: '10.1/t', creators: [{ firstName: 'A', lastName: 'B' }], date: '2021' }, { zoteroKey: 'K' });
  assert.equal(res.itemKey, 'NEWK');

  stubFetch({ successful: {}, failed: { '0': { message: 'API key required' } } });
  await assert.rejects(() => zoteroCreateItem({ title: 'T' }, {}), /API key required/);
});

test('zoteroCreateItem：写前自动 ping 学习 Zotero-Server-ID（Zotero 10+ 428 防护）', async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url) === `${ZOTERO_API_BASE}/`) {
      return { ok: true, status: 200, statusText: 'OK', headers: { get: (k) => (k === 'Zotero-Server-ID' ? 'SID-1' : null) }, text: async () => '' };
    }
    return { ok: true, status: 200, statusText: 'OK', headers: { get: () => null }, text: async () => JSON.stringify({ successful: { '0': { key: 'NEWK2' } } }) };
  };
  const res = await zoteroCreateItem({ title: 'T' }, { zoteroKey: 'K' });
  assert.equal(res.itemKey, 'NEWK2');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${ZOTERO_API_BASE}/`); // 先 ping
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[1].init.headers['Zotero-Server-ID'], 'SID-1');
  assert.equal(calls[1].init.headers['Zotero-API-Key'], 'K');
  assert.equal(calls[1].init.headers['Connection'], 'close');
});

test('zoteroCreateItem：已从读请求学习 Server-ID 后不再 ping', async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const isWrite = init.method === 'POST';
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: (k) => (k === 'Zotero-Server-ID' ? 'SID-2' : null) },
      text: async () => (isWrite ? JSON.stringify({ successful: { '0': { key: 'NEWK3' } } }) : JSON.stringify([])),
    };
  };
  await zoteroSearch('x'); // 读请求响应头学习 SID-2（覆盖 SID-1）
  const res = await zoteroCreateItem({ title: 'T' }, {});
  assert.equal(res.itemKey, 'NEWK3');
  assert.equal(calls.length, 2); // 检索 + 写入，无 ping
  assert.equal(calls[1].init.headers['Zotero-Server-ID'], 'SID-2');
});

test('toSearchView：精简单投影', () => {
  const view = toSearchView({ title: 'T', authors: ['a', 'b'], year: 2020, venue: 'V', doi: 'd', url: 'u', citationCount: 3, source: 's' });
  assert.deepEqual(view, { title: 'T', authors: ['a', 'b'], year: 2020, venue: 'V', doi: 'd', url: 'u', citationCount: 3, source: 's' });
});