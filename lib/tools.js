/**
 * dsh-lit-full-search 工具层：7 个全局 model 工具。
 *
 * 每个工具 = light-core 薄包装 + 结果裁剪防上下文爆炸（预算来自配置文件/环境变量）。
 *
 * execute 出错 **必须 throw**（带 cause），不能返回 {isError:true} 信封——
 * DSH 的 ToolRuntime 把 execute 返回值一律当作符合 output.schema 的成功值送进 render，
 * 出错路径只认抛出的异常（dsh-tools: `const returned = await tool.execute(...); createSuccessResult(...)`
 * 外层 `catch (error) { return toolErrorResult(error) }`）。若返回信封会报出误导性的
 * "output.render failed"，把真实原因掩盖。见 interfaces/dsh-preset/host-plugin.js 的 wrapToolError。
 */
import {
  searchOpenAlex,
  searchSemanticScholar,
  lookupOpenAlexByDoi,
  citedByOpenAlex,
  zoteroSearch,
  zoteroFindByDoi,
  zoteroCreateItem,
  zoteroListLibraries,
  zoteroListCollections,
} from './light-core.js';
import { MAX_IMPORT_REFS, importReferences, resolveTarget } from './zotero-import.js';
import { loadConfig, resolveAuth, resolveBudget } from './config.js';

/**
 * 单源结果条数上限（防上下文爆炸；OpenAlex per_page 上限 200，这里保守）。
 * 只约束单个数据源；双源合并后的总量不设上限（最坏 2×limit）。
 */
export const LIMIT_CAP = 25;

