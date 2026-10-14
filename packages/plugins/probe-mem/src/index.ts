/**
 * probe-mem —— 内存占用采集（官方插件）
 *
 * ⚠️ 铁律②：官方插件也用 plugin-sdk 写，不许有任何内核特权。
 * ⚠️ 零依赖：只用 node:os。
 */

import { freemem, totalmem } from 'node:os';
import { defineProbe } from '@zhizhi/plugin-sdk';

const GB = 1024 ** 3;
const round = (n: number, digits = 2): number => Number(n.toFixed(digits));

export default defineProbe({
  id: 'probe-mem',

  sample() {
    const ts = Date.now();
    const total = totalmem();
    const free = freemem();
    const used = total - free;

    return [
      { key: 'mem.usage', value: round((used / total) * 100, 1), unit: '%', ts },
      { key: 'mem.used', value: round(used / GB), unit: 'GB', ts },
      { key: 'mem.total', value: round(total / GB), unit: 'GB', ts },
    ];
  },
});
