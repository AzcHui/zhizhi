/**
 * @zhizhi/plugin-sdk · define-persona
 *
 * 台词包插件的定义入口：事件 + 情境 → 一句话。
 *
 * ⭐ 这是整个项目「别人能改」的最低成本入口：
 *   改台词 = 改一个 JSON 文件（M5 会把 persona-zhi 的台词全部外置成 persona.json）。
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
