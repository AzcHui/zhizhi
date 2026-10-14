/**
 * probe-disk —— 磁盘空间采集（官方插件）
 *
 * ⚠️ 铁律②：官方插件也用 plugin-sdk 写，不许有任何内核特权。
 * ⚠️ 零依赖：node:fs/promises 的 statfs（Windows 实测可用）。
 *
 * 盘符列表 M0 先写死；等 S2（数据外置）时改成配置项。
 * 某个盘不存在（拔了移动盘 / 盘符没分配）会抛错 —— 跳过即可，不算异常。
 */

import { statfs } from 'node:fs/promises';
import { defineProbe } from '@zhizhi/plugin-sdk';
import type { Metric } from '@zhizhi/plugin-sdk';

const DRIVES = ['C:\\', 'D:\\', 'E:\\'] as const;
const GB = 1024 ** 3;
const round = (n: number, digits = 1): number => Number(n.toFixed(digits));

export default defineProbe({
  id: 'probe-disk',

  async sample(): Promise<readonly Metric[]> {
    const ts = Date.now();
    const metrics: Metric[] = [];

    for (const drive of DRIVES) {
      try {
        const fs = await statfs(drive);
        const total = fs.blocks * fs.bsize;
        const free = fs.bavail * fs.bsize;
        if (total <= 0) continue;

        metrics.push(
          {
            key: 'disk.free',
            value: round(free / GB),
            unit: 'GB',
            ts,
            source: drive,
            meta: { drive },
          },
          {
            key: 'disk.usage',
            value: round((1 - free / total) * 100),
            unit: '%',
            ts,
            source: drive,
            meta: { drive },
          },
        );
      } catch {
        // 盘不存在 → 跳过。这是正常情况，不是错误，故不打扰用户
      }
    }

    return metrics;
  },
});
