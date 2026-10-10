import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';

import { name, inject, apply, ROUTE, DIAGNOSE_ROUTE, routeRegistry } from '../lib/index.js';

// 路由测试用隔离 DSH_HOME，避免读写真实用户配置。
const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'lfs-index-'));
const prevHome = process.env.DSH_HOME;
process.env.DSH_HOME = tmpHome;

test.after(() => {
  if (prevHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = prevHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

test('插件元信息：name/inject/ROUTE', () => {
  assert.equal(name, 'dsh-lit-full-search');
  assert.deepEqual(inject, ['tools', 'webServer']);
  assert.equal(ROUTE, '/lit-full-search/api/config');
  assert.equal(DIAGNOSE_ROUTE, '/lit-full-search/api/diagnose');
});

function fakeReq(body, method, url) {
  const stream = Readable.from(body === undefined ? '' : body);
  stream.method = method;
  stream.url = url;
  return stream;
}

function fakeRes() {
  const out = { status: 0, body: '' };
  return {
    out,
    writeHead(status, headers) {
      out.status = status;
      out.headers = headers;
    },
    end(str) {
      out.body = str;
    },
  };
}

async function callHandle(method, url, body) {
  routeRegistry.clear(); // 测试隔离：每次重新注册路由
  // 直接构造 ctx：只用 webServer 注册路由，按 path 收集 handler 后调一次
  const handlers = new Map();
  const fakeWS = {
    register({ path, handler: h }) {
      handlers.set(path, h);
      return () => {};
    },
  };
  const ctx = {
    get(key) {
      if (key === 'webServer') return fakeWS;
      return undefined;
    },
    effect() {},
  };
  apply(ctx);
  const handler = handlers.get(new URL(url, 'http://localhost').pathname);
  assert.ok(handler, `路由未注册：${url}`);
  const res = fakeRes();
  await handler(fakeReq(body, method, url), res);
  return { status: res.out.status, json: JSON.parse(res.out.body) };
}

test('apply：缺 tools/webServer 时安全降级', () => {
  const warned = [];
  const origWarn = console.warn;
  console.warn = (m) => warned.push(m);
  try {
    apply({ get: () => undefined, effect: () => {} });
    assert.ok(warned.some((w) => /tools service unavailable/.test(w)));
  } finally {
    console.warn = origWarn;
  }
});

test('客户端面板只用现行主题 token（--dsw-alias-*），不残留失效的 --ds-color-*', () => {
  const css = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const stale = css.match(/--ds-color-[a-z-]+/g) ?? [];
  assert.deepEqual(stale, [], `面板 CSS 残留失效 token：${[...new Set(stale)].join(', ')}`);
  const tokens = new Set(css.match(/--dsw-alias-[a-z0-9-]+/g) ?? []);
  assert.ok(tokens.size >= 8, `面板应使用现行主题 token，实际用到 ${tokens.size} 个`);
  for (const required of ['--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-border-l1', '--dsw-alias-bg-layer-1']) {
    assert.ok(tokens.has(required), `面板缺少 ${required}`);
  }
});

test('apply：注册 8 个全局工具 + 路由', () => {
  routeRegistry.clear();
  const registeredTools = [];
  const routes = [];
  const ctx = {
    get(key) {
      if (key === 'tools') return { register: (def) => { registeredTools.push(def); return () => {}; } };
      if (key === 'webServer') return { register: (r) => { routes.push(r); return () => {}; } };
      return undefined;
    },
    effect() {},
  };
  apply(ctx);
  assert.equal(registeredTools.length, 8);
  assert.deepEqual(registeredTools.map((t) => t.name), ['lit_search', 'lit_abstract', 'lit_cited_by', 'zotero_search', 'zotero_collections', 'lit_to_zotero', 'zotero_enrich', 'zotero_abstract']);
  assert.equal(routes.length, 2);
  assert.equal(routes[0].path, ROUTE);
  assert.equal(routes[1].path, DIAGNOSE_ROUTE);
  assert.equal(routes[0].kind, 'exact');
});

test('registerRoute：refcount —— 重复 apply 只注册一次，引用归零才 dispose', () => {
  routeRegistry.clear();
  let registerCalls = 0;
  let disposeCalls = 0;
  const fakeWS = {
    register() {
      registerCalls += 1;
      return () => { disposeCalls += 1; };
    },
  };
  const effects = [];
  // 通过两次 apply（相同 webServer）模拟组合重载；每次 apply 注册 2 条路由
  const mkCtx = () => ({
    get: (k) => (k === 'webServer' ? fakeWS : undefined),
    effect: (fn) => effects.push(fn),
  });
  apply(mkCtx());
  apply(mkCtx());
  assert.equal(registerCalls, 2); // 第二次 apply 走 refs 计数，不再真实注册

  // effects：tools 缺失（mkCtx 只给 webServer），每个 apply 推 2 个路由 effect（顺序：apply1 ROUTE、apply1 DIAGNOSE、apply2 ROUTE、apply2 DIAGNOSE）
  const returned = effects.map((fn) => fn());
  assert.equal(returned.length, 4);
  returned[0](); // ROUTE refs 2 → 1
  returned[1](); // DIAGNOSE refs 2 → 1
  assert.equal(disposeCalls, 0);
  returned[2](); // ROUTE refs 1 → 0 → dispose
  assert.equal(disposeCalls, 1);
  returned[3](); // DIAGNOSE refs 1 → 0 → dispose
  assert.equal(disposeCalls, 2);

  // 引用归零后再次 apply → 重新注册
  apply(mkCtx());
  assert.equal(registerCalls, 4);
});

test('handleConfig：GET 返回安全视图（键只给掩码/状态，不下发明文）', async () => {
  const { status, json } = await callHandle('GET', ROUTE);
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.config.openAlexApiKeySet, false);
  assert.equal(json.config.openAlexApiKey, undefined);
  assert.equal(json.config.zoteroKey, undefined);
  assert.match(json.configFile, /lit-full-search\.config\.json$/);
});

test('handleConfig：POST 保存掩码视图并落盘', async () => {
  const { status, json } = await callHandle('POST', ROUTE, JSON.stringify({
    openAlexApiKey: 'MY-SECRET-KEY',
    zoteroKey: null,
    budget: { searchLimit: 5, citedByLimit: 99 },
  }));
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.config.openAlexApiKeySet, true);
  assert.equal(json.config.openAlexApiKeyMask, '…-KEY');
  assert.equal(json.config.budget.searchLimit, 5);
  assert.equal(json.config.budget.citedByLimit, 25); // 99 → 夹紧到 25
  assert.equal(existsSync(path.join(tmpHome, 'lit-full-search.config.json')), true);

  // 再 GET 确认已设置
  const { json: again } = await callHandle('GET', ROUTE);
  assert.equal(again.config.openAlexApiKeySet, true);
  assert.equal(again.config.openAlexApiKey, undefined);
});

test('handleConfig：非法请求体 400、错误 method 405', async () => {
  const bad1 = await callHandle('POST', ROUTE, '{not json');
  assert.equal(bad1.status, 400);
  assert.equal(bad1.json.ok, false);
  const bad2 = await callHandle('POST', ROUTE, JSON.stringify([1, 2, 3]));
  assert.equal(bad2.status, 400);
  const bad3 = await callHandle('DELETE', ROUTE);
  assert.equal(bad3.status, 405);
});

test('handleConfig：PUT 与 POST 等价', async () => {
  const { status, json } = await callHandle('PUT', ROUTE, JSON.stringify({ mailto: 'me@x.y' }));
  assert.equal(status, 200);
  assert.equal(json.config.mailto, 'me@x.y');
});

test('handleDiagnose：GET 返回五项检查（stub fetch，防真实网络）；非 GET 405', async () => {
  const realFetch = globalThis.fetch;
  // 清空 LIT_SEARCH_* 环境变量，避免运行环境影响「密钥未设置」断言
  const savedEnv = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('LIT_SEARCH_')) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('api.openalex.org')) {
      return { ok: true, status: 200, statusText: 'OK', headers: { get: () => null }, text: async () => '{}' };
    }
    if (u.includes('localhost:23119')) {
      return { ok: true, status: 200, statusText: 'OK', headers: { get: (k) => (k === 'X-Zotero-Version' ? '10.0.0' : null) }, text: async () => '[]' };
    }
    throw new Error('未预期的请求：' + u);
  };
  try {
    const { status, json } = await callHandle('GET', DIAGNOSE_ROUTE);
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.ok(json.ranAt);
    assert.equal(json.checks.length, 5);
    const zotero = json.checks.find((c) => c.id === 'zotero-api');
    assert.equal(zotero.ok, true);
    assert.match(zotero.detail, /10\.0\.0/);
    // 未配置密钥 → 提示型失败
    assert.equal(json.checks.find((c) => c.id === 'zotero-key').ok, false);

    const bad = await callHandle('POST', DIAGNOSE_ROUTE, '{}');
    assert.equal(bad.status, 405);
  } finally {
    globalThis.fetch = realFetch;
    for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
  }
});