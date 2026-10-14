/**
 * channel-alert —— 只给 P0 告警用的通道（官方插件）
 *
 * 承载 `critical`：**强提醒**。将来（M4 之后）它会升级成 Windows Toast ——
 * 进通知中心，你不看也在。
 *
 * 它和 channel-console 的分工，就是「分通道原则」的最小样本：
 *   **弱互动与强提醒永不混用。**
 *   天天弹的提醒你会免疫；只有出大事才弹的提醒，你才会真的看一眼。
 *
 * 输出用 `type: "alert"`（而不是 console 的 `"event"`）——
 * 外壳可以据此决定走哪套呈现，而不必去猜。
 */

import { defineChannel } from '@zhizhi/plugin-sdk';

export default defineChannel({
  id: 'channel-alert',
  sends: ['critical'],

  send(message) {
    process.stdout.write(
      `${JSON.stringify({
        type: 'alert',
        level: message.severity,
        eventId: message.eventId,
        text: message.text,
      })}\n`,
    );
  },
});
