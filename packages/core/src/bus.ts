/**
 * @zhizhi/core · bus
 *
 * 事件总线 —— 内核 7 样之一（绝不外放）。
 * 它是**插件之间的唯一通道**（铁律①）。把总线交出去 = 没人管秩序。
 */

import type { Logger } from './logger.ts';

export type Handler<T> = (payload: T) => void;

/** 内部收口用；真实类型由 topic 的调用双方约定，见 on/emit 的泛型 */
type AnyHandler = (payload: never) => void;

export class Bus {
  readonly #handlers = new Map<string, Set<AnyHandler>>();
  readonly #log: Logger;

  constructor(log: Logger) {
    this.#log = log;
  }

  /** 订阅；返回取消订阅函数 */
  on<T>(topic: string, handler: Handler<T>): () => void {
    let set = this.#handlers.get(topic);
    if (!set) {
      set = new Set<AnyHandler>();
      this.#handlers.set(topic, set);
    }
    const stored = handler as unknown as AnyHandler;
    set.add(stored);
    return () => {
      set.delete(stored);
    };
  }

  /**
   * 发布。单个订阅者抛错会被隔离 ——
   * 「插件崩溃不许带崩内核」在总线这一层也要守。
   */
  emit<T>(topic: string, payload: T): void {
    const set = this.#handlers.get(topic);
    if (!set || set.size === 0) return;
    for (const handler of [...set]) {
      try {
        (handler as unknown as Handler<T>)(payload);
      } catch (err) {
        this.#log.error(`订阅者处理 "${topic}" 时抛错（已隔离，其余订阅者继续）`, err);
      }
    }
  }

  /** 当前有哪些 topic 有人订阅（排查用） */
  topics(): string[] {
    return [...this.#handlers.keys()];
  }

  /** 清空所有订阅（主要给测试用） */
  clear(): void {
    this.#handlers.clear();
  }
}