/** 把作者参数 DSL 编译成 DSH 工具注册所需的 JSON Schema（同上文 host-plugin.js compileParams）。 */
export function compileParams(spec) {
  const properties = {};
  const required = [];
  for (const [key, def] of Object.entries(spec ?? {})) {
    const { required: isRequired, ...rest } = def ?? {};
    properties[key] = rest;
    if (isRequired === true) required.push(key);
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/** 错误包装：把底层异常包装成带工具名的清晰错误。必须抛出——见文件头注释。 */
export function wrapToolError(toolName, error) {
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`${toolName} 执行失败：${message}`);
  wrapped.cause = error;
  return wrapped;
}

/** 文献卡片视图：工具结果的结构化 meta（进入结果节点的 `meta`，浏览器端 `tool.call.toolview` 渲染文献卡片）。 */
function literatureMeta(payload) {
  return { card: 'literature', ...payload };
}

/**
 * 检索结果投影为精简格式（对应用户预算裁剪）。
 *
 * 注意：必须整体剔除 abstract 键，不能写成 `{ ...item, abstract: undefined }`——
 * DSH 的 ToolRuntime 会对 execute 返回值做 lossless JSON 校验（JSON.stringify 往返），
 * undefined 值会被 stringify 丢弃导致往返不等，报「value is not lossless JSON」。
 */
function toTrimmedResult(result) {
  return {
    items: (result.items ?? []).map(({ abstract, ...rest }) => rest),
    diagnostics: result.diagnostics,
  };
}

/** 读取当前生效的认证（文件配置 > 环境变量）与预算。 */
function effectiveAuthAndBudget() {
  const config = loadConfig();
  return { auth: resolveAuth(config), budget: resolveBudget(config) };
}

/**
 * 双源检索合并：OpenAlex 与 Semantic Scholar 结果按 DOI（无 DOI 按 标题+年份）去重，
 * 轮流交叉排序（OpenAlex 在前）。**不设合并总量上限**——每个源已各自夹紧到 limit
 * （单源上限 LIMIT_CAP），双源最坏情况即 2×limit 条。
 * 某个源失败时其 diagnostics 记 { ok:false, error }，不拖垮另一个源。
 */
export function mergeSearchResults(openAlexResult, s2Result) {
  const oaItems = openAlexResult?.items ?? [];
  const s2Items = s2Result?.items ?? [];
  const seen = new Set();
  const items = [];
  const push = (item) => {
    const key = item.doi ? `doi:${item.doi.toLowerCase()}` : `t:${(item.title || '').toLowerCase()}|${item.year ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };
  const max = Math.max(oaItems.length, s2Items.length);
  for (let i = 0; i < max; i += 1) {
    if (i < oaItems.length) push(oaItems[i]);
    if (i < s2Items.length) push(s2Items[i]);
  }
  return {
    items,
    diagnostics: { ...(openAlexResult?.diagnostics ?? {}), ...(s2Result?.diagnostics ?? {}) },
  };
}

/** 裁剪单个整数参数：无参数 → 默认；越界 → 夹紧。 */
function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

// ---- 工具定义表 ---------------------------------------------------------------

export const toolDefinitions = [
  {
    name: 'lit_search',
    description: '学术文献检索（OpenAlex；配置 Semantic Scholar API Key 后双源检索并按 DOI 去重合并）。按关键词检索，返回结构化文献列表（标题/作者/年份/期刊/DOI/被引/链接）。可配合 yearFrom/yearTo 过滤年份。',
    parameters: {
      query: { type: 'string', required: true, description: '检索关键词或短语' },
      limit: { type: 'integer', description: '每个数据源的结果上限（默认取检索预算，最大 25）；配置 Semantic Scholar 后双源各取 limit 条再合并，合计最多 2×limit（不设合并总量上限）' },
      yearFrom: { type: 'integer', description: '起始年份（含）' },
      yearTo: { type: 'integer', description: '结束年份（含）' },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        items: { type: 'array', items: { type: 'object', additionalProperties: true } },
        diagnostics: { type: 'object', additionalProperties: true },
      },
    },
    async execute(args) {
      const { auth, budget } = effectiveAuthAndBudget();
      const requested = args.limit !== undefined ? clampInt(args.limit, 1, LIMIT_CAP, budget.searchLimit) : budget.searchLimit;
      const limit = Math.min(requested, budget.searchLimit);
      const years = {
        ...(args.yearFrom ? { yearFrom: args.yearFrom } : {}),
        ...(args.yearTo ? { yearTo: args.yearTo } : {}),
      };
      if (!auth.s2ApiKey) {
        const result = await searchOpenAlex(args.query, { limit, ...years, ...auth });
        return toTrimmedResult(result);
      }
      // 配置了 S2 密钥：双源并发检索；单源失败记入 diagnostics，两源均失败才抛错。
      const [oa, s2] = await Promise.allSettled([
        searchOpenAlex(args.query, { limit, ...years, ...auth }),
        searchSemanticScholar(args.query, { limit, ...years, s2ApiKey: auth.s2ApiKey }),
      ]);
      if (oa.status === 'rejected' && s2.status === 'rejected') {
        throw new Error(`OpenAlex 与 Semantic Scholar 均失败：${oa.reason?.message ?? oa.reason}；${s2.reason?.message ?? s2.reason}`);
      }
      const failedDiagnostics = (source, reason) => ({ [source]: { ok: false, error: String(reason?.message ?? reason) } });
      const oaResult = oa.status === 'fulfilled' ? oa.value : { items: [], diagnostics: failedDiagnostics('openalex', oa.reason) };
      const s2Result = s2.status === 'fulfilled' ? s2.value : { items: [], diagnostics: failedDiagnostics('semanticscholar', s2.reason) };
      return toTrimmedResult(mergeSearchResults(oaResult, s2Result));
    },
    render(args, value) {
      const items = Array.isArray(value?.items) ? value.items : [];
      const lines = items.map((item) => {
        const authors = Array.isArray(item.authors) && item.authors.length > 0 ? item.authors.join(', ') : '未知作者';
        const year = item.year ?? '?';
        const doi = item.doi ? ` | DOI: ${item.doi}` : '';
        const cited = typeof item.citationCount === 'number' ? ` | 被引 ${item.citationCount}` : '';
        return `- **${item.title}**（${authors}, ${year}）${doi}${cited}\n  来源: ${item.source} | ${item.url}`;
      });
      if (items.length === 0) {
        return [{ type: 'text', text: `未找到与「${args.query}」相关的文献。` }];
      }
      return [{ type: 'text', text: `检索「${args.query}」结果（${items.length} 条）：\n\n${lines.join('\n')}` }];
    },
    presentationMeta(args, value) {
      return literatureMeta({
        kind: 'list',
        tool: 'lit_search',
        ...(args.query ? { query: args.query } : {}),
        items: (Array.isArray(value?.items) ? value.items : []).map((item) => ({
          title: item.title,
          authors: Array.isArray(item.authors) ? item.authors.slice(0, 5) : [],
          year: item.year ?? null,
          venue: item.venue || '',
          doi: item.doi || '',
          citationCount: item.citationCount ?? null,
          source: item.source || '',
          url: item.url || '',
        })),
      });
    },
  },
  {
    name: 'lit_abstract',
    description: '通过 DOI 或标题获取文献摘要（OpenAlex）。无摘要时返回 status=missing；标题不足时可用 doi 精确匹配。',
    parameters: {
      doi: { type: 'string', description: '文献 DOI（优先，精确）' },
      title: { type: 'string', description: '文献标题（无 DOI 时用标题检索取第一条）' },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        abstract: { type: 'string' },
        source: { type: 'string' },
        status: { type: 'string' },
        title: { type: 'string' },
        doi: { type: 'string' },
      },
    },
    async execute(args) {
      if (!args.doi && !args.title) throw new Error('必须提供 doi 或 title 之一。');
      const { auth, budget } = effectiveAuthAndBudget();
      let work;
      if (args.doi) {
        work = await lookupOpenAlexByDoi(args.doi, auth);
      } else {
        const result = await searchOpenAlex(args.title, { limit: 1, ...auth });
        work = result.items[0];
      }
      if (!work) {
        return { abstract: '', source: 'openalex', status: 'missing', title: args.title || '', doi: args.doi || '' };
      }
      return {
        abstract: (work.abstract || '').slice(0, budget.abstractChars),
        source: work.source || 'openalex',
        status: work.abstract ? 'complete' : 'missing',
        title: work.title || args.title || '',
        doi: work.doi || args.doi || '',
      };
    },
    render(args, value) {
      if (value.status === 'missing' || !value.abstract) {
        return [{ type: 'text', text: `未找到摘要${value.title ? `：《${value.title}》` : ''}（DOI: ${value.doi || '未知'}）。` }];
      }
      return [{ type: 'text', text: `摘要（来源: ${value.source}，标题: ${value.title}）：\n\n${value.abstract}` }];
    },
    presentationMeta(args, value) {
      return literatureMeta({
        kind: 'abstract',
        tool: 'lit_abstract',
        ...(value.title ? { title: value.title } : {}),
        ...(value.doi ? { doi: value.doi } : {}),
        source: value.source || '',
        status: value.status || 'missing',
        abstract: (value.abstract || '').slice(0, 800),
      });
    },
  },
  {
    name: 'lit_cited_by',
    description: '查询一篇文献的被引列表（OpenAlex cited-by）。传 DOI 或 OpenAlex work ID（如 W1234567890）。',
    parameters: {
      identifier: { type: 'string', required: true, description: '文献 DOI 或 OpenAlex work ID' },
      limit: { type: 'integer', description: '结果上限（默认取检索预算，最大 25）' },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        items: { type: 'array', items: { type: 'object', additionalProperties: true } },
        diagnostics: { type: 'object', additionalProperties: true },
      },
    },
    async execute(args) {
      const { auth, budget } = effectiveAuthAndBudget();
      const requested = args.limit !== undefined ? clampInt(args.limit, 1, LIMIT_CAP, budget.citedByLimit) : budget.citedByLimit;
      const limit = Math.min(requested, budget.citedByLimit);
      const result = await citedByOpenAlex(args.identifier, { limit, ...auth });
      return toTrimmedResult(result);
    },
    render(args, value) {
      const items = Array.isArray(value?.items) ? value.items : [];
      if (items.length === 0) {
        return [{ type: 'text', text: `未找到「${args.identifier}」的被引记录。` }];
      }
      const lines = items.map((item) => {
        const authors = Array.isArray(item.authors) && item.authors.length > 0 ? item.authors.join(', ') : '未知作者';
        const year = item.year ?? '?';
        const doi = item.doi ? ` | DOI: ${item.doi}` : '';
        return `- **${item.title}**（${authors}, ${year}）${doi}\n  来源: ${item.source} | ${item.url}`;
      });
      return [{ type: 'text', text: `「${args.identifier}」的被引文献（${items.length} 条）：\n\n${lines.join('\n')}` }];
    },
    presentationMeta(args, value) {
      return literatureMeta({
        kind: 'list',
        tool: 'lit_cited_by',
        ...(args.identifier ? { identifier: args.identifier } : {}),
        items: (Array.isArray(value?.items) ? value.items : []).map((item) => ({
          title: item.title,
          authors: Array.isArray(item.authors) ? item.authors.slice(0, 5) : [],
          year: item.year ?? null,
          venue: item.venue || '',
          doi: item.doi || '',
          citationCount: item.citationCount ?? null,
          source: item.source || '',
          url: item.url || '',
        })),
      });
    },
  },
  {
    name: 'zotero_search',
    description: '检索本地 Zotero 库（需 Zotero 10+ 运行中并开启本地 API）。返回条目 key/标题/作者/年份/DOI/URL。',
    parameters: {
      query: { type: 'string', required: true, description: '检索关键词（匹配全文索引与标题/作者/年份）' },
      limit: { type: 'integer', description: '结果上限（默认取检索预算，最大 100）' },
      qmode: { type: 'string', description: '检索模式：everything（默认）| titleCreatorYear' },
      library: { type: 'string', description: "目标库：缺省 'user'（个人库）/ 'group:<id>' / 纯数字群组 id / 库名" },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        items: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
    },
    async execute(args) {
      const { budget } = effectiveAuthAndBudget();
      const requested = args.limit !== undefined ? clampInt(args.limit, 1, 100, budget.zoteroLimit) : budget.zoteroLimit;
      const limit = Math.min(requested, budget.zoteroLimit);
      const libraryKey = args.library ? (await resolveTarget({ library: args.library })).libraryKey : 'user';
      const items = await zoteroSearch(args.query, {
        limit,
        libraryKey,
        ...(args.qmode ? { qmode: args.qmode } : {}),
      });
      return { items };
    },
    render(args, value) {
      const items = Array.isArray(value?.items) ? value.items : [];
      if (items.length === 0) {
        return [{ type: 'text', text: `Zotero 中未找到「${args.query}」相关条目。` }];
      }
      const lines = items.map((item) => {
        const authors = Array.isArray(item.authors) && item.authors.length > 0 ? item.authors.join(', ') : '未知作者';
        const year = item.year ?? '?';
        const doi = item.doi ? ` | DOI: ${item.doi}` : '';
        return `- **${item.title}**（${authors}, ${year}）[key: ${item.key}]${doi}`;
      });
      return [{ type: 'text', text: `Zotero 检索结果（${items.length} 条）：\n\n${lines.join('\n')}` }];
    },
    presentationMeta(args, value) {
      return literatureMeta({
        kind: 'list',
        tool: 'zotero_search',
        ...(args.query ? { query: args.query } : {}),
        zotero: true,
        items: (Array.isArray(value?.items) ? value.items : []).map((item) => ({
          title: item.title,
          authors: Array.isArray(item.authors) ? item.authors.slice(0, 5) : [],
          year: item.year ?? null,
          doi: item.doi || '',
          key: item.key || '',
          libraryKey: item.libraryKey || 'user',
        })),
      });
    },
  },
  {
    name: 'zotero_save',
    description: '将文献归档到 Zotero：DOI 查重 → 建条目。幂等，重复执行不会重复建条目。需要 Zotero 本地 API 运行中；写操作需要 LIT_SEARCH_ZOTERO_KEY（Zotero → 设置 → 高级 → 密钥）。',
    parameters: {
      doi: { type: 'string', description: '文献 DOI（优先）' },
      title: { type: 'string', description: '文献标题（无 DOI 时用标题检索）' },
      collectionKey: { type: 'string', description: '目标收藏夹 key（可选）' },
      library: { type: 'string', description: "目标库：缺省 'user'（个人库）/ 'group:<id>' / 纯数字群组 id / 库名" },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        outcome: { type: 'string' },
        itemKey: { type: 'string' },
        title: { type: 'string' },
        doi: { type: 'string' },
      },
    },
    async execute(args) {
      if (!args.doi && !args.title) throw new Error('必须提供 doi 或 title 之一。');

      // 解析文献元数据（OpenAlex）
      const { auth } = effectiveAuthAndBudget();
      let work;
      if (args.doi) {
        work = await lookupOpenAlexByDoi(args.doi, auth).catch(() => undefined);
      }
      if (!work && args.title) {
        const result = await searchOpenAlex(args.title, { limit: 1, ...auth });
        work = result.items[0];
      }
      if (!work) throw new Error('无法解析文献元数据，请提供有效 DOI 或标题。');

      // DOI 查重（幂等）
      const libraryKey = args.library ? (await resolveTarget({ library: args.library })).libraryKey : 'user';
      const existing = work.doi ? await zoteroFindByDoi(work.doi, { libraryKey }).catch(() => null) : null;
      if (existing) {
        return { outcome: 'exists', itemKey: existing.key, title: existing.title || work.title, doi: work.doi };
      }

      // 建条目（写操作需要 Zotero key，缺 key 时 core 的 401 会自然报错）
      const created = await zoteroCreateItem(
        {
          title: work.title,
          creators: (work.authors ?? []).map((fullName) => {
            const parts = String(fullName).split(/\s+/);
            const lastName = parts.pop() || '';
            return parts.length > 0 ? { firstName: parts.join(' '), lastName } : { lastName };
          }),
          ...(work.doi ? { doi: work.doi } : {}),
          ...(work.year ? { date: String(work.year) } : {}),
          ...(work.url ? { url: work.url } : {}),
        },
        { zoteroKey: auth.zoteroKey, collectionKey: args.collectionKey, libraryKey },
      );
      return { outcome: 'created', itemKey: created.itemKey, title: work.title, doi: work.doi };
    },
    render(args, value) {
      const labels = { created: '已创建', exists: '已存在（未重复建档）' };
      const label = labels[value.outcome] || value.outcome || '完成';
      const lines = [`Zotero 归档结果：**${label}**`];
      if (value.title) lines.push(`标题: ${value.title}`);
      if (value.itemKey) lines.push(`条目 key: ${value.itemKey}`);
      if (value.doi) lines.push(`DOI: ${value.doi}`);
      return [{ type: 'text', text: lines.join('\n') }];
    },
    presentationMeta(args, value) {
      return literatureMeta({
        kind: 'status',
        tool: 'zotero_save',
        status: value.outcome || '',
        itemKey: value.itemKey || '',
        title: (value.title || '').slice(0, 200),
        doi: value.doi || '',
      });
    },
  },
  {
    name: 'zotero_collections',
    description:
      '列出 Zotero 库与收藏夹（key / 名称 / 完整路径 / 条目数），用于定位目标库并把收藏夹名解析成 key。省略 library 只列库；给出 library 则列该库收藏夹。写回 Zotero 前先用它确认目标。',
    parameters: {
      library: { type: 'string', description: "库：'user'（个人库，缺省）/ 'group:<id>' / 纯数字群组 id / 库名（如 WENJUN_MA's Group）" },
      query: { type: 'string', description: '按收藏夹名称过滤（可选，不区分大小写的包含匹配）' },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        libraries: { type: 'array', items: { type: 'object', additionalProperties: true } },
        library: { type: 'string' },
        collectionCount: { type: 'number' },
        collections: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
    },
    async execute(args) {
      const libraries = await zoteroListLibraries();
      if (!args.library) {
        return { libraries, library: '', collectionCount: 0, collections: [] };
      }
      const { libraryKey, libraryName } = await resolveTarget({ library: args.library });
      let collections = await zoteroListCollections({ libraryKey });
      if (args.query) {
        const needle = String(args.query).toLowerCase();
        collections = collections.filter((c) => c.name.toLowerCase().includes(needle) || c.path.toLowerCase().includes(needle));
      }
      return {
        libraries,
        library: libraryName,
        libraryKey,
        collectionCount: collections.length,
        collections: collections.map((c) => ({ key: c.key, name: c.name, path: c.path, itemCount: c.itemCount })),
      };
    },
    render(args, value) {
      const lines = [];
      if (!args.library) {
        lines.push(`Zotero 库（共 ${value.libraries.length} 个）：`);
        for (const lib of value.libraries) lines.push(`- ${lib.name}  [${lib.libraryKey}]${lib.type === 'user' ? '（个人库默认）' : ''}`);
        lines.push('', '要列收藏夹，请再调用并给出 library。');
        return [{ type: 'text', text: lines.join('\n') }];
      }
      lines.push(`库「${value.library}」（${value.libraryKey}）收藏夹：${value.collectionCount} 个`);
      const shown = value.collections.slice(0, 60);
      for (const c of shown) {
        lines.push(`- ${c.path}  [${c.key}]${typeof c.itemCount === 'number' ? ` · ${c.itemCount} 条` : ''}`);
      }
      if (value.collections.length > shown.length) lines.push(`…（其余 ${value.collections.length - shown.length} 个已省略，可用 query 过滤）`);
      return [{ type: 'text', text: lines.join('\n') }];
    },
    presentationMeta(args, value) {
      return literatureMeta({
        kind: 'zotero-collections',
        tool: 'zotero_collections',
        ...(value.library ? { library: value.library } : {}),
        libraries: (value.libraries ?? []).map((l) => ({ name: l.name, libraryKey: l.libraryKey })),
        collections: (value.collections ?? []).slice(0, 100).map((c) => ({ key: c.key, name: c.name, path: c.path, itemCount: c.itemCount })),
      });
    },
  },
  {
    name: 'zotero_import',
    description:
      '把一个文献列表批量写回指定 Zotero 库/收藏夹（支持群组库）。逐条解析元数据（Crossref → OpenAlex → 引用行内解析）、去重（已在目标库且已在收藏夹＝跳过；在库但不在收藏夹＝加挂；否则新建），单条失败不中断并汇报。先用 zotero_collections 确认目标 key/名称。',
    parameters: {
      refs: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: '参考文献列表：每项可为 DOI、标题，或整行参考文献（自动抽 DOI）；单次最多 200 条',
      },
      library: { type: 'string', description: "目标库：'user'（个人库，缺省）/ 'group:<id>' / 纯数字群组 id / 库名" },
      collection: { type: 'string', description: "目标收藏夹：key、名称，或 '父 > 子' 路径（名称歧义会报错并列出候选）" },
      itemTypes: {
        type: 'array',
        items: { type: 'string' },
        description: "只收这些 Zotero itemType（如 ['journalArticle']）；解析出其它类型记 skipped。缺省不过滤",
      },
      dryRun: { type: 'boolean', description: '只输出计划（exists/added/created 计数），不发起任何写请求' },
      attachPdf: {
        type: 'boolean',
        description: '新建条目后尝试把 OpenAlex 上的 OA PDF 一并挂为附件；下载/上传失败只记录在该条，不影响建档。缺省不挂',
      },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dryRun: { type: 'boolean' },
        library: { type: 'string' },
        libraryKey: { type: 'string' },
        collection: { type: 'string' },
        collectionKey: { type: 'string' },
        collectionSizeBefore: { type: 'number' },
        counts: { type: 'object', additionalProperties: true },
        items: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
    },
    async execute(args) {
      const refs = Array.isArray(args.refs) ? args.refs : [];
      if (refs.length === 0) throw new Error('refs 不能为空：请给出 DOI / 标题 / 整行参考文献列表。');
      if (refs.length > MAX_IMPORT_REFS) throw new Error(`单次最多导入 ${MAX_IMPORT_REFS} 条，当前 ${refs.length} 条。`);
      const config = loadConfig();
      const auth = resolveAuth(config);
      return importReferences({
        refs,
        library: args.library ?? 'user',
        collection: args.collection ?? '',
        ...(Array.isArray(args.itemTypes) ? { itemTypes: args.itemTypes } : {}),
        dryRun: args.dryRun === true,
        attachPdf: args.attachPdf === true,
        auth,
        zoteroKey: auth.zoteroKey,
        mailto: auth.mailto || '',
        limit: MAX_IMPORT_REFS,
      });
    },
    render(args, value) {
      const c = value.counts ?? {};
      const where = `${value.library}${value.collection ? ` › ${value.collection}` : ''}`;
      const head = value.dryRun
        ? `Zotero 导入预演（未写入）：${where}`
        : `Zotero 导入完成：${where}`;
      const lines = [
        head,
        `新建 ${c.created ?? 0} · 加挂 ${c.added ?? 0} · 已存在 ${c.exists ?? 0} · 跳过 ${c.skipped ?? 0} · 失败 ${c.failed ?? 0}`,
        `目标收藏夹原有 ${value.collectionSizeBefore ?? 0} 条`,
      ];
      for (const item of (value.items ?? []).slice(0, 50)) {
        const label = { created: '新建', added: '加挂', exists: '已有', skipped: '跳过', failed: '失败' }[item.action] ?? item.action;
        const subject = item.title ? String(item.title).slice(0, 80) : item.doi ? `DOI: ${item.doi}` : '';
        const detail = item.action === 'failed' || item.action === 'skipped' ? `（${item.error}）` : item.itemKey ? ` [${item.itemKey}]` : '';
        const pdf = { attached: ' · PDF 已挂', exists: ' · PDF 已有', none: ' · 无 OA PDF', skipped: '', planned: ' · PDF 待挂', failed: ` · PDF 失败（${item.pdfError ?? ''}）` }[item.pdf] ?? '';
        lines.push(`- #${item.n ?? '-'} ${label}${detail}${subject ? ` | ${subject}` : ''}${pdf}`);
      }
      if ((value.items ?? []).length > 50) lines.push(`…（其余 ${value.items.length - 50} 条见结构化结果）`);
      return [{ type: 'text', text: lines.join('\n') }];
    },
    presentationMeta(args, value) {
      return literatureMeta({
        kind: 'zotero-import',
        tool: 'zotero_import',
        dryRun: value.dryRun === true,
        library: value.library || '',
        collection: value.collection || '',
        counts: value.counts ?? {},
        items: (value.items ?? []).slice(0, 100).map((item) => ({
          n: item.n ?? null,
          action: item.action,
          itemKey: item.itemKey || '',
          title: item.title || '',
          doi: item.doi || '',
          itemType: item.itemType || '',
          ...(item.pdf ? { pdf: item.pdf } : {}),
        })),
      });
    },
  },
];