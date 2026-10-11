/**
 * 检查 GUI 实际下发的 dsh-lit-full-search 客户端模块是否已包含最新改动。
 * 客户端插件在 DSH 启动时被打包/缓存，改了 lib/client.js 不一定立刻反映到浏览器。
 */
const base = 'http://127.0.0.1:3080/';
const html = await (await fetch(base)).text();
const urls = [...html.matchAll(/(?:src|href)="([^"]*plugins[^"]*)"/g)].map((m) => m[1]);
console.log('页面里的插件批次 URL:', urls.length);

const needles = ['zotero-collection-items', 'CollectionItemsCard', '三级下钻', 'zotero_collection_items'];
for (const raw of urls) {
  const url = new URL(raw.replace(/&amp;/g, '&'), base).toString();
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    console.log('ERR', err.message, raw.slice(0, 50));
    continue;
  }
  const text = await res.text();
  if (!text.includes('lit-full-search')) continue;
  console.log('HTTP', res.status, '| 模块长度', text.length, '| rev 参数:', new URL(url).searchParams.get('rev'));
  for (const n of needles) console.log('   含', n.padEnd(26), text.includes(n));
  // 该批次里 dsh-lit-full-search 那一段的头部，确认是哪个版本
  const idx = text.indexOf('lit-full-search');
  console.log('   片段:', JSON.stringify(text.slice(Math.max(0, idx - 60), idx + 120)));
}
