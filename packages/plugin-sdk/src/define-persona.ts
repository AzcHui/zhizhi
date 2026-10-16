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
  /**
   * 挑一句话；返回 undefined = 「这次选择不说」。
   * `options` 的三段式约定（专属新鲜 → `"*"` 兜底新鲜 → 才许重复）
   * 见 core 里 `Persona` 契约的说明；不关心的实现忽略它即可。
   *
   * M7 起 `options.isStale(key)` 由内核注入（主机带记忆时）——
   * 「说过」以**模板原文**为键、跨重启生效；实现不认识它时忽略即可（退回进程内判据）。
   */
  readonly speak: (
    event: ZhizhiEvent,
    options?: {
      readonly allowRepeat?: boolean;
      readonly useFallback?: boolean;
      readonly isStale?: (key: string) => boolean;
    },
  ) => Line | undefined;
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
 * | `{count}` | 🆕 M7：该类型**是第几次**（内核按记忆填，如 `都第 {count} 次了…`；主机不带记忆时原样保留） |
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

  // 「没说过」记录（进程内存活期）—— M6 挑句原则：**没说过 / 近期没说过的优先**。
  // M7 起内核若带记忆（composeLine 注入 isStale），「说过」跨重启仍算说过；
  // 这里自己的 Set 继续管会话内不重复（主机不带记忆时它是唯一判据）。
  const said = new Set<string>();

  return definePersona({
    id: data.id,
    speak(
      event: ZhizhiEvent,
      options?: {
        readonly allowRepeat?: boolean;
        readonly useFallback?: boolean;
        readonly isStale?: (key: string) => boolean;
      },
    ): Line | undefined {
      // 三段式（见 core/Persona 契约）：专属新鲜 → `"*"` 兜底新鲜 → 才许重复。
      // ⚠️ 第一段绝不能把 `"*"` 混进来 —— 否则中层的兜底键会把下层的专属台词挡死。
      const allowRepeat = options?.allowRepeat === true;
      const useFallback = options?.useFallback === true;
      const isStale = options?.isStale;
      const specific = data.lines[event.type];
      const pool = useFallback
        ? data.lines[FALLBACK_KEY]
        : (specific ?? (allowRepeat ? data.lines[FALLBACK_KEY] : undefined));
      // 没有台词 = 「这次我不说」→ 返回 undefined，让内核用客观描述兜底。
      // ⚠️ 这里**绝不能**抛错：台词包是默认值不是必需品，缺台词不是故障。
      if (pool === undefined || pool.length === 0) return undefined;

      // 新鲜 = 会话内没说过（本 Set）且 跨重启也没说过（内核记忆，若有）。
      // 模板原文为键 —— 填完 {value} 的文本每次都不同，当不了「说过」的凭据。
      const fresh = pool.filter((line) => !said.has(line) && !(isStale?.(line) ?? false));
      const candidates = fresh.length > 0 ? fresh : allowRepeat ? pool : [];
      // 全都说过了、又不许重复 → undefined，把机会让给下一层台词包
      if (candidates.length === 0) return undefined;

      const picked = candidates[Math.floor(Math.random() * candidates.length)]!;
      said.add(picked);
      // key = 模板原文（fillPlaceholders 之前）—— 内核记忆按它记账（M7）
      return { text: fillPlaceholders(picked, event), key: picked };
    },
  });
}
