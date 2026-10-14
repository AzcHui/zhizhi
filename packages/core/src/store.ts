/**
 * @zhizhi/core · store
 *
 * 状态存储 —— 它的「海马体」（内核 7 样之一）。
 * 插件能直接写 = 记忆可被污染，所以它只对外暴露受控的 get/set。
 *
 * M0：仅内存。
 * S2（数据外置）阶段再落盘 JSON：事件日志 / 记忆 / 亲密度 trust。
 */

export class Store {
  readonly #data = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.#data.get(key) as T | undefined;
  }

  set<T>(key: string, value: T): void {
    this.#data.set(key, value);
  }

  has(key: string): boolean {
    return this.#data.has(key);
  }

  delete(key: string): boolean {
    return this.#data.delete(key);
  }

  keys(): string[] {
    return [...this.#data.keys()];
  }

  get size(): number {
    return this.#data.size;
  }

  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.#data);
  }
}
