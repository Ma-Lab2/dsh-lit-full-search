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
import { existsSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

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
  const { limit = 10, yearFrom, yearTo, apiKey, mailto, proxy } = options;
  const url = new URL(`${OPENALEX_API_BASE}/works`);
  url.searchParams.set('search', String(query ?? ''));
  url.searchParams.set('per_page', String(Math.min(Math.max(limit, 1), 25)));
  const yearFilter = [];
  if (yearFrom) yearFilter.push(`publication_year:>${Number(yearFrom) - 1}`);
  if (yearTo) yearFilter.push(`publication_year:<${Number(yearTo) + 1}`);
  if (yearFilter.length > 0) url.searchParams.set('filter', yearFilter.join(','));
  applyOpenAlexAuth(url, { apiKey, mailto });
  const data = await fetchJson(url.toString(), {}, proxy);
  return {
    items: (Array.isArray(data.results) ? data.results : []).map(mapOpenAlexWork),
    diagnostics: { openalex: { ok: true, count: data.results?.length ?? 0 } },
  };
}

/** 按 DOI 查 OpenAlex work。DOI 不存在（404）返回 null，不抛错。 */
export async function lookupOpenAlexByDoi(doi, options = {}) {
  const { apiKey, mailto, proxy } = options;
  const url = new URL(`${OPENALEX_API_BASE}/works/doi:${encodeURIComponent(doi)}`);
  applyOpenAlexAuth(url, { apiKey, mailto });
  let data;
  try {
    data = await fetchJson(url.toString(), {}, proxy);
  } catch (err) {
    // 404 = 该 DOI 在 OpenAlex 不存在（打错或未收录）。返回 null 让调用方走「未找到」分支：
    // lit_abstract → status=missing（其文档承诺的行为）；lit_cited_by → 自己的「无法解析」提示。
    // 否则会把网关的 404 HTML 当工具故障抛进模型上下文。
    if (err?.status === 404) return null;
    throw err;
  }
  return data ? mapOpenAlexWork(data) : null;
}

