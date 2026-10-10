/**
 * dsh-lit-full-search 轻量核心：零依赖 fetch 直连 OpenAlex / Zotero 本地 API。
 *
 * 刻意不 import 项目 core 库——插件以 tgz 独立分发，无 npm 依赖、无构建产物依赖。
 * 网络与映射形状与 core/providers/openalex.ts、core/zotero/client.ts 保持一致（精简版）：
 *  - OpenAlex /works 检索、/works/doi:xxx 查询、filter=cites:xxx 被引
 *  - Zotero 本地 API 只读检索 / 建条目 / 查重（写操作需 LIT_SEARCH_ZOTERO_KEY 或已完成授权）
 *
 * 新增独立测试文件之前请确认 light-core 与 core 的 wire 格式同步演进。
 */
import { createHash } from 'node:crypto';

/** OpenAlex API 基址。 */
export const OPENALEX_API_BASE = 'https://api.openalex.org';

/** Semantic Scholar Graph API 基址。 */
export const S2_API_BASE = 'https://api.semanticscholar.org/graph/v1';

/** Zotero 本地 API 基址（Zotero 10+，设置 → 高级 → 安全 → 允许其他应用程序通过本地 API 访问 Zotero）。 */
export const ZOTERO_API_BASE = 'http://localhost:23119/api';

/** WorkItem 精简投影：保持与 core 的 WorkItem 字段一致（无 externalIds，够用即可）。 */
export function toSearchView(item) {
  return {
    title: item.title || '',
    authors: Array.isArray(item.authors) ? item.authors.slice(0, 30) : [],
    year: item.year ?? null,
    venue: item.venue || '',
    doi: item.doi || '',
    url: item.url || '',
    citationCount: typeof item.citationCount === 'number' ? item.citationCount : null,
    source: item.source || '',
  };
}

/** OpenAlex /works 检索。 */
export async function searchOpenAlex(query, options = {}) {
  const { limit = 10, yearFrom, yearTo, apiKey, s2ApiKey, mailto } = options;
  const url = new URL(`${OPENALEX_API_BASE}/works`);
  url.searchParams.set('search', String(query ?? ''));
  url.searchParams.set('per_page', String(Math.min(Math.max(limit, 1), 25)));
  const yearFilter = [];
  if (yearFrom) yearFilter.push(`publication_year:>${Number(yearFrom) - 1}`);
  if (yearTo) yearFilter.push(`publication_year:<${Number(yearTo) + 1}`);
  if (yearFilter.length > 0) url.searchParams.set('filter', yearFilter.join(','));
  applyOpenAlexAuth(url, { apiKey, mailto });
  const data = await fetchJson(url.toString());
  return {
    items: (Array.isArray(data.results) ? data.results : []).map(mapOpenAlexWork),
    diagnostics: { openalex: { ok: true, count: data.results?.length ?? 0 } },
  };
}

/** 按 DOI 查 OpenAlex work。 */
export async function lookupOpenAlexByDoi(doi, options = {}) {
  const { apiKey, s2ApiKey, mailto } = options;
  const url = new URL(`${OPENALEX_API_BASE}/works/doi:${encodeURIComponent(doi)}`);
  applyOpenAlexAuth(url, { apiKey, mailto });
  const data = await fetchJson(url.toString());
  return data ? mapOpenAlexWork(data) : null;
}

/** 被引列表：DOI 或 OpenAlex work ID → /works?filter=cites:xxx。 */
export async function citedByOpenAlex(identifier, options = {}) {
  const { limit = 25, apiKey, s2ApiKey, mailto } = options;
  let openAlexId = identifier;
  if (!/^W\d+$/i.test(identifier)) {
    // 非 OpenAlex work ID（如 DOI）：先按 DOI 查询拿到 work ID
    const work = await lookupOpenAlexByDoi(identifier, { apiKey, mailto });
    if (!work?.externalIds?.openalex) {
      throw new Error(`无法解析「${identifier}」为 OpenAlex work ID`);
    }
    openAlexId = work.externalIds.openalex;
  }
  const url = new URL(`${OPENALEX_API_BASE}/works`);
  url.searchParams.set('filter', `cites:${openAlexId}`);
  url.searchParams.set('per_page', String(Math.min(Math.max(limit, 1), 200)));
  applyOpenAlexAuth(url, { apiKey, mailto });
  const data = await fetchJson(url.toString());
  return {
    items: (Array.isArray(data.results) ? data.results : []).map(mapOpenAlexWork),
    diagnostics: { openalex: { ok: true, count: data.results?.length ?? 0 } },
  };
}

