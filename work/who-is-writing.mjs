/** 看另一个会话在干什么：抓它最近的文件写入/编辑目标，确认是否在动本仓库。 */
import { readFileSync } from 'node:fs';
import { decompressAll } from './inspect-session-meta.mjs';

const file = process.argv[2];
const n = Number(process.argv[3] ?? 12);
const text = decompressAll(readFileSync(file));
const lines = text.split('\n').filter((l) => l.trim());

const interesting = [];
for (const line of lines) {
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    continue;
  }
  if (rec.type !== 'tool/call') continue;
  const s = line;
  if (!/dsh-lit-full-search|lit-review|cordis\.patch|lib[\\/]index\.js/.test(s)) continue;
  const name = /"name":"([^"]+)"/.exec(s)?.[1] ?? '?';
  const args = /"arguments":(\{.*?\})\s*[,}]/.exec(s)?.[1] ?? '';
  interesting.push({ seq: rec.seq, name, args: args.slice(0, 220) });
}
console.log('与该仓库相关的 tool/call:', interesting.length);
for (const it of interesting.slice(-n)) console.log(`#${it.seq} ${it.name}  ${it.args}`);
