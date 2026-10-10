/**
 * Zotero 批量写回引擎：参考文献（DOI / 标题 / 整行）→ 指定库 + 收藏夹。
 *
 * 分工：
 *  - 本模块：参考文献行解析、目标库/收藏夹名解析、元数据链（Crossref → OpenAlex → 行内解析）、
 *    itemType 映射与白名单过滤、去重编排、报告结构。
 *  - light-core.js：Zotero 本地 API 的库路径、收藏夹读写、Server-ID 握手与授权。
 *
 * 关键语义（工具层直接暴露）：
 *  - library：'user'（缺省）或 'group:<id>'，也接受库名 / 纯数字 id。
 *  - collection：收藏夹 key、名称，或 '父 > 子' 路径；名称歧义时报错并列出候选。
 *  - 去重发生在**目标库内**：已在该库且已在目标收藏夹 → exists；已在库但不在收藏夹 → added；否则 created。
 *  - itemTypes：解析出的 Zotero itemType 白名单（例如只收 ['journalArticle']），不在白名单 → skipped。
 *  - dryRun：只做只读推导，不发起任何写请求。
 */

import {
  ZOTERO_API_BASE,
  externalFetch,
  lookupOpenAlexByDoi,
  normalizeDoi,
  searchOpenAlex,
  zoteroAddToCollection,
  zoteroAttachPdf,
  zoteroCreateItem,
  zoteroListCollections,
  zoteroListLibraries,
  zoteroLibraryPrefix,
  zoteroSearch,
} from './light-core.js';

/** 单次导入上限（防一次工具调用把库写爆 / 上下文爆炸）。 */
export const MAX_IMPORT_REFS = 200;

/** 各 Zotero itemType 允许的字段（写错字段 Zotero 会 400，做白名单兜底）。 */
const ALLOWED_FIELDS = Object.freeze({
  journalArticle: ['title', 'date', 'publicationTitle', 'volume', 'issue', 'pages', 'ISSN', 'url', 'abstractNote', 'DOI', 'language', 'publisher'],
  conferencePaper: ['title', 'date', 'proceedingsTitle', 'conferenceName', 'place', 'publisher', 'pages', 'url', 'abstractNote', 'DOI'],
  preprint: ['title', 'date', 'repository', 'archiveID', 'place', 'publisher', 'url', 'abstractNote', 'DOI'],
  report: ['title', 'date', 'institution', 'reportType', 'reportNumber', 'place', 'publisher', 'url', 'abstractNote', 'DOI'],
  thesis: ['title', 'date', 'university', 'thesisType', 'place', 'url', 'abstractNote', 'DOI'],
  dataset: ['title', 'date', 'repository', 'versionNumber', 'publisher', 'place', 'url', 'abstractNote', 'DOI'],
  bookSection: ['title', 'date', 'bookTitle', 'publisher', 'place', 'pages', 'ISBN', 'url', 'abstractNote', 'DOI'],
});

/** Crossref type → Zotero itemType。 */
export function crossrefTypeToZotero(type) {
  switch (String(type || '').toLowerCase()) {
    case 'proceedings-article':
    case 'proceedings':
      return 'conferencePaper';
    case 'posted-content':
    case 'preprint':
      return 'preprint';
    case 'dataset':
      return 'dataset';
    case 'report':
    case 'report-series':
      return 'report';
    case 'dissertation':
      return 'thesis';
    case 'book-chapter':
    case 'book-section':
      return 'bookSection';
    default:
      return 'journalArticle';
  }
}

/** 场馆名启发式判定 itemType（只在没有权威元数据时兜底）。 */
export function guessItemType(venue = '', hint = '') {
  if (hint) return hint;
  const v = String(venue);
  if (/thesis|dissertation|学位论文/i.test(v)) return 'thesis';
  if (/dataset|zenodo|figshare/i.test(v)) return 'dataset';
  if (/report|technical report/i.test(v)) return 'report';
  if (/preprint|arxiv/i.test(v)) return 'preprint';
  if (/meeting|congress|conference|proceedings|symposium|workshop/i.test(v)) return 'conferencePaper';
  return 'journalArticle';
}

