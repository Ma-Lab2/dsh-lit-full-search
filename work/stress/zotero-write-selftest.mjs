/**
 * lit_to_zotero **真实写入**自检：建条目 → 验证 → 删除 → 验证无残留。
 *
 * 压力测试的 70 个用例全部走 dryRun（不碰真实库），所以「非 dryRun 的写路径」只在 fetch 替身下
 * 验证过契约。本脚本补上真机端到端：用插件自己的 importReferences 真建条目（含 PDF 上传），
 * 再逐条读回核对，最后删除并确认库内不留残留。
 *
 * 安全措施：
 *  - 只在**个人库**（users/0）操作，不碰群组库；
 *  - 目标收藏夹是脚本自建、名字带 __DSH-SELFTEST 前缀，用完即删；
 *  - 全程 try/finally，失败也会执行清理并打印残留清单。
 *
 * 用法：node work/stress/zotero-write-selftest.mjs
 */
import { importReferences } from '../../lib/lit-to-zotero.js';
import { loadConfig, resolveAuth } from '../../lib/config.js';
import { zoteroGetItem } from '../../lib/light-core.js';

const Z = 'http://localhost:23119/api';
const auth = resolveAuth(loadConfig());
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const COLLECTION_NAME = `__DSH-SELFTEST-${STAMP}`;

// Frontiers（OA）与 PR Research（OA）：两者都应有 OA PDF，能真正走完上传四段
const REFS = ['10.3389/fphy.2023.1227140', '10.1103/physrevresearch.7.013230'];

let serverId = null;

async function call(path, { method = 'GET', body, write = false, version } = {}) {
  const headers = { Connection: 'close' };
  if (write && serverId) headers['Zotero-Server-ID'] = serverId;
  if (write && auth.zoteroKey) headers['Zotero-API-Key'] = auth.zoteroKey;
  // DELETE / PATCH 必须带版本前置条件，否则 Zotero 返回 428
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
    /* 非 JSON 响应（如 DELETE 的空体） */
  }
  return { status: res.status, ok: res.ok, text, json };
}

/** 个人库顶层条目总数（Total-Results 头）。 */
async function topItemCount() {
  const res = await fetch(`${Z}/users/0/items/top?limit=1`, { headers: { Connection: 'close' } });
  await res.text().catch(() => '');
  return Number(res.headers.get('Total-Results') ?? -1);
}

/**
 * 删除条目/收藏夹。Zotero 的 DELETE 必须带 `If-Unmodified-Since-Version`（否则 428），
 * 所以先 GET 拿 version 再删——第一次跑自检时漏了这个头，导致三个对象都没删掉。
 */
async function deleteWithVersion(kind, key) {
  const get = await call(`/users/0/${kind}/${key}`);
  if (get.status === 404) return { status: 404, note: '已不存在' };
  const version = get.json?.version;
  const del = await call(`/users/0/${kind}/${key}`, { method: 'DELETE', write: true, version });
  return { status: del.status, note: del.ok ? '已删除' : del.text.slice(0, 120) };
}

const created = []; // { key, title }
let collectionKey = '';
let baseline = -1;
const problems = [];

