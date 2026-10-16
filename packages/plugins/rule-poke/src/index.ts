/**
 * rule-poke —— 戳着玩规则（官方插件，M4-b1 前置 · 决策 #34）
 *
 * 分工抄 `idleMs` 那个现成模式：**外壳喂事实，内核做裁决。**
 *
 *   外壳：每次点球 → 立刻抖一下（L1，它自己的事）＋ 往 stdin 发 {"poked":1}（只报事实）
 *   内核：累计 → 随机阈值（3~7）→ 达标产出 poked 事件 → persona 挑台词 → 标准出口（L3）
 *   外壳：收到 type poked 的 eventId → 它自己躲开（L4，它自己的事）
 *
 * 四条硬约束（缺一个都会做坏）：
 *   ① 玩伴不做裁判 —— 台词不许有"计数"或"制止"的味道（台词在 persona.json）
 *   ② **阈值必须随机（3~7）、不许写死** —— 写死会被摸出来，还会退化成"刷触发"
 *   ③ 静音 = 关"说"不关"动"（抖与挪是外壳的事，本规则只管"说"这一半）
 *   ④ 动作归外壳、说话归内核
 *
 * 与闲聊（rule-chitchat）的两条边界：
 *   · **不受 trust < 10 压制** —— 同 `say@` 的道理：用户主动来玩，压掉 = 把玩的入口关死
 *   · **不占每日上限** —— 每日上限是「自动闲聊」的额度；戳是用户自己动手，天然有限
 */

import { defineRule } from '@zhizhi/plugin-sdk';
import type { ContextInput, ZhizhiEvent } from '@zhizhi/plugin-sdk';

/** 累计的戳击数（外壳每报一次事实 +1；回应后归零重计） */
let pokes = 0;

/** 本次回应需要的戳击数 —— **随机 3~7**（硬约束 ②），回应后重抽 */
let threshold = drawThreshold();

function drawThreshold(): number {
  // 3 + rand(0..4) → 3~7。⚠️ 别改成常量：写死会被摸出来，玩两下就退化成刷触发
  return 3 + Math.floor(Math.random() * 5);
}

export default defineRule({
  id: 'rule-poke',

  // 外壳每点一下报一次事实；只认正数（宁可不记也不记错）
  onContext(ctx: ContextInput): void {
    if (typeof ctx['poked'] === 'number' && Number.isFinite(ctx['poked']) && ctx['poked'] > 0) {
      pokes += 1;
    }
  },

  evaluate(): readonly ZhizhiEvent[] {
    // 还没戳够它忍的次数 —— 「不知道你闲不闲，所以不说」同款的安静，不是出错
    if (pokes < threshold) return [];

    pokes = 0;
    threshold = drawThreshold(); // 回应完重抽 —— 每轮的忍耐度都不一样

    const ts = Date.now();
    return [
      {
        id: `poked@${ts}`,
        type: 'poked',
        severity: 'info', // 「多要紧」的正确归类：就是玩玩
        kind: 'poked', // 内核据此绕闸门、走 dispatcher（决策 #22 同款）
        metrics: [], // 玩闹没有指标证据 —— 更不能进告警闸门
        ts,
        // summary 是兜底描述：没有台词包时，只只用它说话（降级，不是故障）
        summary: '（被戳了好多下）哎哟。',
      },
    ];
  },
});
