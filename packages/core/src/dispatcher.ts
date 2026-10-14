/**
 * @zhizhi/core · dispatcher
 *
 * 分通道裁决 —— 它的「分寸感」（内核 7 样之一，绝不外放）。
 *
 * 铁律（来自《互动与情绪价值评估》第三节）：
 *   提醒（强）与 互动/情绪（弱）**永不混用**。
 *   日常说话 → 浮窗气泡；只有 P0 安全告警 → 才升级为 Toast。
 *
 * M0：只实现「注册通道 + 按 severity 选一个能承载它的通道」。
 * 分级策略（什么算 P0、互动预算每天 10 次）留给 M2。
 */

import type { Logger } from './logger.ts';
import type { Channel, OutgoingMessage } from './types.ts';

export class Dispatcher {
  readonly #channels: Channel[] = [];
  readonly #log: Logger;

  constructor(log: Logger) {
    this.#log = log;
  }

  register(channel: Channel): void {
    this.#channels.push(channel);
  }

  /** 当前已注册的通道 id（cli 里打印出来看看谁在值班） */
  channelIds(): string[] {
    return this.#channels.map((c) => c.id);
  }

  /**
   * 送出一条消息。
   * @returns 是否成功送出（false = 没有通道认领，或通道抛错被隔离）
   */
  async dispatch(msg: OutgoingMessage): Promise<boolean> {
    const target = this.#channels.find((c) => c.sends.includes(msg.severity));
    if (!target) {
      // 如实报告，不静默丢弃
      this.#log.warn(`没有通道愿意承载 "${msg.severity}"，消息未送出：${msg.text}`);
      return false;
    }
    try {
      await target.send(msg);
      return true;
    } catch (err) {
      this.#log.error(`通道 "${target.id}" 发送失败（已隔离，不影响其他通道）`, err);
      return false;
    }
  }
}
