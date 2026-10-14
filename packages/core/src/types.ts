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
  /** 事件类型：mem.high / disk.tight / proc.suspicious，persona 按它挑台词 */
  readonly type: string;
  readonly severity: Severity;
  /** 触发它的指标快照（用于归因与展示） */
  readonly metrics: readonly Metric[];
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
}

/** 台词 —— persona 的产出。纯数据，不是代码。 */
export interface Line {
  readonly text: string;
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

// ─────────────────────────────── 插件实例契约 ───────────────────────────────

/** probe（采集器）：产生指标 */
export interface Probe {
  readonly id: string;
  /** 采样一次；返回空数组表示「这次没什么可汇报的」 */
  sample(): readonly Metric[] | Promise<readonly Metric[]>;
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
}

/** persona（台词包）：事件 + 情境 → 台词 */
export interface Persona {
  readonly id: string;
  /** 给一个事件挑一句话；返回 undefined 表示「这次不说话」 */
  speak(event: ZhizhiEvent): Line | undefined;
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
