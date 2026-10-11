/**
 * preset 组合回归测试。
 *
 * 背景（真机发现）：`lit-review` 起初把 `plugins` 留成空列表，理由是「工具已由 profile 行
 * 全局注册，preset 只是模式标记」。这个前提是错的：
 * `@deepseek-ai/dsh-web-app` 这一层把 24 个能力行全部 `disabled: true`
 * （tool-fs / tool-fs-search / tool-pwsh / tool-bash / tool-jobs / skill-filesystem /
 * tool-skill / command-goal / tool-goal / plan-mode / compaction-basic / command-compact /
 * tool-result-pruner / tool-subagent* / workflow-ptc / tool-workflow / tool-ralph /
 * agent-instructions / tool-todo / tool-web），改由**每个 agent preset 逐 agent 重新声明**。
 * 于是空 preset 的会话只剩根作用域工具：能写出综述，但读不了项目文件、调不出任何 skill、
 * 不加载项目 AGENTS.md、没有上下文压缩。
 *
 * 本测试把「preset 必须逐行声明这些能力」钉死，防止再次退化成空列表。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const raw = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
/** 去掉注释行，避免把头部说明里的「plugins 留空」当成实际配置。 */
const code = raw.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');

/** 行 id 是否作为独立的一行出现（避免 tool-fs 误匹配 tool-fs-search）。 */
function hasRow(id) {
  return new RegExp(`^\\s*-\\s*id:\\s*${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(code);
}

test('preset lit-review：plugins 不能留空（回归：空 preset 会丢掉 AGENTS.md / 技能 / 文件读写）', () => {
  assert.ok(/id:\s*lit-review/.test(code), 'patch 里应声明 preset lit-review');
  assert.ok(!/plugins:\s*\[\s*\]/.test(code), 'preset 的 plugins 不能是空列表——web-app 层已把能力行禁用，只由 preset 提供');
});

test('preset lit-review：逐行声明 web-app 层禁用掉的能力（缺一个都会静默降级）', () => {
  const required = [
    'persona',                // 工作目录提示
    'agent-instructions',     // 项目 AGENTS.md（不编造文献、SI 单位、文献目录规则）
    'skill-filesystem',       // 技能发现
    'tool-skill',             // 调用技能（nature-* / paper-digest / lit-to-project…）
    'tool-fs',                // 读写项目文件
    'tool-fs-search',         // glob / grep
    'tool-todo',              // 多步流程进度
    'tool-web',               // 网络兜底
    'tool-ask-user',          // 向用户提问
    'present',                // 交付物
    'compaction-basic',       // 上下文压缩
    'tool-result-pruner',     // 工具结果裁剪
    'tool-subagent',          // 并行精读
    'tool-workflow',          // 工作流
  ];
  const missing = required.filter((id) => !hasRow(id));
  assert.deepEqual(missing, [], `preset 缺少这些能力行：${missing.join(', ')}`);
});

test('preset lit-review：shell 行带平台守卫（与上游 standard 一致）', () => {
  assert.ok(hasRow('tool-pwsh'), '应声明 tool-pwsh');
  assert.ok(hasRow('tool-bash'), '应声明 tool-bash');
  assert.match(code, /- id:\s*tool-pwsh[\s\S]{0,200}?disabled:\s*!!js process\.platform !== 'win32'/,
    'tool-pwsh 应只在 Windows 启用');
  assert.match(code, /- id:\s*tool-bash[\s\S]{0,200}?disabled:\s*!!js process\.platform === 'win32'/,
    'tool-bash 应只在非 Windows 启用');
});