/** 被引列表：DOI 或 OpenAlex work ID → /works?filter=cites:xxx。 */
export async function citedByOpenAlex(identifier, options = {}) {
  const { limit = 25, apiKey, mailto, proxy } = options;
  let openAlexId = identifier;
  if (!/^W\d+$/i.test(identifier)) {
    // 非 OpenAlex work ID（如 DOI）：先按 DOI 查询拿到 work ID
    const work = await lookupOpenAlexByDoi(identifier, { apiKey, mailto, proxy });
    if (!work?.externalIds?.openalex) {
      throw new Error(`无法解析「${identifier}」为 OpenAlex work ID`);
    }
    openAlexId = work.externalIds.openalex;
  }
  const url = new URL(`${OPENALEX_API_BASE}/works`);
  url.searchParams.set('filter', `cites:${openAlexId}`);
  url.searchParams.set('per_page', String(Math.min(Math.max(limit, 1), 200)));
  applyOpenAlexAuth(url, { apiKey, mailto });
  const data = await fetchJson(url.toString(), {}, proxy);
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
 * S2 个人密钥配额是「全部端点合计 1 次/秒」（官方 tutorial）。模型常并发调用多个 lit_search，
 * 每个都会打一次 S2，同一秒内第二个请求即 429——过去这会被 allSettled 吞掉、render 不显示，
 * 表现为「配了 key 但结果全是 openalex」。这里把所有 S2 请求串行排队并保证最小间隔，429 再退避重试一次。
 */
export const S2_MIN_INTERVAL_MS = 1100;
const S2_RETRY_DELAY_MS = 2000;
let s2Queue = Promise.resolve();
let s2LastAt = 0;
let s2IntervalMs = S2_MIN_INTERVAL_MS;
let s2RetryDelayMs = S2_RETRY_DELAY_MS;
/** 网络层失败（连接超时/DNS 等，无 HTTP 状态码）后的熔断窗口。 */
const S2_CIRCUIT_MS = 30_000;
let s2CircuitOpenUntil = 0;
let s2CircuitReason = '';

/** 仅测试用：调整节流间隔与 429 退避（传 undefined 恢复默认），并重置排队与熔断状态。 */
export function __setS2IntervalForTest(ms, retryMs) {
  s2IntervalMs = ms ?? S2_MIN_INTERVAL_MS;
  s2RetryDelayMs = retryMs ?? (ms === undefined ? S2_RETRY_DELAY_MS : ms);
  s2LastAt = 0;
  s2Queue = Promise.resolve();
  s2CircuitOpenUntil = 0;
  s2CircuitReason = '';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 串行 + 限速地执行一次 S2 请求；429 时退避后重试一次。 */
function s2Fetch(url, init, proxy = '') {
  const run = async () => {
    // 熔断：近期连不上 S2（网络层失败）时直接失败，不让排队的请求一个个再等 10 秒连接超时。
    if (Date.now() < s2CircuitOpenUntil) throw new Error(s2CircuitReason);
    const once = async (viaProxy) => {
      const wait = s2LastAt + s2IntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      s2LastAt = Date.now();
      return fetchJson(url, init, viaProxy);
    };
    const attempt = async () => {
      try {
        return await once(proxy);
      } catch (err) {
        if (err?.status !== undefined) throw err;
        // 网络层失败（ECONNRESET / 连接超时）常是瞬时的：先重试一次；走代理失败的那次改走直连。
        // 只有重试也失败才熔断——实测单次 ECONNRESET 曾把后续 60 秒全部判死。
        try {
          return await once('');
        } catch (err2) {
          if (err2?.status === undefined) {
            s2CircuitOpenUntil = Date.now() + S2_CIRCUIT_MS;
            s2CircuitReason = `${err2.message}（Semantic Scholar 网络不可达，${Math.round(S2_CIRCUIT_MS / 1000)} 秒内跳过）`;
          }
          throw err2;
        }
      }
    };
    try {
      return await attempt();
    } catch (err) {
      if (err?.status !== 429) throw err;
      await sleep(Math.max(s2RetryDelayMs, s2IntervalMs));
      return attempt();
    }
  };
  const result = s2Queue.then(run, run);
  // 队列只用于排序，单次失败不能卡住后续请求
  s2Queue = result.catch(() => {});
  return result;
}

/**
 * Semantic Scholar /paper/search（relevance search）检索。
 * 仅在配置了 S2 API Key 时由 lit_search 调用（无 key 时该端点对共享池基本恒 429，实测确认）。
 * 用 relevance 而非 bulk：bulk 不按相关度排序，取前 N 条不适合「摸底检索」。
 */
export async function searchSemanticScholar(query, options = {}) {
  const { limit = 10, yearFrom, yearTo, s2ApiKey, proxy } = options;
  const url = new URL(`${S2_API_BASE}/paper/search`);
  url.searchParams.set('query', String(query ?? ''));
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 25)));
  url.searchParams.set('fields', S2_FIELDS);
  if (yearFrom || yearTo) url.searchParams.set('year', `${yearFrom ?? ''}-${yearTo ?? ''}`);
  const headers = {};
  if (s2ApiKey) headers['x-api-key'] = s2ApiKey;
  const data = await s2Fetch(url.toString(), { headers }, proxy);
  const papers = Array.isArray(data?.data) ? data.data : [];
  return {
    items: papers.map(mapS2Paper).filter(Boolean),
    diagnostics: { semanticscholar: { ok: true, count: papers.length } },
  };
}

/**
 * S2 按 DOI 取单篇（lit_abstract 的摘要回退用）。
 * 必要性：OpenAlex 对相当一部分文献没有 `abstract_inverted_index`——实测连 Labaune 2013
 * （Nat Commun，209 被引的 pB 奠基工作）都是空的，而 S2 存有完整摘要。
 * 该 DOI 不在 S2 里（404）返回 null，不抛错。走 s2Fetch，共享节流/重试/熔断。
 */
export async function lookupS2ByDoi(doi, options = {}) {
  const { s2ApiKey, proxy } = options;
  const url = new URL(`${S2_API_BASE}/paper/DOI:${encodeURIComponent(doi)}`);
  url.searchParams.set('fields', 'title,year,venue,externalIds,abstract');
  const headers = {};
  if (s2ApiKey) headers['x-api-key'] = s2ApiKey;
  let data;
  try {
    data = await s2Fetch(url.toString(), { headers }, proxy);
  } catch (err) {
    if (err?.status === 404) return null;
    throw err;
  }
  return data ?? null;
}

