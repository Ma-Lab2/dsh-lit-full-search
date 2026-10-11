/**
 * preset 漂移检查：把本插件的 `lit-review` preset 与上游 `standard` preset 对照。
 *
 * 为什么需要：`@deepseek-ai/dsh-web-app` 把 24 个能力行禁用、改由每个 preset 逐 agent
 * 声明，所以本 preset 必须自己列出需要的能力行。这些行是上游的**快照**，上游增删行或
 * 改动行内配置（尤其是 plan-mode 的 section 文本）时，本 preset 不会自动跟随。
 *
 * 用法：
 *   node work/check-preset-drift.mjs                    # 自动探测桌面端运行时
 *   node work/check-preset-drift.mjs <standard.patch.yml 路径>
 *
 * 输出三类：
 *   [未声明] 上游 standard 有、本 preset 没有 —— 信息性，属于有意的裁剪
 *   [多余]   本 preset 有、上游 standard 没有 —— 可能是拼写错误或上游已删除该行
 *   [漂移]   两边都有、但行内配置不同（当前只比对 plan-mode 的 section 文本）
 *
 * 退出码：发现「多余」或「漂移」时返回 1，便于接到 CI / 发布前检查。
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const CANDIDATES = [
  process.argv[2],
  process.env.DSH_WEB_APP_PRESETS,
  process.env.APPDATA && path.join(process.env.APPDATA, 'dsh-tauri', 'dependencies', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets'),
].filter(Boolean);

function findStandard() {
  for (const candidate of CANDIDATES) {
    if (!candidate) continue;
    const file = candidate.endsWith('.yml') ? candidate : path.join(candidate, 'standard.patch.yml');
    if (existsSync(file)) return file;
  }
  return null;
}

/** 去掉注释行。 */
const strip = (text) => text.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');

/** 收集 `- id: X` 行 id，按出现顺序。 */
function rowIds(text) {
  return [...strip(text).matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((m) => m[1]);
}

/** 取某行 id 之后、下一个 `- id:` 之前的整段文本。 */
function rowBlock(text, id) {
  const body = strip(text);
  const start = body.search(new RegExp(`^\\s*-\\s*id:\\s*${id}\\s*$`, 'm'));
  if (start < 0) return '';
  const rest = body.slice(start);
  const next = rest.slice(1).search(/^\s*-\s*id:\s*\S+\s*$/m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** 取 `section: |` 之后的缩进块文本（用于 plan-mode 比对）。 */
function blockScalar(block, key) {
  const lines = block.split('\n');
  const at = lines.findIndex((line) => new RegExp(`^\\s*${key}:\\s*\\|`).test(line));
  if (at < 0) return '';
  const indent = /^(\s*)/.exec(lines[at])[1].length;
  const out = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') { out.push(''); continue; }
    if (/^(\s*)/.exec(line)[1].length <= indent) break;
    out.push(line.trim());
  }
  return out.join('\n').trim();
}

const standardPath = findStandard();
const localPath = new URL('../cordis.patch.yml', import.meta.url);
const localText = readFileSync(localPath, 'utf8');

if (!standardPath) {
  console.log('[跳过] 未找到上游 standard.patch.yml。');
  console.log('       指定路径：node work/check-preset-drift.mjs <path/to/standard.patch.yml>');
  console.log('       或设 DSH_WEB_APP_PRESETS 指向 .../@deepseek-ai/dsh-web-app/presets');
  process.exit(0);
}

const standardText = readFileSync(standardPath, 'utf8');
const standardRows = rowIds(standardText);
const localRows = rowIds(localText);

// preset 自身的声明行不算能力行
const META = new Set(['preset-standard', 'preset-lit-review', 'dsh-lit-full-search']);

console.log('上游 standard:', standardPath);
console.log(`上游行数 ${standardRows.length}｜本 preset 行数 ${localRows.length}`);
console.log('');

const missing = standardRows.filter((id) => !META.has(id) && !localRows.includes(id));
const extra = localRows.filter((id) => !META.has(id) && !standardRows.includes(id));

console.log(`[未声明] 上游有、本 preset 有意裁剪 ${missing.length} 行：`);
for (const id of missing) console.log('   -', id);

console.log('');
console.log(`[多余] 本 preset 有、上游 standard 没有 ${extra.length} 行：`);
for (const id of extra) console.log('   -', id);

console.log('');
const localPlan = blockScalar(rowBlock(localText, 'plan-mode'), 'section');
const upstreamPlan = blockScalar(rowBlock(standardText, 'plan-mode'), 'section');
const drifted = [];
if (localPlan && upstreamPlan && localPlan !== upstreamPlan) drifted.push('plan-mode 的 section 文本与上游不一致');
if (localPlan && !upstreamPlan) drifted.push('上游已不再声明 plan-mode（本 preset 仍在复制其 section）');

console.log(`[漂移] ${drifted.length} 项：`);
for (const item of drifted) console.log('   -', item);

console.log('');
if (extra.length || drifted.length) {
  console.log('结论：需要人工同步（见上）。');
  process.exit(1);
}
console.log('结论：无漂移（未声明的行属于有意的裁剪）。');
