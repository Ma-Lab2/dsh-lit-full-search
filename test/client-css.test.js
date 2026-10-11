/**
 * 客户端 CSS 注入回归测试。
 *
 * 背景（真机发现）：插件从 v1.1.0 起所有 .lfs-* 样式**从未生效**——设置面板和工具卡片都退化成纯文本。
 * 根因是 `ctx.effect(fn)` 的语义：它**立刻调用 fn**，并把 fn 的**返回值**当清理函数
 * （平台自身写法：`ctx.effect(() => dispose, "…")`）。原代码写的是
 * `ctx.effect(() => styleEl.remove(), …)`，等于注入后当场把 <style> 删掉。
 *
 * 这个 bug 单测抓不到，因为既有测试只检查 CSS 文本里有没有失效 token，从不检查「注入后样式还在不在」。
 * 本文件在 Node 里用**忠实模拟 ctx.effect 语义**的假 ctx 跑一遍 apply()，断言：
 *   1. apply() 结束后 <style> 仍然在 document.head 里；
 *   2. 注入的 CSS 覆盖了源码里用到的每一个 lfs-* class（防止类名与规则漂移）；
 *   3. 重复 apply 不会重复注入（data-plugin-css 去重）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/** 最小 React shim：只要 createElement 能搭树即可（本文件不渲染卡片）。 */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useCallback: (f) => f,
  useMemo: (f) => (typeof f === 'function' ? f() : f),
  useRef: (v) => ({ current: v }),
};

/** 假 document：记录 head 里的元素，支持 querySelector(style[data-plugin-css=...]) 去重查询。 */
function makeDocument() {
  const head = {
    children: [],
    appendChild(el) {
      this.children.push(el);
      return el;
    },
  };
  return {
    head,
    createElement(tag) {
      const el = {
        tagName: String(tag).toUpperCase(),
        textContent: '',
        dataset: {},
        removed: false,
        remove() {
          el.removed = true;
          const i = head.children.indexOf(el);
          if (i >= 0) head.children.splice(i, 1);
        },
      };
      return el;
    },
    querySelector(selector) {
      const m = /^style\[data-plugin-css=(?:"(.*)"|'(.*)')]$/.exec(selector);
      if (!m) return null;
      const wanted = m[1] ?? m[2];
      return head.children.find((el) => el.tagName === 'STYLE' && el.dataset.pluginCss === wanted) ?? null;
    },
  };
}

/** 忠实模拟平台 ctx：effect(setup) 立刻调用 setup，并把返回值登记为清理函数。 */
function makeCtx(registrations) {
  const disposers = [];
  return {
    disposers,
    get(key) {
      if (key !== 'slots') return undefined;
      return {
        inject(name, fn) {
          if (name !== 'tool.call.toolview') return;
          for (const reg of fn()) registrations.set(reg.key, reg.component);
        },
        register(spec, component) {
          return { key: spec.key, component };
        },
      };
    },
    effect(setup, label) {
      // 平台语义：立刻执行 setup，把它的返回值当清理函数
      const disposer = setup();
      if (typeof disposer === 'function') disposers.push({ disposer, label });
    },
  };
}

function loadAndApply() {
  let captured = null;
  const doc = makeDocument();
  const win = { __ModuleLoader__: { load: (spec) => { captured = spec; } } };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', source)(win, doc);
  assert.ok(captured, '没有捕获到 __ModuleLoader__.load');
  const mod = captured.factory((id) => (id === 'react' ? React : {}));
  const registrations = new Map();
  const ctx = makeCtx(registrations);
  mod.apply(ctx);
  return { doc, ctx, registrations };
}

test('client CSS：apply() 之后 <style> 必须仍然存在（回归：ctx.effect 当场删掉样式）', () => {
  const { doc, ctx } = loadAndApply();
  const styles = doc.head.children.filter((el) => el.tagName === 'STYLE');
  assert.equal(styles.length, 1, `期望注入 1 个 <style>，实际 ${styles.length} 个`);
  assert.ok(!styles[0].removed, '<style> 被移除了——检查是不是又用 ctx.effect 注册了 remove()');
  assert.match(styles[0].textContent, /\.lfs-card\s*\{/, '注入的 CSS 应包含 .lfs-card 规则');
  assert.match(styles[0].textContent, /\.lfs-page\s*\{/, '注入的 CSS 应包含 .lfs-page 规则');
  // 清理函数里不应再包含「移除样式」这件事
  assert.equal(ctx.disposers.length, 0, '不应为样式注册任何 effect 清理函数');
});

test('client CSS：重复 apply 只注入一次（data-plugin-css 去重）', () => {
  let captured = null;
  const doc = makeDocument();
  const win = { __ModuleLoader__: { load: (spec) => { captured = spec; } } };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', source)(win, doc);
  const mod = captured.factory((id) => (id === 'react' ? React : {}));
  const registrations = new Map();
  mod.apply(makeCtx(registrations));
  mod.apply(makeCtx(registrations));
  assert.equal(doc.head.children.filter((el) => el.tagName === 'STYLE').length, 1, '重复 apply 不应重复注入样式');
});

test('client CSS：源码里用到的每个 lfs-* class 都有对应规则（防类名与规则漂移）', () => {
  const { doc } = loadAndApply();
  const css = doc.head.children.find((el) => el.tagName === 'STYLE').textContent;

  // 收集 CSS 里定义过的 .lfs-xxx 选择器
  const defined = new Set([...css.matchAll(/\.(lfs-[a-z0-9-]+)/gi)].map((m) => m[1]));
  // 收集源码里 className: 'lfs-xxx ...' 用到的类名
  const used = new Set();
  for (const m of source.matchAll(/className:\s*'([^']+)'/g)) {
    for (const cls of m[1].split(/\s+/)) if (cls.startsWith('lfs-')) used.add(cls);
  }
  assert.ok(used.size > 10, `应当解析出多个 lfs-* 类名，实际 ${used.size} 个`);
  const missing = [...used].filter((c) => !defined.has(c));
  assert.deepEqual(missing, [], `以下 class 在 CSS 里没有对应规则：${missing.join(', ')}`);
});

test('client CSS：样式表里不含已失效的 --ds-color-* token', () => {
  const { doc } = loadApplyForTokenCheck();
  const css = doc.head.children.find((el) => el.tagName === 'STYLE').textContent;
  const stale = [...css.matchAll(/--ds-color-[a-z0-9-]+/gi)].map((m) => m[0]);
  assert.deepEqual([...new Set(stale)], [], `面板/卡片 CSS 残留失效 token：${[...new Set(stale)].join(', ')}`);
});

function loadApplyForTokenCheck() {
  return loadAndApply();
}