/** S2 paper JSON → 精简 WorkItem（与 core/providers/semanticscholar.ts mapS2Paper 对齐；无标题条目丢弃）。 */export function mapS2Paper(paper) {
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

/** Zotero 条目 JSON → 精简条目（zotero_search 与 zotero_collection_items 共用）。 */
function mapZoteroItem(entry, libraryKey) {
  return {
    key: entry?.key || '',
    itemType: entry?.data?.itemType || '',
    title: entry?.data?.title || '',
    authors: creatorsToAuthors(entry?.data?.creators),
    year: extractYear(entry?.data?.date),
    doi: normalizeDoi(entry?.data?.DOI),
    url: entry?.data?.url || '',
    libraryKey,
  };
}

/** 本地 API 返回里丢掉附件/笔记/批注，以及没有标题也没有 DOI 的空壳。 */
function keepRealItems(items) {
  return items.filter((i) => !NON_ITEM_TYPES.has(i.itemType) && (i.title || i.doi));
}

/** Zotero 只读检索（库条目，不含附件/笔记/批注）；libraryKey 支持 'user' / 'group:<id>'。 */
export async function zoteroSearch(query, options = {}) {
  const { limit = 20, qmode = 'everything', libraryKey = 'user' } = options;
  const url = new URL(`${ZOTERO_API_BASE}${zoteroLibraryPrefix(libraryKey)}/items`);
  url.searchParams.set('q', String(query ?? ''));
  url.searchParams.set('qmode', qmode === 'titleCreatorYear' ? 'titleCreatorYear' : 'everything');
  // 排除附件/笔记/批注：API 侧的 `-x || y || z` 语法在本地 API 上不保证生效
  // （实测按论文标题检索会带回同条目下的 PDF 附件行），故查询与客户端两侧都过滤。
  url.searchParams.set('itemType', '-attachment || -note || -annotation');
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 100)));
  // Connection: close —— 防止 undici 复用 Zotero HTTP/1.0 已关闭的 socket（"fetch failed"）
  const data = await fetchJson(url.toString(), { headers: { Connection: 'close' } });
  const items = (Array.isArray(data) ? data : []).map((entry) => mapZoteroItem(entry, libraryKey));
  // 本地 API 的 q 是「全文索引 + 标题/创建者/年份」混合匹配：只留顶层文献条目
  // （丢掉附件/笔记/批注，以及没有标题也没有 DOI 的空壳）
  return keepRealItems(items);
}

/**
 * 收藏夹内的顶层条目（`/collections/<key>/items/top`）。
 * `/items/top` 只回顶层条目，本身已排除附件等子条目；仍走一遍 keepRealItems 兜住顶层笔记。
 * 补上「核对某个专题收藏夹已收哪些文献」这条链路——此前只能用 zotero_search 搜全库绕道。
 */
export async function zoteroCollectionItems(collectionKey, options = {}) {
  const { limit = 20, libraryKey = 'user' } = options;
  const prefix = zoteroLibraryPrefix(libraryKey);
  const url = new URL(`${ZOTERO_API_BASE}${prefix}/collections/${encodeURIComponent(collectionKey)}/items/top`);
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 100)));
  const data = await fetchJson(url.toString(), { headers: { Connection: 'close' } });
  const items = (Array.isArray(data) ? data : []).map((entry) => mapZoteroItem(entry, libraryKey));
  return keepRealItems(items);
}

/** 本地 API 检索里要排除的非文献条目类型。 */
const NON_ITEM_TYPES = new Set(['attachment', 'note', 'annotation']);

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

/** 单条目完整记录（含 version 与 data）；404 返回 null。 */
export async function zoteroGetItem(itemKey, options = {}) {
  const { libraryKey = 'user' } = options;
  const prefix = zoteroLibraryPrefix(libraryKey);
  const res = await zoteroRequest(`${prefix}/items/${encodeURIComponent(itemKey)}`);
  if (res.status === 404) {
    await res.text().catch(() => '');
    return null;
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`读取条目失败：HTTP ${res.status} ${res.statusText}${text ? `：${text.slice(0, 150)}` : ''}`);
  const raw = text ? JSON.parse(text) : null;
  if (!raw?.data) return null;
  return { key: raw.key ?? itemKey, version: raw.version, data: raw.data };
}

/** 条目的全部子对象（笔记 / 附件 / 批注等）。 */
export async function zoteroItemChildren(itemKey, options = {}) {
  const { libraryKey = 'user' } = options;
  const prefix = zoteroLibraryPrefix(libraryKey);
  const res = await zoteroRequest(`${prefix}/items/${encodeURIComponent(itemKey)}/children`);
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`读取子条目失败：HTTP ${res.status} ${res.statusText}${text ? `：${text.slice(0, 150)}` : ''}`);
  const list = text ? JSON.parse(text) : [];
  return (Array.isArray(list) ? list : []).map((entry) => ({ key: entry?.key ?? '', version: entry?.version, data: entry?.data ?? {} }));
}