/** OpenAlex work JSON → 精简 WorkItem。 */
// ---- Semantic Scholar --------------------------------------------------------

/** S2 检索字段集（与 core/providers/semanticscholar.ts 的 FIELDS 保持一致）。 */
const S2_FIELDS = 'title,authors.name,year,venue,externalIds,abstract,citationCount,openAccessPdf,url';

/**
 * Semantic Scholar /paper/search 检索。
 * 仅在配置了 S2 API Key 时由 lit_search 调用（匿名共享池不稳定，不做匿名回落检索）。
 * 不做节流（精简版）：lit_search 每次最多并发一次 S2 请求，远低于 1 rps 配额。
 */
export async function searchSemanticScholar(query, options = {}) {
  const { limit = 10, yearFrom, yearTo, s2ApiKey } = options;
  const url = new URL(`${S2_API_BASE}/paper/search`);
  url.searchParams.set('query', String(query ?? ''));
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 25)));
  url.searchParams.set('fields', S2_FIELDS);
  if (yearFrom || yearTo) url.searchParams.set('year', `${yearFrom ?? ''}-${yearTo ?? ''}`);
  const headers = {};
  if (s2ApiKey) headers['x-api-key'] = s2ApiKey;
  const data = await fetchJson(url.toString(), { headers });
  const papers = Array.isArray(data?.data) ? data.data : [];
  return {
    items: papers.map(mapS2Paper).filter(Boolean),
    diagnostics: { semanticscholar: { ok: true, count: papers.length } },
  };
}

/** S2 paper JSON → 精简 WorkItem（与 core/providers/semanticscholar.ts mapS2Paper 对齐；无标题条目丢弃）。 */
export function mapS2Paper(paper) {
  if (!paper?.title) return null;
  const authors = new Set();
  for (const a of paper.authors ?? []) {
    if (a?.name) authors.add(a.name);
  }
  return {
    title: paper.title,
    authors: [...authors].slice(0, 30),
    year: typeof paper.year === 'number' ? paper.year : null,
    venue: paper.venue || '',
    doi: normalizeDoi(paper.externalIds?.DOI),
    url: paper.url || '',
    citationCount: typeof paper.citationCount === 'number' ? paper.citationCount : null,
    abstract: typeof paper.abstract === 'string' ? paper.abstract.replace(/\s+/g, ' ').trim().slice(0, 100000) : '',
    oaPdfUrl: paper.openAccessPdf?.url || '',
    source: 'semanticscholar',
    externalIds: {
      s2: paper.paperId || '',
      doi: paper.externalIds?.DOI || '',
    },
  };
}

export function mapOpenAlexWork(work) {
  const authors = new Set();
  for (const a of work.authorships ?? []) {
    const name = a?.author?.display_name;
    if (name) authors.add(name);
  }
  const inverted = work.abstract_inverted_index;
  const abstract = inverted ? invertOpenAlexAbstract(inverted).slice(0, 100000) : '';
  return {
    title: work.title || work.display_name || '',
    authors: [...authors].slice(0, 30),
    year: typeof work.publication_year === 'number' ? work.publication_year : null,
    venue: work.primary_location?.source?.display_name || '',
    doi: work.doi ? String(work.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') : '',
    url: work.primary_location?.landing_page_url || work.id || '',
    citationCount: typeof work.cited_by_count === 'number' ? work.cited_by_count : null,
    abstract,
    oaPdfUrl: work.best_oa_location?.pdf_url || work.primary_location?.pdf_url || '',
    source: 'openalex',
    externalIds: {
      openalex: work.id || '',
      doi: work.doi || '',
    },
  };
}

/** inverted index → 正文。 */
export function invertOpenAlexAbstract(index) {
  const words = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const p of positions) words[p] = word;
  }
  return words.filter(Boolean).join(' ').trim();
}

