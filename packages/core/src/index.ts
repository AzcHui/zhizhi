/**
 * @zhizhi/core · index
 *
 * 内核出口。
 *
 * ⚠️ 这个包必须保持：**零 UI 依赖、零外部依赖**。
 * 它是「先内核后外壳」的物理保证 —— 同一个内核，cli 今天用它，app(M4) 以后也用它。
 */

export * from './types.ts';
export { createLogger, setLogLevel } from './logger.ts';
export type { Logger } from './logger.ts';
export { Bus } from './bus.ts';
export type { Handler } from './bus.ts';
export { Scheduler } from './scheduler.ts';
export type { TickHandler } from './scheduler.ts';
export { Store } from './store.ts';
export {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_SUSTAIN_MS,
  GATE_NAMES,
  createGates,
  runGates,
} from './gates.ts';
export type {
  Gate,
  GateContext,
  GateName,
  GateOptions,
  GateRunResult,
  GateVerdict,
} from './gates.ts';
export { Dispatcher } from './dispatcher.ts';
export { composeLine } from './voice.ts';
export { Registry } from './registry.ts';

/** 内核版本 —— 外壳与插件可以据此做兼容判断 */
export const CORE_VERSION = '0.1.0';
