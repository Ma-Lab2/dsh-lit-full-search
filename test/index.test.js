import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';

import { name, inject, apply, ROUTE, routeRegistry } from '../lib/index.js';

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
  // 直接构造 ctx：只用 webServer 注册路由，然后取 handler 调一次
  let handler = null;
  const fakeWS = {
    register({ path, handler: h }) {
      handler = h;
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
  assert.notEqual(handler, null);
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

test('apply：注册 5 个全局工具 + 路由', () => {
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
  assert.equal(registeredTools.length, 5);
  assert.deepEqual(registeredTools.map((t) => t.name), ['lit_search', 'lit_abstract', 'lit_cited_by', 'zotero_search', 'zotero_save']);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, ROUTE);
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
  // 通过两次 apply（相同 webServer）模拟组合重载
  const mkCtx = () => ({
    get: (k) => (k === 'webServer' ? fakeWS : undefined),
    effect: (fn) => effects.push(fn),
  });
  apply(mkCtx());
  apply(mkCtx());
  assert.equal(registerCalls, 1); // 第二次 apply 走 refs 计数，不再真实注册

  // effects：tools 缺失（mkCtx 只给 webServer），每个 apply 只推 1 个路由 effect
  const returned = effects.map((fn) => fn());
  const routeRelease1 = returned[0];
  const routeRelease2 = returned[1];
  routeRelease1(); // refs 2 → 1
  assert.equal(disposeCalls, 0);
  routeRelease2(); // refs 1 → 0 → 真正 dispose
  assert.equal(disposeCalls, 1);

  // 引用归零后再次 apply → 重新注册
  apply(mkCtx());
  assert.equal(registerCalls, 2);
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