/** OpenAlex 认证：api_key 或 mailto（匿名回落无参）。 */
function applyOpenAlexAuth(url, { apiKey, mailto } = {}) {
  if (apiKey) url.searchParams.set('api_key', apiKey);
  else if (mailto) url.searchParams.set('mailto', mailto);
}

/**
 * Zotero 10+ 写请求防护：写操作必须携带 Zotero-Server-ID 响应头值（缺失 → 428）。
 * 从任意 Zotero 响应头学习并模块级缓存；写前未掌握时先 ping 一次 API 根。
 * 对应 core/zotero/client.ts 的 recordHeaders + ping 逻辑（精简版）。
 */
let zoteroServerId = null;

/**
 * 库路径：缺省 / 'user' → /users/0（本地个人库）；'group:<id>' → /groups/<id>。
 * Zotero 本地 API 与 Web API 路径同形，个人库固定用 users/0。
 */
export function zoteroLibraryPrefix(libraryKey = 'user') {
  const key = String(libraryKey ?? 'user').trim();
  if (key === '' || key === 'user') return '/users/0';
  const group = key.match(/^group:(\d+)$/);
  if (group) return `/groups/${group[1]}`;
  throw new Error(`无法识别的 libraryKey「${key}」：应为 'user' 或 'group:<id>'`);
}

function learnZoteroHeaders(res) {
  const sid = res?.headers?.get?.('Zotero-Server-ID');
  if (sid) zoteroServerId = sid;
}

/** 探测 Zotero 本地 API 根，学习 Zotero-Server-ID；失败静默（由后续写请求自身报错）。 */
async function zoteroPing() {
  try {
    const res = await fetch(`${ZOTERO_API_BASE}/`, { headers: { Connection: 'close' } });
    learnZoteroHeaders(res);
    await res.text().catch(() => '');
  } catch {
    /* ignore */
  }
}

/**
 * 弹窗请求 Zotero 写入授权（POST /local/authorize，Zotero 客户端会弹「允许 / 始终允许」）。
 * 得到的是本地实例签发的 key——只在本地 API 有效（拿到 api.zotero.org 上会被判 Invalid）。
 */
