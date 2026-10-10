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
  zoteroListLibraries,
  zoteroListCollections,
} from './light-core.js';
import { MAX_IMPORT_REFS, importReferences, resolveTarget } from './lit-to-zotero.js';
import { ENRICH_DEFAULT_INCLUDE, enrichItem, getAbstract } from './zotero-enrich.js';
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

/**
 * render 里的作者裁剪上限。压力测试实测：lit_search 双源 50 条时渲染约 18k 字符，
 * 大头是作者全名（每条最多 30 人）。只裁 render（模型上下文），结构化结果与卡片不受影响。
 */
export const RENDER_AUTHOR_CAP = 6;

/** 作者列表 → 渲染文本：超过上限时截断并注明总人数。 */
export function formatAuthors(authors, cap = RENDER_AUTHOR_CAP) {
  if (!Array.isArray(authors) || authors.length === 0) return '未知作者';
  if (authors.length <= cap) return authors.join(', ');
  return `${authors.slice(0, cap).join(', ')} 等 ${authors.length} 人`;
}

/** 查询词含中日韩字符？（用于提示「外网源对中文匹配差，建议改英文」） */
export function hasCjk(text) {
  return /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(String(text ?? ''));
}

/**
 * 双源检索里某个源失败时的警告行。过去 diagnostics 只在结构化结果里、render 不显示，
 * 模型（和用户）看不出 S2 掉线，会把单源结果当成完整检索。
 */
export function sourceFailureNote(diagnostics) {
  const names = { openalex: 'OpenAlex', semanticscholar: 'Semantic Scholar' };
  const failed = Object.entries(diagnostics ?? {}).filter(([, d]) => d && d.ok === false);
  if (failed.length === 0) return '';
  const parts = failed.map(([k, d]) => `${names[k] ?? k}（${d.error ?? '未知错误'}）`);
  return `\n\n⚠ 以下数据源本次失败，结果仅来自其余数据源：${parts.join('；')}`;
}

