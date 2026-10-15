/**
 * @zhizhi/plugin-sdk · index
 *
 * ⭐ 插件契机的唯一出口 —— **社区插件只需要依赖这一个包**。
 *
 * 它做了两件事：
 *   1. 提供 define-* 定义函数（带校验，写错了立刻炸在开发机上）
 *   2. 把内核的数据结构**转发**出来，这样插件不必直接 import @zhizhi/core，
 *      也就物理上守住了「插件只依赖 SDK」这条线。
 */

// 定义函数
export { defineProbe } from './define-probe.ts';
export type { ProbeDefinition } from './define-probe.ts';
export { defineRule } from './define-rule.ts';
export type { RuleDefinition } from './define-rule.ts';
export { definePersona, definePersonaFromJson } from './define-persona.ts';
export type { PersonaDefinition, PersonaJson } from './define-persona.ts';
export { defineChannel } from './define-channel.ts';
export type { ChannelDefinition } from './define-channel.ts';

// manifest
export { PLUGIN_TYPES, validateManifest } from './manifest.ts';
export type { ManifestIssue, PluginManifest, PluginPermissions } from './manifest.ts';

// 数据契约（转发内核定义，插件不许自己另发明一套）
export type {
  Channel,
  ContextInput,
  EventKind,
  Feedback,
  Line,
  LogLevel,
  Metric,
  MetricBatch,
  OutgoingMessage,
  Persona,
  PluginStatus,
  PluginType,
  Probe,
  Rule,
  Severity,
  ZhizhiEvent,
} from '@zhizhi/core';

/** SDK 版本 —— 写进 manifest 的 sdk 字段用的就是它 */
export const SDK_VERSION = '0.1.0';
