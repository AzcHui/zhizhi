/**
 * @zhizhi/plugin-sdk · define-rule
 *
 * 判断规则插件的定义入口：消费指标 → 产生事件。
 * M0 只固定契约，官方 rule-threshold / rule-sustained 在 M2 落地。
 */

import type { MetricBatch, Rule, ZhizhiEvent } from '@zhizhi/core';

export interface RuleDefinition {
  readonly id: string;
  /** 同步判定 —— 理由见 core 里 `Rule` 契约的说明 */
  readonly evaluate: (batch: MetricBatch) => readonly ZhizhiEvent[];
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
  };
}
