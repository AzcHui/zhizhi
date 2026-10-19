/**
 * rule-chitchat —— 闲聊规则（官方插件，M6 立项 · M6-b 重构节奏）
 *
 * 它管的是「什么时候主动开口」，与告警**完全两回事**：
 *
 *   告警：机器出事了 → 忙时最有用   → 走阈值 + 四道闸门（内核的分寸系统）
 *   闲聊：你闲下来了 → 闲时才合适   → 节奏由只只**自己判断**（M6-b，决策 #18 改写）
 *
 * ⚠️ 硬约束（报表第三节，走歪了就白做）：
 *   ① **不得复用告警的阈值/闸门** —— 本插件产生的 chitchat 事件 `kind: 'chitchat'`：
 *      内核会**绕闸门、走 dispatcher**（决策 #22）。
 *   ② 闲聊本身**永不等模型** —— 模型台词走「预生成」，后台补进 learned.json。
 *   ③ **没外壳喂上下文 = 自动静默** —— `idleMs` 由外壳经反向通道喂进来；
 *      没人喂就不触发，但绝不报错（监控照常，与「空 loadout 降级」同一条原则）。
 *
 * ── M6-b · 发言节奏自控（决策 #18 改写）──────────────────────────────
 *
 *  用户手上只留两个键：**闲聊 开/关**（`chitchatEnabled`）＋ **话量档**
 *  （`chitchatVolume`：low / normal / high）。**间隔与空闲门槛归只只自管**：
 *
 *    · 间隔 = 按信任档位给 `[min,max]` 区间、**档内均匀随机**（不线性插值 ——
 *      「熟悉档 25~60 分钟」人一看就懂，插值出的「37.4 分钟」没人体会得到）。
 *    · 空闲门槛也按档位自管（越亲近越早来找你）。
 *    · **防聚集**：抽中值对**内核下限**取 max —— 不会连抽两个最短贴着说。
 *
 *  **内核双保险（宪法，不暴露给用户、也不该能设成 0）**：
 *    · **最短间隔** —— 任何抽中值低于它都被**抬到底线**；
 *    · **每日上限** —— 自动闲聊超过它当天就闭嘴（点名的 `say@` 不受此限 ——
 *      那是用户的明确指令，与 trust 门槛同一个道理）。
 *
 *  ⚠️ 旧键 `chitchatIntervalMs` / `chitchatIdleMs` **已下线**（cli 会告警并忽略）——
 *     「间隔旋钮的存在本身就是失败信号」：它说明只只自己管不好，得你来管。
 *
 *  🧪 `ZHIZHI_CHITCHAT_SCALE` 环境变量：**验收/调试专用**（地位同 cli 的 `--idle-ms`），
 *     等比缩放全部闲聊时距（区间 / 双保险 / 空闲门槛）。正常运行不设它。
 */

import { defineRule, trustTier } from '@zhizhi/plugin-sdk';
import type { ContextInput, ZhizhiEvent } from '@zhizhi/plugin-sdk';

// ── 待定项 #7 拍板的数值（2026-10-16，改手感只动这几行常量）──────────────

const MINUTE = 60_000; // 下面全部按「分钟」写，一眼能核对

/** 信任档位 → 自动闲聊间隔区间（分钟）。沉默档本就被内核压掉，这里给个兜底值 */
const TIER_GAP_MINUTES: Record<string, { min: number; max: number }> = {
  沉默: { min: 60, max: 120 },
  陌生: { min: 45, max: 90 },
  熟悉: { min: 25, max: 60 },
  亲近: { min: 12, max: 35 },
};

/** 信任档位 → 空闲门槛（分钟）：你多久没动，它才认为「你闲下来了」 */
const TIER_IDLE_MINUTES: Record<string, number> = {
  沉默: 20,
  陌生: 20,
  熟悉: 12,
  亲近: 8,
};

/** 话量档 → 区间缩放（少 ×2 说得少 ／ 多 ×0.5 说得多；告警与它无关） */
const VOLUME_SCALE: Record<string, number> = { low: 2, normal: 1, high: 0.5 };

