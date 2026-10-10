/**
 * 清理 zotero-write-selftest 的残留（DELETE 需要 If-Unmodified-Since-Version）。
 * 用法：node work/stress/zotero-cleanup.mjs <itemKey|collectionKey> [...]
 */
import { loadConfig, resolveAuth } from '../../lib/config.js';

const Z = 'http://localhost:23119/api';
const auth = resolveAuth(loadConfig());
let serverId = null;

async function call(path, { method = 'GET', body, write = false, version } = {}) {
  const headers = { Connection: 'close' };
  if (write && serverId) headers['Zotero-Server-ID'] = serverId;
  if (write && auth.zoteroKey) headers['Zotero-API-Key'] = auth.zoteroKey;
  if (version !== undefined) headers['If-Unmodified-Since-Version'] = String(version);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${Z}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const sid = res.headers.get('Zotero-Server-ID');
  if (sid) serverId = sid;
  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  return { status: res.status, ok: res.ok, text, json };
}

await call('/');
const keys = process.argv.slice(2);
if (keys.length === 0) {
  console.error('用法：node work/stress/zotero-cleanup.mjs <key> [...]');
  process.exit(2);
}

for (const key of keys) {
  // 自动判类型：先按条目查，再按收藏夹查
  let kind = 'items';
  let get = await call(`/users/0/items/${key}`);
  if (get.status === 404) {
    kind = 'collections';
    get = await call(`/users/0/collections/${key}`);
  }
  if (get.status === 404) {
    console.log(`${key} 不存在（item/collection 均为 404）`);
    continue;
  }
  const version = get.json?.version;
  console.log(`${key} 类型=${kind} version=${version} name=${String(get.json?.data?.title ?? get.json?.data?.name ?? '').slice(0, 50)}`);
  const del = await call(`/users/0/${kind}/${key}`, { method: 'DELETE', write: true, version });
  console.log(`  DELETE → HTTP ${del.status} ${del.text.slice(0, 120)}`);
  const after = await call(`/users/0/${kind}/${key}`);
  console.log(`  复查 → HTTP ${after.status}${after.status === 404 ? '（已删除）' : '（仍存在）'}`);
}
