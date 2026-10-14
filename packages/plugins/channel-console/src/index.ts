/**
 * channel-console —— 日常说话用的通道（官方插件）
 *
 * 承载 `info` / `warn`：**弱提醒**，不打断人。
 *
 * 输出到 stdout 的一行 JSON，正是 M4 外壳要消费的那个协议（见《架构设计与开发计划》第七节）：
 *   {"type":"event","level":"warn","text":"内存占用偏高：mem.usage 87.3%（阈值 >85）"}
 *
 * 现在还没有外壳，所以这行 JSON 就是「只只说了什么」的唯一凭证。
 */

import { defineChannel } from '@zhizhi/plugin-sdk';

export default defineChannel({
  id: 'channel-console',
  sends: ['info', 'warn'],

  send(message) {
    process.stdout.write(
      `${JSON.stringify({
        type: 'event',
        level: message.severity,
        eventId: message.eventId,
        text: message.text,
      })}\n`,
    );
  },
});