/** 双保险 ①：最短间隔（分钟）—— 抽中值低于它一律抬到底线 */
const FLOOR_GAP_MINUTES = 10;
/** 双保险 ②：每日上限（本地日内的自动闲聊句数；say@ 点名不计） */
const DAILY_AUTO_LIMIT = 24;

// ── 运行时状态 ──

/** 外壳喂来的空闲时长；undefined = 没人喂 → 闲聊自动静默（硬约束 ③） */
let idleMs: number | undefined = undefined;
/** 内核注入的亲密度（M7 记忆）；没注入（无记忆的主机）按「熟悉」对待 */
let trust = 40;
/** 用户点了「说说」—— 下一次 evaluate 立即开口（用户指令优先于一切节奏条件） */
let sayRequested = false;

/** 外壳是否喂上过第一帧 context（greeting 触发条件：喂上才算「真活了」，内核自跑不算） */
let firstContextSeen = false;
/** 启动招呼只说一次（同进程内） */
let greeted = false;

/** 闲聊开/关（用户手上唯一必有的键；**关 = 连点名也不说** —— 零歧义） */
let enabled = true;
/** 话量档 */
let volume = 'normal';

/** 下次自动闲聊允许的时刻（上次开口 + 抽中的间隔）；undefined = 还没开过口 */
let nextAllowedAt: number | undefined = undefined;
/** 每日上限计数（本地日；跨天清零） */
let autoCountDay = '';
let autoCount = 0;

