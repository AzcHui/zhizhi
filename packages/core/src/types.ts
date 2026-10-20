/**
 * @zhizhi/core · types
 *
 * ⭐ 这是全项目**唯一**允许定义「跨插件数据结构」的地方。
 * 铁律①：插件之间禁止互相 import —— 它们共享的类型只能来自这里
 * （再由 plugin-sdk 转出去，插件侧只需依赖 plugin-sdk 一个包）。
 *
 * 判断标准：只要有两个插件需要看同一个字段，这个类型就必须住在这里。
 */

// ─────────────────────────────── 基础枚举 ───────────────────────────────

/** 内核日志级别 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 事件严重度 —— M2 分通道的依据（日常走弱通道，P0 才升级） */
export type Severity = 'info' | 'warn' | 'critical';

/**
 * 事件的性质（M6）—— 内核据此决定它走不走「告警的分寸系统」。
 *
 *   alert    告警（默认）：有指标证据、要过四道闸门（threshold/sustained/…）
 *   chitchat 闲聊：没有指标证据、天然只冒一次 → **绕闸门、不绕 dispatcher**
 *            （决策 #22：闸门是告警的分寸系统；dispatcher 是唯一出口，
 *             静默时段 / 每日上限这些宪法级机制都在出口那一侧管着它）
 */
export type EventKind = 'alert' | 'chitchat' | 'poked';

/** 6 类扩展点（不多不少） */
export type PluginType = 'probe' | 'rule' | 'persona' | 'channel' | 'action' | 'view';

/** 插件生命周期（铁律③：插件崩溃不许带崩内核） */
export type PluginStatus = 'discovered' | 'active' | 'failed';

// ─────────────────────────────── 数据契约 ───────────────────────────────

/**
 * 指标 —— probe 的产出。
 *
 * ⚠️ 指标是**数据**，不是文字。「说人话」是 persona 的活儿。
 * 这条边界守住了，采集层才能被复用（终端 / 浮窗 / 未来接别的 UI）。
 */
export interface Metric {
  /** 指标名，点分命名：cpu.usage / mem.used / disk.free */
  readonly key: string;
  /** 数值 */
  readonly value: number;
  /** 单位：% / GB / MB/s */
  readonly unit?: string;
  /** 采集时刻（epoch ms） */
  readonly ts: number;
  /** 归因：谁贡献的。「多少」是报警，「谁」才是帮助 */
  readonly source?: string;
  /** 附加结构信息（如磁盘盘符、CPU 核心号） */
  readonly meta?: Readonly<Record<string, string | number | boolean>>;
}

/** 一次采样中，某一个 probe 的全部产出 */
export interface MetricBatch {
  readonly probeId: string;
  readonly metrics: readonly Metric[];
}

/** 事件 —— rule 消费指标后的产出 */
export interface ZhizhiEvent {
  readonly id: string;
  /** 事件类型：mem.high / disk.tight / chitchat，persona 按它挑台词 */
  readonly type: string;
  readonly severity: Severity;
  /**
   * 事件的性质（M6）。不写 = `'alert'`。
   * 内核据此决定：告警走四道闸门，chitchat 绕闸门但**照样走 dispatcher**。
   */
  readonly kind?: EventKind;
  /** 触发它的指标快照（用于归因与展示；chitchat 没有指标证据，为空数组） */
  readonly metrics: readonly Metric[];
  /**
   * 🆕 M8-a：来源 probe 的 id（如 `probe-cpu`）—— 由产事件的 rule 填。
   * gates 的持续判定据此查「该事件的采样周期」（per-probe 调度后各 probe 间隔不同，
   * 统一 intervalMs 的口径已不存在）。闲聊类事件没有来源，可不填。
   */
  readonly sourceProbe?: string;
  /** 首次触发时刻（epoch ms） */
  readonly ts: number;
  /**
   * 客观描述（由 rule 生成，会带上具体数值，如「内存占用偏高：mem.usage 87.3%（阈值 >85）」）。
   *
   * 它**不是**台词 —— 人格化的说法是 persona 的活儿。
   * 内核在没有 persona 插件时用它兜底，装了 persona 之后就会被台词覆盖。
   */
  readonly summary?: string;
  /** 已被闸门压掉的次数（M2 冷却期用） */
  readonly suppressed?: number;
  /**
   * 🆕 M8-b：**瞬时事实事件**（如「检测到新增开机自启项」）—— 出现即成立，不是「连续超标的
   * 状态」。sustained（要攒持续时长）与 cooldown（同类型 15 分钟只报一次）的语义对它**不适用**
   * （哨兵一分钟内必须告警；两个新增项挨着发生也该各报各的）。置 true 后 gates 跳过这两道，
   * **threshold 证据校验照跑**（空口报照样拦）。不填 = 常规事件（默认走全四道）。
   */
  readonly ephemeral?: boolean;
}

