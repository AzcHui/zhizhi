/**
 * @zhizhi/plugin-sdk · define-rule
 *
 * 判断规则插件的定义入口：消费指标 → 产生事件。
 * M0 只固定契约，官方 rule-threshold / rule-sustained 在 M2 落地。
 */

import type { ContextInput, MetricBatch, Rule, ZhizhiEvent } from '@zhizhi/core';

export interface RuleDefinition {
  readonly id: string;
  /** 同步判定 —— 理由见 core 里 `Rule` 契约的说明 */
  readonly evaluate: (batch: MetricBatch) => readonly ZhizhiEvent[];
  /** 可选：接收外壳喂来的上下文（如 idleMs）—— 见 core 里 `Rule` 契约的说明 */
  readonly onContext?: (ctx: ContextInput) => void;
  /** 可选：接收内核下发的启动配置 —— 见 core 里 `Rule` 契约的说明 */
  readonly configure?: (config: Readonly<Record<string, unknown>>) => void;
}

export function defineRule(definition: RuleDefinition): Rule {
  if (!definition.id) {
    throw new Error('defineRule: 缺少 id');
  }
  if (typeof definition.evaluate !== 'function') {
    throw new Error(`defineRule("${definition.id}"): 缺少 evaluate() 方法`);
  }
  return {
    id: definition.id,
    evaluate: definition.evaluate,
    // 两个可选能力：实现了才挂上去（没实现 = 内核转交时直接跳过，不用 try/undefined 探测）
    ...(typeof definition.onContext === 'function' ? { onContext: definition.onContext } : {}),
    ...(typeof definition.configure === 'function' ? { configure: definition.configure } : {}),
  };
}