export async function zoteroAuthorize(appName = 'dsh-lit-full-search') {
  if (!zoteroServerId) await zoteroPing();
  let res;
  try {
    res = await fetch(`${ZOTERO_API_BASE}/local/authorize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Connection: 'close',
        ...(zoteroServerId ? { 'Zotero-Server-ID': zoteroServerId } : {}),
      },
      body: JSON.stringify({ appName }),
    });
  } catch (err) {
    throw new Error(`无法连接 Zotero 进行授权：${err instanceof Error ? err.message : String(err)}`);
  }
  learnZoteroHeaders(res);
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`Zotero 授权失败（HTTP ${res.status}）${text ? `：${text.slice(0, 200)}` : ''}`);
  const data = text ? JSON.parse(text) : null;
  if (!data?.key) throw new Error('Zotero 授权响应缺少 key');
  return data.key;
}

/**
 * Zotero 请求底座：统一补 Connection: close（HTTP/1.0 服务器）与 Zotero-Server-ID
 * （Zotero 10+ 写请求缺它会 428）；首次 401 时弹窗授权一次再用新 key 重试
 * （remember=false 的 key 单次请求后即消耗）。返回原始 Response，由调用方解析。
 */
async function zoteroRequest(path, options = {}) {
  const { method = 'GET', body, headers: extraHeaders = {}, write = false, zoteroKey, authRetry = true } = options;
  const send = async (key) => {
    if (write && !zoteroServerId) await zoteroPing();
    const headers = { Connection: 'close', ...extraHeaders };
    if (write && zoteroServerId) headers['Zotero-Server-ID'] = zoteroServerId;
    if (write && key) headers['Zotero-API-Key'] = key;
    return fetch(`${ZOTERO_API_BASE}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
  };
  let res = await send(zoteroKey);
  if (write && res.status === 401 && authRetry) {
    const key = await zoteroAuthorize();
    res = await send(key);
  }
  learnZoteroHeaders(res);
  return res;
}

/** JSON 写请求（POST/PATCH）→ 解析后的响应体；非 2xx 抛错。 */
async function zoteroWrite(path, body, options = {}) {
  const method = options.method ?? 'POST';
  const res = await zoteroRequest(path, {
    method,
    write: true,
    zoteroKey: options.zoteroKey,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`Zotero 写入失败：HTTP ${res.status} ${res.statusText}${text ? `：${text.slice(0, 200)}` : ''}`);
  }
  return text ? JSON.parse(text) : null;
}

/** 库列表：个人库 + 已同步到本地的群组库（GET /users/0/groups）。 */
export async function zoteroListLibraries() {
  const libraries = [{ libraryKey: 'user', id: 0, type: 'user', name: '我的文库' }];
  let groups;
  try {
    groups = await fetchJson(`${ZOTERO_API_BASE}/users/0/groups`, { headers: { Connection: 'close' } });
  } catch {
    return libraries; // 未开启本地 API 或无群组：只返回个人库
  }
  for (const entry of Array.isArray(groups) ? groups : []) {
    const data = entry?.data ?? entry;
    const id = data?.id ?? entry?.id;
    if (id === undefined || id === null || id === '') continue;
    libraries.push({
      libraryKey: `group:${String(id)}`,
      id: Number(id),
      type: 'group',
      name: typeof data?.name === 'string' && data.name ? data.name : `群组库 ${String(id)}`,
    });
  }
  return libraries;
}

/**
 * 库内收藏夹列表（含条目数与父收藏夹），用于把「收藏夹名」解析成 key。
 * 每页 100 条分页取全量。
 */
export async function zoteroListCollections(options = {}) {
  const { libraryKey = 'user' } = options;
  const prefix = zoteroLibraryPrefix(libraryKey);
  const out = [];
  for (let start = 0; start < 2000; start += 100) {
    const page = await fetchJson(`${ZOTERO_API_BASE}${prefix}/collections?limit=100&start=${start}`, {
      headers: { Connection: 'close' },
    });
    const list = Array.isArray(page) ? page : [];
    for (const entry of list) {
      out.push({
        key: entry?.key ?? '',
        name: entry?.data?.name ?? '',
        parentKey: entry?.data?.parentCollection ?? null,
        itemCount: typeof entry?.meta?.numItems === 'number' ? entry.meta.numItems : null,
      });
    }
    if (list.length < 100) break;
  }
  // 补全路径（父在子前即可解析；收藏夹层级很浅，直接循环解析父链）
  const byKey = new Map(out.map((c) => [c.key, c]));
  for (const collection of out) {
    const names = [collection.name];
    let parentKey = collection.parentKey;
    let guard = 0;
    while (parentKey && guard < 20) {
      const parent = byKey.get(parentKey);
      if (!parent) break;
      names.unshift(parent.name);
      parentKey = parent.parentKey;
      guard += 1;
    }
    collection.path = names.join(' > ');
  }
  return out;
}

/** Zotero 只读检索（库条目，不含附件/笔记/批注）；libraryKey 支持 'user' / 'group:<id>'。 */
export async function zoteroSearch(query, options = {}) {
  const { limit = 20, qmode = 'everything', libraryKey = 'user' } = options;
  const url = new URL(`${ZOTERO_API_BASE}${zoteroLibraryPrefix(libraryKey)}/items`);
  url.searchParams.set('q', String(query ?? ''));
  url.searchParams.set('qmode', qmode === 'titleCreatorYear' ? 'titleCreatorYear' : 'everything');
  url.searchParams.set('itemType', '-attachment || note || annotation');
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 100)));
  // Connection: close —— 防止 undici 复用 Zotero HTTP/1.0 已关闭的 socket（"fetch failed"）
  const data = await fetchJson(url.toString(), { headers: { Connection: 'close' } });
  const items = (Array.isArray(data) ? data : []).map((entry) => ({
    key: entry.key || '',
    itemType: entry.data?.itemType || '',
    title: entry.data?.title || '',
    authors: creatorsToAuthors(entry.data?.creators),
    year: extractYear(entry.data?.date),
    doi: normalizeDoi(entry.data?.DOI),
    url: entry.data?.url || '',
    libraryKey,
  }));
  // 本地 API 的 q 是「全文索引 + 标题/创建者/年份」混合匹配，过滤掉空 title（附件子条目等）
  return items.filter((i) => i.title || i.doi);
}