/** 台词 —— persona 的产出。纯数据，不是代码。 */
export interface Line {
  readonly text: string;
  /**
   * 这句话的**模板原文**（占位符还没填的样子）—— M7 记忆去重的键。
   * ⚠️ 为什么不用 text 当键：`{value}` 每次都不同（CPU 95.4% / 96.1%），
   *    按填完的文本去重永远判「没说过」→ 第 7 次还会说同一句模板，记忆就白记了。
   * 台词包能带就带；不带时内核退回用 text 当键（纯动态生成的台词本来就无模板可言）。
   */
  readonly key?: string;
  /** 说这句话时的情绪标签：happy / tired / annoyed / sleepy */
  readonly mood?: string;
}

/**
 * 一条要发出去的消息。
 *
 * ⚠️ 这里**故意没有** `channel` 字段：走哪个通道是内核 dispatcher 的裁决，
 *    不是调用方（更不是插件）能自己选的事 —— 否则「分通道」这条纪律就形同虚设。
 */
export interface OutgoingMessage {
  readonly eventId: string;
  readonly text: string;
  readonly severity: Severity;
}

/**
 * 反馈 —— 用户对某一句话的反应。
 * ⚠️ 「评论」坚决不做自由输入，只用固定原因（打字成本高 100 倍，数据还更差）。
 */
export interface Feedback {
  readonly eventId: string;
  readonly vote: 'up' | 'down' | 'mute';
  readonly reason?: 'too_frequent' | 'wrong' | 'annoying';
  readonly ts: number;
}

/**
 * 上下文输入（M6）—— 外壳喂给内核的环境信息。
 *
 * ⚠️ 为什么它不算「键鼠监听」：`GetLastInputInfo` /
 *    `powerMonitor.getSystemIdleTime()` 只返回**一个数字**
 *    （最后一次用户输入距今多少毫秒），**根本不知道你按了什么**。
 *    与当初明确砍掉的键鼠钩子（记录按键内容）性质完全不同。
 *
 * 由外壳定期经**反向通道**（stdin 一行 JSON）喂进来；没有外壳喂 = 相应能力自动静默
 * （如闲聊不触发），但监控照常、不崩、不报错 —— 与 M5「空 loadout 降级」同一原则。
 */
export interface ContextInput {
  /** 最后一次用户输入距今多少毫秒（空闲时长） */
  readonly idleMs?: number;
  /**
   * 用户主动要求「现在说一句」（M6：浮窗「说说」按钮经反向通道发来）。
   * 这是**用户的明确指令**，不是遥测 —— 规则应立即安排一句（照常走 dispatcher 标准出口）。
   */
  readonly requestSay?: boolean;
  /**
   * 🆕 M6-b：当前亲密度（0~100）—— **内核注入**（来自 M7 记忆），不是外壳喂的。
   * 规则据此自管发言节奏（按信任档位给自己定间隔区间），而不是让用户调。
   */
  readonly trust?: number;
  /**
   * 🆕 M4-b2-a：「静一下」截止时刻（epoch ms；**0 = 未静音**）—— 外壳随 idleMs 一起喂，
   * 且**每秒都喂真值**（点「恢复」后内核不留旧的未来时刻）。
   * 口径：**只压「它自己开口」**—— cli 在 chitchat 分流处判 `now < muteUntil` 丢弃；
   * poked、告警、`say@` 点名一律不受影响（戳是玩、点名是明确指令，都不是它自己开口）。
   */
  readonly muteUntil?: number;
  /**
   * 🆕 M4-b1（决策 #34）：外壳报「球刚被点了一下」。
   * **只报事实** —— 要不要回应（抖 ／ 挪 ／ 说）由内核的规则裁决，外壳不自作主张。
   */
  readonly poked?: number;
  /**
   * 🆕 M11-b1（二·AB）：前台窗口的**分类结果**（外壳在 C# 侧分类完只传枚举）。
   * ⛔ 隐私红线（结构保证，不靠约定）：**窗口标题原文永远不出外壳** —— 传的是映射结果，
   * 内核根本拿不到标题，因此不可能泄漏。不喂 = `busy` 恒 false，判定与 M11-a2 逐字等价。
   */
  readonly foreground?: 'meeting' | 'fullscreen' | 'code' | 'browser' | 'unknown';
}

// ─────────────────────────────── 插件实例契约 ───────────────────────────────

/** probe（采集器）：产生指标 */
export interface Probe {
  readonly id: string;
  /** 采样一次；返回空数组表示「这次没什么可汇报的」 */
  sample(): readonly Metric[] | Promise<readonly Metric[]>;
  /**
   * 🆕 M8-b：可选，接收内核下发的启动配置（对称 `Rule.configure`）。
   * cli 会把 `dataDir`（用户数据目录路径）一并递进来 —— 需要持久化状态的 probe
   * （如哨兵的基线文件）从这里拿路径。只在启动时下发一次；抛错被隔离。
   */
  configure?(config: Readonly<Record<string, unknown>>): void;
  /**
   * 🆕 M8-b 补丁（二·V）：可选，通知 probe「接下来这几次 sample() 是校准试采」。
   * 校准实测不经总线（collect.ts 直调 sample() 只为测耗时），但有状态 probe 的
   * sample() 带副作用（如哨兵的基线对比/吸收）—— 不挂起的话，「关机期间新增的
   * 自启项」会在校准里被静默吸收，告警永远发不出去。无状态 probe 无需实现。
   */
  setCalibrating?(on: boolean): void;
}