/** 去掉 JATS/HTML 标签与多余空白（Crossref 摘要常带 <jats:p>）。 */
function cleanMarkup(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把整行参考文献拆成结构化字段。
 * 支持两种形态：带 `(年).` 的 APA 风格整行；或裸 DOI / 裸标题。
 */
export function parseReferenceLine(raw) {
  // 只剥掉「列表序号」：序号后必须有空白。否则会把裸 DOI 开头的 "10." 当成序号吃掉
  // （'10.1063/1.4885100' → '1063/1.4885100'）。
  const body = String(raw ?? '').replace(/^\s*\d+[.)]\s+/, '').trim();
  const doiMatch = body.match(/10\.\d{4,9}\/[^\s,;]+/);
  const doi = doiMatch ? normalizeDoi(doiMatch[0].replace(/[.)，。]+$/, '')) : '';

  const head = body.match(/^(.*?)\s*\((\d{4}[a-z]?)\)\.\s*(.*)$/);
  if (!head) {
    // 裸 DOI / 裸标题
    const title = doi && normalizeDoi(body) === doi ? '' : body.replace(/https?:\/\/\S+$/, '').replace(/[.。]$/, '').trim();
    return { raw: body, authorsRaw: '', year: '', title, venue: '', volume: '', issue: '', pages: '', doi };
  }

  const [, authorsRaw, year, rest] = head;
  const starred = rest.match(/^(.*?)\.\s+\*(.+?)\*(.*)$/);
  const title = (starred ? starred[1] : rest.replace(/\.\s*https?:\/\/\S+$/, '')).trim();
  const venue = starred ? starred[2].trim() : '';
  const tail = starred ? starred[3].trim() : '';
  const loc = tail.match(/^,?\s*([0-9]+)\s*(?:\(([^)]+)\))?\s*,\s*([^.,]+)/);
  return {
    raw: body,
    authorsRaw: authorsRaw.trim(),
    year,
    title,
    venue,
    volume: loc ? loc[1] : '',
    issue: loc && loc[2] ? loc[2] : '',
    pages: loc ? loc[3].trim() : '',
    doi,
  };
}

/**
 * 解析 APA 作者串：'Poole, P. L., Andereck, C. D., et al.' → [{lastName,firstName}]。
 * 也接受 'First Middle Last' 形态。丢弃 'et al.' 与 '&'。
 */
