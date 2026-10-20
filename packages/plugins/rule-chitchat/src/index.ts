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
 * ── M11-a2 · 二·AA：判定整个翻转 ——「闹钟 ＋ 等你回来」（2026-10-20 用户拍板）──────
 *
 *  旧判定 `idleMs < 门槛 → 闭嘴` 是**反的**：打字的人 idleMs 恒 0 → 永不出声；
 *  走开吃饭 idleMs 巨大 → 正好在空房间里自言自语。它不是在身边说话，是在空房间自言自语。
 *
 *  新语义：**「到点」是唯一触发条件，「你在不在」只决定现在说还是等你回来说。**
 *
 *    ① 点名 sayRequested / greeting        → 原样保留，最高优先
 *    ② 开关关 / 没喂 idleMs                → 沉默（硬约束 ③ 不变）
 *    ③ now < dueAt                         → 什么都不做
 *    ④ 到点了 ├─ idleMs >= 门槛 → pendingSince = now，挂起（你在离开 → 攒着）
 *             └─ idleMs <  门槛 → 现在就说（你在场 → 到点就说）
 *    ⑤ 挂起中 └─ prevIdleMs >= 门槛 && idleMs < 门槛（**跨越**）→ 现在就说，否则继续等
 *    ⑥ 说完：dueAt = now + drawGapMs()；pendingSince = undefined
 *
 *  ⚠️ 六个易错点（开工单第八节，踩一个就白做）：
 *    1. prevIdleMs 在 onContext 更新（evaluate 每 300ms / onContext 每 1000ms，频率不同）
 *    2. pendingSince 只攒 1 句 —— 单个时间戳不是队列，离开 8 小时回来也只说 1 句
 *    3. idleMs === undefined 不许兜底 0（硬约束 ③）
 *    4. 「回来了」用跨越判定，不能用「现在 idle 小」—— 否则一直在场也判成刚回来
 *    5. 每日上限必须和间隔一起提（熟悉档 30 句/天会被 24 硬砍 = 白调）
 *    6. 攒话 ≥30 分钟回来 → type = chitchat_back（「你回来了」专用池）
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

/** 信任档位 → 自动闲聊间隔区间（分钟）。沉默档本就被内核压掉，这里给个兜底值。
 *  M11-a2 二·AA 下调（「活跃」：用户原话「一天才 10 几句闲聊我都嫌少」） */
const TIER_GAP_MINUTES: Record<string, { min: number; max: number }> = {
  沉默: { min: 90, max: 150 },
  陌生: { min: 35, max: 60 },
  熟悉: { min: 15, max: 25 },
  亲近: { min: 8, max: 18 },
};

/** 信任档位 → 空闲门槛（分钟）：**语义已变**（M11-a2）——
 *  不再是「你得多闲我才说」，而是「你离开多久我开始攒话」。数值保持不变 */
const TIER_IDLE_MINUTES: Record<string, number> = {
  沉默: 20,
  陌生: 20,
  熟悉: 12,
  亲近: 8,
};

/** 话量档 → 区间缩放（少 ×2 说得少 ／ 多 ×0.5 说得多；告警与它无关）
 *  ⚠️ 嫌吵调这个，别动间隔常量 —— 间隔是节奏，话量才是用户的音量旋钮（开工单第四节） */
const VOLUME_SCALE: Record<string, number> = { low: 2, normal: 1, high: 0.5 };

/** 双保险 ①：最短间隔（分钟）—— 抽中值低于它一律抬到底线。
 *  M11-a2：10 → 5，否则亲近档的 8 分钟被抬到 10，梯度被压平 */
const FLOOR_GAP_MINUTES = 5;
/** 双保险 ②：每日上限（本地日内的自动闲聊句数；say@ 点名不计）。
 *  M11-a2：24 → 48 —— 必须和间隔一起改，否则熟悉档 30 句/天被砍到 24，等于白调 */
const DAILY_AUTO_LIMIT = 48;

/** 攒话多久回来算「你回来了」（分钟）→ 走 chitchat_back 专用池（开工单第六节） */
const BACK_POOL_MINUTES = 30;

// ── 运行时状态 ──

/** 外壳喂来的空闲时长；undefined = 没人喂 → 闲聊自动静默（硬约束 ③）
 *  ⚠️ 不许兜底成 0 ——「没人喂」和「你在动」是两码事（易错点 3） */
let idleMs: number | undefined = undefined;
/** 上一帧 idle（判「回来了」的跨越用）—— **只在 onContext 里更新**（易错点 1：
 *  evaluate 每 300ms、onContext 每 1000ms，在 evaluate 里更新会同一秒内重复判「回来了」） */
