/**
 * rule-autostart —— 安全哨兵规则（官方插件 · M8-b，照开工单《验收清单》二·U）
 *
 * 把 probe-autostart 的自启项变化翻译成事件：
 *   新增 → `security.newAutostart`（warn；命中可疑特征升级 **critical** —— 措辞与级别，
 *          **不做任何阻断**：只只是哨兵不是杀软）
 *   改写 → `security.autostartChanged`（warn，before/after 都带）
 *   消失 → **不告警**（正常卸载属日常；基线静默吸收，probe 侧就不产指标）
 *
 * 两类事件都 `ephemeral: true`（离散事实：出现即告，不攒持续不冷却）——
 * 一分钟内必须出声，两个新增项挨着也各报各的。
 * summary 必须带**谁**（名称）、**从哪来**（命令）、**在哪个键**——「多少」是报警，「谁」才是帮助。
 */

import { defineRule } from '@zhizhi/plugin-sdk';
import type { Metric, MetricBatch, ZhizhiEvent } from '@zhizhi/plugin-sdk';

/** 从指标 meta 取人话：名称（命令）＠所在键短名 */
function describe(m: Metric): string {
  const name = String(m.meta?.['name'] ?? m.source ?? '（未知名称）');
  const srcKey = String(m.meta?.['sourceKey'] ?? '');
  const shortKey = srcKey.startsWith('HK')
    ? `${srcKey.split('\\')[0]}…\\${srcKey.split('\\').pop()}`
    : srcKey;
  const tail = shortKey === '' ? '' : ` ＠${shortKey}`;
  // 改写事件（有 before/after）走对照形态 —— 「被改写了」必须让人看见从什么变成了什么
  if (typeof m.meta?.['before'] === 'string' && typeof m.meta?.['after'] === 'string') {
    // ⭐ 剥掉类型前缀（二·V ⑥）：probe 存的是 "SZ|cmd…"，气泡显示 `zz-test：SZ|a → SZ|b`
    //   没人看得懂 —— 类型是基线比对的内部格式，给人看的只有命令
    const human = (s: string) => s.replace(/^[A-Z_]+\|/, '');
    return `${name}：${human(m.meta['before'])} → ${human(m.meta['after'])}${tail}`;
  }
  const command = String(m.meta?.['command'] ?? '');
  const cmd = command === '' ? '' : `（${command}）`;
  return `${name}${cmd}${tail}`;
}

function makeEvent(
  type: string,
  severity: 'warn' | 'critical',
  label: string,
  hits: readonly Metric[],
  probeId: string,
  ts: number,
): ZhizhiEvent {
  return {
    id: `${type}@${ts}`,
    type,
    severity,
    // 瞬时事实：sustained/cooldown 对它无意义（gates 的 ephemeral 分支）——
    // 证据校验（threshold 闸门）仍照跑：metrics 非空，能过
    ephemeral: true,
    metrics: hits,
    // ⚠️ 必须填（开工单坑 2）：sustained 的容忍缺口按来源 probe 查采样周期，
    //    缺了会让闸门行为不可预测 —— sourceProbe 与 probe id 严格一致
    sourceProbe: probeId,
    ts,
    summary: `${label}：${hits.map(describe).join('；')}｜来源 ${probeId}`,
  };
}

export default defineRule({
  id: 'rule-autostart',
  // M8-a watches：cli 启动报告算「关掉 probe-autostart 后哪些告警失效」用
  watches: ['security.autostart.item', 'security.autostart.changedItem'],

  evaluate(batch: MetricBatch): readonly ZhizhiEvent[] {
    const added = batch.metrics.filter((m) => m.key === 'security.autostart.item');
    const changed = batch.metrics.filter((m) => m.key === 'security.autostart.changedItem');
    if (added.length === 0 && changed.length === 0) return [];

    const ts = Date.now();
    const events: ZhizhiEvent[] = [];
    if (added.length > 0) {
      // 可疑升级（开工单对比表：命中可疑特征 → critical，走同一事件不新开类型）
      const anySuspicious = added.some((m) => m.meta?.['suspicious'] === 1);
      events.push(
        makeEvent(
          'security.newAutostart',
          anySuspicious ? 'critical' : 'warn',
          anySuspicious ? '新增自启项，而且看着不太对劲' : '发现新的开机自启项',
          added,
          batch.probeId,
          ts,
        ),
      );
    }
    if (changed.length > 0) {
      events.push(makeEvent('security.autostartChanged', 'warn', '开机自启项被改写', changed, batch.probeId, ts));
    }
    return events;
  },
});
