/**
 * @zhizhi/core · memory
 *
 * M7 · 记忆 + 亲密度 —— 内核的「长期记忆」。
 *
 * 与 store（进程内海马体）的分工：
 *   store   = 跨 tick 的时间状态（闸门的「第一次超标是什么时候」），进程死就没了
 *   memory  = **落盘**的长期状态（说过哪些话、说过多少次、跟你关系怎么样），重启还在
 *
 * 两个文件（都在 `<数据目录>/memory/` 下）：
 *   events.jsonl  事件日志：**说出口的**每一句话，一行一条 JSON（追加式；>1MB 轮转一轮 .old）
 *   trust.json    亲密度：0~100 的一个数字 + 最后互动的日子
 *
 * ⭐ 单一事实源：「某类型说过哪些话」「某类型是第几次」都从事件日志**派生**，
 *    不另设 said.json / count.json —— 有日志就有一切，少一份要同步的真相。
 *
 * 容错纪律（与 settings 相同，「宁可不记也不记错」）：
 *   文件不存在 = 第一次跑（正常）；JSON 坏 = 丢那条/整份、告警；**绝不因记忆崩内核**。
 *   写不进去（目录只读等）→ 记忆退化成进程内存活期，内核照常说话，告警一次不刷屏。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Logger } from './logger.ts';
import type { ZhizhiEvent } from './types.ts';

/** 单类型保留的「最近说过」条数 —— 够大，池子小的时候它就是全部历史 */
const SAID_KEEP_PER_TYPE = 60;

/** 事件日志超过这个大小就轮转（个人机一天说不了几句，1MB 很遥远） */
const LOG_ROTATE_BYTES = 1024 * 1024;

// ─────────────────────────────── 亲密度 ───────────────────────────────

/** 亲密度初始值：40 = 「熟悉」档 —— 刚认识的室友，不是陌生人也不是老友 */
export const TRUST_START = 40;
export const TRUST_MIN = 0;
export const TRUST_MAX = 100;
/** 原设计表（《互动与情绪价值功能评估》第七节）：和它对话 +2 · 每天不互动 -2 */
const TRUST_INTERACTION_BONUS = 2;
const TRUST_DAILY_DECAY = 2;

/**
 * 亲密度档位（表现差异见设计文档；M7 只兑现两处：闲聊门槛 + 状态区档位词）：
 *   0~9   沉默   只报警（功能性），几乎不说话
 *   10~39 陌生   冷淡、话少
 *   40~79 熟悉   正常、偶尔主动搭话
 *   80~100 亲近  话多、活泼、开始吐槽你
 */
export type TrustTier = '沉默' | '陌生' | '熟悉' | '亲近';

export function trustTier(trust: number): TrustTier {
  if (trust < 10) return '沉默';
  if (trust < 40) return '陌生';
  if (trust < 80) return '熟悉';
  return '亲近';
}