export function splitApaAuthors(raw) {
  const cleaned = String(raw || '')
    .replace(/\bet\s+al\.?/gi, '')
    .replace(/\s*&\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return [];
  const parts = cleaned.split(/,\s+(?=[A-Za-z][A-Za-z''’\-]+,\s+[A-Z]\.)/);
  const out = [];
  for (const part of parts) {
    const piece = part.replace(/^[,\s]+|[,\s]+$/g, '');
    if (!piece) continue;
    const m = piece.match(/^([^,]+),\s*(.+)$/);
    if (m) {
      const lastName = m[1].trim();
      const firstName = m[2].replace(/\s+/g, ' ').trim();
      if (lastName) out.push({ lastName, ...(firstName ? { firstName } : {}) });
      continue;
    }
    const tokens = piece.split(/\s+/);
    if (tokens.length === 1) out.push({ lastName: tokens[0] });
    else out.push({ firstName: tokens.slice(0, -1).join(' '), lastName: tokens[tokens.length - 1] });
  }
  return out;
}

/** 'First Middle Last' → {firstName:'First Middle', lastName:'Last'}；单名 → {lastName}。 */
export function splitFullName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return { lastName: parts[0] };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

/** 目标库解析：'user' / 'group:<id>' / 纯数字 id / 库名（精确 → 包含，多义报错）。 */
export function resolveLibraryKey(libraries, spec = 'user') {
  const wanted = String(spec ?? 'user').trim();
  if (wanted === '' || wanted === 'user') return 'user';
  if (/^group:\d+$/.test(wanted)) return wanted;
  if (/^\d+$/.test(wanted)) return `group:${wanted}`;
  const lower = wanted.toLowerCase();
  const exact = libraries.filter((l) => l.name.toLowerCase() === lower);
  if (exact.length === 1) return exact[0].libraryKey;
  const partial = libraries.filter((l) => l.name.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0].libraryKey;
  const pool = exact.length > 1 ? exact : partial;
  if (pool.length === 0) {
    throw new Error(`找不到库「${wanted}」。可用库：${libraries.map((l) => `${l.name} (${l.libraryKey})`).join('、')}`);
  }
  throw new Error(`库名「${wanted}」不唯一，请用更完整的名称或 libraryKey：${pool.map((l) => `${l.name} (${l.libraryKey})`).join('、')}`);
}

/** 收藏夹解析：key / 名称 / '父 > 子' 路径（精确 → 包含，多义报错）。 */
export function resolveCollection(collections, spec) {
  const wanted = String(spec ?? '').trim();
  if (!wanted) throw new Error('collection 不能为空');
  const byKey = collections.find((c) => c.key === wanted);
  if (byKey) return byKey;

  const wantedPath = wanted
    .split('>')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (wantedPath.length > 1) {
    // 逐段匹配（段内允许包含匹配），取路径尾部对齐的候选
    const hits = collections.filter((c) => {
      const segments = c.path
        .split('>')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (segments.length < wantedPath.length) return false;
      const tail = segments.slice(segments.length - wantedPath.length);
      return tail.every((seg, i) => seg === wantedPath[i] || seg.includes(wantedPath[i]));
    });
    if (hits.length === 1) return hits[0];
    if (hits.length === 0) throw new Error(`找不到收藏夹路径「${wanted}」。`);
    throw new Error(`收藏夹路径「${wanted}」不唯一：${hits.map((c) => `${c.path} (${c.key})`).join('、')}`);
  }

  const lower = wanted.toLowerCase();
  const exact = collections.filter((c) => c.name.toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  const partial = collections.filter((c) => c.name.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  const pool = exact.length > 1 ? exact : partial;
  if (pool.length === 0) throw new Error(`库内找不到收藏夹「${wanted}」（共 ${collections.length} 个收藏夹）。`);
  throw new Error(`收藏夹名「${wanted}」不唯一，请用完整路径或 key：${pool.map((c) => `${c.path} (${c.key})`).join('、')}`);
}

/** 目标库 + 收藏夹解析（库名/收藏夹名 → libraryKey / collectionKey）。 */
export async function resolveTarget({ library = 'user', collection = '' } = {}) {
  const libraries = await zoteroListLibraries();
  const libraryKey = resolveLibraryKey(libraries, library);
  const libraryName = libraries.find((l) => l.libraryKey === libraryKey)?.name ?? libraryKey;
  let collectionKey = '';
  let collectionPath = '';
  if (collection) {
    const collections = await zoteroListCollections({ libraryKey });
    const hit = resolveCollection(collections, collection);
    collectionKey = hit.key;
    collectionPath = hit.path;
  }
  return { libraryKey, libraryName, collectionKey, collectionPath };
}

/** 目标收藏夹现有顶层条目的 DOI/标题索引（分页取全量）。 */
async function buildCollectionIndex({ libraryKey, collectionKey }) {
  const prefix = zoteroLibraryPrefix(libraryKey);
  const dois = new Set();
  const titles = new Set();
  if (!collectionKey) return { dois, titles, count: 0 };
  let count = 0;
  for (let start = 0; start < 2000; start += 100) {
    const res = await fetch(`${ZOTERO_API_BASE}${prefix}/collections/${encodeURIComponent(collectionKey)}/items/top?limit=100&start=${start}`, {
      headers: { Connection: 'close' },
    });
    if (!res.ok) throw new Error(`读取目标收藏夹失败：HTTP ${res.status} ${res.statusText}`);
    const text = await res.text();
    const list = text ? JSON.parse(text) : [];
    count += list.length;
    for (const item of list) {
      const doi = normalizeDoi(item?.data?.DOI ?? '');
      if (doi) dois.add(doi.toLowerCase());
      const title = normalizeTitle(item?.data?.title);
      if (title) titles.add(title);
    }
    if (list.length < 100) break;
  }
  return { dois, titles, count };
}

/** 标题归一化：只留字母数字与中日韩字符，用于无 DOI 去重。 */
export function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim();
}

/** 逐字段白名单过滤（避免写错字段导致 Zotero 400）。 */
function filterFields(itemType, fields) {
  const allowed = ALLOWED_FIELDS[itemType] ?? ALLOWED_FIELDS.journalArticle;
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (!allowed.includes(key)) continue;
    if (value === undefined || value === null || value === '') continue;
    out[key] = value;
  }
  return out;
}

/** Crossref metadata → Zotero 条目。 */
export function fromCrossref(message, fallback = {}) {
  const itemType = crossrefTypeToZotero(message?.type);
  const dateParts = message?.issued?.['date-parts']?.[0] ?? message?.published?.['date-parts']?.[0];
  const container = message?.['container-title']?.[0];
  const creators = (Array.isArray(message?.author) ? message.author : [])
    .map((a) => (a?.family ? { lastName: a.family, ...(a.given ? { firstName: a.given } : {}) } : a?.name ? { lastName: a.name } : null))
    .filter(Boolean);
  const fields = {
    title: cleanMarkup(message?.title?.[0] ?? fallback.title),
    date: dateParts?.[0] ? String(dateParts[0]) : fallback.year || '',
    ...(container ? (itemType === 'conferencePaper' ? { proceedingsTitle: container } : { publicationTitle: container }) : {}),
    volume: message?.volume ?? fallback.volume,
    issue: message?.issue ?? fallback.issue,
    pages: message?.page ?? fallback.pages,
    ISSN: message?.ISSN?.[0],
    url: message?.URL,
    ...(itemType === 'preprint' ? { repository: 'arXiv' } : {}),
    ...(itemType === 'report' && message?.publisher ? { institution: message.publisher } : {}),
    ...(itemType === 'thesis' && message?.publisher ? { university: message.publisher } : {}),
    ...(itemType === 'dataset' ? { repository: message?.publisher ?? '' } : {}),
    abstractNote: message?.abstract ? cleanMarkup(message.abstract) : '',
  };
  return {
    itemType,
    fields,
    creators: creators.length > 0 ? creators : splitApaAuthors(fallback.authorsRaw),
    doi: normalizeDoi(message?.DOI ?? fallback.doi),
  };
}

/** OpenAlex WorkItem → Zotero 条目（Crossref 缺失/失败时的兜底）。 */
export function fromOpenAlexWork(work, fallback = {}) {
  const itemType = work?.externalIds?.arxiv ? 'preprint' : guessItemType(work?.venue, '');
  const fields = {
    title: work?.title || fallback.title || '',
    date: work?.year ? String(work.year) : fallback.year || '',
    ...(work?.venue ? (itemType === 'preprint' ? { repository: work.venue } : { publicationTitle: work.venue }) : {}),
    url: work?.url ?? '',
    abstractNote: work?.abstract ?? '',
  };
  const creators = (Array.isArray(work?.authors) ? work.authors : []).map(splitFullName).filter(Boolean);
  return {
    itemType,
    fields,
    creators: creators.length > 0 ? creators : splitApaAuthors(fallback.authorsRaw),
    doi: normalizeDoi(work?.doi ?? fallback.doi),
  };
}

/** 仅凭解析出的引用行构造条目（离线兜底）。 */
export function fromParsedLine(parsed) {
  const itemType = parsed.itemTypeHint || guessItemType(parsed.venue, '');
  const fields = {
    title: parsed.title || '',
    date: parsed.year || '',
    ...(parsed.venue ? (itemType === 'conferencePaper' ? { proceedingsTitle: parsed.venue } : { publicationTitle: parsed.venue }) : {}),
    volume: parsed.volume || '',
    issue: parsed.issue || '',
    pages: parsed.pages || '',
  };
  return { itemType, fields, creators: splitApaAuthors(parsed.authorsRaw), doi: parsed.doi };
}

/** 输入项规整：字符串（DOI/标题/整行）或 { raw|doi|title|itemType|n }。 */
export function normalizeRefEntry(entry) {
  if (typeof entry === 'string') return parseReferenceLine(entry);
  const base = parseReferenceLine(entry?.raw ?? entry?.doi ?? entry?.title ?? '');
  return {
    ...base,
    ...(entry?.doi ? { doi: normalizeDoi(entry.doi) } : {}),
    ...(entry?.title ? { title: entry.title } : {}),
    ...(entry?.itemType ? { itemTypeHint: entry.itemType } : {}),
    ...(entry?.n !== undefined ? { n: entry.n } : {}),
  };
}

async function fetchCrossref(doi, mailto, proxy = '') {
  const url = new URL(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
  if (mailto) url.searchParams.set('mailto', mailto);
  const res = await externalFetch(url.toString(), {
    headers: { 'User-Agent': `dsh-lit-full-search (mailto:${mailto || 'anonymous'})` },
  }, proxy);
  if (!res.ok) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text)?.message ?? null;
  } catch {
    return null;
  }
}

