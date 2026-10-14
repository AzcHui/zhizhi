/**
 * @zhizhi/core · registry
 *
 * 插件注册表 + 生命周期 —— 内核 7 样之一（绝不外放）。
 *
 * ⭐ 铁律③在这里落地：**插件崩溃不许带崩内核**。
 * 每个插件的初始化独立 try/catch，状态机 discovered → active → failed，
 * 任何一个插件炸了，其余插件和内核照常运行，并且**如实记录失败原因**。
 */

import type { Logger } from './logger.ts';
import type { LoadOutcome, PluginType, Probe } from './types.ts';

/** probe 插件的工厂形态 —— plugin-sdk 的 defineProbe() 产出的就是它 */
export type ProbeFactory = () => Probe;

export class Registry {
  readonly #probes = new Map<string, Probe>();
  readonly #outcomes: LoadOutcome[] = [];
  readonly #log: Logger;

  constructor(log: Logger) {
    this.#log = log;
  }

  /** 加载一个 probe 插件。失败会被隔离并记录，不抛出。 */
  registerProbe(id: string, factory: ProbeFactory): LoadOutcome {
    return this.#load(id, 'probe', () => {
      const probe = factory();
      this.#probes.set(id, probe);
    });
  }

  probe(id: string): Probe | undefined {
    return this.#probes.get(id);
  }

  probes(): readonly Probe[] {
    return [...this.#probes.values()];
  }

  probeIds(): string[] {
    return [...this.#probes.keys()];
  }

  outcomes(): readonly LoadOutcome[] {
    return this.#outcomes;
  }

  /** 加载失败的插件（cli 里用来提示「插件缺失」这类情况） */
  failed(): readonly LoadOutcome[] {
    return this.#outcomes.filter((o) => o.status === 'failed');
  }

  get activeCount(): number {
    return this.#probes.size;
  }

  #load(id: string, type: PluginType, run: () => void): LoadOutcome {
    let outcome: LoadOutcome;
    try {
      run();
      outcome = { id, type, status: 'active' };
      this.#log.info(`插件 ${id} 已激活`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      outcome = { id, type, status: 'failed', error };
      this.#log.error(`插件 ${id} 加载失败（已隔离，内核继续运行）：${error}`);
    }
    this.#outcomes.push(outcome);
    return outcome;
  }
}
