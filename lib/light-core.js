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

/** OpenAlex API 基址。 */
export const OPENALEX_API_BASE = 'https://api.openalex.org';

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

/** Zotero 只读检索（库条目，不含附件/笔记/批注）。 */
export async function zoteroSearch(query, options = {}) {
  const { limit = 20, qmode = 'everything' } = options;
  const url = new URL(`${ZOTERO_API_BASE}/users/0/items`);
  url.searchParams.set('q', String(query ?? ''));
  url.searchParams.set('qmode', qmode === 'titleCreatorYear' ? 'titleCreatorYear' : 'everything');
  url.searchParams.set('itemType', '-attachment || note || annotation');
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 100)));
  const data = await fetchJson(url.toString());
  const items = (Array.isArray(data) ? data : []).map((entry) => ({
    key: entry.key || '',
    itemType: entry.data?.itemType || '',
    title: entry.data?.title || '',
    authors: creatorsToAuthors(entry.data?.creators),
    year: extractYear(entry.data?.date),
    doi: normalizeDoi(entry.data?.DOI),
    url: entry.data?.url || '',
    libraryKey: 'user',
  }));
  // 本地 API 的 q 是「全文索引 + 标题/创建者/年份」混合匹配，过滤掉空 title（附件子条目等）
  return items.filter((i) => i.title || i.doi);
}

/** 按 DOI 在 Zotero 中精确查重（qmode=everything；归一化后比较）。 */
export async function zoteroFindByDoi(doi, options = {}) {
  const normalized = normalizeDoi(doi);
  if (!normalized) return null;
  const items = await zoteroSearch(normalized, { ...options, qmode: 'everything', limit: Math.min(options.limit ?? 25, 100) });
  return items.find((i) => i.doi === normalized) ?? null;
}

/** Zotero 建条目（写操作；需要 LIT_SEARCH_ZOTERO_KEY 或用户已完成本地授权）。 */
export async function zoteroCreateItem(metadata, options = {}) {
  const { zoteroKey, collectionKey } = options;
  const payload = [
    {
      itemType: metadata.itemType || 'journalArticle',
      title: metadata.title || '',
      creators: (metadata.creators || []).map((c) => ({ creatorType: 'author', ...c })),
      ...(metadata.doi ? { DOI: metadata.doi } : {}),
      ...(metadata.date ? { date: metadata.date } : {}),
      ...(metadata.url ? { url: metadata.url } : {}),
      ...(collectionKey ? { collections: [collectionKey] } : {}),
      tags: [],
    },
  ];
  const headers = { 'Content-Type': 'application/json' };
  if (zoteroKey) headers['Zotero-API-Key'] = zoteroKey;
  const data = await fetchJson(`${ZOTERO_API_BASE}/users/0/items`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const success = data?.successful?.['0'];
  if (!success?.key) throw new Error(data?.failed?.['0']?.message ? `Zotero 写入失败：${data.failed['0'].message}` : 'Zotero 写入失败，请检查 Zotero 授权与字段。');
  return { itemKey: success.key };
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