/**
 * 元数据链：Crossref → OpenAlex(DOI) → OpenAlex(标题) → 行内解析。
 * 任何一步失败都只降级不抛。
 */
export async function resolveMetadata(parsed, options = {}) {
  const { mailto = '', auth = {} } = options;
  if (parsed.doi) {
    const message = await fetchCrossref(parsed.doi, mailto, auth.proxy).catch(() => null);
    if (message) return fromCrossref(message, parsed);
    const work = await lookupOpenAlexByDoi(parsed.doi, auth).catch(() => null);
    if (work) return fromOpenAlexWork(work, parsed);
    return fromParsedLine(parsed);
  }
  if (parsed.title) {
    const result = await searchOpenAlex(parsed.title, { limit: 1, ...auth }).catch(() => null);
    const work = result?.items?.[0];
    if (work) return fromOpenAlexWork(work, parsed);
  }
  return fromParsedLine(parsed);
}

/** PDF 文件魔数（%PDF）。 */
const PDF_MAGIC = '%PDF';

/** 取 OA PDF 直链：Crossref 不提供，只有 OpenAlex 的 best_oa_location 会给。 */
export async function resolveOaPdfUrl(parsed, auth = {}) {
  if (!parsed?.doi) return '';
  const work = await lookupOpenAlexByDoi(parsed.doi, auth).catch(() => null);
  return work?.oaPdfUrl || '';
}

