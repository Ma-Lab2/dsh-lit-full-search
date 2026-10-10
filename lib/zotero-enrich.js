/**
 * zotero_enrich 引擎：**单点查** —— 给定一个条目引用（item key / DOI / 标题 / zotero:// 引用），
 * 从本地 Zotero 取回该条目的深度记录：书目字段、标签、所属收藏夹（含名称与路径）、
 * 笔记、**全部附件**（可选解析磁盘路径与存在性）、附件下的批注、以及 Zotero 全文索引缓存。
 *
 * 只读：本模块不发起任何写请求；不做库级枚举。
 */

import {
  zoteroAttachmentFulltext,
  zoteroFindByDoi,
  zoteroGetItem,
  zoteroItemChildren,
  zoteroListCollections,
  zoteroListLibraries,
  zoteroResolveAttachmentPath,
  zoteroSearch,
} from './light-core.js';
import { normalizeTitle, resolveLibraryKey } from './lit-to-zotero.js';

/** 可选的额外对象集合。基础标识字段（key/itemType/title/date/DOI）总是返回。 */
export const ENRICH_INCLUDES = ['fields', 'tags', 'collections', 'notes', 'attachments', 'annotations', 'fulltext'];
export const ENRICH_DEFAULT_INCLUDE = ['fields', 'tags', 'collections'];
export const MAX_CHARS_RANGE = { min: 200, max: 20000, default: 2000 };

/** 去掉笔记/批注里的 HTML 标签与多余空白。 */
export function stripHtml(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 规整 Zotero 里存的摘要：来源网页的换行/缩进会原样留在 abstractNote 里
 * （实测某条 939 字符中 219 个是空白，上标 `10^18 W cm^-2` 被拆成 4 行），
 * 这里折叠所有空白为单空格，并去掉开头的 `Abstract` / `摘要` 段标签。
 */
export function normalizeAbstract(text) {
  const collapsed = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return collapsed.replace(/^(?:abstract|摘要)\s*(?:[:：]\s*|\s+)/i, '');
}

/** 截断到 maxChars，返回 { text, chars, truncated }。 */
function clampText(text, maxChars) {
  const full = String(text ?? '');
  const text2 = full.length > maxChars ? full.slice(0, maxChars) : full;
  return { text: text2, chars: full.length, truncated: full.length > maxChars };
}

/**
 * 解析条目引用。返回 { kind, key?, libraryKey?, doi?, title? }。
 * 支持：8 位 item key / `zotero://user/0/item/KEY` / `zotero://group/<id>/attachment/KEY` / DOI / 标题。
 */
export function parseEnrichRef(ref) {
  const raw = String(ref ?? '').trim();
  if (raw === '') throw new Error('ref 不能为空');
  const zoteroRef = raw.match(/^zotero:\/\/(user|group)\/([^/]+)\/(item|attachment)\/([A-Za-z0-9]+)$/i);
  if (zoteroRef) {
    const [, scope, scopeId, kind, key] = zoteroRef;
    return {
      kind: 'zotero',
      key,
      refKind: kind.toLowerCase(),
      libraryKey: scope.toLowerCase() === 'user' ? 'user' : `group:${scopeId}`,
    };
  }
  if (/^[A-Za-z0-9]{8}$/.test(raw)) return { kind: 'key', key: raw };
  const doiMatch = raw.match(/10\.\d{4,9}\/\S+/);
  if (doiMatch) return { kind: 'doi', doi: doiMatch[0].replace(/[.)，。]+$/, '') };
  return { kind: 'title', title: raw };
}

/** data → 基础标识字段（总是返回）。 */
function identityFields(data) {
  return {
    itemType: data.itemType ?? '',
    title: data.title ?? '',
    date: data.date ?? '',
    DOI: data.DOI ?? '',
  };
}

/** data → 书目字段（include 含 'fields' 时并入）。 */
function bibliographicFields(data) {
  const creators = Array.isArray(data.creators)
    ? data.creators.map((c) => (c?.name ? { name: c.name } : { firstName: c?.firstName ?? '', lastName: c?.lastName ?? '' }))
    : [];
  const year = /(19|20)\d{2}/.exec(String(data.date ?? ''));
  return {
    creators,
    year: year ? Number(year[0]) : null,
    publicationTitle:
      (data.publicationTitle ?? '') || (data.bookTitle ?? '') || (data.proceedingsTitle ?? '') || (data.journalAbbreviation ?? ''),
    volume: data.volume ?? '',
    issue: data.issue ?? '',
    pages: data.pages ?? '',
    url: data.url ?? '',
    abstractNote: normalizeAbstract(data.abstractNote),
    extra: data.extra ?? '',
    language: data.language ?? '',
    dateAdded: data.dateAdded ?? '',
    dateModified: data.dateModified ?? '',
  };
}

