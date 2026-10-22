#!/usr/bin/env node
/**
 * 只只台词本校验器 —— 生成台词池后必须跑这一遍。
 *
 * 用法：
 *   node skills/zhizhi-persona/scripts/check-persona.mjs <文件.json>
 *
 * 退出码：0 = 没有 ERROR（可以落盘）；1 = 有 ERROR（必须改）
 *
 * 为什么需要它：台词本里有五类「写错了也不报错、只是说不出口」的问题 ——
 * 句数不够（会快速循环）、占位符丢（用户看到花括号）、段名拼错（永不生效）、
 * id 撞车（整套被跳过）、语义错位（在你打字时说「你半天没动了」）。
 * 这些光看 JSON 是看不出来的，只能量。
 */

import { readFileSync, existsSync } from 'node:fs';

// ── 已知段名（与 reference/schema.md 保持一致）──────────────────────────
const KNOWN = new Set([
  'chitchat', 'chitchat_back', 'greeting', 'poked', 'poked_again',
  'cpu.high', 'mem.high', 'disk.tight',
  'security.newAutostart', 'security.autostartChanged',
  'security.autostartTrusted', 'security.autostartUnsigned',
  'security.autostartSigBroken', '*',
]);

/** 句数下限：段存在时不得低于此数（段缺失不算错 —— 内置包会兜底） */
const MIN_LINES = {
  chitchat: 30, chitchat_back: 5, greeting: 3,
  poked: 4, poked_again: 4,
  'cpu.high': 3, 'mem.high': 2, 'disk.tight': 2,
  'security.newAutostart': 2,
};

/** 该段至少有一句要带的占位符（缺了用户就看不懂发生了什么） */
const REQUIRED_PLACEHOLDER = {
  'cpu.high': '{value}', 'mem.high': '{value}', 'disk.tight': '{value}',
  'security.newAutostart': '{name}', 'security.autostartChanged': '{name}',
  'security.autostartTrusted': '{name}', 'security.autostartUnsigned': '{name}',
  'security.autostartSigBroken': '{name}',
};

/** 只只认识的占位符 —— 别的会被原样显示给用户 */
const ALLOWED_PLACEHOLDERS = new Set([
  'value', 'count', 'name', 'command', 'drive', 'publisher', 'summary',
]);

/** 保留 id：与内核/内置包重名会被静默跳过 */
const RESERVED_IDS = new Set(['persona-zhi', 'persona-user', 'persona-learned', 'zhizhi']);

/** chitchat 的语义禁区：这些是「你不在」的说法，会用在你在场的时候 */
const CHITCHAT_FORBIDDEN = ['半天没动', '不动的时候', '歇着呢', '你没在', '你不在'];

/** 硬禁区（语气越界）—— 只 WARN，因为可能出现在引用/玩笑里，需人判断 */
const TONE_RED_FLAGS = [
  { re: /^(该|快|赶紧|快去|别再)/, why: '像是命令句（「该休息了」「快去睡」）→ 只只不催' },
  { re: /人家|嘛～|啦～/, why: '二次元腔（「人家」「嘛～」）→ 只只不卖萌' },
  { re: /废物|笨蛋|蠢|懒死|没救了/, why: '攻击用户本人 → 吐槽的是处境和电脑，不是人' },
  { re: /加油|一定会|都会好的|不要放弃/, why: '鸡汤 → 只只不做人生鼓励' },
];

// ── 结果收集 ────────────────────────────────────────────────────────────
const errors = [];
const warns = [];
const infos = [];
const E = (m) => errors.push(m);
const W = (m) => warns.push(m);
const I = (m) => infos.push(m);

// ── 主流程 ──────────────────────────────────────────────────────────────
const path = process.argv[2];
if (!path) {
  console.error('用法：node skills/zhizhi-persona/scripts/check-persona.mjs <文件.json>');
  process.exit(2);
}
if (!existsSync(path)) {
  console.error(`❌ 文件不存在：${path}`);
  process.exit(2);
}

