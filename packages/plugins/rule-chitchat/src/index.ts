/**
 * rule-chitchat —— 闲聊规则（官方插件，M6）
 *
 * 它管的是「什么时候主动开口」，与告警**完全两回事**：
 *
 *   告警：机器出事了 → 忙时最有用   → 走阈值 + 四道闸门（内核的分寸系统）
 *   闲聊：你闲下来了 → 闲时才合适   → 只看两个数：空闲够不够久、隔了多久没聊
 *
 * ⚠️ 三条硬约束（报表第三节，走歪了就白做）：
 *   ① **不得复用告警的阈值/闸门** —— `threshold` 是灵敏度（多小的问题算问题），
 *      `cooldownMs` 是告警的话量。想多说几句调的是**闲聊间隔**，不是那些。
 *      所以本插件产生的 chitchat 事件 `kind: 'chitchat'`：内核会**绕闸门、走 dispatcher**。
 *   ② 闲聊本身**永不等模型** —— 模型台词走「预生成」，后台补进 learned.json，
 *      这里只管到点挑（模型层是 M6 加餐，本插件对它一无所知）。
 *   ③ **没外壳喂上下文 = 自动静默** —— `idleMs` 由外壳经反向通道喂进来；
 *      没人喂就不触发，但绝不报错（监控照常，与「空 loadout 降级」同一条原则）。
 */

import { defineRule } from '@zhizhi/plugin-sdk';
import type { ContextInput, ZhizhiEvent } from '@zhizhi/plugin-sdk';

/** 默认旋钮 —— 可被数据目录 `zhizhi.settings.json` 覆盖（cli 启动时调 configure()） */
const DEFAULT_IDLE_MS = 10 * 60_000; // 空闲满 10 分钟才算「你闲下来了」
const DEFAULT_INTERVAL_MS = 30 * 60_000; // 两次闲聊最少隔 30 分钟

/** 外壳喂来的空闲时长；undefined = 没人喂 → 闲聊自动静默（硬约束 ③） */
let idleMs: number | undefined = undefined;
/** 距上次闲聊的最小间隔（旋钮：闲聊间隔） */
let intervalMs = DEFAULT_INTERVAL_MS;
/** 空闲多久才算闲（旋钮：空闲阈值；它不是告警阈值，别混） */
let idleThresholdMs = DEFAULT_IDLE_MS;
/** 上次闲聊时刻 —— 插件自己的时间状态，自守卫（一个 tick 里会按 probe 数被调多次） */
let lastChitchatAt: number | undefined = undefined;
/** 用户点了「说说」—— 下一次 evaluate 立即开口（用户指令优先于空闲/间隔两个条件） */
let sayRequested = false;

export default defineRule({
  id: 'rule-chitchat',

  // 外壳每秒喂一次上下文；只认「非负数」，别的宁可不更新（不猜、不静默填错）
  onContext(ctx: ContextInput): void {
    if (typeof ctx['idleMs'] === 'number' && Number.isFinite(ctx['idleMs']) && ctx['idleMs'] >= 0) {
      idleMs = ctx['idleMs'];
    }
    if (ctx['requestSay'] === true) sayRequested = true;
  },

  // 内核下发配置：只认领自己认识的键，类型不对就保持默认（宁可默认也不填错值）
  configure(config: Readonly<Record<string, unknown>>): void {
    const interval = config['chitchatIntervalMs'];
    if (typeof interval === 'number' && Number.isFinite(interval) && interval > 0) {
      intervalMs = interval;
    }
    const idle = config['chitchatIdleMs'];
    if (typeof idle === 'number' && Number.isFinite(idle) && idle >= 0) {
      idleThresholdMs = idle;
    }
  },

  evaluate(): readonly ZhizhiEvent[] {
    const now = Date.now();

    // 用户点了「说说」：这是明确指令，优先于空闲/间隔两个条件 —— 立即开口。
    // 顺带把「上次闲聊」重置到现在：自动闲聊从这句话起重新计间隔。
    // ⚠️ 只消费一次（evaluate 一个 tick 会被调多次，第一调消费掉，其余不再触发）。
    if (sayRequested) {
      sayRequested = false;
      lastChitchatAt = now;
      return [makeChitchat(now)];
    }

    // 硬约束 ③：没人喂上下文 → 沉默。不是出错，是「不知道你闲不闲，所以不说」
    if (idleMs === undefined) return [];
    if (idleMs < idleThresholdMs) return []; // 你还忙着呢，不打扰
    if (lastChitchatAt !== undefined && now - lastChitchatAt < intervalMs) return []; // 刚聊过

    lastChitchatAt = now;
    return [makeChitchat(now)];
  },
});

function makeChitchat(ts: number): ZhizhiEvent {
  return {
    id: `chitchat@${ts}`,
    type: 'chitchat',
    severity: 'info', // 「多要紧」的正确归类：critical=出事 / warn=不对劲 / info=就是说说
    kind: 'chitchat', // 内核据此绕闸门、走 dispatcher（决策 #22）
    metrics: [], // 闲聊没有指标证据 —— 所以更不能进告警闸门（threshold 会拦空口报）
    ts,
    // summary 是兜底描述：没有台词包时，只只用它说话（降级，不是故障）
    summary: '（闲聊）你歇着呢，我陪你待会儿。',
  };
}
