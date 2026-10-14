/**
 * @zhizhi/plugin-sdk · define-persona
 *
 * 台词包插件的定义入口：事件 + 情境 → 一句话。
 *
 * ⭐ 这是整个项目「别人能改」的最低成本入口。
 *    M5 起台词**不在代码里**，而在 `persona.json` 里 ——
 *    所以这个文件提供两条路：
 *
 *      ① `definePersona({ id, speak })`   —— 写代码的台词包（有能力才用）
 *      ② `definePersonaFromJson(data)`    —— **纯数据台词包**（JSON，不执行代码）
 *
 * 🔒 决策 D（性格包 = 纯数据，不允许执行代码）就是靠 ② 落地的：
 *    别人分享一套性格 = 分享一个文件夹（JSON + 图片），风险为零。
 *
 * ⚠️ 台词包**碰不到**沉默机制、阈值、通道 —— 那些是内核宪法。
 *    这里只能决定「说什么、怎么说」。
 */

import type { Line, Persona, ZhizhiEvent } from '@zhizhi/core';

export interface PersonaDefinition {
  readonly id: string;
  /** 挑一句话；返回 undefined = 「这次选择不说」 */
  readonly speak: (event: ZhizhiEvent) => Line | undefined;
}

export function definePersona(definition: PersonaDefinition): Persona {
  if (!definition.id) {
    throw new Error('definePersona: 缺少 id');
  }
  if (typeof definition.speak !== 'function') {
    throw new Error(`definePersona("${definition.id}"): 缺少 speak() 方法`);
  }
  return {
    id: definition.id,
    speak: definition.speak,
  };
}

// ──────────────────────────── 纯数据台词包（persona.json） ────────────────────────────

/**
 * `persona.json` 的形状 —— **纯数据，不含任何代码**。
 *
 * ```json
 * {
 *   "id": "zhi",
 *   "name": "只只",
 *   "tone": "有人味 · 会吐槽你",
 *   "lines": {
 *     "cpu.high": ["CPU 都 {value}% 了，你这是开了几个浏览器？"],
 *     "mem.high": ["内存 {value}% —— 要我帮你数数标签页吗"],
 *     "*": ["{summary}"]
 *   }
 * }
 * ```
 *
 * 台词里能用的占位符（用 `{}` 包住，写错的会**原样保留**，方便一眼看出打错）：
 *
 * | 占位符 | 来自 |
 * |---|---|
 * | `{summary}` | 事件的客观描述（rule 给的，带具体数值） |
 * | `{type}` · `{severity}` | 事件类型 / 严重度 |
 * | `{key}` · `{value}` · `{unit}` | 触发它的第一个指标 |
 * | `{drive}` 等 | 该指标的 `meta` 字段（键名直接用，如磁盘的 `drive`） |
 */
export interface PersonaJson {
  readonly id: string;
  /** 形象层：名字（日志 / 未来 UI 用） */
  readonly name?: string;
  /** 性格层：语气说明，给人看的（M6/M7 接亲密度时会用上） */
  readonly tone?: string;
  /** 台词层：事件类型 → 候选台词；`"*"` 是兜底键 */
  readonly lines: Readonly<Record<string, readonly string[]>>;
}

/** 没有专门台词的事件，用这个键的台词 */
const FALLBACK_KEY = '*';

function fail(source: string, why: string): never {
  throw new Error(`台词包不合规（${source}）：${why}`);
}

/** 校验 + 归一化；不合规就抛出带**出处**的清晰错误（loader 会把它记成 invalid） */
function parsePersonaJson(raw: unknown, source: string): PersonaJson {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(source, '顶层必须是一个 JSON 对象');
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj['id'] !== 'string' || obj['id'].trim() === '') {
    fail(source, '缺少非空的 "id"');
  }

  const lines = obj['lines'];
  if (lines === null || typeof lines !== 'object' || Array.isArray(lines)) {
    fail(source, '"lines" 必须是一个对象：事件类型 → 台词数组');
  }

  const table: Record<string, readonly string[]> = {};
  let usable = 0;
  for (const [type, value] of Object.entries(lines as Record<string, unknown>)) {
    if (!Array.isArray(value)) {
      fail(source, `"lines.${type}" 必须是字符串数组`);
    }
    const pool: string[] = [];
    for (const item of value as readonly unknown[]) {
      if (typeof item !== 'string' || item.trim() === '') {
        fail(source, `"lines.${type}" 里只能放非空字符串`);
      }
      pool.push(item);
    }
    if (pool.length > 0) usable += 1;
    table[type] = pool;
  }
  if (usable === 0) {
    fail(source, '"lines" 里一句台词都没有 —— 空的台词包没有意义（想沉默就别装它）');
  }

  // 可选字段：只在确实给了字符串时才带上，免得 undefined 混进来
  return {
    id: obj['id'] as string,
    ...(typeof obj['name'] === 'string' ? { name: obj['name'] } : {}),
    ...(typeof obj['tone'] === 'string' ? { tone: obj['tone'] } : {}),
    lines: table,
  };
}

/** 把一句台词里的 `{占位符}` 换成真实值；不认识的占位符**原样留着**（打错了能看见） */
function fillPlaceholders(text: string, event: ZhizhiEvent): string {
  const metric = event.metrics[0];
  const vars: Record<string, string> = {
    type: event.type,
    severity: event.severity,
    summary: event.summary ?? event.type,
    key: metric?.key ?? '',
    value: metric === undefined ? '' : String(metric.value),
    unit: metric?.unit ?? '',
  };
  if (metric?.meta !== undefined) {
    for (const [k, v] of Object.entries(metric.meta)) vars[k] = String(v);
  }
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole);
}

/**
 * 把一份**纯数据**的台词包变成内核能用的 persona。
 *
 * @param raw    `persona.json` 的内容（已 `JSON.parse`）
 * @param source 出处（文件路径 / 包名）—— 只用来把错误说清楚
 */
export function definePersonaFromJson(raw: unknown, source: string): Persona {
  const data = parsePersonaJson(raw, source);

  return definePersona({
    id: data.id,
    speak(event: ZhizhiEvent): Line | undefined {
      const pool = data.lines[event.type] ?? data.lines[FALLBACK_KEY];
      // 没有台词 = 「这次我不说」→ 返回 undefined，让内核用客观描述兜底。
      // ⚠️ 这里**绝不能**抛错：台词包是默认值不是必需品，缺台词不是故障。
      if (pool === undefined || pool.length === 0) return undefined;

      const picked = pool[Math.floor(Math.random() * pool.length)]!;
      return { text: fillPlaceholders(picked, event) };
    },
  });
}
