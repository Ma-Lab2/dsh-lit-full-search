/**
 * DSH 工具契约校验器（测试基础设施，本身不是测试文件）。
 *
 * 复刻 DSH ToolRuntime 对工具调用的三道硬校验：
 *   1. lossless JSON：JSON.stringify → JSON.parse 必须与原值深等
 *      （值为 undefined 的键会被 stringify 丢掉 → 往返不等 → 报 "value is not lossless JSON"）
 *   2. outputSchema：根对象 additionalProperties:false 时，多出来的键被直接拒绝
 *      （报 `"value.X" is not a declared property`）
 *   3. render()：必须返回 [{ type:'text', text:string }]，模型只看得见这里
 *
 * 任何一条不过，工具在真实会话里就是**整体不可用**：模型只收到一条 Error，拿不到任何数据。
 * 2026-10 压力测试发现的两个 P0（lit_to_zotero 的 n=undefined、zotero_collections 漏声明 libraryKey）
 * 都是这一层没被覆盖导致的，故把校验固化成测试。
 */

/** 深比较（JSON 语义）。 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/** 递归列出所有值为 undefined 的路径。 */
export function undefinedPaths(value, prefix = '$') {
  const out = [];
  if (value === undefined) return [prefix];
  if (Array.isArray(value)) {
    value.forEach((v, i) => out.push(...undefinedPaths(v, `${prefix}[${i}]`)));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) out.push(...undefinedPaths(v, `${prefix}.${k}`));
  }
  return out;
}

/** 模拟 DSH lossless JSON 校验。通过返回 null，否则返回原因。 */
export function checkLossless(value) {
  let round;
  try {
    round = JSON.parse(JSON.stringify(value));
  } catch (err) {
    return `JSON 往返抛错：${err.message}`;
  }
  if (!deepEqual(round, value)) {
    return `往返不等（undefined 值被 stringify 丢弃）：${undefinedPaths(value).join(', ')}`;
  }
  return null;
}

const TYPE_OK = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
};

/** 校验 value 是否符合 DSH JSON Schema 子集。返回错误数组（空 = 通过）。 */
export function validateAgainstSchema(value, schema, path = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;
  const check = TYPE_OK[schema.type];
  if (check && !check(value)) {
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    errors.push(`${path} 类型应为 ${schema.type}，实际 ${actual}`);
    return errors;
  }
  if (schema.type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key} 缺失（required）`);
    }
    for (const [key, sub] of Object.entries(value)) {
      if (key in props) {
        errors.push(...validateAgainstSchema(sub, props[key], `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key} 不是已声明的属性（additionalProperties:false）`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...validateAgainstSchema(sub, schema.additionalProperties, `${path}.${key}`));
      }
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((v, i) => errors.push(...validateAgainstSchema(v, schema.items, `${path}[${i}]`)));
  }
  return errors;
}

/** render() 输出必须是 [{ type:'text', text:string }]。 */
export function checkRenderBlocks(blocks) {
  if (!Array.isArray(blocks)) return 'render 未返回数组';
  if (blocks.length === 0) return 'render 返回空数组（模型将看不到任何输出）';
  for (const [i, b] of blocks.entries()) {
    if (!b || typeof b !== 'object') return `render[${i}] 不是对象`;
    if (b.type !== 'text') return `render[${i}].type = ${JSON.stringify(b.type)}（期望 'text'）`;
    if (typeof b.text !== 'string') return `render[${i}].text 不是字符串`;
  }
  return null;
}

/**
 * 对一个工具的一次调用结果做全套契约校验。
 * @returns {{ok:boolean, failures:string[], textChars:number}}
 */
export function checkToolCall(def, args, value) {
  const failures = [];
  const lossless = checkLossless(value);
  if (lossless) failures.push(`lossless JSON: ${lossless}`);
  for (const e of validateAgainstSchema(value, def.outputSchema)) failures.push(`outputSchema: ${e}`);
  let textChars = 0;
  try {
    const blocks = def.render(args, value);
    const r = checkRenderBlocks(blocks);
    if (r) failures.push(`render: ${r}`);
    else textChars = blocks.reduce((n, b) => n + b.text.length, 0);
  } catch (err) {
    failures.push(`render 抛错：${err.message}`);
  }
  try {
    const meta = def.presentationMeta(args, value);
    const m = checkLossless(meta);
    if (m) failures.push(`presentationMeta lossless: ${m}`);
    const mr = checkRenderBlocks([{ type: 'text', text: JSON.stringify(meta) }]);
    if (mr) failures.push(`presentationMeta: ${mr}`);
  } catch (err) {
    failures.push(`presentationMeta 抛错：${err.message}`);
  }
  return { ok: failures.length === 0, failures, textChars };
}
