/**
 * @zhizhi/core · scheduler
 *
 * 调度器 —— 内核 7 样之一（绝不外放）。
 * 它决定「什么时候该看机器一眼」。
 *
 * M0 只实现「固定间隔 tick」；
 * 「连续 2 分钟超标才报」这类**条件触发**属于闸门（gates）的职责，留给 M2。
 */

import type { Logger } from './logger.ts';

export type TickHandler = (tick: number, now: number) => void | Promise<void>;

export class Scheduler {
  readonly intervalMs: number;
  readonly #handler: TickHandler;
  readonly #log: Logger;
  #timer: ReturnType<typeof setInterval> | undefined;
  #tick = 0;

  constructor(intervalMs: number, handler: TickHandler, log: Logger) {
    this.intervalMs = intervalMs;
    this.#handler = handler;
    this.#log = log;
  }

  get tick(): number {
    return this.#tick;
  }

  get running(): boolean {
    return this.#timer !== undefined;
  }

  start(): this {
    if (this.#timer !== undefined) return this;
    this.#timer = setInterval(() => {
      void this.#fire();
    }, this.intervalMs);
    return this;
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async #fire(): Promise<void> {
    this.#tick += 1;
    try {
      await this.#handler(this.#tick, Date.now());
    } catch (err) {
      // 一次 tick 出错不该让整个调度停摆
      this.#log.error(`第 ${this.#tick} 次 tick 抛错（已隔离，调度继续）`, err);
    }
  }
}