/** 标签：data.tags[].tag → 字符串数组。 */
export function mapTags(data) {
  if (!Array.isArray(data.tags)) return [];
  return data.tags.map((t) => (typeof t === 'string' ? t : t?.tag)).filter((t) => typeof t === 'string' && t);
}

/** 收藏夹 key → { key, name, path }（用库内收藏夹表映射，未知 key 仅回 key）。 */
export function mapCollections(keys, collections) {
  const byKey = new Map((collections ?? []).map((c) => [c.key, c]));
  return (Array.isArray(keys) ? keys : [])
    .filter((k) => typeof k === 'string' && k)
    .map((k) => {
      const hit = byKey.get(k);
      return { key: k, name: hit?.name ?? '', path: hit?.path ?? '' };
    });
}

/** 子对象分组（纯函数，便于测试）。 */
export function groupChildren(children = []) {
  const notes = [];
  const attachments = [];
  for (const child of children) {
    const data = child?.data ?? {};
    if (data.itemType === 'note') notes.push(child);
    else if (data.itemType === 'attachment') attachments.push(child);
  }
  return { notes, attachments };
}

/**
 * 单点查主流程。
 *
 * @param {object} options
 * @param {string} options.ref            条目引用（必填）
 * @param {string} [options.library]      目标库（'user' / 'group:<id>' / 库名）
 * @param {string[]} [options.include]    额外对象集合，见 ENRICH_INCLUDES
 * @param {boolean} [options.paths]       是否解析附件磁盘路径
 * @param {number} [options.maxChars]     笔记/批注/全文截断
 * @returns {Promise<object>}
 */