let raw;
try {
  raw = JSON.parse(readFileSync(path, 'utf8'));
} catch (err) {
  console.error(`❌ JSON 解析失败：${path}\n   ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
  console.error('❌ 顶层必须是一个对象（形如 { id?, name?, tone?, lines }）');
  process.exit(1);
}

// id
// 内置台词包（packages/plugins/*/persona.json）用它自己的 id 是合法的 —— 它就是那个人。
// 保留字检查只针对「用户池」（data/user.json 这类），因为那才可能撞上内置 id。
const isBuiltinPack = /packages[\\/]plugins[\\/][^\\/]+[\\/]persona\.json$/i.test(path);
const id = typeof raw.id === 'string' ? raw.id.trim() : '';
if (id === '') {
  I('未写 id —— 内核会自动补成 persona-user（合法，但建议显式写一个）');
} else if (isBuiltinPack) {
  I(`内置台词包（id = "${id}"）—— 跳过保留字检查（它就是那个人）`);
} else if (RESERVED_IDS.has(id)) {
  E(`id = "${id}" 与内置台词包重名 → 内核会 WRN 后**直接跳过整个文件**，整套台词一个字都不生效。请换一个（如 persona-mine）`);
} else if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
  W(`id = "${id}" 不是「小写字母/数字/连字符」形式，部分宿主可能挑剔（建议 persona-mine 这种）`);
}

// lines
const lines = raw.lines;
if (lines === null || typeof lines !== 'object' || Array.isArray(lines)) {
  console.error('❌ 缺少 lines 对象（台词必须挂在 lines 下面，按事件类型分段）');
  process.exit(1);
}

const pools = Object.keys(lines);
if (pools.length === 0) E('lines 是空的 —— 一句话都没有');

// 逐段检查
const rows = [];
for (const key of pools) {
  const pool = lines[key];
  const tag = KNOWN.has(key) ? '' : '⚠️';

  if (!KNOWN.has(key)) {
    W(`段名 "${key}" 不是已知事件类型 → 这段**永远不会被用到**（拼错了？见 reference/schema.md 段名总表）`);
  }
  if (!Array.isArray(pool)) {
    E(`"${key}" 必须是字符串数组，现在是 ${typeof pool}`);
    rows.push([key, '-', '-', '❌']);
    continue;
  }
  if (pool.length === 0) {
    E(`"${key}" 是空数组 → 该事件会退化成兜底句`);
    rows.push([key, 0, '-', '❌']);
    continue;
  }

  let bad = 0;
  const seen = new Set();
  const text = [];
  for (const [i, line] of pool.entries()) {
    if (typeof line !== 'string') {
      E(`"${key}"[${i}] 不是字符串（${typeof line}）`);
      bad++; continue;
    }
    if (line.trim() === '') {
      E(`"${key}"[${i}] 是空字符串`);
      bad++; continue;
    }
    text.push(line);
    if (seen.has(line)) W(`"${key}" 有重复句：「${line}」—— 重复等于浪费名额`);
    seen.add(line);
  }

  // 长度
  const lens = text.map((s) => [...s].length);
  const maxLen = lens.length ? Math.max(...lens) : 0;
  for (const s of text) {
    const n = [...s].length;
    if (n > 60) E(`"${key}" 有一句 ${n} 字（硬上限 60）：「${s.slice(0, 24)}…」—— 气泡放不下`);
    else if (n > 45) W(`"${key}" 有一句 ${n} 字（建议 ≤45，短才像朋友插一句）：「${s.slice(0, 24)}…」`);
  }

  // 占位符
  for (const s of text) {
    for (const m of s.matchAll(/\{([a-zA-Z_]+)\}/g)) {
      const name = m[1];
      if (!ALLOWED_PLACEHOLDERS.has(name)) {
        E(`"${key}" 里有未知占位符 {${name}} → 会原样显示给用户（允许：${[...ALLOWED_PLACEHOLDERS].map((x) => `{${x}}`).join(' ')}）`);
      }
    }
  }
  const need = REQUIRED_PLACEHOLDER[key];
  if (need && !text.some((s) => s.includes(need))) {
    E(`"${key}" 没有任何一句带 ${need} → 用户不知道具体数值/对象是什么`);
  }

  // 句数
  const min = MIN_LINES[key];
  if (min && pool.length < min) {
    E(`"${key}" 只有 ${pool.length} 句（下限 ${min}）→ 台词「说过」是永久记账的，句数太少会快速循环，用户几天就背下来了`);
  }

  // chitchat 语义
  if (key === 'chitchat') {
    for (const s of text) {
      for (const bad of CHITCHAT_FORBIDDEN) {
        if (s.includes(bad)) {
          E(`"chitchat" 里出现「${bad}」：「${s}」→ 这是「用户不在」的说法，而 chitchat 是**用户在电脑前**说的。应移到 chitchat_back`);
        }
      }
    }
  }

  // 语气
  for (const s of text) {
    for (const { re, why } of TONE_RED_FLAGS) {
      if (re.test(s)) W(`"${key}"：「${s}」→ ${why}`);
    }
  }

  rows.push([key, String(pool.length), String(maxLen), bad === 0 ? '✅' : '❌']);
}

// 覆盖度提示（不是错：user.json 只覆盖部分段是合法的，但会与内置包混搭）
const missing = [...KNOWN].filter((k) => k !== '*' && !(k in lines));
if (missing.length > 0) {
  I(`未覆盖 ${missing.length} 段（${missing.join('、')}）→ 这些事件会**改用内置台词包的说法**，即两套语气混搭。如果要「完全独立的一套人格」，应把它们也写进来`);
}

// ── 输出 ────────────────────────────────────────────────────────────────
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].length));
console.log(`\n只只台词本校验：${path}`);
console.log('─'.repeat(64));
console.log(`${pad('段名', 28)}${pad('句数', 6)}${pad('最长', 6)}状态`);
console.log('─'.repeat(64));
for (const [k, n, m, st] of rows) console.log(`${pad(k, 28)}${pad(n, 6)}${pad(m, 6)}${st}`);
console.log('─'.repeat(64));

for (const m of errors) console.log(`❌ ${m}`);
for (const m of warns) console.log(`⚠️  ${m}`);
for (const m of infos) console.log(`ℹ️  ${m}`);

console.log(`\n合计：❌ ${errors.length} ／ ⚠️ ${warns.length} ／ ℹ️ ${infos.length}`);
if (errors.length > 0) {
  console.log('❌ 有 ERROR，不要落盘。改到 0 再跑一遍。\n');
  process.exit(1);
}
console.log('✅ 没有 ERROR，可以落盘（WARN 请逐条向用户说明为什么保留）。\n');
