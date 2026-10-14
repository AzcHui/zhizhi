/**
 * @zhizhi/core · scheduler
 *
 * 调度器 —— 内核 7 样之一（绝不外放）。
 * 它决定「什么时候该看机器一眼」。
 *
 * 实现是**自调度**（`setTimeout` 链），不是 `setInterval`：
 *   `setInterval` 不管上一次 handler 有没有跑完就按固定节拍再触发，
 *   handler 一旦是 async（采样真的要读系统），慢的那次就会被下一次压上来，**tick 重叠**。
 *   自调度把「下一次」排在「这一次完成之后」，从根上杜绝重叠。
 *   代价：节拍会带上单次处理耗时（当前 2~3ms，相对 5000ms 可忽略）。
 */

import type { Logger } from './logger.ts';

export type TickHandler = (tick: number, now: number) => void | Promise<void>;

export class Scheduler {
  readonly intervalMs: number;
  readonly #handler: TickHandler;
  readonly #log: Logger;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #tick = 0;
  #running = false;

  constructor(intervalMs: number, handler: TickHandler, log: Logger) {
    this.intervalMs = intervalMs;
    this.#handler = handler;
    this.#log = log;
  }

  get tick(): number {
    return this.#tick;
  }

  get running(): boolean {
    return this.#running;
  }

  start(): this {
    if (this.#running) return this;
    this.#running = true;
    this.#schedule();
    return this;
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #schedule(): void {
    this.#timer = setTimeout(() => {
      void this.#fire();
    }, this.intervalMs);
  }

  async #fire(): Promise<void> {
    this.#tick += 1;
    try {
      await this.#handler(this.#tick, Date.now());
    } catch (err) {
      // 一次 tick 出错不该让整个调度停摆
      this.#log.error(`第 ${this.#tick} 次 tick 抛错（已隔离，调度继续）`, err);
    } finally {
      // ⭐ 关键：**等本次 handler 完成后**才排下一次 → 永不重叠。
      //    handler 里若调了 stop()（如跑满验收轮数），这里就不再续排。
      if (this.#running) this.#schedule();
    }
  }
}