/**
 * rule（判断规则）：消费指标 → 产生事件。
 *
 * ⚠️ 判定是**同步**的：它本质是纯计算（读指标、比阈值），没有 IO。
 *    让判定变成异步，会把事件顺序和闸门的状态搞成竞态 —— 那是自找的麻烦。
 *    （采集器 probe 之所以是异步的，是因为它要真的去读系统状态。）
 */
export interface Rule {
  readonly id: string;
  evaluate(batch: MetricBatch): readonly ZhizhiEvent[];
  /**
   * 可选：接收外壳喂来的上下文（M6，如 `idleMs`）。
   * 不实现 = 不关心上下文；内核转交时会把实现里的抛错隔离掉。
   */
  onContext?(ctx: ContextInput): void;
  /**
   * 可选：接收内核下发的配置（M6，来自数据目录的设置文件）。
   * 整份配置都递进来，插件只认领自己认识的键 —— 认领不到的保持默认。
   * 配置只在启动时下发一次；实现里的抛错同样会被隔离。
   */
  configure?(config: Readonly<Record<string, unknown>>): void;
  /**
   * 🆕 M8-a：本规则关心的**指标 key 列表**（如 `['cpu.usage', 'mem.usage']`）。
   * 可选 —— 启动报告据此计算「关掉某 probe 后哪些告警失效」（验收①：不静默失效）。
   * 不填 = 内核无法推断依赖，probe 被关时只按指标前缀约定（probe-x → `x.`）提示。
   */
  readonly watches?: readonly string[];
}

/** persona（台词包）：事件 + 情境 → 台词 */
export interface Persona {
  readonly id: string;
  /**
   * 给一个事件挑一句话；返回 undefined 表示「这次不说话」。
   *
   * ⭐ M6 起配合 core/voice.ts 的**三段式**挑句（三层台词池 user > 内置 > learned，决策 #20）：
   *   第一段（不带 options）—— 只挑该事件类型**专属**台词里「没说过」的；
   *     全用过或没这个类型 → 返回 undefined，把机会让给下一层。
   *   第二段（`{ useFallback: true }`）—— 只挑 `"*"` 兜底键里「没说过」的。
   *   第三段（`{ allowRepeat: true }`）—— 全都说过了，允许重复（宁可重复也不哑巴）。
   *
   * 这个顺序保证：模型补的专属台词（learned）能排在内置包的 `"*"` 兜底**前面**出场，
   * 否则兜底键会把下层整个挡死；不关心这些的实现（如写代码的台词包）忽略 options 即可。
   *
   * 🆕 M7 起 options 多一个 `isStale(key)`（内核有记忆时注入）——
   *    「说过」以**模板原文**为键、跨重启生效；见 `Line.key` 的说明。
   */
  speak(
    event: ZhizhiEvent,
    options?: {
      readonly allowRepeat?: boolean;
      readonly useFallback?: boolean;
      readonly isStale?: (key: string) => boolean;
    },
  ): Line | undefined;
}

/** channel（通道）：把一句话送去哪儿 */
export interface Channel {
  readonly id: string;
  /** 它愿意承载哪些严重度（分通道原则：弱互动与强提醒永不混用） */
  readonly sends: readonly Severity[];
  send(msg: OutgoingMessage): void | Promise<void>;
}

// ─────────────────────────────── 插件加载 ───────────────────────────────

/**
 * 插件没起来的三种原因 —— 之所以分开，是因为**处置方式完全不同**：
 *   missing → 没装 / 装不上     → 该提示用户「去装」
 *   invalid → 装上了但 manifest 不合规 → 该提示插件作者「去改」
 *   crashed → 装上了、合规，但加载时炸了 → 该提示插件作者「去修」
 *
 * 不分开的话，日志里只剩一句「加载失败」，等于没说。
 */
export type PluginFailureKind = 'missing' | 'invalid' | 'crashed';

/** 一次插件加载的结果（registry 产出，供内核如实报告，不静默吞错） */
export interface LoadOutcome {
  /** 插件自报的 id；若插件根本没起来，退化为清单里的 specifier */
  readonly id: string;
  readonly type: PluginType;
  readonly status: PluginStatus;
  /** status === 'failed' 时的失败分类 */
  readonly failureKind?: PluginFailureKind;
  /** status === 'failed' 时的具体原因（给人看的原话） */
  readonly error?: string;
}

/** 清单里的一条插件声明 */
export interface PluginSpec {
  /**
   * 包名（S3 之后这里会换成目录路径）。
   *
   * 📌 例外：`type: 'persona'` 时可以直接给一个 **`.json` 文件路径** ——
   *    那表示「纯数据台词包」（性格包不执行代码，见《人格系统与模型接入设计》第七节）。
   *    相对路径按当前工作目录解析，写绝对路径更稳。
   */
  readonly specifier: string;
  /** 期望的插件类型 —— 即使插件没起来，也要能如实记账 */
  readonly type: PluginType;
}
