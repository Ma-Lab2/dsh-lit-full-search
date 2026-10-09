/**
 * dsh-lit-full-search 工具层：5 个全局 model 工具。
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
} from './light-core.js';
import { loadConfig, resolveAuth, resolveBudget } from './config.js';

/** 结果裁剪上限（防上下文爆炸；OpenAlex per_page 上限 200，这里保守）。 */
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
 * 轮流交叉排序（OpenAlex 在前），总量夹紧到 LIMIT_CAP 防上下文爆炸。
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
  for (let i = 0; i < max && items.length < LIMIT_CAP; i += 1) {
    if (i < oaItems.length) push(oaItems[i]);
    if (items.length >= LIMIT_CAP) break;
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
      limit: { type: 'integer', description: '结果上限（默认取检索预算，最大 25）' },
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
      const items = await zoteroSearch(args.query, {
        limit,
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
      const existing = work.doi ? await zoteroFindByDoi(work.doi, {}).catch(() => null) : null;
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
        { zoteroKey: auth.zoteroKey, collectionKey: args.collectionKey },
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
];