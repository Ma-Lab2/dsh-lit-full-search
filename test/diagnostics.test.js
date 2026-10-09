import test from 'node:test';
import assert from 'node:assert/strict';

import { runDiagnostics } from '../lib/diagnostics.js';
import { defaultConfig, ENV_NAMES } from '../lib/config.js';

/**
 * 诊断测试全部注入 fetchImpl / config，不触碰网络与真实 Zotero。
 * fetchImpl 按 URL 分发预置响应；headers 用 { get } 模拟。
 */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    for (const [match, respond] of routes) {
      if (u.includes(match)) {
        const out = typeof respond === 'function' ? respond(init) : respond;
        if (out instanceof Error) throw out;
        return {
          ok: out.ok !== false,
          status: out.status ?? 200,
          statusText: out.statusText ?? 'OK',
          headers: { get: (k) => out.headers?.[k] ?? null },
          text: async () => out.body ?? '',
        };
      }
    }
    throw new Error(`未预置的请求：${u}`);
  };
  return { impl, calls };
}

/** 清空 LIT_SEARCH_* 环境变量（resolveAuth 会读 env），返回恢复函数。 */
function clearEnv() {
  const saved = {};
  for (const key of Object.values(ENV_NAMES)) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function checkById(result, id) {
  const check = result.checks.find((c) => c.id === id);
  assert.ok(check, `缺少检查项 ${id}`);
  return check;
}

test('runDiagnostics：全部可用时五项全 ok（含 Zotero 版本号与 S2 密钥头）', async () => {
  const restore = clearEnv();
  try {
    const { impl, calls } = fakeFetch([
      ['api.openalex.org', { body: '{}' }],
      ['api.semanticscholar.org', { body: '{}' }],
      ['localhost:23119', { body: '[]', headers: { 'X-Zotero-Version': '10.0.1' } }],
    ]);
    const config = { ...defaultConfig(), mailto: 'me@x.y', s2ApiKey: 'S2-KEY', zoteroKey: 'ZK' };
    const result = await runDiagnostics({ fetchImpl: impl, config });
    assert.equal(result.checks.length, 5);
    assert.ok(result.ranAt);
    assert.equal(checkById(result, 'openalex-api').ok, true);
    assert.equal(checkById(result, 'openalex-identity').ok, true);
    assert.equal(checkById(result, 's2-api').ok, true);
    assert.equal(checkById(result, 'zotero-api').ok, true);
    assert.match(checkById(result, 'zotero-api').detail, /10\.0\.1/);
    assert.equal(checkById(result, 'zotero-key').ok, true);
    // S2 探测带 x-api-key；Zotero 探测带 Connection: close
    const s2Call = calls.find((c) => c.url.includes('semanticscholar.org'));
    assert.equal(s2Call.init.headers['x-api-key'], 'S2-KEY');
    const zCall = calls.find((c) => c.url.includes('localhost:23119'));
    assert.equal(zCall.init.headers.Connection, 'close');
  } finally {
    restore();
  }
});

test('runDiagnostics：Zotero 未运行 → zotero-api 失败，其余不受影响', async () => {
  const restore = clearEnv();
  try {
    const { impl } = fakeFetch([
      ['api.openalex.org', { body: '{}' }],
      ['localhost:23119', new Error('connect ECONNREFUSED 127.0.0.1:23119')],
    ]);
    const result = await runDiagnostics({ fetchImpl: impl, config: defaultConfig() });
    const zotero = checkById(result, 'zotero-api');
    assert.equal(zotero.ok, false);
    assert.match(zotero.detail, /ECONNREFUSED/);
    assert.equal(checkById(result, 'openalex-api').ok, true);
    // 未配置密钥 → 提示型失败，不发 S2 请求
    assert.equal(checkById(result, 's2-api').ok, false);
    assert.match(checkById(result, 's2-api').detail, /未设置/);
    assert.equal(checkById(result, 'zotero-key').ok, false);
    assert.match(checkById(result, 'zotero-key').detail, /未设置/);
    assert.equal(checkById(result, 'openalex-identity').ok, false);
  } finally {
    restore();
  }
});

test('runDiagnostics：S2 密钥无效（401）→ s2-api 失败并带 HTTP 状态', async () => {
  const restore = clearEnv();
  try {
    const { impl } = fakeFetch([
      ['api.openalex.org', { body: '{}' }],
      ['api.semanticscholar.org', { ok: false, status: 401, statusText: 'Unauthorized', body: 'bad key' }],
      ['localhost:23119', { body: '[]' }],
    ]);
    const config = { ...defaultConfig(), s2ApiKey: 'BAD-KEY' };
    const result = await runDiagnostics({ fetchImpl: impl, config });
    const s2 = checkById(result, 's2-api');
    assert.equal(s2.ok, false);
    assert.match(s2.detail, /401/);
  } finally {
    restore();
  }
});

test('runDiagnostics：环境变量兜底（无文件配置时 env 生效）', async () => {
  const restore = clearEnv();
  try {
    process.env[ENV_NAMES.zoteroKey] = 'ENV-ZK';
    const { impl } = fakeFetch([
      ['api.openalex.org', { body: '{}' }],
      ['localhost:23119', { body: '[]' }],
    ]);
    const result = await runDiagnostics({ fetchImpl: impl, config: defaultConfig() });
    assert.equal(checkById(result, 'zotero-key').ok, true);
  } finally {
    restore();
  }
});
