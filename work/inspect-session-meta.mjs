/**
 * 会话日志是「每行一个 zstd 帧」的拼接（本机实测 3005 帧），Node 的 zstdDecompressSync
 * 只解第一帧。这里按 zstd magic 切帧逐个解，切错了就往后并帧重试。
 */
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function decompressAll(buf) {
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf.compare(MAGIC, 0, 4, i, i + 4) === 0) starts.push(i);
  }
  const out = [];
  let k = 0;
  while (k < starts.length) {
    let merged = null;
    // 从当前帧起点开始，依次尝试并入后续帧起点，直到能解开
    for (let j = k + 1; j <= starts.length; j += 1) {
      const end = j < starts.length ? starts[j] : buf.length;
      try {
        merged = zlib.zstdDecompressSync(buf.subarray(starts[k], end));
        k = j;
        break;
      } catch {
        /* 该切法解不开，并下一帧重试 */
      }
    }
    if (merged === null) {
      k += 1; // 整段都解不开：跳过这个起点，避免死循环
      continue;
    }
    out.push(merged.toString('utf8'));
  }
  return out.join('');
}

if (process.argv[1] && process.argv[1].endsWith('inspect-session-meta.mjs')) {
  const file = process.argv[2];
  const limit = Number(process.argv[3] ?? 14);
  if (!file) {
    console.error('用法: node work/inspect-session-meta.mjs <session.v4.jsonl.zstd> [条数]');
    process.exit(2);
  }
  const text = decompressAll(readFileSync(file));
  const lines = text.split('\n').filter((l) => l.trim());
  console.log('解压后', text.length, '字符 |', lines.length, '行');

  const NAMES = ['lit_search', 'lit_abstract', 'lit_cited_by', 'zotero_search', 'zotero_collections', 'lit_to_zotero', 'zotero_enrich', 'zotero_abstract'];
  const found = [];
  for (const line of lines) {
    for (const n of NAMES) {
      if (line.includes(`"${n}"`)) {
        found.push({ name: n, line });
        break;
      }
    }
  }
  console.log('提到工具名的记录:', found.length);
  for (const { name, line } of found.slice(-limit)) {
    const hasMeta = /"meta":\{/.test(line);
    const kind = /"kind":"([^"]+)"/.exec(line)?.[1] ?? '';
    const card = /"card":"([^"]+)"/.exec(line)?.[1] ?? '';
    const type = /"type":"([^"]+)"/.exec(line)?.[1] ?? '';
    console.log(`${name.padEnd(19)} type=${type.padEnd(18)} meta=${hasMeta ? 'Y' : 'n'} card=${card.padEnd(11)} kind=${kind.padEnd(24)} len=${line.length}`);
  }
}