let prevIdleMs: number | undefined = undefined;
/** 前台窗口分类（五值枚举；undefined = 没喂）—— 显式写类型，`typeof` 查询在此处有收窄怪癖 */
type FgClass = 'meeting' | 'fullscreen' | 'code' | 'browser' | 'unknown' | undefined;

/**
 * 🆕 M11-b1（二·AB）：前台窗口分类（外壳 C# 侧分完类只传枚举 —— **标题原文永远不出外壳**，
 * 结构上保证内核拿不到）。undefined = 旧外壳没喂 → busy 恒 false，判定与 M11-a2 逐字等价。
 */
let foreground: FgClass = undefined;
/** 上一帧前台分类（合成 prevBlocked 用）—— **只在 onContext 里更新**（易错点 6，同 prevIdleMs 的坑） */
let prevForeground: FgClass = undefined;
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
/** cli 下发的日志出口（M11-a2：攒话/到点这类状态变化必须可观测 —— 验收② 就靠它） */
let logFn: ((msg: string) => void) | undefined = undefined;

/** 下次自动闲聊该说的时刻（上次开口 + 抽中的间隔；undefined = 还没开过口，启动后先重置）
 *  M11-a2 由 nextAllowedAt 改名 —— 语义从「允许说的最早时刻」变成「闹钟到点」 */
let dueAt: number | undefined = undefined;
/** 到点了但你不在 → 攒着的时刻。**单个时间戳只攒 1 句，不落盘**（易错点 2） */
let pendingSince: number | undefined = undefined;
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
      // M11-a2 易错点 1：旧值先进 prevIdleMs（判「回来了」的跨越基准），再收新值
      prevIdleMs = idleMs;
      idleMs = ctx['idleMs'];
    }
    if (typeof ctx['trust'] === 'number' && Number.isFinite(ctx['trust']) && ctx['trust'] >= 0) {
      trust = ctx['trust'];
    }
    // M11-b1（二·AB）易错点 6：prevForeground 同款纪律 —— 旧值先存，再收新值
    //（cli 已做白名单校验，这里只认 5 个枚举值；没喂 = undefined = busy 恒 false）
    const fg = ctx['foreground'];
    if (fg === 'meeting' || fg === 'fullscreen' || fg === 'code' || fg === 'browser' || fg === 'unknown') {
      prevForeground = foreground;
      foreground = fg;
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
    // M11-a2：cli 递进来的日志出口（probe 同款纪律 —— 有就接，没有照样跑）
    if (typeof config['log'] === 'function') logFn = config['log'] as (msg: string) => void;
  },

  evaluate(): readonly ZhizhiEvent[] {
    const now = Date.now();

    // 用户点了「说说」：明确指令，优先于一切节奏条件（开关关着也不理 —— 关就是关，
    // 零歧义；想让它说一句就把开关打开）。顺带把自动节奏的时钟从这句话重起。
    if (sayRequested) {
      sayRequested = false;
      if (!enabled) return [];
      dueAt = now + drawGapMs();
      return [makeChitchat(now, true, 'chitchat')];
    }

    // M4-b2 插队「greeting 启动打招呼」：外壳喂上第一帧 context 才算「真活了」，同进程只说一次。
    // ⚠️ 排在 sayRequested 之后 —— 点名比「我起来了」更急，同一次 tick 点名优先；
    // ⚠️ 说完顺手把闹钟上好 —— 否则 M11-a2「在场到点就说」会让它启动 1 秒后紧接着又来一句闲聊；
    // ⚠️ 不判 enabled —— 闲聊开关关着也该说「我起来了」，它是启动告知不是闲聊；
    // ⚠️ 不占每日上限、不判 idle 门槛（启动那一刻你必然在动，受门槛就永远打不出来）；
    //    trust<10 放行与 muteUntil 照压都由 cli 在分流处判 —— 统一一处，rule 不重复。
    if (firstContextSeen && !greeted) {
      greeted = true;
      dueAt = now + drawGapMs();
      return [makeGreeting(now)];
    }

    if (!enabled) return [];

    // 硬约束 ③：没人喂上下文 → 沉默。不是出错，是「不知道你在不在，所以不说」
    // ⚠️ 绝不兜底成 0（易错点 3）——「没人喂」和「你在动」是两码事
    if (idleMs === undefined) return [];

    // M11-a2 核心：闹钟 ＋ 等你回来（判定整个翻转 —— 旧代码是 `idle 小 → 闭嘴`，正好说反）
    // M11-b1（二·AB）：**blocked = busy || away**，与「你离开了」共用同一套机制，不新增分支 ——
    //   busy  = foreground ∈ {meeting, fullscreen}（开会/全屏 = 你暂时不在场；
    //           ⚠️ unknown **不构成 busy** —— 宁可多说一句，不要永远沉默，易错点 5）
    //   away  = idleMs >= 空闲门槛（现有逻辑，语义「你离开多久我开始攒」不变）
    // 不喂 foreground 时 busy 恒 false → 判定与 M11-a2 **逐字等价**（旧外壳零回归）
    const thresh = idleThresholdMs();
    const busy = foreground === 'meeting' || foreground === 'fullscreen';
    const blocked = busy || idleMs >= thresh;

    // ⑤ 挂起中：到过点、你不在（开会或离开）→ 只等**回来**（跨越判定，易错点 4 ——
    //    不能用「现在在场」判，否则一直在场也判成刚回来，pendingSince 永远清不掉）
    if (pendingSince !== undefined) {
      const prevBusy = prevForeground === 'meeting' || prevForeground === 'fullscreen';
      const prevAway = prevIdleMs !== undefined && prevIdleMs >= thresh;
      const prevBlocked = prevBusy || prevAway;
      const crossed = prevBlocked && !blocked;
      if (!crossed) return [];   // 还没回来，继续攒（1 句封顶，攒多久都只这一句）
      return sayNow(now);        // 跨越 = 你回来了（散会/切回/动鼠标）→ 立刻说攒着的那句
    }

    // ③ 还没到它自己定的点儿 → 什么都不做
    if (dueAt !== undefined && now < dueAt) return [];

    // ④ 到点了：你不在（busy 或离开）→ 攒着等你回来；你在场 → 现在就说
    if (blocked) {
      const why = busy ? `前台=${foreground}` : `idle=${Math.round(idleMs / 1000)}s ≥ 门槛`;
      pendingSince = now;        // 只在第一次到点时记（不覆盖 —— 只攒 1 句，易错点 2）
      logFn?.(`闲聊到点但你在忙（${why}）→ 攒着，等你回来再说`);
      return [];
    }
    return sayNow(now);          // 你在场 + 到点 → 现在就说（这正是「无论你在干嘛，想说话就说话」）
  },
});