export async function enrichItem(options = {}) {
  const { ref, library = 'user', include = ENRICH_DEFAULT_INCLUDE, paths = false } = options;
  const maxCharsRaw = Number(options.maxChars);
  const maxChars = Number.isInteger(maxCharsRaw)
    ? Math.min(Math.max(maxCharsRaw, MAX_CHARS_RANGE.min), MAX_CHARS_RANGE.max)
    : MAX_CHARS_RANGE.default;
  const wants = (name) => Array.isArray(include) && include.includes(name);

  const parsed = parseEnrichRef(ref);
  const libraries = await zoteroListLibraries();
  const libraryKey = parsed.libraryKey ?? resolveLibraryKey(libraries, library);
  const libraryName = libraries.find((l) => l.libraryKey === libraryKey)?.name ?? libraryKey;

  const notFound = (extra = {}) => ({
    found: false,
    ref: String(ref),
    library: libraryName,
    libraryKey,
    hint: '该库内未命中；可先用 zotero_search 定位 key，或用 zotero_collections 确认库/收藏夹',
    ...extra,
  });

  // 1) 定位条目
  let itemKey = parsed.kind === 'key' || parsed.kind === 'zotero' ? parsed.key : '';
  let resolvedBy = parsed.kind;
  if (!itemKey && parsed.kind === 'doi') {
    const hit = await zoteroFindByDoi(parsed.doi, { libraryKey }).catch(() => null);
    if (hit) {
      itemKey = hit.key;
      resolvedBy = 'doi';
    }
  }
  if (!itemKey && parsed.kind === 'title') {
    const hits = await zoteroSearch(parsed.title, { libraryKey, qmode: 'everything', limit: 25 }).catch(() => []);
    const wanted = normalizeTitle(parsed.title);
    const hit = hits.find((x) => normalizeTitle(x.title) === wanted) ?? hits[0];
    if (hit) {
      itemKey = hit.key;
      resolvedBy = 'title';
    }
  }
  if (!itemKey) return notFound();

  let record = await zoteroGetItem(itemKey, { libraryKey });
  if (!record) return notFound({ resolvedBy });

  // zotero://…/attachment/KEY → 若挂父条目则转到父条目
  if (record.data.itemType === 'attachment' && typeof record.data.parentItem === 'string' && record.data.parentItem) {
    const parent = await zoteroGetItem(record.data.parentItem, { libraryKey });
    if (parent) {
      record = parent;
      resolvedBy = 'zotero-attachment';
    }
  }

  const data = record.data;
  const warnings = [];
  const item = {
    key: record.key,
    version: record.version,
    itemType: data.itemType ?? '',
    title: data.title ?? '',
    date: data.date ?? '',
    DOI: data.DOI ?? '',
  };
  if (wants('fields')) Object.assign(item, bibliographicFields(data));
  if (wants('tags')) item.tags = mapTags(data);
  if (wants('collections')) {
    try {
      const collections = await zoteroListCollections({ libraryKey });
      item.collections = mapCollections(data.collections, collections);
    } catch (err) {
      warnings.push(`收藏夹映射失败：${err instanceof Error ? err.message : String(err)}`);
      item.collections = mapCollections(data.collections, []);
    }
  }

  const counts = { notes: 0, attachments: 0, annotations: 0, fulltext: 0 };
  const needsChildren = wants('notes') || wants('attachments') || wants('annotations') || wants('fulltext');
  if (needsChildren) {
    let children = [];
    try {
      children = await zoteroItemChildren(record.key, { libraryKey });
    } catch (err) {
      warnings.push(`读取子条目失败：${err instanceof Error ? err.message : String(err)}`);
    }
    const { notes, attachments } = groupChildren(children);

    if (wants('notes')) {
      item.notes = notes.map((n) => {
        const text = clampText(stripHtml(n.data.note), maxChars);
        return { key: n.key, ...text };
      });
      counts.notes = item.notes.length;
    }

    if (wants('attachments') || wants('annotations') || wants('fulltext')) {
      item.attachments = [];
      for (const att of attachments) {
        const a = att.data;
        const entry = {
          key: att.key,
          title: a.title ?? '',
          contentType: a.contentType ?? '',
          filename: a.filename ?? '',
          linkMode: a.linkMode ?? '',
          parentItem: a.parentItem ?? record.key,
        };
        if (paths) {
          try {
            const resolved = await zoteroResolveAttachmentPath(att.key, { libraryKey });
            entry.path = resolved.path ?? null;
            entry.exists = resolved.exists;
            if (resolved.url) entry.url = resolved.url;
            if (resolved.error) entry.error = resolved.error;
          } catch (err) {
            entry.error = err instanceof Error ? err.message : String(err);
          }
        }
        item.attachments.push(entry);
      }
      counts.attachments = item.attachments.length;

      if (wants('annotations')) {
        item.annotations = [];
        for (const att of attachments) {
          try {
            const kids = await zoteroItemChildren(att.key, { libraryKey });
            for (const kid of kids) {
              if (kid.data.itemType !== 'annotation') continue;
              const text = clampText(kid.data.annotationText ?? '', maxChars);
              const comment = clampText(kid.data.annotationComment ?? '', maxChars);
              item.annotations.push({
                key: kid.key,
                parentKey: att.key,
                text: text.text,
                textChars: text.chars,
                comment: comment.text,
                page: kid.data.annotationPageLabel ?? '',
                color: kid.data.annotationColor ?? '',
              });
            }
          } catch (err) {
            warnings.push(`批注读取失败（${att.key}）：${err instanceof Error ? err.message : String(err)}`);
          }
        }
        counts.annotations = item.annotations.length;
      }

      if (wants('fulltext')) {
        item.fulltext = [];
        for (const att of attachments) {
          try {
            const ft = await zoteroAttachmentFulltext(att.key, { libraryKey });
            if (!ft.content) continue;
            const clamped = clampText(ft.content, maxChars);
            item.fulltext.push({
              attachmentKey: att.key,
              ...clamped,
              indexedChars: ft.indexedChars,
              totalChars: ft.totalChars,
            });
          } catch (err) {
            warnings.push(`全文索引读取失败（${att.key}）：${err instanceof Error ? err.message : String(err)}`);
          }
        }
        counts.fulltext = item.fulltext.length;
      }
    }
  }

  return {
    found: true,
    ref: String(ref),
    resolvedBy,
    library: libraryName,
    libraryKey,
    item,
    counts,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
