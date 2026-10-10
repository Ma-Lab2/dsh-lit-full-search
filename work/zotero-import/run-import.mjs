#!/usr/bin/env node
/**
 * 用插件引擎（lib/zotero-import.js）把筛选后的《液晶靶激光离子加速综述》参考文献
 * 写回 Zotero：WENJUN_MA's Group → 2.Novel Targets → liqiud crystal target。
 *
 * 用法：
 *   node work/zotero-import/run-import.mjs --dry-run            # 只出计划，不写
 *   node work/zotero-import/run-import.mjs --apply              # 预检 1 条 → 全量写入
 *   node work/zotero-import/run-import.mjs --verify             # 复核是否 16/16 命中
 *   node work/zotero-import/run-import.mjs --rollback <report>  # 删除本次新建条目
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ZOTERO_API_BASE, zoteroLibraryPrefix } from '../../lib/light-core.js';
import { importReferences } from '../../lib/zotero-import.js';
import { loadConfig, resolveAuth } from '../../lib/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REFS_FILE = path.join(HERE, 'data', 'refs-lc-review-2026.json');
const LIBRARY = "WENJUN_MA's Group";
const COLLECTION = '2.Novel Targets > liqiud crystal target';
const LIBRARY_KEY = 'group:6441110';
const ITEM_TYPES = ['journalArticle'];

const mode = process.argv.includes('--apply')
  ? 'apply'
  : process.argv.includes('--verify')
    ? 'verify'
    : process.argv.includes('--rollback')
      ? 'rollback'
      : 'dry-run';

/** 生效认证：把面板里的 openAlexApiKey 映射成引擎期望的 apiKey。 */
function effectiveAuth() {
  const auth = resolveAuth(loadConfig());
  return { ...auth, apiKey: auth.openAlexApiKey, mailto: auth.mailto || '' };
}

function loadKeepRefs() {
  const payload = JSON.parse(readFileSync(REFS_FILE, 'utf8'));
  return payload.refs.filter((r) => r.decision === 'keep');
}

function run(options) {
  const auth = effectiveAuth();
  return importReferences({
    library: LIBRARY,
    collection: COLLECTION,
    itemTypes: ITEM_TYPES,
    auth,
    zoteroKey: auth.zoteroKey,
    mailto: auth.mailto,
    ...options,
  });
}

function line(item) {
  const label = { created: '新建', added: '加挂', exists: '已有', skipped: '跳过', failed: '失败' }[item.action] ?? item.action;
  const key = item.itemKey ? ` [${item.itemKey}]` : '';
  const err = item.error ? ` （${item.error}）` : '';
  return `  #${String(item.n ?? '-').padStart(2)} ${label.padEnd(2)}${key.padEnd(12)} ${(item.title || '').slice(0, 78)}${err}`;
}

function summarize(report) {
  const c = report.counts;
  return `新建 ${c.created} · 加挂 ${c.added} · 已存在 ${c.exists} · 跳过 ${c.skipped} · 失败 ${c.failed}`;
}