/** 真正开口：每日上限 → 产事件 → 重置闹钟与攒话状态（开工单判定表 ⑥） */
function sayNow(now: number): readonly ZhizhiEvent[] {
  // 双保险 ②：每日上限（自动闲聊；跨天清零；say@ 点名不占额度）。
  // ⚠️ 超限时把攒话一并放弃（额度就是「今天说到这儿」—— 回来那拍说完昨天攒的反而吓人）
  const today = localDay(new Date(now));
  if (today !== autoCountDay) {
    autoCountDay = today;
    autoCount = 0;
  }
  if (autoCount >= DAILY_AUTO_LIMIT) {
    pendingSince = undefined;
    return [];
  }

  // 攒话 ≥30 分钟回来 →「你回来了」专用池（开工单第六节分流线）
  const type = pendingSince !== undefined && now - pendingSince >= BACK_POOL_MINUTES * MINUTE * timeScale()
    ? 'chitchat_back'
    : 'chitchat';

  autoCount += 1;
  dueAt = now + drawGapMs();
  pendingSince = undefined;
  return [makeChitchat(now, false, type)];
}

function makeChitchat(ts: number, isUserRequested: boolean, type: 'chitchat' | 'chitchat_back'): ZhizhiEvent {
  return {
    // `say@` = 用户点名的（内核的亲密度门槛不压它）；`chitchat@` = 自己找话说的
    id: `${isUserRequested ? 'say' : 'chitchat'}@${ts}`,
    // type 决定 persona 挑哪个池：chitchat（在场闲话）/ chitchat_back（离开 ≥30 分钟回来，M11-a2）
    type,
    severity: 'info', // 「多要紧」的正确归类：critical=出事 / warn=不对劲 / info=就是说说
    kind: 'chitchat', // 内核据此绕闸门、走 dispatcher（决策 #22）
    metrics: [], // 闲聊没有指标证据 —— 所以更不能进告警闸门（threshold 会拦空口报）
    ts,
    // summary 是兜底描述：没有台词包时，只只用它说话（降级，不是故障）
    summary: type === 'chitchat_back' ? '（你回来了）回来了？我一直在。' : '（闲聊）你忙着呢，我陪你待会儿。',
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
