/**
 * rule-poke —— 戳着玩规则（官方插件，M4-b1 前置 · 决策 #34 · M11-a2 二·AA 去古板）
 *
 * 分工抄 `idleMs` 那个现成模式：**外壳喂事实，内核做裁决。**
 *
 *   外壳：每次点球 → 立刻抖一下（L1，它自己的事）＋ 往 stdin 发 {"poked":1}（只报事实）
 *   内核：累计 → 随机阈值 → 达标产出事件 → persona 挑台词 → 标准出口（L3）
 *   外壳：收到 type poked_again 的 eventId → 它自己躲开（L4，它自己的事）
 *
 * ── M11-a2 · 二·AA：「戳烦了才躲」（用户定案，2026-10-20）────────────────
 *
 *  旧行为「每次达标都躲」太古板 —— 改成**递进**：
 *
 *    | 轮次         | 阈值（随 trust）    | 反应         | 台词池        |
 *    | 第 1 轮      | 陌生 2~4/熟悉 3~7/亲近 5~9 | 说话，**不躲** | `poked`      |
 *    | 第 2 轮及以后 | 同上                | 说话 ＋ 躲开 | `poked_again` |
 *    | 消气         | 5 分钟没戳          | 回到第 1 轮  | ——            |
 *
 *  ❌ 累积侧移已否决（用户：「不知道还以为是 bug」）——
 *     **沉淀：视觉上像 bug 的效果，再巧妙也别用。**
 *
 *  计数带衰减：每 8 秒没戳 pokes −1（不低于 0）—— 连戳它回应，慢戳它陪你玩。
 *
 * 四条硬约束（缺一个都会做坏）：
 *   ① 玩伴不做裁判 —— 台词不许有"计数"或"制止"的味道（台词在 persona.json）
 *   ② **阈值必须随机、不许写死** —— 写死会被摸出来，还会退化成"刷触发"
 *   ③ 静音 = 关"说"不关"动"（抖与挪是外壳的事，本规则只管"说"这一半）
 *   ④ 动作归外壳、说话归内核
 *
 * 与闲聊（rule-chitchat）的两条边界：
 *   · **不受 trust < 10 压制** —— 同 `say@` 的道理：用户主动来玩，压掉 = 把玩的入口关死
 *   · **不占每日上限** —— 每日上限是「自动闲聊」的额度；戳是用户自己动手，天然有限
 */

import { defineRule, trustTier } from '@zhizhi/plugin-sdk';
import type { ContextInput, ZhizhiEvent } from '@zhizhi/plugin-sdk';

const MINUTE = 60_000;

/** 戳计数衰减周期：每 8 秒没戳 −1（连戳它回应，慢戳它陪你玩 —— 二·AA 保留项②） */
const DECAY_INTERVAL_MS = 8_000;
/** 消气时长：5 分钟没戳 → 轮次回 1（「戳烦了才躲」的另一半 —— 它不记仇） */
const COOLDOWN_MS = 5 * MINUTE;

/** 信任档位 → 戳阈值区间（二·AA 保留项③：越亲近越耐戳） */
const TIER_POKE_THRESHOLD: Record<string, { min: number; max: number }> = {
  沉默: { min: 2, max: 4 },
  陌生: { min: 2, max: 4 },
  熟悉: { min: 3, max: 7 },
  亲近: { min: 5, max: 9 },
};

// ── 运行时状态 ──

/** 累计的戳击数（外壳每报一次事实 +1；回应后归零重计） */
let pokes = 0;
/** 最后一次戳的时刻（衰减与消气共用这一口钟） */
let lastPokeAt = 0;
/** 当前轮次：1 = 第 1 轮（不躲）；≥2 = 戳烦了（躲）。5 分钟没戳消气回 1 */
let round = 1;
/** 内核注入的亲密度（M7 记忆）；没注入按「熟悉」对待 —— 与 rule-chitchat 同款兜底 */
let trust = 40;

/** 本次回应需要的戳击数 —— 区间内**随机**（硬约束 ②），回应后按当前 trust 重抽 */
function drawThreshold(): number {
  const base = TIER_POKE_THRESHOLD[trustTier(trust)] ?? TIER_POKE_THRESHOLD['熟悉']!;
  const span = base.max - base.min + 1;
  return base.min + Math.floor(Math.random() * span);
}

/** 本轮的阈值（trust 变档时下次重抽自然跟上，这里只存当前值） */
let threshold = drawThreshold();

export default defineRule({
  id: 'rule-poke',

  // 外壳每点一下报一次事实；只认正数（宁可不记也不记错）。trust 顺带记账（阈值随档位）
  onContext(ctx: ContextInput): void {
    if (typeof ctx['poked'] === 'number' && Number.isFinite(ctx['poked']) && ctx['poked'] > 0) {
      pokes += 1;
      lastPokeAt = Date.now();
    }
    if (typeof ctx['trust'] === 'number' && Number.isFinite(ctx['trust']) && ctx['trust'] >= 0) {
      trust = ctx['trust'];
    }
  },

  evaluate(): readonly ZhizhiEvent[] {
    const now = Date.now();

    // 消气：戳烦了之后 5 分钟没戳 → 回到第 1 轮（它不记仇，明天照样陪你玩）
    if (round > 1 && lastPokeAt > 0 && now - lastPokeAt >= COOLDOWN_MS) {
      round = 1;
    }

    // 计数衰减：每 8 秒没戳 −1，不低于 0（二·AA 保留项② —— 慢戳也是玩，别一直记着）
    if (pokes > 0 && lastPokeAt > 0 && now - lastPokeAt >= DECAY_INTERVAL_MS) {
      const steps = Math.floor((now - lastPokeAt) / DECAY_INTERVAL_MS);
      pokes = Math.max(0, pokes - steps);
      lastPokeAt = now - ((now - lastPokeAt) % DECAY_INTERVAL_MS);   // 保留余数，衰减节奏不漂移
    }

    // 还没戳够它忍的次数 —— 安静，不是出错
    if (pokes < threshold) return [];

    pokes = 0;
    const wasFirstRound = round === 1;
    round = 2;                 // 回应过一轮 → 下一轮起就是「又来？」（第 2 轮及以后都躲）
    threshold = drawThreshold(); // 回应完重抽 —— 每轮的忍耐度都不一样（硬约束 ②）

    const ts = now;
    return [
      {
        id: `poked${wasFirstRound ? '' : '_again'}@${ts}`,
        // type 分流（M11-a2）：poked = 第 1 轮（外壳只说话不挪）；poked_again = 戳烦了（说话＋MoveAside）
        type: wasFirstRound ? 'poked' : 'poked_again',
        severity: 'info', // 「多要紧」的正确归类：就是玩玩
        kind: 'poked', // 内核据此绕闸门、走 dispatcher（决策 #22 同款）
        metrics: [], // 玩闹没有指标证据 —— 更不能进告警闸门
        ts,
        // summary 是兜底描述：没有台词包时，只只用它说话（降级，不是故障）
        summary: wasFirstRound ? '（被戳了好多下）哎哟。' : '（被戳烦了）行吧，我挪个地方。',
      },
    ];
  },
});
