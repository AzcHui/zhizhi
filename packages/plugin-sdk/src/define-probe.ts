/**
 * @zhizhi/plugin-sdk · define-probe
 *
 * 采集器插件的定义入口。
 * ⭐ 官方 probe-cpu 与未来社区插件走的是**同一个函数** —— 铁律②（不许有内核特权）。
 */

import type { Metric, Probe } from '@zhizhi/core';

export interface ProbeDefinition {
  readonly id: string;
  /** 采样一次。返回空数组 = 「这次没什么可汇报的」 */
  readonly sample: () => readonly Metric[] | Promise<readonly Metric[]>;
}

export function defineProbe(definition: ProbeDefinition): Probe {
  if (!definition.id) {
    throw new Error('defineProbe: 缺少 id');
  }
  if (typeof definition.sample !== 'function') {
    throw new Error(`defineProbe("${definition.id}"): 缺少 sample() 方法`);
  }
  return {
    id: definition.id,
    sample: definition.sample,
  };
}
