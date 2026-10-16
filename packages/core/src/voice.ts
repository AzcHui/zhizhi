/**
 * @zhizhi/core · voice
 *
 * 内核的「口才协调器」：把一个事件变成一句要说出口的话。
 *
 * 降级链（顺序不能反）：
 *   1. 有 persona 插件 → 问它要台词（M5 才会有 `persona-zhi`）
 *   2. 没有 persona，或它这次选择不说 → 用事件自带的客观描述兜底
 *   3. 连描述都没有 → 退化成事件类型名（最难看，但绝不哑巴）
 *
 * ⚠️ 为什么内核必须自带兜底：
 *     架构要求「空 loadout 也必须降级，不许崩」——
 *     一个 persona 插件都不装时，只只照样得把话说出来。
 *     **人格是插件的事，但「能不能出声」是内核的责任。**
 */

import type { Logger } from './logger.ts';
import type { VoiceMemory } from './memory.ts';
import type { Line, Persona, ZhizhiEvent } from './types.ts';

/**
 * 把一个事件变成一句要说出口的话。
 *
 * ⭐ M6 起是**三段式**挑句（配合三层台词池 user > 内置 > learned，决策 #20）：
 *
 *   第一段：按优先级问每一层，只要该类型**专属**台词里「没说过」的 ——
 *     靠前的层还有新鲜台词，就轮不到靠后的层。
 *     （模型补的 learned 由此获得出场机会：内置的说遍之前它候着，说遍之后顶上）
 *
 *   第二段：专属的全没有 → 问 `"*"` 兜底键里「没说过」的。
 *     ⚠️ 兜底键必须排在专属之后 —— 否则中层的 `"*"` 会把下层的专属台词挡死（实测踩过：
 *        内置包 `"*"` 有 `{summary}`，learned 的专属闲聊就永远出不了场）。
 *
 *   第三段：全都说过 → 带 allowRepeat 再问一遍 —— 宁可重复也不哑巴。
 *
 * 🆕 M7 起「没说过」跨重启生效：传了 `memory` 就把内核记忆的 `isStale`（按**模板**记账）
 *    注入每一问 —— 上个进程说过的话，这个进程也算说过（记忆的意义就在这儿）。
 *    同时按记忆填 `{count}`（该类型是第几次），台词可以「都第 7 次了…」。
 *    不传 `memory`（主机没接记忆）行为与 M6 完全一致。
 *
 * 降级链（顺序不能反）：
 *   1. 有 persona 插件 → 问它要台词（M5 起 persona-zhi 在这里）
 *   2. 没有 persona，或它这次选择不说 → 用事件自带的客观描述兜底
 *   3. 连描述都没有 → 退化成事件类型名（最难看，但绝不哑巴）
 *
 * ⚠️ 为什么内核必须自带兜底：
 *     架构要求「空 loadout 也必须降级，不许崩」——
 *     一个 persona 插件都不装时，只只照样得把话说出来。
 *     **人格是插件的事，但「能不能出声」是内核的责任。**
 */
export function composeLine(
  event: ZhizhiEvent,
  personas: readonly Persona[],
  log: Logger,
  memory?: VoiceMemory,
): Line {
  // VoiceMemory.isStale 是「按类型记账」的（type, key）；persona 关心的是本次事件的类型，
  // 在这儿绑死 —— 传给台词包的就是单纯的「这句（模板）说过没有」。
  const isStale = memory === undefined ? undefined : (key: string): boolean => memory.isStale(event.type, key);

  for (const persona of personas) {
    try {
      const line = persona.speak(event, { isStale });
      // 「返回 undefined」是 persona 的正当表达 —— 它在说「这次我没有新鲜的」，不是出错
      if (line !== undefined) return withCount(line, event.type, memory);
    } catch (err) {
      // 人格插件坏了不该让只只变哑巴：跳过它，继续走兜底
      log.error(`台词包 ${persona.id} 挑台词时抛错（已跳过，改用兜底描述）`, err);
    }
  }

  // 第二段：专属台词全没有 → 各层的 `"*"` 兜底键（仍只挑没说过的）
  for (const persona of personas) {
    try {
      const line = persona.speak(event, { useFallback: true, isStale });
      if (line !== undefined) return withCount(line, event.type, memory);
    } catch (err) {
      log.error(`台词包 ${persona.id} 挑兜底台词时抛错（已跳过，改用兜底描述）`, err);
    }
  }

  // 第三段：全都说过 → 允许重复（说话可以旧，但不能哑）
  for (const persona of personas) {
    try {
      const line = persona.speak(event, { allowRepeat: true, isStale });
      if (line !== undefined) return withCount(line, event.type, memory);
    } catch (err) {
      log.error(`台词包 ${persona.id} 复挑台词时抛错（已跳过，改用兜底描述）`, err);
    }
  }

  // 兜底：rule 给的客观描述 → 再不行才是事件类型名
  return { text: event.summary ?? event.type };
}

/** 把台词里的 `{count}` 换成「这是第几次」（含本次）；没带记忆就原样留着（SDK 同款纪律） */
function withCount(line: Line, type: string, memory?: VoiceMemory): Line {
  if (memory === undefined || !line.text.includes('{count}')) return line;
  const text = line.text.replace(/\{count\}/g, String(memory.occurrence(type)));
  return { ...line, text };
}