/** 按 DOI 在**指定库**中精确查重（qmode=everything；归一化后比较）。 */
export async function zoteroFindByDoi(doi, options = {}) {
  const normalized = normalizeDoi(doi);
  if (!normalized) return null;
  const items = await zoteroSearch(normalized, { ...options, qmode: 'everything', limit: Math.min(options.limit ?? 25, 100) });
  return items.find((i) => i.doi === normalized) ?? null;
}

/**
 * Zotero 建条目（写操作；需要 zoteroKey，401 时会弹 Zotero 授权窗重试一次）。
 * libraryKey 缺省写入本地个人库，'group:<id>' 写入群组库。
 */
export async function zoteroCreateItem(metadata, options = {}) {
  const { zoteroKey, collectionKey, libraryKey = 'user' } = options;
  const payload = [
    {
      itemType: metadata.itemType || 'journalArticle',
      title: metadata.title || '',
      creators: (metadata.creators || []).map((c) => ({ creatorType: 'author', ...c })),
      ...(metadata.fields ?? {}),
      ...(metadata.doi ? { DOI: metadata.doi } : {}),
      ...(metadata.date ? { date: metadata.date } : {}),
      ...(metadata.url ? { url: metadata.url } : {}),
      ...(collectionKey ? { collections: [collectionKey] } : {}),
      tags: [],
    },
  ];
  const data = await zoteroWrite(`${zoteroLibraryPrefix(libraryKey)}/items`, payload, { zoteroKey });
  const success = data?.successful?.['0'];
  if (!success?.key) throw new Error(data?.failed?.['0']?.message ? `Zotero 写入失败：${data.failed['0'].message}` : 'Zotero 写入失败，请检查 Zotero 授权与字段。');
  return { itemKey: success.key };
}

/**
 * 把已有条目加入收藏夹（读当前 collections 取并集；带乐观锁，412 版本冲突重试一次）。
 * 已在该收藏夹时直接返回 { added: false }（不产生写请求）。
 */
export async function zoteroAddToCollection(itemKey, collectionKey, options = {}) {
  const { zoteroKey, libraryKey = 'user' } = options;
  const prefix = zoteroLibraryPrefix(libraryKey);
  const itemUrl = `${ZOTERO_API_BASE}${prefix}/items/${encodeURIComponent(itemKey)}`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await fetchJson(itemUrl, { headers: { Connection: 'close' } });
    const data = current?.data ?? {};
    const collections = new Set(Array.isArray(data.collections) ? data.collections : []);
    if (collections.has(collectionKey)) return { added: false, itemKey };
    collections.add(collectionKey);
    const headers = current?.version !== undefined ? { 'If-Unmodified-Since-Version': String(current.version) } : {};
    try {
      await zoteroWrite(`${prefix}/items/${encodeURIComponent(itemKey)}`, { collections: [...collections] }, { method: 'PATCH', zoteroKey, headers });
      return { added: true, itemKey };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === 0 && message.includes('412')) continue; // 版本冲突：重读后重试一次
      throw err;
    }
  }
  throw new Error(`加入收藏夹失败：${itemKey}`);
}

/**
 * 给已有条目挂 OA PDF（Zotero 四段上传，移植自 core/zotero/client.ts 的 uploadPdfAttachment）：
 *  1. 建 attachment 子条目（md5/mtime 置空）
 *  2. 申请上传授权（If-None-Match: *；同 md5 已存在 → {exists:true}，直接返回 duplicate）
 *  3. 直传文件（授权返回的 url 优先，否则 PUT 到自身 /file）
 *  4. 授权返回 uploadKey 时补一次注册
 *
 * @param {string} parentItemKey 父条目 key
 * @param {Uint8Array|ArrayBuffer|Buffer} data PDF 字节
 * @returns {Promise<{ attachmentKey: string, duplicate: boolean }>}
 */
