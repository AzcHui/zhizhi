/**
 * @zhizhi/core · gates
 *
 * 四道闸门 + 沉默机制 —— 内核 7 样之一，**宪法级**（绝不外放）。
 *
 * 为什么它是宪法而不是配置项：
 *   「一直叫的不像活的，像闹钟。有分寸才像活的。」
 *   如果插件能绕过冷却期、无视静默时段，那「分寸」就不再是内核的品格，
 *   而变成了某个插件的自觉 —— 而它能不能长期开着，完全取决于有没有分寸。
 *
 * M0：只固定契约与四道闸门的**名字**。
 * M2 才实现真正的判断：
 *   ① threshold  静态阈值     内存 > 85% / CPU > 90% / C 盘 < 10%
 *   ② sustained  持续判定     超标持续 2 分钟才算数（防编译毛刺）
 *   ③ baseline   基线偏移     对比自身历史 z-score，发现「不寻常」而非「高」
 *   ④ cooldown   冷却期       同一事件 15 分钟内只报一次
 */

import type { ZhizhiEvent } from './types.ts';

export interface GateVerdict {
  /** 是否放行 */
  readonly pass: boolean;
  /** 不放行的原因（进日志用；不静默吞掉） */
  readonly reason?: string;
}

export interface GateContext {
  /** 当前时刻（epoch ms） */
  readonly now: number;
  /** 已经放行过的事件（含本次之前的） */
  readonly passed: readonly ZhizhiEvent[];
}

export interface Gate {
  readonly name: GateName;
  check(event: ZhizhiEvent, ctx: GateContext): GateVerdict;
}

export const GATE_NAMES = ['threshold', 'sustained', 'baseline', 'cooldown'] as const;
export type GateName = (typeof GATE_NAMES)[number];

/**
 * M0 占位实现：四道闸门全部放行。
 * 这样骨架先能跑通；闸门逻辑在 M2 落地，届时只替换实现，契约不动。
 */
export function createPassThroughGates(): readonly Gate[] {
  return GATE_NAMES.map((name): Gate => ({
    name,
    check: () => ({ pass: true }),
  }));
}
