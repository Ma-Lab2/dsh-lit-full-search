/**
 * 卡片渲染回归探针：把真实的 lib/client.js 在 Node 里跑起来（stub window.__ModuleLoader__ / React / slots），
 * 捕获 tool.call.toolview 的注册，然后拿**会话日志里真实的 presentationMeta** 逐个渲染。
 *
 * 目的：GUI 里「工具调用只显示普通文本、不出卡片」时，靠这个判断是组件在渲染时抛错（会被平台回落成通用行），
 * 而不是靠猜。
 *
 * 用法: node work/render-cards-probe.mjs <session.v4.jsonl.zstd>
 */
import { readFileSync } from 'node:fs';
import { decompressAll } from './inspect-session-meta.mjs';

// ---- 最小 React shim：createElement 只搭树，够暴露抛错 ----
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useCallback: (f) => f,
  useMemo: (f) => (typeof f === 'function' ? f() : f),
  useRef: (v) => ({ current: v }),
};

// ---- 加载真实客户端模块（第二个参数可指定别的 client.js，用于对比已提交版本） ----
const clientPath = process.argv[3] ?? new URL('../lib/client.js', import.meta.url);
const source = readFileSync(clientPath, 'utf8');
let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec;
    },
  },
};
globalThis.document = {
  createElement: () => ({ textContent: '', remove() {} }),
  head: { appendChild() {} },
};

new Function('window', 'document', source)(globalThis.window, globalThis.document);
if (!captured) throw new Error('没有捕获到 __ModuleLoader__.load');
const mod = captured.factory((id) => (id === 'react' ? React : {}));

// ---- 假的 slots：捕获 toolview 注册 ----
const registrations = new Map();
const slots = {
  inject(name, fn) {
    if (name !== 'tool.call.toolview') return;
    for (const reg of fn()) registrations.set(reg.key, reg.component);
  },
  register(spec, component) {
    return { key: spec.key, component };
  },
};
mod.apply({
  get: (k) => (k === 'slots' ? slots : undefined),
  effect: () => {},
});
console.log('注册的卡片 key:', [...registrations.keys()].join(', ') || '(无)');

// ---- 从会话日志里取真实的 meta，逐个渲染 ----
const text = decompressAll(readFileSync(process.argv[2]));
const metas = [];
for (const line of text.split('\n')) {
  if (!line.includes('"card":"literature"')) continue;
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    continue;
  }
  const walk = (o) => {
    if (!o || typeof o !== 'object') return null;
    if (o.card === 'literature') return o;
    for (const v of Object.values(o)) {
      const hit = walk(v);
      if (hit) return hit;
    }
    return null;
  };
  const meta = walk(rec);
  if (meta) metas.push(meta);
}

const recent = metas.slice(-8);
console.log('\n逐个渲染最近', recent.length, '条 meta：\n');
let failures = 0;
for (const meta of recent) {
  const component = registrations.get(meta.tool);
  const label = `${String(meta.tool).padEnd(19)} kind=${String(meta.kind).padEnd(24)}`;
  if (!component) {
    console.log(label, '→ 没有对应注册（会显示通用行）');
    continue;
  }
  try {
    const tree = component({ block: { meta }, phase: 'result' });
    const isFallback = tree && typeof tree.type === 'function' && tree.type.name === 'CardFallback';
    const rootName = typeof tree?.type === 'function' ? tree.type.name : String(tree?.type);
    console.log(label, '→ 渲染 OK', isFallback ? '(走了 CardFallback 兜底)' : `(根 ${rootName}, ${tree?.props?.className ?? ''})`);
  } catch (err) {
    failures += 1;
    console.log(label, '→ ❌ 抛错:', err.message);
    console.log('     ', String(err.stack).split('\n').slice(1, 4).join('\n      '));
  }
}
console.log('\n抛错数:', failures);
