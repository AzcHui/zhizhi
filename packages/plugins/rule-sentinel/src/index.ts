/**
 * rule-sentinel —— 安全哨兵规则（官方插件 · M8-b）
 *
 * 把 probe-sentinel 的自启项变化翻译成「值得说一句」的事件：
 *   新增自启项 → `sentinel.autorun`（warn · **ephemeral 瞬时事实** —— 出现即告，
 *                不攒持续、不进冷却：一分钟内必须出声，两个新增项挨着也各报各的）
 *   自启项消失 → `sentinel.autorunGone`（info —— 可能是正常卸载，也可能是恶意清理痕迹）
 *
 * summary 必须带**谁**（名称）与**从哪来**（命令）——「多少」是报警，「谁」才是帮助。
 * persona 没接之前，说话用的就是这段客观描述（降级，不是故障）。
 */

import { defineRule } from '@zhizhi/plugin-sdk';
import type { Metric, MetricBatch, ZhizhiEvent } from '@zhizhi/plugin-sdk';

/** 从指标 meta 里取人话描述（名称 + 命令） */
function describe(m: Metric): string {
  const name = typeof m.meta?.['name'] === 'string' ? m.meta['name'] : m.source ?? '（未知名称）';
  const command = typeof m.meta?.['command'] === 'string' ? m.meta['command'] : '';
  return command === '' ? name : `${name}（${command}）`;
}

function makeEvent(type: string, severity: 'warn' | 'info', label: string, hits: readonly Metric[], probeId: string, ts: number): ZhizhiEvent {
  return {
    id: `${type}@${ts}`,
    type,
    severity,
    // 瞬时事实：sustained/cooldown 对它无意义（gates 见 ephemeral 分支）——
    // 证据校验（threshold 闸门）仍照跑：metrics 非空，能过
    ephemeral: true,
    metrics: hits,
    sourceProbe: probeId,
    ts,
    summary: `${label}：${hits.map(describe).join('；')}｜来源 ${probeId}`,
  };
}

export default defineRule({
  id: 'rule-sentinel',
  // 🆕 M8-a watches：cli 启动报告算「关掉 probe-sentinel 后哪些告警失效」用
  watches: ['sentinel.autorunAdded', 'sentinel.autorunRemoved'],

  evaluate(batch: MetricBatch): readonly ZhizhiEvent[] {
    const added = batch.metrics.filter((m) => m.key === 'sentinel.autorunAdded');
    const removed = batch.metrics.filter((m) => m.key === 'sentinel.autorunRemoved');
    if (added.length === 0 && removed.length === 0) return [];

    const ts = Date.now();
    const events: ZhizhiEvent[] = [];
    if (added.length > 0) {
      events.push(makeEvent('sentinel.autorun', 'warn', '发现新的开机自启项', added, batch.probeId, ts));
    }
    if (removed.length > 0) {
      events.push(makeEvent('sentinel.autorunGone', 'info', '开机自启项消失', removed, batch.probeId, ts));
    }
    return events;
  },
});