/** 本地时区的今天，`YYYY-MM-DD` —— 「每天 -2」的「天」按用户本地说了算 */
function localDay(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** 两个本地日之间隔了几天（都按本地时区的日历日算） */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00`);
  const b = Date.parse(`${to}T00:00:00`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

// ─────────────────────────────── 记忆本体 ───────────────────────────────

/** voice.ts 消费的记忆视图 —— 结构化接口，内核不把 Memory 类硬塞给挑句逻辑 */
export interface VoiceMemory {
  /** 这个类型**之前**说出口过几次（不含正在说的这次） */
  occurrence(type: string): number;
  /** 这句（模板）近期说过没有 —— 跨重启的「新鲜」判据 */
  isStale(type: string, key: string): boolean;
}

interface TrustFile {
  trust: number;
  lastActiveDay?: string;
}

export interface MemoryOptions {
  /** 数据目录（不是 memory 子目录 —— 子目录由这里自己拼，调用方少操心一层） */
  readonly dir: string;
  readonly log: Logger;
}

export class Memory {
  readonly #dir: string;
  readonly #log: Logger;
  readonly #eventsPath: string;
  readonly #trustPath: string;

  /** 该类型累计说过几次（从日志派生） */
  readonly #counts = new Map<string, number>();
  /** 该类型最近说过的模板（旧的在前、新的在后；超上限从头丢） */
  readonly #said = new Map<string, string[]>();
  #spokenTotal = 0;

  #trust: number = TRUST_START;
  #lastActiveDay: string | undefined = undefined;

  /** 写盘失败只告警一次 —— 每句话都告警就是刷屏，且内核行为不受影响 */
  #writeBroken = false;

  constructor(options: MemoryOptions) {
    this.#dir = resolve(options.dir, 'memory');
    this.#log = options.log;
    this.#eventsPath = resolve(this.#dir, 'events.jsonl');
    this.#trustPath = resolve(this.#dir, 'trust.json');

    this.#loadEvents();
    this.#loadTrust();
    this.#decayCheck();
  }

  // ── 启动装载 ──

  #loadEvents(): void {
    if (!existsSync(this.#eventsPath)) return; // 第一次跑，正常
    let bad = 0;
    try {
      const raw = readFileSync(this.#eventsPath, 'utf8');
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (t === '') continue;
        try {
          const obj = JSON.parse(t) as { type?: unknown; key?: unknown };
          if (typeof obj['type'] !== 'string' || typeof obj['key'] !== 'string') {
            bad += 1;
            continue;
          }
          this.#bump(obj['type'], obj['key']);
        } catch {
          bad += 1;
        }
      }
    } catch (err) {
      this.#log.warn(
        `事件日志读不动：${this.#eventsPath} —— 从零开始记（旧记忆弃用，内核照常运行）`,
        err instanceof Error ? err.message : err,
      );
      return;
    }
    if (bad > 0) {
      this.#log.warn(`事件日志里有 ${bad} 条读不懂（已跳过；不猜不错）`);
    }
  }

  #loadTrust(): void {
    if (!existsSync(this.#trustPath)) {
      // 第一次跑：冷却时钟从今天起算（明天起「不互动 -2」才开始记，安装日不算冷落）
      this.#lastActiveDay = localDay();
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(this.#trustPath, 'utf8')) as Partial<TrustFile> | null;
      if (raw === null || typeof raw !== 'object') throw new Error('顶层不是对象');
      if (typeof raw['trust'] === 'number' && Number.isFinite(raw['trust'])) {
        this.#trust = Math.min(TRUST_MAX, Math.max(TRUST_MIN, raw['trust']));
      }
      if (typeof raw['lastActiveDay'] === 'string') this.#lastActiveDay = raw['lastActiveDay'];
    } catch (err) {
      this.#log.warn(
        `亲密度文件读不动：${this.#trustPath} —— 整份忽略，回到初始值 ${TRUST_START}（内核照常运行）`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ── 事件日志：说话即记 ──

  #bump(type: string, key: string): void {
    this.#counts.set(type, (this.#counts.get(type) ?? 0) + 1);
    this.#spokenTotal += 1;
    const list = this.#said.get(type) ?? [];
    if (!list.includes(key)) {
      list.push(key);
      if (list.length > SAID_KEEP_PER_TYPE) list.splice(0, list.length - SAID_KEEP_PER_TYPE);
      this.#said.set(type, list);
    }
  }

  /**
   * 记下一句**说出口**的话（dispatcher 送出成功后才调 —— 压在闸门里的不算说过）。
   * 内存先记（保挑句正确），盘后补（写不进只告警）。
   */
  recordSpoken(event: ZhizhiEvent, key: string, text: string): void {
    this.#bump(event.type, key);

    if (this.#writeBroken) return;
    try {
      mkdirSync(this.#dir, { recursive: true });
      if (existsSync(this.#eventsPath) && statSync(this.#eventsPath).size > LOG_ROTATE_BYTES) {
        renameSync(this.#eventsPath, `${this.#eventsPath}.old`);
        this.#log.info('事件日志满 1MB，轮转为 events.jsonl.old（从头记）');
      }
      const entry = { ts: Date.now(), type: event.type, kind: event.kind, severity: event.severity, key, text };
      appendFileSync(this.#eventsPath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (err) {
      this.#writeBroken = true;
      this.#log.warn(
        `事件日志写不进去：${this.#eventsPath} —— 记忆退化成进程内存活期（重启清零），内核照常运行`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ── 亲密度 ──

  get trust(): number {
    return this.#trust;
  }

  get tier(): TrustTier {
    return trustTier(this.#trust);
  }

  get spokenTotal(): number {
    return this.#spokenTotal;
  }

  /** 用户主动互动（点「说说」）—— 原设计表「和它对话 +2」 */
  recordInteraction(): void {
    this.#decayCheck(); // 先把欠的衰减结清，再加今天的互动分
    const before = this.#trust;
    this.#trust = Math.min(TRUST_MAX, this.#trust + TRUST_INTERACTION_BONUS);
    this.#lastActiveDay = localDay();
    this.#saveTrust();
  }

  /**
   * 每天不互动 -2 —— 结账口径：从「最后互动日」到今天，隔了几天就减几个 2。
   * 结完把 lastActiveDay 推进到今天（当天再查 = 隔 0 天 = 幂等，随便谁什么时候调都行）。
   * ⚠️ 别用「上次检查日」当基准 —— 那样「关机三天」的冷却就永远记不上账。
   */
  decayIfNewDay(): void {
    this.#decayCheck();
  }

  #decayCheck(): void {
    const today = localDay();
    const gap = this.#lastActiveDay === undefined ? 0 : daysBetween(this.#lastActiveDay, today);
    if (gap === 0) return;
    const before = this.#trust;
    this.#trust = Math.max(TRUST_MIN, this.#trust - TRUST_DAILY_DECAY * gap);
    this.#lastActiveDay = today;
    if (this.#trust !== before) {
      this.#log.info(`亲密度：${before} → ${this.#trust}（${gap} 天没互动，每天 -2）`);
      this.#saveTrust();
    }
  }

  #saveTrust(): void {
    if (this.#writeBroken) return;
    try {
      mkdirSync(this.#dir, { recursive: true });
      const file: TrustFile = { trust: this.#trust, ...(this.#lastActiveDay ? { lastActiveDay: this.#lastActiveDay } : {}) };
      writeFileSync(this.#trustPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    } catch (err) {
      this.#writeBroken = true;
      this.#log.warn(
        `亲密度写不进去：${this.#trustPath} —— trust 只在进程内有效（重启回档），内核照常运行`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ── voice 视图 ──

  /** 挑句用的记忆视图（occurrence 含本次：之前 N 次 + 这次 = 第 N+1 次） */
  get voice(): VoiceMemory {
    const self = this;
    return {
      occurrence: (type) => (self.#counts.get(type) ?? 0) + 1,
      isStale: (type, key) => (self.#said.get(type) ?? []).includes(key),
    };
  }
}