const CJK_HINT = '提示：OpenAlex / Semantic Scholar 对中文关键词匹配较差，结果可能偏题；建议改用英文关键词或中英混合重试。';

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
    description:
      '外网关键词检索：返回题录列表（标题/作者/年份/期刊/DOI/被引/链接）。文献调研、找某方向的论文、开题/综述摸底、审稿时核对「是否已有更早或更全的工作」、追踪某课题组产出时用它。只查外网，不读本地库（本地库用 zotero_search）；单篇摘要用 lit_abstract，某篇的被引谱系用 lit_cited_by，结果落库用 lit_to_zotero。配 S2 key 后双源并发并按 DOI 去重，单源失败降级记入 diagnostics。',
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
      // 空白 query 必须报错：外网源会返回任意热门文献，模型会当成「检索结果」引用。
      if (!String(args.query ?? '').trim()) throw new Error('query 不能为空白，请给出检索关键词。');
      // 年份倒挂必须报错：两个源都会返回空集，渲染出来是「未找到相关文献」——
      // 模型会把「我把区间写反了」误读成「这个方向没有文献」，这是会导致错误结论的静默陷阱。
      if (args.yearFrom !== undefined && args.yearTo !== undefined && Number(args.yearFrom) > Number(args.yearTo)) {
        throw new Error(`年份区间倒挂：yearFrom=${args.yearFrom} 大于 yearTo=${args.yearTo}，请调换后重试。`);
      }
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
        searchSemanticScholar(args.query, { limit, ...years, s2ApiKey: auth.s2ApiKey, proxy: auth.proxy }),
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
        const authors = formatAuthors(item.authors);
        const year = item.year ?? '?';
        const doi = item.doi ? ` | DOI: ${item.doi}` : '';
        const cited = typeof item.citationCount === 'number' ? ` | 被引 ${item.citationCount}` : '';
        return `- **${item.title}**（${authors}, ${year}）${doi}${cited}\n  来源: ${item.source} | ${item.url}`;
      });
      const hint = (hasCjk(args.query) ? `\n\n${CJK_HINT}` : '') + sourceFailureNote(value?.diagnostics);
      if (items.length === 0) {
        return [{ type: 'text', text: `未找到与「${args.query}」相关的文献。${hint}` }];
      }
      return [{ type: 'text', text: `检索「${args.query}」结果（${items.length} 条）：\n\n${lines.join('\n')}${hint}` }];
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
    description:
      '取单篇文献摘要（DOI 优先；无 DOI 用标题检索取第一条）。审稿/写作/改稿时核对一篇说了什么、或对 lit_search 命中的某条细看时用它；要**本地 Zotero 里存的**摘要用 zotero_abstract，要整篇正文用 zotero_enrich 的 fulltext（本地附件全文索引）。无摘要返回 status=missing。',
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
    description:
      '取一篇文献的被引列表（OpenAlex cited-by）。追踪后续进展、判断影响力、综述里找「谁引了它、之后怎么发展」时用它；传 DOI 或 OpenAlex work ID（如 W1234567890）。',
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
        const authors = formatAuthors(item.authors);
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
    description:
      '检索**本地 Zotero 库**（个人库或群组库），返回条目 key/标题/作者/年份/DOI/URL——薄摘要，用于定位条目。查「我库里有没有这篇/这个方向」、拿到 key 交给 zotero_enrich 时用它；要字段/笔记/附件/批注用 zotero_enrich，要外网检索用 lit_search。',
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
        const authors = formatAuthors(item.authors);
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
    name: 'zotero_collections',
    description:
      '列出 Zotero 库与收藏夹（key / 名称 / 完整路径 / 条目数）。写回前确认目标、把收藏夹名解析成 key、消歧同名收藏夹（例如群组库里的 liqiud crystal target）时用它；省略 library 只列库，给出 library 才列该库收藏夹。',
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
        // execute 在给了 library 时回 libraryKey；outputSchema 是 additionalProperties:false，
        // 漏声明会让 DSH 直接报「"value.libraryKey" is not a declared property」把工具打死。
        libraryKey: { type: 'string' },
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
      // 防御性：render 只在 execute 成功后调用，但 value 缺字段不该把工具变成崩溃。
      const v = value ?? {};
      const libraries = Array.isArray(v.libraries) ? v.libraries : [];
      const collections = Array.isArray(v.collections) ? v.collections : [];
      const lines = [];
      if (!args?.library) {
        lines.push(`Zotero 库（共 ${libraries.length} 个）：`);
        for (const lib of libraries) lines.push(`- ${lib.name}  [${lib.libraryKey}]${lib.type === 'user' ? '（个人库默认）' : ''}`);
        lines.push('', '要列收藏夹，请再调用并给出 library。');
        return [{ type: 'text', text: lines.join('\n') }];
      }
      lines.push(`库「${v.library}」（${v.libraryKey}）收藏夹：${v.collectionCount ?? collections.length} 个`);
      const shown = collections.slice(0, 60);
      for (const c of shown) {
        lines.push(`- ${c.path}  [${c.key}]${typeof c.itemCount === 'number' ? ` · ${c.itemCount} 条` : ''}`);
      }
      if (collections.length > shown.length) lines.push(`…（其余 ${collections.length - shown.length} 个已省略，可用 query 过滤）`);
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
    name: 'lit_to_zotero',
    description:
      '把检索到的文献**写回** Zotero 指定库/收藏夹（支持群组库）：逐条解析元数据（Crossref → OpenAlex → 引用行内）、按 DOI/标题去重（已在收藏夹跳过、在库但不在收藏夹加挂、否则新建），可先 dryRun 预演。综述/论文的参考文献批量入库、调研收尾归档、把审稿或写作中收集的文献存进课题收藏夹时用它；目标先用 zotero_collections 确认。',
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
        kind: 'lit-to-zotero',
        tool: 'lit_to_zotero',
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
  {
    name: 'zotero_enrich',
    description:
      '按 item key / DOI / 标题读深**一个** Zotero 条目：书目字段、标签、所属收藏夹（名称+路径）、笔记、该条目的**全部附件**（paths 可解析磁盘路径与存在性）、附件批注、Zotero 全文索引缓存。审稿/写作/改稿时看「这条到底存了什么、PDF 在哪、有没有笔记批注」时用它；先用 zotero_search 拿 key。只要摘要时可直接用 zotero_abstract（更短）。只读，不做库级枚举。',
    parameters: {
      ref: {
        type: 'string',
        required: true,
        description: "条目引用：8 位 item key（zotero_search 返回值）/ DOI / 标题 / zotero://user/0/item/<KEY>（群组用 zotero://group/<id>/item/<KEY>）",
      },
      library: { type: 'string', description: "目标库：缺省 'user'（个人库）/ 'group:<id>' / 纯数字群组 id / 库名" },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description:
          '书目字段投影（Zotero 原名）：creators / year / date / publicationTitle / volume / issue / pages / DOI / url / abstractNote / extra / language / dateAdded / dateModified。给了就只回这些（标识字段 key/itemType/title 始终在），未知名回报在 unknownFields；省略=全部字段，[]=只要标识字段',
      },
      include: {
        type: 'array',
        items: { type: 'string' },
        description: '子对象组：tags / collections / notes / attachments / annotations / fulltext；缺省 tags+collections。只有点名 notes/attachments/annotations/fulltext 才会去读子对象',
      },
      paths: {
        type: 'boolean',
        description: '解析每个附件的本地磁盘路径与存在性（每条附件一次 Zotero 请求）。缺省 false，只给附件元数据',
      },
      maxChars: { type: 'integer', description: '笔记/批注/全文/摘要的单条截断（200–20000，缺省 2000）' },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        found: { type: 'boolean' },
        ref: { type: 'string' },
        resolvedBy: { type: 'string' },
        library: { type: 'string' },
        libraryKey: { type: 'string' },
        hint: { type: 'string' },
        item: { type: 'object', additionalProperties: true },
        counts: { type: 'object', additionalProperties: true },
        unknownFields: { type: 'array', items: { type: 'string' } },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
    async execute(args) {
      const include = Array.isArray(args.include) && args.include.length > 0 ? args.include : undefined;
      const fields = Array.isArray(args.fields) ? args.fields : undefined;
      return enrichItem({
        ref: args.ref,
        library: args.library ?? 'user',
        ...(include ? { include } : {}),
        ...(fields ? { fields } : {}),
        paths: args.paths === true,
        ...(args.maxChars !== undefined ? { maxChars: args.maxChars } : {}),
      });
    },
    render(args, value) {
      if (value.found !== true) {
        return [
          {
            type: 'text',
            text: `未在「${value.library}」(${value.libraryKey}) 中找到条目「${value.ref}」。${value.hint ?? ''}`,
          },
        ];
      }
      const item = value.item ?? {};
      // 字段投影：给了 fields 就只打印被点名的字段；省略则保持既有输出（作者/来源/DOI/摘要）
      const requested = Array.isArray(args?.fields) ? args.fields : null;
      const DEFAULT_SHOWN = new Set(['creators', 'publicationTitle', 'volume', 'issue', 'pages', 'year', 'date', 'DOI', 'url', 'abstractNote']);
      const show = (name) => (requested === null ? DEFAULT_SHOWN.has(name) : requested.includes(name));

      const lines = [`Zotero 条目：${item.title || '(无标题)'}`];
      lines.push(`库：${value.library} (${value.libraryKey}) · key \`${item.key}\` · ${item.itemType} · 命中方式 ${value.resolvedBy}`);
      if (show('creators') && item.creators?.length) {
        const names = item.creators.map((c) => c.name ?? [c.firstName, c.lastName].filter(Boolean).join(' ')).filter(Boolean);
        lines.push(`作者：${names.slice(0, 8).join('; ')}${names.length > 8 ? ` 等 ${names.length} 人` : ''}`);
      }
      const venue = [show('publicationTitle') ? item.publicationTitle : '', show('volume') ? item.volume : '', show('issue') ? item.issue : '', show('pages') ? item.pages : ''].filter(Boolean).join(' ');
      const dateText = show('date') ? item.date : show('year') && item.year ? String(item.year) : '';
      if (venue || dateText) lines.push(`来源：${venue || '—'}${dateText ? ` · ${dateText}` : ''}`);
      if (show('DOI') && item.DOI) lines.push(`DOI: ${item.DOI}`);
      if (show('url') && item.url) lines.push(`URL: ${item.url}`);
      if (show('abstractNote') && item.abstractNote) {
        const abs = String(item.abstractNote);
        const cap = Number.isInteger(args?.maxChars) ? Math.min(Math.max(args.maxChars, 200), 20000) : 2000;
        lines.push(`摘要（${abs.length} 字）：${abs.slice(0, cap)}${abs.length > cap ? `…（已截断，共 ${abs.length} 字）` : ''}`);
      }
      // 仅显式点名时打印的"边角字段"
      if (requested !== null) {
        if (show('extra') && item.extra) lines.push(`extra: ${item.extra}`);
        if (show('language') && item.language) lines.push(`语言: ${item.language}`);
        if (show('dateAdded') && item.dateAdded) lines.push(`加入时间: ${item.dateAdded}`);
        if (show('dateModified') && item.dateModified) lines.push(`修改时间: ${item.dateModified}`);
      }
      if (item.tags?.length) lines.push(`标签：${item.tags.join(', ')}`);
      if (item.collections?.length) lines.push(`收藏夹：${item.collections.map((c) => c.path || c.name || c.key).join(' ｜ ')}`);
      if (Array.isArray(item.attachments)) {
        lines.push(`附件 ${item.attachments.length} 个：`);
        for (const att of item.attachments.slice(0, 20)) {
          const where = att.path ? `${att.path}${att.exists === false ? '（文件不在磁盘上）' : ''}` : att.url ? att.url : '（未解析路径）';
          lines.push(`- ${att.title || att.filename || '(未命名)'} · ${att.contentType || '未知类型'} · ${att.linkMode || '—'}${att.error ? ` · ${att.error}` : ''} → ${where}`);
        }
        if (item.attachments.length > 20) lines.push(`…其余 ${item.attachments.length - 20} 个附件已省略`);
      }
      if (Array.isArray(item.notes)) {
        lines.push(`笔记 ${item.notes.length} 条：`);
        for (const note of item.notes.slice(0, 10)) lines.push(`- ${note.text}${note.truncated ? ` …（共 ${note.chars} 字，已截断）` : ''}`);
        if (item.notes.length > 10) lines.push(`…其余 ${item.notes.length - 10} 条笔记已省略`);
      }
      if (Array.isArray(item.annotations)) {
        lines.push(`批注 ${item.annotations.length} 条：`);
        for (const a of item.annotations.slice(0, 30)) {
          lines.push(`- [p.${a.page || '?'}] ${a.text || '(无选区文本)'}${a.comment ? ` ／ 批注：${a.comment}` : ''}`);
        }
        if (item.annotations.length > 30) lines.push(`…其余 ${item.annotations.length - 30} 条批注已省略`);
      }
      if (Array.isArray(item.fulltext)) {
        for (const ft of item.fulltext) {
          lines.push(`全文索引（${ft.attachmentKey}，${ft.chars}/${ft.totalChars} 字${ft.truncated ? '，已截断' : ''}）：\n${ft.text}`);
        }
      }
      // 未识别的 fields 必须在 render 里说出来：模型只看得到 render，看不到结构化 unknownFields。
      // 否则把 abstractNote 误写成 abstract 时，模型只会看到「调用成功但没有摘要」，无从修正。
      if (Array.isArray(value.unknownFields) && value.unknownFields.length > 0) {
        lines.push(`⚠ 未识别的 fields 已忽略：${value.unknownFields.join('、')}（可用字段见工具参数说明）`);
      }
      if (value.warnings?.length) lines.push(`警告：${value.warnings.join('；')}`);
      return [{ type: 'text', text: lines.join('\n') }];
    },
    presentationMeta(args, value) {
      const item = value.item ?? {};
      return literatureMeta({
        kind: 'zotero-enrich',
        tool: 'zotero_enrich',
        found: value.found === true,
        ref: value.ref || '',
        library: value.library || '',
        libraryKey: value.libraryKey || '',
        ...(value.resolvedBy ? { resolvedBy: value.resolvedBy } : {}),
        // 卡片只显示被请求的子对象组与字段（避免 abstract-only 调用还显示「附件 0 · 笔记 0」）
        groups: Array.isArray(args?.include) ? args.include : Array.isArray(args?.fields) ? [] : ENRICH_DEFAULT_INCLUDE,
        ...(Array.isArray(args?.fields) ? { fields: args.fields } : {}),
        counts: value.counts ?? {},
        item: {
          key: item.key || '',
          itemType: item.itemType || '',
          title: item.title || '',
          date: item.date || '',
          DOI: item.DOI || '',
          publicationTitle: item.publicationTitle || '',
          tags: item.tags ?? [],
          collections: item.collections ?? [],
          attachments: (item.attachments ?? []).map((a) => ({
            key: a.key,
            title: a.title || a.filename || '',
            contentType: a.contentType || '',
            linkMode: a.linkMode || '',
            path: a.path ?? null,
            exists: a.exists ?? null,
          })),
        },
      });
    },
  },
  {
    name: 'zotero_abstract',
    description:
      '取**本地 Zotero** 里存的单篇摘要（abstractNote），按 item key / DOI / 标题 / zotero:// 引用定位；与 lit_abstract（外网 OpenAlex）对称——本地摘要为空时可用 lit_abstract 按 DOI 试外网。只要摘要、不要其它字段时用它；要看标签/收藏夹/笔记/附件/批注请用 zotero_enrich。只读。',
    parameters: {
      ref: { type: 'string', required: true, description: '条目引用：item key / DOI / 标题 / zotero:// 引用（四种写法同 zotero_enrich）' },
      library: { type: 'string', description: "目标库：缺省 'user'（个人库）/ 'group:<id>' / 纯数字群组 id / 库名" },
      maxChars: { type: 'integer', description: '摘要截断长度（200–20000，缺省 2000）' },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        found: { type: 'boolean' },
        ref: { type: 'string' },
        resolvedBy: { type: 'string' },
        library: { type: 'string' },
        libraryKey: { type: 'string' },
        key: { type: 'string' },
        title: { type: 'string' },
        DOI: { type: 'string' },
        abstractNote: { type: 'string' },
        chars: { type: 'number' },
        truncated: { type: 'boolean' },
        hint: { type: 'string' },
      },
    },
    async execute(args) {
      return getAbstract(args.ref, {
        ...(args.library !== undefined ? { library: args.library } : {}),
        ...(args.maxChars !== undefined ? { maxChars: args.maxChars } : {}),
      });
    },
    render(args, value) {
      if (value.found !== true) {
        return [
          {
            type: 'text',
            text: `未在「${value.library}」(${value.libraryKey}) 中找到条目「${value.ref}」。${value.hint ?? ''}`,
          },
        ];
      }
      const where = `${value.title || '(无标题)'}（${[value.key, value.library, value.DOI].filter(Boolean).join(' · ')}）`;
      if (!value.abstractNote) {
        return [{ type: 'text', text: `${where}\n本地 Zotero 该条目的 abstractNote 为空；可试 lit_abstract（按 DOI 取外网摘要）。` }];
      }
      return [
        {
          type: 'text',
          text: `${where}\n${value.abstractNote}${value.truncated ? `\n…（已截断，共 ${value.chars} 字）` : ''}`,
        },
      ];
    },
    presentationMeta(args, value) {
      return literatureMeta({
        kind: 'zotero-abstract',
        tool: 'zotero_abstract',
        found: value.found === true,
        ref: value.ref || '',
        library: value.library || '',
        key: value.key || '',
        title: (value.title || '').slice(0, 200),
        DOI: value.DOI || '',
        chars: value.chars ?? 0,
        truncated: value.truncated === true,
      });
    },
  },
];