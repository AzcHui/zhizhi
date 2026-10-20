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
  /**
   * 🆕 M8-b：可选，接收内核下发的启动配置（含 dataDir 用户数据目录路径）——
   * 需要持久化状态的 probe（如哨兵的基线文件）从这里拿路径。只在启动时调一次。
   */
  readonly configure?: (config: Readonly<Record<string, unknown>>) => void;
  /**
   * 🆕 M8-b 补丁（二·V）：可选，校准试采前后由 cli 调用 —— 有状态 probe 据此挂起
   * sample() 的副作用（基线对比/吸收/落盘），只保留真实采集耗时。
   */
  readonly setCalibrating?: (on: boolean) => void;
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
    // 实现了才挂（与 defineRule 的可选能力同款纪律）
    ...(typeof definition.configure === 'function' ? { configure: definition.configure } : {}),
    ...(typeof definition.setCalibrating === 'function' ? { setCalibrating: definition.setCalibrating } : {}),
  };
}