try {
  // 学习 Zotero-Server-ID（写请求必需）
  await call('/');
  console.log('Zotero-Server-ID 学习:', serverId ? 'ok' : '未取到（写请求可能 428）');
  baseline = await topItemCount();
  console.log('个人库顶层条目基线:', baseline);

  // 1) 建自检收藏夹
  const mk = await call('/users/0/collections', { method: 'POST', body: [{ name: COLLECTION_NAME }], write: true });
  collectionKey = mk.json?.successful?.['0']?.key ?? '';
  console.log(`建收藏夹「${COLLECTION_NAME}」→ HTTP ${mk.status} key=${collectionKey || '(无)'}`);
  if (!collectionKey) throw new Error(`建收藏夹失败：HTTP ${mk.status} ${mk.text.slice(0, 200)}`);

  // 2) 真实写入（非 dryRun，含 PDF 上传）
  console.log('\n=== importReferences 真实写入（dryRun:false, attachPdf:true）===');
  const report = await importReferences({
    refs: REFS,
    library: 'user',
    collection: COLLECTION_NAME,
    dryRun: false,
    attachPdf: true,
    auth,
    zoteroKey: auth.zoteroKey,
    mailto: auth.mailto || '',
  });
  console.log('counts:', JSON.stringify(report.counts), '| 收藏夹写入前:', report.collectionSizeBefore);
  for (const it of report.items) {
    console.log(`  #${it.n} ${it.action} [${it.itemKey || '-'}] pdf=${it.pdf ?? '-'} ${it.pdfError ? `pdfError=${it.pdfError}` : ''} | ${String(it.title).slice(0, 60)}`);
    if (it.itemKey) created.push({ key: it.itemKey, title: it.title });
    if (it.action !== 'created') problems.push(`条目 #${it.n} 未按预期新建：${it.action} ${it.error ?? ''}`);
  }

  // 3) 逐条读回核对
  console.log('\n=== 读回核对 ===');
  for (const { key } of created) {
    const rec = await zoteroGetItem(key, { libraryKey: 'user' });
    if (!rec) {
      problems.push(`读回失败：${key} 不存在`);
      continue;
    }
    const d = rec.data ?? {};
    console.log(`  ${key}: ${d.itemType} | ${String(d.title).slice(0, 55)}`);
    console.log(`      DOI=${d.DOI || '(无)'} date=${d.date || '(无)'} creators=${(d.creators ?? []).length} collections=${JSON.stringify(d.collections ?? [])}`);
    if (!d.title) problems.push(`${key} 无标题`);
    if (!d.DOI) problems.push(`${key} 无 DOI`);
    if ((d.creators ?? []).length === 0) problems.push(`${key} 无作者`);
    if (!(d.collections ?? []).includes(collectionKey)) problems.push(`${key} 未归入自检收藏夹`);
    // 附件（PDF）
    const kids = await call(`/users/0/items/${key}/children`);
    const atts = (kids.json ?? []).filter((c) => c.data?.itemType === 'attachment');
    console.log(`      子条目 ${(kids.json ?? []).length} 个，其中附件 ${atts.length} 个${atts.map((a) => ` [${a.data.contentType} ${a.data.filename || ''}]`).join('')}`);
  }

  // 4) 收藏夹成员核对
  const members = await call(`/users/0/collections/${collectionKey}/items/top?limit=100`);
  console.log(`\n收藏夹内顶层条目: ${(members.json ?? []).length} 条`);
  if ((members.json ?? []).length !== created.length) problems.push(`收藏夹成员数 ${(members.json ?? []).length} ≠ 新建数 ${created.length}`);
} catch (err) {
  problems.push(`执行抛错：${err instanceof Error ? err.message : String(err)}`);
} finally {
  // 5) 清理：先删条目（连同其附件子条目），再删收藏夹
  console.log('\n=== 清理 ===');
  for (const { key } of created) {
    const del = await deleteWithVersion('items', key);
    console.log(`  删条目 ${key} → HTTP ${del.status}（${del.note}）`);
    if (del.status !== 204 && del.status !== 404) problems.push(`删条目失败 ${key}: ${del.note}`);
  }
  if (collectionKey) {
    const del = await deleteWithVersion('collections', collectionKey);
    console.log(`  删收藏夹 ${collectionKey} → HTTP ${del.status}（${del.note}）`);
    if (del.status !== 204 && del.status !== 404) problems.push(`删收藏夹失败 ${collectionKey}: ${del.note}`);
  }

  // 6) 验证无残留
  console.log('\n=== 残留检查 ===');
  for (const { key } of created) {
    const res = await call(`/users/0/items/${key}`);
    console.log(`  ${key} 复查 → HTTP ${res.status}${res.status === 404 ? '（已删除）' : '（仍存在！）'}`);
    if (res.status !== 404) problems.push(`残留条目 ${key}`);
  }
  if (collectionKey) {
    const res = await call(`/users/0/collections/${collectionKey}`);
    console.log(`  收藏夹复查 → HTTP ${res.status}${res.status === 404 ? '（已删除）' : '（仍存在！）'}`);
    if (res.status !== 404) problems.push(`残留收藏夹 ${collectionKey}`);
  }
  const after = await topItemCount();
  console.log(`  个人库顶层条目: ${baseline} → ${after}${after === baseline ? '（已还原）' : '（数量不一致！）'}`);
  if (after !== baseline) problems.push(`个人库条目数未还原：${baseline} → ${after}`);
  const cols = await call('/users/0/collections?limit=100');
  const left = (cols.json ?? []).filter((c) => c.data?.name === COLLECTION_NAME);
  console.log(`  同名收藏夹残留: ${left.length}`);
  if (left.length > 0) problems.push('同名收藏夹仍存在');

  console.log('\n===== 结论 =====');
  if (problems.length === 0) console.log('全部通过：写入成功、读回一致、清理干净。');
  else {
    console.log(`发现 ${problems.length} 个问题：`);
    for (const p of problems) console.log(`- ${p}`);
  }
  process.exitCode = problems.length === 0 ? 0 : 1;
}