/**
 * 附件磁盘路径。Zotero 的 `/file/view/url` 对 imported_file 返回 `file://` URL：
 * 去协议 → 解码 → `file:///C:/…` 还原为 `C:\…` → `existsSync` 校验（条目可能已同步但文件未下载）。
 * linked_url 附件返回 URL；无文件/接口不支持时 path 与 url 均为 null 并带 error。
 */
export async function zoteroResolveAttachmentPath(attachKey, options = {}) {
  const { libraryKey = 'user' } = options;
  const prefix = zoteroLibraryPrefix(libraryKey);
  const res = await zoteroRequest(`${prefix}/items/${encodeURIComponent(attachKey)}/file/view/url`);
  const text = (await res.text().catch(() => '')).trim();
  if (!res.ok) {
    return { path: null, exists: null, url: null, error: `HTTP ${res.status} ${res.statusText}` };
  }
  if (!text) return { path: null, exists: null, url: null, error: '接口未返回路径' };
  if (!text.startsWith('file://')) return { path: null, exists: null, url: text, error: null };
  const decoded = decodeURIComponent(text.slice('file://'.length));
  const local = decoded.replace(/^\/([A-Za-z]:)/, '$1').split('/').join(path.sep);
  return { path: local, exists: existsSync(local), url: null, error: null };
}

/** 附件的 Zotero 全文索引缓存（`.zotero-ft-cache`）；未建索引时 content 为空。 */
export async function zoteroAttachmentFulltext(attachKey, options = {}) {
  const { libraryKey = 'user' } = options;
  const prefix = zoteroLibraryPrefix(libraryKey);
  const res = await zoteroRequest(`${prefix}/items/${encodeURIComponent(attachKey)}/fulltext`);
  const text = await res.text().catch(() => '');
  if (res.status === 404) return { content: '', indexedChars: 0, totalChars: 0 };
  if (!res.ok) throw new Error(`读取全文索引失败：HTTP ${res.status} ${res.statusText}${text ? `：${text.slice(0, 150)}` : ''}`);
  const data = text ? JSON.parse(text) : {};
  const content = typeof data?.content === 'string' ? data.content : '';
  return {
    content,
    indexedChars: typeof data?.indexedChars === 'number' ? data.indexedChars : content.length,
    totalChars: typeof data?.totalChars === 'number' ? data.totalChars : content.length,
  };
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

/** 错误响应体摘要：HTML 页面（网关/Cloudflare 的 404 等）去标签后截断，避免把整页标记灌进模型上下文。 */
export function summarizeErrorBody(body) {
  return String(body ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** 代理隧道的连接超时（与 undici 默认 connect timeout 对齐）。 */
const PROXY_CONNECT_TIMEOUT_MS = 10_000;
/** 经代理单次请求的整体超时（握手 + 响应）。 */
const PROXY_TOTAL_TIMEOUT_MS = 15_000;

/**
 * 经 HTTP 代理（CONNECT 隧道）发起**单次** HTTPS 请求（不跟随重定向），返回 fetch 风格的最小 Response。
 * 不用全局 dispatcher / NODE_USE_ENV_PROXY：插件运行在 DSH Host 进程里，改全局会波及其它插件与本地 Zotero 请求。
 */
function proxyRequestOnce(target, init, proxy) {
  const p = new URL(proxy);
  const proxyLib = p.protocol === 'https:' ? https : http;
  // 下载 PDF 这类大响应需要比 JSON 更长的预算；调用方用 init.timeoutMs 覆盖。
  const totalMs = Number(init.timeoutMs) > 0 ? Number(init.timeoutMs) : PROXY_TOTAL_TIMEOUT_MS;
  return new Promise((resolveRaw, rejectRaw) => {
    // 整体超时：CONNECT 的 timeout 只管握手阶段，隧道建立后响应卡住（实测 19 s 后 ECONNRESET）会拖住整个 S2 队列。
    let settled = false;
    const sockets = [];
    const finish = (fn) => (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(overall);
      fn(v);
    };
    const resolve = finish(resolveRaw);
    const reject = finish(rejectRaw);
    const overall = setTimeout(() => {
      sockets.forEach((s) => s.destroy());
      reject(new Error(`经代理请求超时（${Math.round(totalMs / 1000)} 秒）：${target.hostname}`));
    }, totalMs);
    const auth = p.username ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}` } : {};
    const port = target.port || '443';
    const connectReq = proxyLib.request({
      host: p.hostname,
      port: p.port || (p.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      headers: { Host: `${target.hostname}:${port}`, ...auth },
      timeout: PROXY_CONNECT_TIMEOUT_MS,
    });
    connectReq.on('timeout', () => connectReq.destroy(new Error(`代理连接超时：${p.host}`)));
    // 支持 AbortSignal（诊断面板的 5s 超时依赖它）
    if (init.signal) {
      if (init.signal.aborted) connectReq.destroy(new Error('请求已取消'));
      else init.signal.addEventListener('abort', () => connectReq.destroy(new Error('请求超时或已取消')), { once: true });
    }
    connectReq.on('error', (err) => {
      const e = new Error(`代理 ${p.host} 不可用：${err.message}`);
      e.code = 'PROXY_UNAVAILABLE';
      reject(e);
    });
    connectReq.on('connect', (connectRes, socket) => {
      sockets.push(socket);
      if (connectRes.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理 ${p.host} 拒绝隧道：HTTP ${connectRes.statusCode}`));
        return;
      }
      const req = https.request(
        target,
        {
          method: init.method ?? 'GET',
          headers: init.headers ?? {},
          createConnection: () => tls.connect({ socket, servername: target.hostname }),
          agent: false,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('error', reject);
          res.on('end', () => {
            const raw = Buffer.concat(chunks);
            const body = raw.toString('utf8');
            const headers = new Map(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : v]));
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              statusText: res.statusMessage ?? '',
              headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
              text: async () => body,
              arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
            });
          });
        },
      );
      req.on('error', reject);
      if (init.body !== undefined) req.write(init.body);
      req.end();
    });
    connectReq.end();
  });
}

