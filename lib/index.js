/**
 * dsh-lit-full-search Host 插件
 *
 * 单一职责：注册全局 7 个 model 工具（lit_search / lit_abstract / lit_cited_by / zotero_search /
 * zotero_collections / lit_to_zotero / zotero_enrich；定义在 tools.js）+ 配置读写路由
 * GET/POST /lit-full-search/api/config。
 *
 * 工具注册：ctx.tools.register 在**根作用域**注册 → 全局可见（任何模式/预设下都可用）。
 * 配置路由：settings 面板（client.js 的 panellist 图标 + shell.overlay 表单）读写
 * $DSH_HOME（或 ~/.dsh）/lit-full-search.config.json。
 */

import { toolDefinitions, compileParams, wrapToolError } from './tools.js';
import { loadConfig, saveConfig, applyPatch, publicView, configFilePath } from './config.js';
import { runDiagnostics } from './diagnostics.js';

const ROUTE = '/lit-full-search/api/config';
const DIAGNOSE_ROUTE = '/lit-full-search/api/diagnose';

/**
 * 路由引数保护的 registerRoute：
 * webServer.register({kind:'exact',...}) 对同一 path 重复注册会抛错（rs 的 exact
 * 路由表 key 冲突），而插件可能被多次 apply（preset 世代切换 / 组合重载）。
 * 用模块级 Map<path, {dispose, refs}> 计数：第一次注册真实路由，后续只 +1 引用；
 * 引用归零才真正 dispose。
 */
const routeRegistry = new Map();

function registerRoute(webServer, path, handler) {
  const existing = routeRegistry.get(path);
  if (existing) {
    existing.refs += 1;
    return () => {
      existing.refs -= 1;
      if (existing.refs <= 0) {
        existing.dispose();
        routeRegistry.delete(path);
      }
    };
  }
  // webServer.register 返回 disposer（Cordis ctx.effect 会把回调返回值当作清理函数）
  const dispose = webServer.register({ kind: 'exact', path, handler });
  const entry = { refs: 1, dispose };
  routeRegistry.set(path, entry);
  return () => {
    entry.refs -= 1;
    if (entry.refs <= 0) {
      entry.dispose();
      routeRegistry.delete(path);
    }
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** 读取请求体 JSON（小体积配置，直接攒全量）。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        req.destroy();
        reject(new Error('请求体过大'));
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error(`JSON 解析失败: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

async function handleConfig(req, res) {
  const url = new URL(req.url || '', 'http://localhost');
  if (url.pathname !== ROUTE) {
    sendJson(res, 404, { ok: false, error: 'not found' });
    return;
  }
  try {
    if (req.method === 'GET') {
      const config = loadConfig();
      sendJson(res, 200, { ok: true, config: publicView(config), configFile: configFilePath() });
      return;
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      const patch = await readBody(req);
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' });
        return;
      }
      const current = loadConfig();
      const next = applyPatch(current, patch);
      saveConfig(next);
      sendJson(res, 200, { ok: true, config: publicView(next), configFile: configFilePath() });
      return;
    }
    sendJson(res, 405, { ok: false, error: `method ${req.method} not allowed` });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 400, { ok: false, error: message });
  }
}

/** 服务诊断：GET → { ok, ranAt, checks }（检查项见 diagnostics.js；单项失败不拖垮整体）。 */
async function handleDiagnose(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, error: `method ${req.method} not allowed` });
    return;
  }
  try {
    const result = await runDiagnostics();
    sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { ok: false, error: message });
  }
}

const name = 'dsh-lit-full-search';
const inject = ['tools', 'webServer'];

function apply(ctx) {
  // 1. 全局工具
  const tools = ctx.get('tools');
  if (tools !== undefined) {
    for (const def of toolDefinitions) {
      const tool = tools.register({
        name: def.name,
        description: def.description,
        parameters: compileParams(def.parameters),
        output: {
          schema: def.outputSchema,
          render: def.render,
          ...(def.presentationMeta ? { presentationMeta: def.presentationMeta } : {}),
        },
        async execute(args, exec) {
          try {
            return await def.execute(args, exec);
          } catch (error) {
            throw wrapToolError(def.name, error);
          }
        },
      });
      ctx.effect(() => tool, `dsh-lit-full-search.tools.${def.name}`);
    }
  } else {
    console.warn('[dsh-lit-full-search] tools service unavailable; tools not registered');
  }

  // 2. 配置路由 + 诊断路由
  const webServer = ctx.get('webServer');
  if (webServer === undefined) {
    console.warn('[dsh-lit-full-search] webServer service unavailable; config route not registered');
    return;
  }
  const release = registerRoute(webServer, ROUTE, handleConfig);
  ctx.effect(() => release, 'dsh-lit-full-search.route');
  const releaseDiagnose = registerRoute(webServer, DIAGNOSE_ROUTE, handleDiagnose);
  ctx.effect(() => releaseDiagnose, 'dsh-lit-full-search.route.diagnose');
}

export { name, inject, apply, ROUTE, DIAGNOSE_ROUTE, routeRegistry };