function writeReport(report, tag) {
  const file = path.join(HERE, 'data', `import-report-${tag}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n', 'utf8');
  return file;
}

// ---- 各模式 -----------------------------------------------------------------

if (mode === 'dry-run') {
  const report = await run({ refs: loadKeepRefs(), dryRun: true });
  console.log(`目标：${report.library} › ${report.collection}  [${report.collectionKey}]`);
  console.log(`收藏夹现有 ${report.collectionSizeBefore} 条 → 计划：${summarize(report)}`);
  for (const item of report.items) console.log(line(item));
  console.log('\n（--dry-run 未写入任何数据）');
} else if (mode === 'apply') {
  const keep = loadKeepRefs();
  const plan = await run({ refs: keep, dryRun: true });
  console.log(`预演：${summarize(plan)}`);

  const firstCreate = plan.items.find((i) => i.action === 'created');
  if (firstCreate) {
    const pilotRef = keep.find((r) => r.n === firstCreate.n);
    console.log(`\n预检：先写 1 条 #${pilotRef.n} ${String(pilotRef.title).slice(0, 60)}`);
    const pilot = await run({ refs: [pilotRef], dryRun: false });
    console.log(line(pilot.items[0]));
    if (pilot.counts.failed > 0 || pilot.counts.created !== 1) {
      writeReport(pilot, `pilot-failed-${Date.now()}`);
      console.error('\n预检失败：写入未成功，已停止（未继续其余条目）。');
      if (pilot.items[0].error) console.error(`原因：${pilot.items[0].error}`);
      process.exit(1);
    }
    const back = await run({ refs: [pilotRef], dryRun: true });
    if (back.items[0].action !== 'exists') {
      console.error(`\n预检回读失败：#${pilotRef.n} 未出现在目标收藏夹（action=${back.items[0].action}）。`);
      process.exit(1);
    }
    console.log(`预检通过：#${pilotRef.n} 已在 ${COLLECTION}（itemKey ${pilot.items[0].itemKey}）。`);
  }

  console.log('\n开始全量写入…');
  const report = await run({ refs: keep, dryRun: false });
  const file = writeReport(report, new Date().toISOString().replace(/[:.]/g, '-'));
  console.log(`结果：${summarize(report)}`);
  for (const item of report.items) console.log(line(item));
  console.log(`\n报告：${path.relative(process.cwd(), file)}`);
  console.log(`收藏夹条目数：${report.collectionSizeBefore} → ${report.collectionSizeBefore + report.counts.added + report.counts.created}`);
} else if (mode === 'verify') {
  const report = await run({ refs: loadKeepRefs(), dryRun: true });
  const missing = report.items.filter((i) => i.action !== 'exists');
  console.log(`复核 ${report.library} › ${report.collection}：`);
  console.log(`  exists ${report.counts.exists}/${report.items.length} · added ${report.counts.added} · created ${report.counts.created} · failed ${report.counts.failed}`);
  for (const item of missing) console.log(line(item));
  console.log(missing.length === 0 ? '\n[OK] 筛选后的参考文献全部在目标收藏夹内。' : `\n[!] 还有 ${missing.length} 条未就位。`);
} else {
  // --rollback <report.json>
  const idx = process.argv.indexOf('--rollback');
  const reportPath = process.argv[idx + 1];
  if (!reportPath) {
    console.error('用法：--rollback <report.json>');
    process.exit(1);
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const created = report.items.filter((i) => i.action === 'created' && i.itemKey);
  console.log(`回滚 ${created.length} 条（新建条目）…`);
  const auth = effectiveAuth();
  const prefix = zoteroLibraryPrefix(report.libraryKey || LIBRARY_KEY);
  let ok = 0;
  for (const item of created) {
    const url = `${ZOTERO_API_BASE}${prefix}/items/${encodeURIComponent(item.itemKey)}`;
    const headers = { Connection: 'close' };
    if (auth.zoteroKey) headers['Zotero-API-Key'] = auth.zoteroKey;
    const current = await fetch(url, { headers }).catch(() => null);
    if (!current?.ok) {
      console.log(`  ✗ ${item.itemKey} 读取失败（HTTP ${current?.status ?? 'n/a'}），未删除`);
      continue;
    }
    const headers2 = { ...headers, 'If-Unmodified-Since-Version': current.headers.get('Last-Modified-Version') ?? '0' };
    const sid = current.headers.get('Zotero-Server-ID');
    if (sid) headers2['Zotero-Server-ID'] = sid;
    const del = await fetch(url, { method: 'DELETE', headers: headers2 });
    if (del.ok || del.status === 204) {
      ok += 1;
      console.log(`  ✓ 已删除 ${item.itemKey}  ${(item.title || '').slice(0, 60)}`);
    } else {
      console.log(`  ✗ ${item.itemKey} 删除失败 HTTP ${del.status}`);
    }
  }
  console.log(`回滚完成：${ok}/${created.length}`);
}
