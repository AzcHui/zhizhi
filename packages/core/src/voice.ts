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
import type { Line, Persona, ZhizhiEvent } from './types.ts';

export function composeLine(
  event: ZhizhiEvent,
  personas: readonly Persona[],
  log: Logger,
): Line {
  for (const persona of personas) {
    try {
      const line = persona.speak(event);
      // 「返回 undefined」是 persona 的正当表达 —— 它在说「这一次我选择不说」，
      // 不是出错，所以要继续往下问别的人格包。
      if (line !== undefined) return line;
    } catch (err) {
      // 人格插件坏了不该让只只变哑巴：跳过它，继续走兜底
      log.error(`台词包 ${persona.id} 挑台词时抛错（已跳过，改用兜底描述）`, err);
    }
  }

  // 兜底：rule 给的客观描述 → 再不行才是事件类型名
  return { text: event.summary ?? event.type };
}
