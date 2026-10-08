import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';

import {
  ENV_NAMES,
  DEFAULT_BUDGET,
  BUDGET_RANGE,
  configFilePath,
  defaultConfig,
  clampInt,
  clampBudget,
  maskKey,
  applyPatch,
  publicView,
  loadConfig,
  saveConfig,
  resolveAuth,
  resolveBudget,
} from '../lib/config.js';

test('ENV_NAMES 与核心环境变量保持一致', () => {
  assert.equal(ENV_NAMES.openAlexApiKey, 'LIT_SEARCH_OPENALEX_API_KEY');
  assert.equal(ENV_NAMES.s2ApiKey, 'LIT_SEARCH_S2_API_KEY');
  assert.equal(ENV_NAMES.mailto, 'LIT_SEARCH_MAILTO');
  assert.equal(ENV_NAMES.zoteroKey, 'LIT_SEARCH_ZOTERO_KEY');
});

test('defaultConfig 不包含任何密钥', () => {
  const cfg = defaultConfig();
  assert.deepEqual(cfg, { mailto: '', openAlexApiKey: '', zoteroKey: '', budget: { ...DEFAULT_BUDGET } });
});

test('clampInt：非法值回落 fallback，越界夹紧', () => {
  assert.equal(clampInt('abc', 1, 25, 10), 10);
  assert.equal(clampInt(0, 1, 25, 10), 1);
  assert.equal(clampInt(100, 1, 25, 10), 25);
  assert.equal(clampInt(7, 1, 25, 10), 7);
  assert.equal(clampInt(2.5, 1, 25, 10), 10); // 非整数
});

test('clampBudget：逐字段夹紧，非法/缺失字段回落默认', () => {
  assert.deepEqual(clampBudget(null), { ...DEFAULT_BUDGET });
  assert.deepEqual(clampBudget({ searchLimit: 999, zoteroLimit: 0, abstractChars: 'x' }), {
    searchLimit: 25,
    citedByLimit: 25,
    zoteroLimit: 1,
    abstractChars: 2000,
  });
  assert.deepEqual(clampBudget({ searchLimit: 5, abstractChars: 5000 }), {
    searchLimit: 5,
    citedByLimit: 25,
    zoteroLimit: 20,
    abstractChars: 5000,
  });
});

test('maskKey：空/短 key 与尾 4 位掩码', () => {
  assert.equal(maskKey(''), '');
  assert.equal(maskKey(undefined), '');
  assert.equal(maskKey('ab'), 'ab');
  assert.equal(maskKey('abcdefgh'), '…efgh');
});

test('applyPatch：密钥 undefined 保留 / null 清空 / 字符串覆盖；budget 合并夹紧', () => {
  const current = { mailto: 'a@b.c', openAlexApiKey: 'AAA', zoteroKey: '', budget: { ...DEFAULT_BUDGET } };
  const next = applyPatch(current, { openAlexApiKey: null, mailto: 'new@x.y', budget: { searchLimit: 3, citedByLimit: 999 } });
  assert.equal(next.openAlexApiKey, '');
  assert.equal(next.mailto, 'new@x.y');
  assert.equal(next.budget.searchLimit, 3);
  assert.equal(next.budget.citedByLimit, 25);
  assert.equal(next.budget.zoteroLimit, 20); // 未传字段保留
  // 非字符串密钥字段抛错
  assert.throws(() => applyPatch(current, { zoteroKey: 42 }), /必须是字符串/);
});

test('publicView：不暴露明文，只给布尔状态与掩码', () => {
  const view = publicView({ mailto: '', openAlexApiKey: 'SECRET-KEY-1234', zoteroKey: '', budget: { ...DEFAULT_BUDGET } });
  assert.equal(view.openAlexApiKeySet, true);
  assert.equal(view.openAlexApiKeyMask, '…1234');
  assert.equal(view.openAlexApiKey, undefined);
  assert.equal(view.zoteroKeySet, false);
  assert.equal(view.budget.searchLimit, 10);
});