/** 验收/调试缩放（环境变量，默认 1 = 真实节奏） */
function timeScale(): number {
  const raw = Number(process.env['ZHIZHI_CHITCHAT_SCALE']);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/** 本地时区的今天，`YYYY-MM-DD`（跨天判定用） */
function localDay(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** 当前档位下（含话量档与验收缩放）的间隔区间，分钟 → ms */
function gapRangeMs(): { min: number; max: number } {
  const base = TIER_GAP_MINUTES[trustTier(trust)] ?? TIER_GAP_MINUTES['熟悉']!;
  const vol = VOLUME_SCALE[volume] ?? 1;
  const s = timeScale();
  return { min: base.min * vol * MINUTE * s, max: base.max * vol * MINUTE * s };
}

/** 抽一个间隔：档内均匀随机，再对内核下限取 max（防聚集 —— 不会连抽最短贴着说） */
function drawGapMs(): number {
  const { min, max } = gapRangeMs();
  const drawn = min + Math.random() * (max - min);
  const floor = FLOOR_GAP_MINUTES * MINUTE * timeScale();
  return Math.max(drawn, floor);
}

/** 当前档位的空闲门槛（ms） */
function idleThresholdMs(): number {
  const base = TIER_IDLE_MINUTES[trustTier(trust)] ?? TIER_IDLE_MINUTES['熟悉']!;
  return base * MINUTE * timeScale();
}

export default defineRule({
  id: 'rule-chitchat',

  // 外壳每秒喂一次上下文；只认「非负数」，别的宁可不更新（不猜、不静默填错）
  onContext(ctx: ContextInput): void {
    firstContextSeen = true;   // greeting 触发条件：第一帧 context 到了（在这里只记状态，事件统一在 evaluate 产）
    if (typeof ctx['idleMs'] === 'number' && Number.isFinite(ctx['idleMs']) && ctx['idleMs'] >= 0) {
      idleMs = ctx['idleMs'];
    }
    if (typeof ctx['trust'] === 'number' && Number.isFinite(ctx['trust']) && ctx['trust'] >= 0) {
      trust = ctx['trust'];
    }
    if (ctx['requestSay'] === true) sayRequested = true;
  },

  /**
   * 内核下发配置（M6-b 起只认领两个用户键）。
   * ⚠️ `chitchatIntervalMs` / `chitchatIdleMs` 已下线 —— cli 检测到会告警并拦下，
   *    这里**故意不读**它们（双保险不该能被 settings 绕开）。
   */
  configure(config: Readonly<Record<string, unknown>>): void {
    if (typeof config['chitchatEnabled'] === 'boolean') {
      enabled = config['chitchatEnabled'];
    }
    const vol = config['chitchatVolume'];
    if (typeof vol === 'string' && VOLUME_SCALE[vol] !== undefined) {
      volume = vol;
    }
  },

  evaluate(): readonly ZhizhiEvent[] {
    const now = Date.now();

    // 用户点了「说说」：明确指令，优先于一切节奏条件（开关关着也不理 —— 关就是关，
    // 零歧义；想让它说一句就把开关打开）。顺带把自动节奏的时钟从这句话重起。
    if (sayRequested) {
      sayRequested = false;
      if (!enabled) return [];
      nextAllowedAt = now + drawGapMs();
      return [makeChitchat(now, true)];
    }

    // M4-b2 插队「greeting 启动打招呼」：外壳喂上第一帧 context 才算「真活了」，同进程只说一次。
    // ⚠️ 排在 sayRequested 之后 —— 点名比「我起来了」更急，同一次 tick 点名优先；
    // ⚠️ 不碰 nextAllowedAt —— 别把自动闲聊的时钟带着重置；
    // ⚠️ 不判 enabled —— 闲聊开关关着也该说「我起来了」，它是启动告知不是闲聊；
    // ⚠️ 不占每日上限、不判 idle 门槛（启动那一刻你必然在动，受门槛就永远打不出来）；
    //    trust<10 放行与 muteUntil 照压都由 cli 在分流处判 —— 统一一处，rule 不重复。
    if (firstContextSeen && !greeted) {
      greeted = true;
      return [makeGreeting(now)];
    }

    if (!enabled) return [];

    // 硬约束 ③：没人喂上下文 → 沉默。不是出错，是「不知道你闲不闲，所以不说」
    if (idleMs === undefined) return [];
    if (idleMs < idleThresholdMs()) return []; // 你还忙着呢，不打扰
    if (nextAllowedAt !== undefined && now < nextAllowedAt) return []; // 还没到它自己定的点儿

    // 双保险 ②：每日上限（自动闲聊；跨天清零；say@ 点名不占额度）
    const today = localDay(new Date(now));
    if (today !== autoCountDay) {
      autoCountDay = today;
      autoCount = 0;
    }
    if (autoCount >= DAILY_AUTO_LIMIT) return [];

    autoCount += 1;
    nextAllowedAt = now + drawGapMs();
    return [makeChitchat(now, false)];
  },
});

function makeChitchat(ts: number, isUserRequested: boolean): ZhizhiEvent {
  return {
    // `say@` = 用户点名的（内核的亲密度门槛不压它）；`chitchat@` = 自己找话说的
    id: `${isUserRequested ? 'say' : 'chitchat'}@${ts}`,
    type: 'chitchat',
    severity: 'info', // 「多要紧」的正确归类：critical=出事 / warn=不对劲 / info=就是说说
    kind: 'chitchat', // 内核据此绕闸门、走 dispatcher（决策 #22）
    metrics: [], // 闲聊没有指标证据 —— 所以更不能进告警闸门（threshold 会拦空口报）
    ts,
    // summary 是兜底描述：没有台词包时，只只用它说话（降级，不是故障）
    summary: '（闲聊）你歇着呢，我陪你待会儿。',
  };
}

/** M4-b2 插队「greeting 启动打招呼」：kind 复用 chitchat（绕闸门 + 走 dispatcher，内核零改动），
 *  eventId/type 用 greeting —— persona 按它挑台词、cli 按前缀放行沉默档。 */
function makeGreeting(ts: number): ZhizhiEvent {
  return {
    id: `greeting@${ts}`,
    type: 'greeting',
    severity: 'info',
    kind: 'chitchat',
    metrics: [],
    ts,
    // 止血（监工 2026-10-19）：兜底文案也要有人味 —— 带括号前缀是机器日志味，
    // greeting 只有 5 句，台词耗尽走兜底时用户会愣一下。
    summary: '我起来了。',
  };
}
