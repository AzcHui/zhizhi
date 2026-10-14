/**
 * rule-threshold —— 阈值判断规则（官方插件）
 *
 * 它做的是「**翻译**」：把指标数值翻译成「值得说一句」的候选事件。
 *
 * ⚠️ 它**不负责**决定该不该真的说出口 —— 那是四道闸门的活儿（尤其持续判定与冷却期），
 *    而那些闸门住在内核里、插件连读都读不到。
 *    一句话：**插件负责「发现」，内核负责「分寸」。**
 */

import { defineRule } from '@zhizhi/plugin-sdk';
import type { Metric, MetricBatch, Severity, ZhizhiEvent } from '@zhizhi/plugin-sdk';

interface Threshold {
  readonly metric: string;
  readonly op: '>' | '<';
  readonly value: number;
  readonly severity: Severity;
  readonly type: string;
  readonly label: string;
}

/**
 * 阈值表。
 *
 * M2 先写在代码里；到 S2「数据外置」阶段会挪进 JSON —— 那时用户不碰代码就能调它。
 * 同一 type 命中多条时取**最严重**的那条，免得同一个盘又报「紧张」又报「告急」。
 */
const THRESHOLDS: readonly Threshold[] = [
  { metric: 'mem.usage', op: '>', value: 85, severity: 'warn', type: 'mem.high', label: '内存占用偏高' },
  { metric: 'cpu.usage', op: '>', value: 90, severity: 'warn', type: 'cpu.high', label: 'CPU 占用偏高' },
  { metric: 'disk.usage', op: '>', value: 90, severity: 'warn', type: 'disk.tight', label: '磁盘空间紧张' },
  { metric: 'disk.usage', op: '>', value: 95, severity: 'critical', type: 'disk.tight', label: '磁盘空间告急' },
];

/** 严重度排序 —— 用来在同类命中里挑最狠的那条 */
const RANK: Record<Severity, number> = { info: 0, warn: 1, critical: 2 };

function isHit(value: number, rule: Threshold): boolean {
  return rule.op === '>' ? value > rule.value : value < rule.value;
}

function makeEvent(rule: Threshold, metric: Metric, probeId: string): ZhizhiEvent {
  const ts = Date.now();
  const reading = `${metric.value}${metric.unit ?? ''}`;
  return {
    id: `${rule.type}@${ts}`,
    type: rule.type,
    severity: rule.severity,
    metrics: [metric],
    ts,
    // summary 是**客观描述**，不是台词 —— 人格化的说法留给 persona（M5）
    summary: `${rule.label}：${metric.key} ${reading}（阈值 ${rule.op}${rule.value}）｜来源 ${probeId}`,
  };
}

export default defineRule({
  id: 'rule-threshold',

  evaluate(batch: MetricBatch): readonly ZhizhiEvent[] {
    const best = new Map<string, { rule: Threshold; metric: Metric }>();

    for (const rule of THRESHOLDS) {
      const metric = batch.metrics.find((m) => m.key === rule.metric && isHit(m.value, rule));
      if (metric === undefined) continue;

      const current = best.get(rule.type);
      if (current === undefined || RANK[rule.severity] > RANK[current.rule.severity]) {
        best.set(rule.type, { rule, metric });
      }
    }

    return [...best.values()].map(({ rule, metric }) => makeEvent(rule, metric, batch.probeId));
  },
});
