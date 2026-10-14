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
 * 四道闸门按序过，任一道不放行就**短路**（后面的不再问）：
 *   ① threshold  证据校验   事件必须带着指标证据来（防坏插件空口报）
 *   ② sustained  持续判定   ⭐ 短尖峰不算数，必须持续够久（防编译毛刺）
 *   ③ baseline   基线偏移   对比自身历史的 z-score（⚠️ M7 记忆落地后才实现，现在是诚实占位）
 *   ④ cooldown   冷却期     同一类事件在窗口内只报一次
 *
 * ⚠️ 为什么 sustained / cooldown 必须住在内核、而不是交给插件：
 *     它们需要**跨 tick 的时间状态**（「第一次超标是什么时候」）。
 *     把这状态交给插件，等于把「分寸」交给第三方的自觉。
 *     所以它们的状态一律记在内核的 store 里，插件连读都读不到。
 */

import type { Store } from './store.ts';
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

/** 默认持续判定窗口：2 分钟。编译时 CPU 飙一下属于正常，不该喊 */
export const DEFAULT_SUSTAIN_MS = 120_000;

/** 默认冷却期：15 分钟。同一件事别反复念 */
export const DEFAULT_COOLDOWN_MS = 900_000;

export interface GateOptions {
  /** 状态存放处 —— 内核的状态存储。四道闸门的时间状态都记在这儿，插件碰不到 */
  readonly store: Store;
  /** 持续判定窗口（ms），默认 2 分钟 */
  readonly sustainMs?: number;
  /** 冷却期（ms），默认 15 分钟 */
  readonly cooldownMs?: number;
}

/** sustained 闸门的记忆：这一轮「持续超标」从什么时候开始的 */
interface SustainState {
  readonly firstAt: number;
  /** 最近一次见到它是什么时候 —— 用来判断中间断了没有 */
  readonly lastSeenAt: number;
}

const sustainKey = (type: string): string => `gate:sustained:${type}`;
const cooldownKey = (type: string): string => `gate:cooldown:${type}`;

/** 时长的人话格式化 —— 日志里别出现「才持续 2s，不到 2s」这种自相矛盾的话 */
function humanMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)} 分钟`;
}

export function createGates(options: GateOptions): readonly Gate[] {
  const { store } = options;
  const sustainMs = options.sustainMs ?? DEFAULT_SUSTAIN_MS;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;

  return [
    // ── ① 证据校验 ──
    {
      name: 'threshold',
      check: (event) =>
        event.metrics.length > 0
          ? { pass: true }
          : { pass: false, reason: '事件没带任何指标证据（空口报），压掉' },
    },

    // ── ② 持续判定 ──
    {
      name: 'sustained',
      check: (event, ctx) => {
        const key = sustainKey(event.type);
        const prev = store.get<SustainState>(key);

        // 中间断过（两次见到它相隔超过一个窗口）→ 说明早就恢复正常了，重新计时。
        //
        // ⚠️ 这里是用「时间间隔」间接推断「它恢复了」，所以有个前提：
        //    **采样间隔必须远小于判定窗口**（常态：5 秒采样 / 2 分钟窗口）。
        //    若采样比窗口还慢，就会永远被判成「新一轮」，持续判定永不通过。
        //    cli 启动时会校验这一点并告警。
        const isNewRound = prev === undefined || ctx.now - prev.lastSeenAt > sustainMs;

        const state: SustainState = isNewRound
          ? { firstAt: ctx.now, lastSeenAt: ctx.now }
          : { firstAt: prev.firstAt, lastSeenAt: ctx.now };
        store.set(key, state);

        const held = ctx.now - state.firstAt;
        if (held < sustainMs) {
          return {
            pass: false,
            reason: `${event.type} 只持续了 ${humanMs(held)}，还不够久 —— 尖峰不算数`,
          };
        }
        return { pass: true };
      },
    },

    // ── ③ 基线偏移 ──
    {
      name: 'baseline',
      // 诚实占位：z-score 需要历史样本，而 store 现在还是空的。
      // 等 M7 记忆系统落地后在这里补实现 —— 现在是「还没做」，不是「忘了」。
      check: () => ({ pass: true }),
    },

    // ── ④ 冷却期 ──
    {
      name: 'cooldown',
      check: (event, ctx) => {
        const key = cooldownKey(event.type);
        const lastAt = store.get<number>(key);

        if (lastAt !== undefined && ctx.now - lastAt < cooldownMs) {
          const waitingMs = cooldownMs - (ctx.now - lastAt);
          return {
            pass: false,
            reason: `${event.type} 还在冷却，再等 ${humanMs(waitingMs)}`,
          };
        }

        store.set(key, ctx.now);
        return { pass: true };
      },
    },
  ];
}

export interface GateRunResult {
  readonly pass: boolean;
  /** 被哪道闸门拦下的 */
  readonly blockedBy?: GateName;
  readonly reason?: string;
}

/**
 * 按序跑闸门，遇到不放行就短路。
 * 四道闸门的**执行顺序由内核固定**，不由插件决定 —— 顺序本身就是纪律的一部分。
 */
export function runGates(
  gates: readonly Gate[],
  event: ZhizhiEvent,
  ctx: GateContext,
): GateRunResult {
  for (const gate of gates) {
    const verdict = gate.check(event, ctx);
    if (!verdict.pass) {
      return { pass: false, blockedBy: gate.name, reason: verdict.reason };
    }
  }
  return { pass: true };
}