/** 下载并校验 PDF（魔数），返回字节。 */
export async function downloadPdf(url, proxy = '') {
  const res = await externalFetch(url, { headers: { Connection: 'close' } }, proxy);
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status} ${res.statusText}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const magic = String.fromCharCode(...bytes.slice(0, 4));
  if (magic !== PDF_MAGIC) throw new Error(`下载内容不是 PDF（魔数 ${JSON.stringify(magic)}）`);
  return bytes;
}

/**
 * 批次导入。`dryRun` 只做只读推导，不发起任何写请求。
 *
 * @param {object} options
 * @param {(string|object)[]} options.refs     参考文献（DOI / 标题 / 整行 / 对象）
 * @param {string} [options.library='user']    目标库（key / id / 名称）
 * @param {string} [options.collection='']     目标收藏夹（key / 名称 / '父 > 子'）
 * @param {string[]} [options.itemTypes=[]]    允许的 Zotero itemType 白名单
 * @param {boolean} [options.dryRun=false]     只读推导，不写
 * @param {boolean} [options.attachPdf=false]  新建条目后尝试挂 OA PDF（失败只记录，不影响建档）
 * @param {object} [options.auth={}]           OpenAlex 认证（apiKey/mailto）
 * @param {string} [options.zoteroKey]         Zotero 写 key（缺省取 auth.zoteroKey）
 * @param {string} [options.mailto='']         Crossref 礼貌池邮箱
 * @returns {Promise<object>} 报告
 */
