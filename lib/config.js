/**
 * dsh-lit-full-search 配置模块。
 *
 * 配置优先级：配置文件（$DSH_HOME 或 ~/.dsh/lit-full-search.config.json） > 环境变量 LIT_SEARCH_* > 默认值。
 * 文件只存用户显式设置的字段；未设置的字段回落到环境变量/默认值。GET 返回 key 掩码（只留尾 4 位），
 * 设置状态用布尔字段表达，避免把密钥明文下发给浏览器端。
 */

import os from 'node:os';
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

/** 环境变量兜底名（与 core/auth.ts 的命名保持一致）。 */
export const ENV_NAMES = {
  openAlexApiKey: 'LIT_SEARCH_OPENALEX_API_KEY',
  s2ApiKey: 'LIT_SEARCH_S2_API_KEY',
  mailto: 'LIT_SEARCH_MAILTO',
  zoteroKey: 'LIT_SEARCH_ZOTERO_KEY',
};

/** 检索预算默认值（防上下文爆炸）。 */
export const DEFAULT_BUDGET = Object.freeze({
  searchLimit: 10, // lit_search 结果上限
  citedByLimit: 25, // lit_cited_by 结果上限
  zoteroLimit: 20, // zotero_search 结果上限
  abstractChars: 2000, // lit_abstract 摘要字符上限
});

/** 预算各字段的有效范围（int）。（searchLimit/citedByLimit/zoteroLimit 上限 25，由 OpenAlex per_page 上限决定） */
export const BUDGET_RANGE = Object.freeze({
  searchLimit: { min: 1, max: 25 },
  citedByLimit: { min: 1, max: 25 },
  zoteroLimit: { min: 1, max: 100 },
  abstractChars: { min: 200, max: 100000 },
});

export function configFilePath(dshHome) {
  const base = dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(base, 'lit-full-search.config.json');
}

/** 默认配置（不含任何密钥）。 */
export function defaultConfig() {
  return {
    mailto: '',
    openAlexApiKey: '',
    zoteroKey: '',
    budget: { ...DEFAULT_BUDGET },
  };
}

/** 把任意值夹到整数区间；非法值回落默认。 */
export function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** 逐字段夹紧预算；非法字段回落默认。 */
export function clampBudget(budget) {
  const out = { ...DEFAULT_BUDGET };
  const src = budget && typeof budget === 'object' ? budget : {};
  for (const [key, range] of Object.entries(BUDGET_RANGE)) {
    out[key] = clampInt(src[key], range.min, range.max, DEFAULT_BUDGET[key]);
  }
  return out;
}

/** key 掩码：非空返回尾 4 位，空返回 ''。 */
export function maskKey(key) {
  if (typeof key !== 'string' || key === '') return '';
  const trimmed = key.trim();
  if (trimmed.length <= 4) return trimmed;
  return `…${trimmed.slice(-4)}`;
}

function sanitizeSecret(value, current) {
  // 显式传空字符串 → 清除；未传（undefined）→ 保留现值；其他 → 覆盖。
  if (value === undefined) return current;
  if (value === null) return '';
  if (typeof value !== 'string') throw new Error('密钥字段必须是字符串');
  return value.trim();
}

/**
 * 把 POST 的 patch 合并到现有配置上（不落盘）。
 * - 密钥字段：undefined 保留，null/'' 清除，字符串覆盖
 * - budget：按字段合并并夹紧，未传字段保留
 */
export function applyPatch(current, patch) {
  const src = patch && typeof patch === 'object' ? patch : {};
  const next = { ...current };
  next.mailto = sanitizeSecret(src.mailto, current.mailto);
  next.openAlexApiKey = sanitizeSecret(src.openAlexApiKey, current.openAlexApiKey);
  next.zoteroKey = sanitizeSecret(src.zoteroKey, current.zoteroKey);
  if (src.budget && typeof src.budget === 'object') {
    next.budget = clampBudget({ ...current.budget, ...src.budget });
  } else {
    next.budget = clampBudget(current.budget);
  }
  return next;
}

/** GET 回给前端的安全视图：key 只给掩码与布尔状态，不给明文。 */
export function publicView(config) {
  return {
    mailto: config.mailto,
    openAlexApiKeySet: Boolean(config.openAlexApiKey),
    openAlexApiKeyMask: maskKey(config.openAlexApiKey),
    zoteroKeySet: Boolean(config.zoteroKey),
    zoteroKeyMask: maskKey(config.zoteroKey),
    budget: { ...config.budget },
  };
}

/** 读取配置：文件不存在 → 默认；字段缺失 → 默认；非法值 → 夹紧。 */
export function loadConfig(dshHome) {
  const file = configFilePath(dshHome);
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return defaultConfig();
    // 损坏的 JSON：当作默认配置，不抛（设置面板下次保存会覆盖）。
    return defaultConfig();
  }
  const base = defaultConfig();
  const cfg = {
    mailto: typeof raw.mailto === 'string' ? raw.mailto : base.mailto,
    openAlexApiKey: typeof raw.openAlexApiKey === 'string' ? raw.openAlexApiKey : base.openAlexApiKey,
    zoteroKey: typeof raw.zoteroKey === 'string' ? raw.zoteroKey : base.zoteroKey,
    budget: clampBudget(raw.budget),
  };
  return cfg;
}

/** 保存配置到文件。 */
export function saveConfig(config, dshHome) {
  const file = configFilePath(dshHome);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

/** 解析配置 + 环境变量 → 实际生效的认证值（文件 > env > 空）。 */
export function resolveAuth(config) {
  const env = process.env;
  return {
    openAlexApiKey: (config.openAlexApiKey || env[ENV_NAMES.openAlexApiKey] || '').trim(),
    s2ApiKey: (config.s2ApiKey || env[ENV_NAMES.s2ApiKey] || '').trim(),
    mailto: (config.mailto || env[ENV_NAMES.mailto] || '').trim(),
    zoteroKey: (config.zoteroKey || env[ENV_NAMES.zoteroKey] || '').trim(),
  };
}

/** 生效预算（文件兜底默认；budget 已在 loadConfig 夹紧）。 */
export function resolveBudget(config) {
  return clampBudget(config.budget);
}