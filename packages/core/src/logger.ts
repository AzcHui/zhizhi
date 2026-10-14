/**
 * @zhizhi/core · logger
 *
 * 两条约定：
 * 1. **所有日志走 stderr**，stdout 只留给「数据」（cli 每 5 秒那行 JSON）。
 *    这样 M4 的外壳可以只读 stdout 拿数据、stderr 看日志，互不干扰。
 * 2. 统一 `[模块]` 前缀 —— 出问题时能一眼定位是谁在说话。
 */

import type { LogLevel } from './types.ts';

const LEVEL_TAG: Record<LogLevel, string> = {
  debug: 'DBG',
  info: 'INF',
  warn: 'WRN',
  error: 'ERR',
};

const LEVEL_ORDER: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

let threshold: LogLevel = 'info';

/** 调整内核日志阈值（cli 的 --verbose 会把它降到 debug） */
export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER.indexOf(level) >= LEVEL_ORDER.indexOf(threshold);
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
  /** 派生一个带了模块名的子 logger */
  child(scope: string): Logger;
}

function create(scope: string): Logger {
  const write = (level: LogLevel, msg: string, extra?: unknown): void => {
    if (!shouldLog(level)) return;
    const line = `${stamp()} ${LEVEL_TAG[level]} [${scope}] ${msg}`;
    // 全部走 stderr —— stdout 是数据的通道，不是日志的
    if (extra === undefined) console.error(line);
    else console.error(line, extra);
  };

  return {
    debug: (msg, extra) => write('debug', msg, extra),
    info: (msg, extra) => write('info', msg, extra),
    warn: (msg, extra) => write('warn', msg, extra),
    error: (msg, extra) => write('error', msg, extra),
    child: (childScope: string) => create(childScope),
  };
}

/** 内核根 logger */
export function createLogger(scope = 'core'): Logger {
  return create(scope);
}
