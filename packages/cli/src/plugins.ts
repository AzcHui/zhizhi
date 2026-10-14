/**
 * 只只的插件清单
 *
 * S1「契约先行」阶段：清单是**手写**的，加载走动态 `import()`。
 * S3 阶段（等真有第三方需求）会换成「扫描 pluginsDir 目录」——那时这份清单
 * 由目录内容自动生成，而这个文件就可以退休了。
 *
 * ⚠️ 为什么要写 `type`：插件有可能**压根没起来**（没装 / manifest 不合规），
 *    那时它无法自报身份，记账就只能靠这里声明的期望类型。
 *
 * 📌 M1 的验收就靠它：把 `@zhizhi/probe-cpu` 这一行留着、但让包装不上，
 *    程序必须照常跑完，并明确告诉用户「插件缺失」。
 */

import type { PluginSpec } from '@zhizhi/core';

export const PLUGINS: readonly PluginSpec[] = [
  // 采集：只说「机器怎么了」
  { specifier: '@zhizhi/probe-cpu', type: 'probe' },
  { specifier: '@zhizhi/probe-mem', type: 'probe' },
  { specifier: '@zhizhi/probe-disk', type: 'probe' },
  // 判断：把指标翻译成「值得说一句」的候选事件
  { specifier: '@zhizhi/rule-threshold', type: 'rule' },
  // 通道：弱提醒（info/warn）与强告警（critical）分开走 —— 分通道原则
  { specifier: '@zhizhi/channel-console', type: 'channel' },
  { specifier: '@zhizhi/channel-alert', type: 'channel' },
];