/** 代理请求最多跟随的重定向跳数。 */
const PROXY_MAX_REDIRECTS = 5;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * 该响应是否应跟随重定向：返回下一个绝对 URL，或 null（不跟随）。
 * 抽成纯函数是为了可测——「代理不跟随重定向」曾导致开启代理后 OA PDF 一律挂不上。
 */
export function nextRedirectUrl(status, location, baseUrl, redirectsLeft = PROXY_MAX_REDIRECTS) {
  if (!location || redirectsLeft <= 0) return null;
  if (!REDIRECT_STATUS.has(status)) return null;
  try {
    return new URL(location, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * 经代理请求，**跟随重定向**。这一步不能省：OA PDF 直链普遍是 301/302 跳转
 * （例如 Frontiers 的 /articles/.../pdf 会 301 到实际文件），不跟随就只会拿到一小段 HTML，
 * 然后被 downloadPdf 判成「内容不是 PDF」。真机自检就是这样发现代理开启后挂不上 PDF 的。
 * 只支持 https 目标（OpenAlex / S2 / Crossref / 出版社 PDF 均为 https）；http 目标交给普通 fetch。
 */
export async function proxyFetch(url, init = {}, proxy, redirectsLeft = PROXY_MAX_REDIRECTS) {
  const target = new URL(url);
  if (target.protocol !== 'https:') return fetch(url, init);
  const res = await proxyRequestOnce(target, init, proxy);
  const next = nextRedirectUrl(res.status, res.headers.get('location'), target, redirectsLeft);
  if (!next) return res;
  // 301/302/303 在 fetch 语义下都按 GET 重发（本插件的调用方只有 GET）
  return proxyFetch(next, { ...init, method: 'GET', body: undefined }, proxy, redirectsLeft - 1);
}

/** 外网请求：配置了代理走 CONNECT 隧道，否则直连 fetch。本地 Zotero 请求不要经过这里。 */
export async function externalFetch(url, init = {}, proxy = '') {
  if (!proxy) return fetch(url, init);
  try {
    return await proxyFetch(url, init, proxy);
  } catch (err) {
    // 代理软件没开（连不上代理本身）时回落直连，避免「关了 Clash 检索全挂」。
    // 隧道被拒 / 目标超时等其它错误照常抛出。
    if (err?.code === 'PROXY_UNAVAILABLE') return fetch(url, init);
    throw err;
  }
}

/** 通用 GET/POST JSON。请求失败抛错（含网络/HTTP 状态信息），由上层按工具包装。proxy 仅外网请求传。 */
async function fetchJson(url, init = {}, proxy = '') {
  let res;
  try {
    res = await externalFetch(url, init, proxy);
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
    const detail = summarizeErrorBody(body);
    const error = new Error(`HTTP ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`);
    // 让上层能按状态码分支（如 OpenAlex 404 = 该 DOI 不存在 → 走「未找到」而不是报故障）
    error.status = res.status;
    throw error;
  }
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}