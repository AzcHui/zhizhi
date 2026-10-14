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
   *
   * 选通道规则：挑**第一个**愿意承载该 severity 的通道。
   * 若同时有多个通道认领同一 severity —— 只发第一个，但**打 warn 点出来**：
   *   静默选第一个会让其余通道永远不被调用、又不报错，与「不静默吞错」原则相悖。
   *
   * @returns 是否成功送出（false = 没有通道认领，或通道抛错被隔离）
   */
  async dispatch(msg: OutgoingMessage): Promise<boolean> {
    const targets = this.#channels.filter((c) => c.sends.includes(msg.severity));
    if (targets.length === 0) {
      // 如实报告，不静默丢弃
      this.#log.warn(`没有通道愿意承载 "${msg.severity}"，消息未送出：${msg.text}`);
      return false;
    }
    const [target, ...rest] = targets;
    if (target !== undefined && rest.length > 0) {
      this.#log.warn(
        `有 ${targets.length} 个通道都声明承载 "${msg.severity}"：` +
          `${targets.map((c) => c.id).join(', ')} —— 只发给 "${target.id}"，` +
          `其余不会被调用。请检查通道声明是否重叠。`,
      );
    }
    if (target === undefined) return false;
    try {
      await target.send(msg);
      return true;
    } catch (err) {
      this.#log.error(`通道 "${target.id}" 发送失败（已隔离，不影响其他通道）`, err);
      return false;
    }
  }
}
