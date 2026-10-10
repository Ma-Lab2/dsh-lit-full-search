/**
 * dsh-lit-full-search 服务诊断：检测 OpenAlex / Semantic Scholar / Zotero 本地 API 的可用性。
 *
 * 供 Host 路由 GET /lit-full-search/api/diagnose（面板「运行系统诊断」按钮）使用。
 * 每个检查独立超时（5s）并行执行，互不阻塞；单项失败不影响其它项。
 * 返回 { ranAt, checks }，checks 元素为 { id, label, ok, detail }。
 */
import { OPENALEX_API_BASE, S2_API_BASE, ZOTERO_API_BASE, externalFetch } from './light-core.js';
import { loadConfig, resolveAuth, ENV_NAMES } from './config.js';

/** 单项网络检查的超时（毫秒）。Zotero 未运行时 connect 会立刻失败，超时只是兜底。 */
const CHECK_TIMEOUT_MS = 5000;

/** 带超时的 fetch：超时触发 AbortController，避免死连接挂住整个诊断。 */
async function fetchWithTimeout(fetchImpl, url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 网络类检查的公共骨架：请求 → ok / HTTP 状态 / 异常详情。 */
async function probe(fetchImpl, id, label, url, init, okDetail) {
  try {
    const res = await fetchWithTimeout(fetchImpl, url, init);
    await res.text().catch(() => '');
    if (res.ok) return { id, label, ok: true, detail: typeof okDetail === 'function' ? okDetail(res) : okDetail };
    return { id, label, ok: false, detail: `HTTP ${res.status} ${res.statusText || ''}`.trim() };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { id, label, ok: false, detail: `请求失败：${detail}` };
  }
}

/** OpenAlex 可达性（带上已配置的身份标识）。 */
function checkOpenAlex(fetchImpl, auth) {
  const url = new URL(`${OPENALEX_API_BASE}/works`);
  url.searchParams.set('per_page', '1');
  if (auth.apiKey) url.searchParams.set('api_key', auth.apiKey);
  else if (auth.mailto) url.searchParams.set('mailto', auth.mailto);
  return probe(fetchImpl, 'openalex-api', 'OpenAlex API', url.toString(), {}, '可达');
}

/** OpenAlex 身份标识：apiKey 或 mailto 至少一项（纯配置检查，不发请求）。 */
function checkOpenAlexIdentity(auth) {
  if (auth.apiKey) return { id: 'openalex-identity', label: 'OpenAlex 身份标识', ok: true, detail: '已配置 API Key（最高配额）' };
  if (auth.mailto) return { id: 'openalex-identity', label: 'OpenAlex 身份标识', ok: true, detail: `已配置邮箱（礼貌池）：${auth.mailto}` };
  return {
    id: 'openalex-identity',
    label: 'OpenAlex 身份标识',
    ok: false,
    detail: `未设置：正使用匿名共享池。建议在面板填写邮箱或设置 ${ENV_NAMES.mailto} 环境变量`,
  };
}

/** Semantic Scholar：未配置密钥则跳过网络探测（lit_search 此时不走 S2）；配置了则实测。 */
async function checkS2(fetchImpl, auth) {
  if (!auth.s2ApiKey) {
    return {
      id: 's2-api',
      label: 'Semantic Scholar API',
      ok: false,
      detail: `未设置 API Key：lit_search 仅检索 OpenAlex。可在面板粘贴或在环境中设置 ${ENV_NAMES.s2ApiKey}`,
    };
  }
  const url = `${S2_API_BASE}/paper/search?query=test&limit=1&fields=title`;
  return probe(fetchImpl, 's2-api', 'Semantic Scholar API', url, { headers: { 'x-api-key': auth.s2ApiKey } }, '可达且密钥有效');
}

/** Zotero 本地 API 可达性（只读端点，不需要密钥）。 */
function checkZoteroApi(fetchImpl) {
  // Connection: close —— 与 light-core 一致，防止 undici 复用 Zotero HTTP/1.0 已关闭的 socket
  return probe(
    fetchImpl,
    'zotero-api',
    'Zotero 本地 API',
    `${ZOTERO_API_BASE}/users/0/items?limit=1`,
    { headers: { Connection: 'close' } },
    (res) => {
      const version = res.headers?.get?.('X-Zotero-Version');
      return version ? `可达（Zotero ${version}）` : '可达';
    },
  );
}

/** Zotero 写密钥：lit_to_zotero 写回需要（纯配置检查，不发请求）。 */
function checkZoteroKey(auth) {
  if (auth.zoteroKey) {
    return { id: 'zotero-key', label: 'Zotero 写密钥', ok: true, detail: '已配置（lit_to_zotero 可写回）' };
  }
  return {
    id: 'zotero-key',
    label: 'Zotero 写密钥',
    ok: false,
    detail: `未设置：lit_to_zotero 写回需要。Zotero → 设置 → 高级 → 密钥，或在环境中设置 ${ENV_NAMES.zoteroKey}`,
  };
}

/**
 * 运行全部诊断检查（并行，单项独立超时）。
 * options.fetchImpl：测试注入用；options.config：测试注入用（默认读配置文件+环境变量）。
 */
export async function runDiagnostics(options = {}) {
  const auth = resolveAuth(options.config ?? loadConfig());
  // 外网探测与工具走同一条路径（配置了代理就经代理），否则诊断「可达」而检索却超时，结论会误导。
  const fetchImpl = options.fetchImpl ?? ((url, init) => (url.startsWith(ZOTERO_API_BASE) ? globalThis.fetch(url, init) : externalFetch(url, init, auth.proxy)));
  const checks = await Promise.all([
    checkOpenAlex(fetchImpl, auth),
    checkOpenAlexIdentity(auth),
    checkS2(fetchImpl, auth),
    checkZoteroApi(fetchImpl),
    checkZoteroKey(auth),
  ]);
  return { ranAt: new Date().toISOString(), checks };
}