export async function importReferences(options = {}) {
  const {
    refs = [],
    library = 'user',
    collection = '',
    itemTypes = [],
    dryRun = false,
    attachPdf = false,
    auth = {},
    zoteroKey = auth.zoteroKey,
    mailto = '',
    limit = MAX_IMPORT_REFS,
  } = options;

  if (!Array.isArray(refs) || refs.length === 0) throw new Error('refs 不能为空');
  if (refs.length > limit) throw new Error(`单次最多导入 ${limit} 条参考文献，当前 ${refs.length} 条`);

  const target = await resolveTarget({ library, collection });
  const index = await buildCollectionIndex(target);
  const allow = Array.isArray(itemTypes) ? itemTypes.filter(Boolean) : [];
  const items = [];

  for (const [position, entry] of refs.entries()) {
    const parsed = normalizeRefEntry(entry);
    // n 必须始终是具体值：parseReferenceLine 对裸 DOI/裸标题不产出 n，
    // 若写成 `n: parsed.n` 会出现值为 undefined 的键 → JSON.stringify 丢键 →
    // DSH 的 lossless JSON 校验直接拒绝整个工具结果。字符串条目回落到 1-based 序号。
    const record = {
      n: parsed.n ?? position + 1,
      doi: parsed.doi,
      title: parsed.title,
      itemType: parsed.itemTypeHint ?? '',
      action: '',
      itemKey: '',
      error: '',
      ...(dryRun ? { planned: false } : {}),
    };
    try {
      if (allow.length > 0 && parsed.itemTypeHint && !allow.includes(parsed.itemTypeHint)) {
        record.action = 'skipped';
        record.error = `itemType ${parsed.itemTypeHint} 不在白名单 ${allow.join('/')}`;
        items.push(record);
        continue;
      }

      // 1) 已在目标收藏夹？
      const doiKey = parsed.doi ? parsed.doi.toLowerCase() : '';
      const titleKey = normalizeTitle(parsed.title);
      const inCollection = (doiKey && index.dois.has(doiKey)) || (!doiKey && titleKey && index.titles.has(titleKey));
      if (inCollection) {
        record.action = 'exists';
        items.push(record);
        continue;
      }

      // 2) 在目标库其它位置？→ 加挂到目标收藏夹（无收藏夹目标时按「已存在」处理）
      const query = parsed.doi || parsed.title;
      if (query) {
        const found = await zoteroSearch(query, { libraryKey: target.libraryKey, qmode: 'everything', limit: 25 }).catch(() => []);
        const hit = parsed.doi
          ? found.find((x) => normalizeDoi(x.doi).toLowerCase() === doiKey)
          : found.find((x) => normalizeTitle(x.title) === titleKey);
        if (hit) {
          if (target.collectionKey) {
            const result = dryRun
              ? { added: true }
              : await zoteroAddToCollection(hit.key, target.collectionKey, { libraryKey: target.libraryKey, zoteroKey });
            record.action = 'added';
            record.itemKey = hit.key;
            record.itemType = hit.itemType || record.itemType;
            record.title = record.title || hit.title;
            if (dryRun) record.planned = result.added;
            items.push(record);
            continue;
          }
          record.action = 'exists';
          record.itemKey = hit.key;
          items.push(record);
          continue;
        }
      }

      // 3) 新建：先解析元数据，再按 itemType 白名单过滤
      const meta = await resolveMetadata(parsed, { mailto, auth });
      record.itemType = meta.itemType;
      record.title = meta.fields?.title || record.title;
      if (record.doi === '' && meta.doi) record.doi = meta.doi;
      if (allow.length > 0 && !allow.includes(meta.itemType)) {
        record.action = 'skipped';
        record.error = `解析出 itemType ${meta.itemType}，不在白名单 ${allow.join('/')}`;
        items.push(record);
        continue;
      }
      if (!meta.fields?.title) {
        record.action = 'failed';
        record.error = '无法解析出标题';
        items.push(record);
        continue;
      }
      if (dryRun) {
        record.action = 'created';
        record.planned = true;
        if (attachPdf) record.pdf = parsed.doi ? 'planned' : 'skipped';
        items.push(record);
        continue;
      }
      const created = await zoteroCreateItem(
        { itemType: meta.itemType, title: meta.fields.title, creators: meta.creators, fields: filterFields(meta.itemType, meta.fields), doi: meta.doi },
        { collectionKey: target.collectionKey, libraryKey: target.libraryKey, zoteroKey },
      );
      record.action = 'created';
      record.itemKey = created.itemKey;

      // 可选：挂 OA PDF。任何一步失败都只记在条目上，绝不改变「已建档」的事实。
      if (attachPdf) {
        const doi = parsed.doi || meta.doi;
        if (!doi) {
          record.pdf = 'skipped';
        } else {
          try {
            const pdfUrl = await resolveOaPdfUrl({ doi }, auth);
            if (!pdfUrl) {
              record.pdf = 'none';
            } else {
              const bytes = await downloadPdf(pdfUrl, auth.proxy);
              const attached = await zoteroAttachPdf(created.itemKey, bytes, {
                zoteroKey,
                libraryKey: target.libraryKey,
                title: meta.fields?.title || '',
                filename: `${doi.replace(/[^\w.-]+/g, '_')}.pdf`,
              });
              record.pdf = attached.duplicate ? 'exists' : 'attached';
            }
          } catch (err) {
            record.pdf = 'failed';
            record.pdfError = err instanceof Error ? err.message : String(err);
          }
        }
      }
      items.push(record);
    } catch (error) {
      record.action = 'failed';
      record.error = error instanceof Error ? error.message : String(error);
      items.push(record);
    }
  }

  const counts = { created: 0, added: 0, exists: 0, skipped: 0, failed: 0 };
  for (const item of items) counts[item.action] = (counts[item.action] ?? 0) + 1;

  return {
    dryRun,
    library: target.libraryName,
    libraryKey: target.libraryKey,
    collection: target.collectionPath,
    collectionKey: target.collectionKey,
    collectionSizeBefore: index.count,
    counts,
    items,
  };
}
