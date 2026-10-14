/**
 * probe-cpu —— CPU 占用采集（官方插件）
 *
 * ⚠️ 铁律②：官方插件也用 plugin-sdk 写，不许有任何内核特权。
 * ⚠️ 零依赖：只用 node:os。
 *
 * 算法：CPU 占用率必须靠「两次采样的差值」算 —— 单次 os.cpus() 给的是
 * 自开机以来的累计时间，直接除会得到一个几乎不变的数字。
 */

import { cpus } from 'node:os';
import { defineProbe } from '@zhizhi/plugin-sdk';
import type { Metric } from '@zhizhi/plugin-sdk';

interface CoreTimes {
  readonly idle: number;
  readonly total: number;
}

const round = (n: number, digits = 1): number => Number(n.toFixed(digits));

function readCores(): CoreTimes[] {
  return cpus().map((core) => {
    const t = core.times;
    return {
      idle: t.idle,
      total: t.user + t.nice + t.sys + t.idle + t.irq,
    };
  });
}

/** 模块加载时的快照，作为第一次采样的基准 */
let previous: CoreTimes[] = readCores();

export default defineProbe({
  id: 'probe-cpu',

  sample(): readonly Metric[] {
    const current = readCores();
    const ts = Date.now();

    let idleDelta = 0;
    let totalDelta = 0;
    const cores = Math.min(current.length, previous.length);

    for (let i = 0; i < cores; i += 1) {
      const cur = current[i];
      const prev = previous[i];
      if (!cur || !prev) continue;
      idleDelta += cur.idle - prev.idle;
      totalDelta += cur.total - prev.total;
    }

    previous = current;

    const usage = totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0;

    return [
      { key: 'cpu.usage', value: round(usage), unit: '%', ts },
      { key: 'cpu.cores', value: current.length, unit: 'count', ts },
    ];
  },
});