export async function zoteroAttachPdf(parentItemKey, data, options = {}) {
  const { zoteroKey, libraryKey = 'user', title = '', filename = 'paper.pdf' } = options;
  const prefix = zoteroLibraryPrefix(libraryKey);
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const md5 = createHash('md5').update(bytes).digest('hex');
  const mtime = Date.now();

  // 1) 附件条目
  const created = await zoteroWrite(
    `${prefix}/items`,
    [
      {
        itemType: 'attachment',
        linkMode: 'imported_file',
        parentItem: parentItemKey,
        title: title || filename.replace(/\.pdf$/i, ''),
        contentType: 'application/pdf',
        filename,
        md5: null,
        mtime: null,
      },
    ],
    { zoteroKey },
  );
  const attachKey = created?.successful?.['0']?.key;
  if (!attachKey) throw new Error('创建 PDF 附件条目失败');

  // 2) 上传授权
  const authRes = await zoteroRequest(`${prefix}/items/${attachKey}/file`, {
    method: 'POST',
    write: true,
    zoteroKey,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'If-None-Match': '*' },
    body: new URLSearchParams({ md5, filename, filesize: String(bytes.byteLength), mtime: String(mtime) }).toString(),
  });
  const authText = await authRes.text().catch(() => '');
  if (!authRes.ok) throw new Error(`Zotero 上传授权失败：HTTP ${authRes.status}${authText ? `：${authText.slice(0, 150)}` : ''}`);
  const auth = authText ? JSON.parse(authText) : {};
  if (auth.exists) return { attachmentKey: attachKey, duplicate: true };

  // 3) 直传文件
  const hasServerUrl = typeof auth.url === 'string' && auth.url;
  const uploadUrl = hasServerUrl ? (auth.url.startsWith('http') ? auth.url : `${ZOTERO_API_BASE}${auth.url}`) : `${ZOTERO_API_BASE}${prefix}/items/${attachKey}/file`;
  const upHeaders = { 'Content-Type': 'application/pdf', Connection: 'close' };
  if (zoteroServerId) upHeaders['Zotero-Server-ID'] = zoteroServerId;
  if (zoteroKey) upHeaders['Zotero-API-Key'] = zoteroKey;
  const upRes = await fetch(uploadUrl, { method: hasServerUrl ? 'POST' : 'PUT', headers: upHeaders, body: bytes });
  const upText = await upRes.text().catch(() => '');
  if (!upRes.ok) throw new Error(`Zotero 上传文件失败：HTTP ${upRes.status}${upText ? `：${upText.slice(0, 150)}` : ''}`);

  // 4) 注册上传完成
  if (typeof auth.uploadKey === 'string' && auth.uploadKey) {
    const regRes = await zoteroRequest(`${prefix}/items/${attachKey}/file`, {
      method: 'POST',
      write: true,
      zoteroKey,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ upload: auth.uploadKey }).toString(),
    });
    await regRes.text().catch(() => '');
    if (!regRes.ok) throw new Error(`Zotero 注册上传失败：HTTP ${regRes.status}`);
  }
  return { attachmentKey: attachKey, duplicate: false };
}

/** 复用 core/types.ts 的归一化 DOI 逻辑。 */
export function normalizeDoi(doi) {
  if (!doi) return '';
  return String(doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim();
}

function creatorsToAuthors(creators) {
  return (Array.isArray(creators) ? creators : [])
    .map((c) => [c?.firstName, c?.lastName].filter(Boolean).join(' ').trim())
    .filter(Boolean);
}

function extractYear(date) {
  const m = String(date ?? '').match(/(19|20)\d{2}/);
  return m ? m[0] : null;
}

/** 通用 GET/POST JSON。请求失败抛错（含网络/HTTP 状态信息），由上层按工具包装。 */
async function fetchJson(url, init = {}) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`网络请求失败：${detail}`);
  }
  learnZoteroHeaders(res);
  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(`HTTP ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}