test('loadConfig/saveConfig：文件往返 + 损坏 JSON 回落默认 + 缺字段补齐', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lfs-cfg-'));
  try {
    // 文件不存在 → 默认
    let cfg = loadConfig(dir);
    assert.deepEqual(cfg.budget, { ...DEFAULT_BUDGET });
    // 保存后再读
    saveConfig({ mailto: 'x@y.z', openAlexApiKey: 'KEY', zoteroKey: '', budget: { searchLimit: 4, citedByLimit: 25, zoteroLimit: 20, abstractChars: 3000 } }, dir);
    assert.equal(existsSync(configFilePath(dir)), true);
    cfg = loadConfig(dir);
    assert.equal(cfg.mailto, 'x@y.z');
    assert.equal(cfg.openAlexApiKey, 'KEY');
    assert.equal(cfg.budget.searchLimit, 4);
    assert.equal(cfg.budget.abstractChars, 3000);
    // 损坏 JSON → 默认（不抛）
    writeFileSync(configFilePath(dir), '{broken json', 'utf8');
    cfg = loadConfig(dir);
    assert.equal(cfg.openAlexApiKey, '');
    // 缺字段（旧版文件）→ 补齐默认
    writeFileSync(configFilePath(dir), JSON.stringify({ mailto: 'only' }), 'utf8');
    cfg = loadConfig(dir);
    assert.deepEqual(cfg.budget, { ...DEFAULT_BUDGET });
    assert.equal(cfg.openAlexApiKey, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveAuth：配置文件 > 环境变量 > 空串', () => {
  const prevMail = process.env[ENV_NAMES.mailto];
  const prevKey = process.env[ENV_NAMES.openAlexApiKey];
  try {
    process.env[ENV_NAMES.mailto] = 'env@x.y';
    process.env[ENV_NAMES.openAlexApiKey] = 'ENV-KEY';
    // 文件有值 → 文件优先
    let auth = resolveAuth({ mailto: 'file@x.y', openAlexApiKey: 'FILE-KEY', s2ApiKey: '', zoteroKey: '' });
    assert.equal(auth.mailto, 'file@x.y');
    assert.equal(auth.openAlexApiKey, 'FILE-KEY');
    // 文件空 → env
    auth = resolveAuth({ mailto: '', openAlexApiKey: '', s2ApiKey: '', zoteroKey: '' });
    assert.equal(auth.mailto, 'env@x.y');
    assert.equal(auth.openAlexApiKey, 'ENV-KEY');
    // 全空 → ''
    auth = resolveAuth({ mailto: '', openAlexApiKey: '', s2ApiKey: '', zoteroKey: '' });
    assert.equal(auth.zoteroKey, '');
  } finally {
    if (prevMail === undefined) delete process.env[ENV_NAMES.mailto];
    else process.env[ENV_NAMES.mailto] = prevMail;
    if (prevKey === undefined) delete process.env[ENV_NAMES.openAlexApiKey];
    else process.env[ENV_NAMES.openAlexApiKey] = prevKey;
  }
});

test('resolveBudget：夹紧后的预算', () => {
  const budget = resolveBudget({ budget: { searchLimit: 99, citedByLimit: -1, zoteroLimit: 20, abstractChars: 3000 } });
  assert.equal(budget.searchLimit, 25);
  assert.equal(budget.citedByLimit, 1);
  assert.equal(budget.abstractChars, 3000);
});

test('configFilePath：优先传入 dshHome，其次 DSH_HOME，最后 ~/.dsh', () => {
  assert.equal(configFilePath('/tmp/x'), path.join('/tmp/x', 'lit-full-search.config.json'));
  const prev = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = '/tmp/env-home';
    assert.equal(configFilePath(), path.join('/tmp/env-home', 'lit-full-search.config.json'));
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
  // 无 DSH_HOME 时用 homedir
  const prev2 = process.env.DSH_HOME;
  try {
    delete process.env.DSH_HOME;
    assert.equal(configFilePath(), path.join(os.homedir(), '.dsh', 'lit-full-search.config.json'));
  } finally {
    if (prev2 === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev2;
  }
});