/**
 * 只只的家 · 全局状态
 *
 * 极简 store（不引 Pinia —— 四个页面共 6 个字段，Vue 的 reactive 足够）。
 * 单一事实源 = 外壳推过来的数据；本地只存「当前选中页」这种纯 UI 状态。
 */

import { reactive, computed } from 'vue';
import { send, onMessage, inShell, waitFor, type Overview, type HistoryItem, type PoolSection, type LogLine, type Digest } from './bridge';

export interface HomeState {
  /** 概览 */
  overview: Overview | null;
  /** 消息历史 */
  history: { total: number; items: HistoryItem[] } | null;
  /** 台词池 */
  pools: PoolSection[] | null;
  /** 首页摘要（9.4） */
  digest: Digest | null;
  /** 日志 */
  logs: LogLine[];
  /** 日志实时推流开关 */
  logLive: boolean;
  /** 外壳是否就位（vite dev 单跑时为 false） */
  connected: boolean;
  /** 首屏是否已完成一次握手 */
  ready: boolean;
  /** 最后一次错误（显示在顶栏，不静默吞） */
  error: string | null;
  /** 台词池读取失败的原因（**独立于 error** —— error 会被试听回包清掉，互相覆盖就看不见了） */
  poolsError: string | null;
}

export const state = reactive<HomeState>({
  overview: null,
  history: null,
  pools: null,
  digest: null,
  logs: [],
  logLive: true,
  connected: false,
  ready: false,
  error: null,
  poolsError: null,
});

/** 台词池总句数 */
export const poolTotal = computed(() =>
  (state.pools ?? []).reduce((n, s) => n + s.lines.length, 0),
);

/** 「已说过 M 句」：从消息历史里去重统计（isStale 记账在内核侧，这里只做可见统计） */
export const saidTotal = computed(() => {
  const items = state.history?.items ?? [];
  return new Set(items.map((i) => i.text)).size;
});

/** 把外壳推来的日志追加进来（保留最近 500 条，界面不至于无限长）。 */
function pushLog(line: LogLine): void {
  state.logs.push(line);
  if (state.logs.length > 500) state.logs.splice(0, state.logs.length - 500);
}

/**
 * 校验并规整外壳发来的台词池。
 *
 * ⚠️ **为什么必须有这个函数**（2026-10-22 P0）：
 *   外壳的 .NET `JsonSerializer` 默认**保持属性名原样**，
 *   record 会被序列化成 `Sections` / `Type` / `Lines` / `Text` / `Source`（大写），
 *   而前端约定是小写 —— 一旦对不上，`state.pools` 就是 undefined，
 *   页面会**永远显示「正在读台词池…」且不报错**（用户视角：功能坏了但没人告诉他）。
 *
 * → 这里**宁可报错也不静默**：结构对不上就抛给上层记 error。
 */
function normalizePools(data: unknown): PoolSection[] {
  const raw = (data as { sections?: unknown } | undefined)?.sections;
  if (!Array.isArray(raw)) {
    const actual = data && typeof data === 'object' ? Object.keys(data).join(',') : '(不是对象)';
    throw new Error(`台词池结构对不上（缺 sections）—— 外壳发来的字段是：${actual}`);
  }
  return raw.map((sec, i) => {
    const s = sec as { type?: unknown; lines?: unknown };
    if (typeof s.type !== 'string' || !Array.isArray(s.lines)) {
      const actual = sec && typeof sec === 'object' ? Object.keys(sec).join(',') : '(不是对象)';
      throw new Error(`台词池第 ${i + 1} 段结构对不上 —— 字段是：${actual}`);
    }
    return {
      type: s.type,
      lines: s.lines.map((ln) => {
        const l = ln as { text?: unknown; source?: unknown };
        if (typeof l.text !== 'string') {
          const actual = ln && typeof ln === 'object' ? Object.keys(ln).join(',') : '(不是对象)';
          throw new Error(`台词池第 ${i + 1} 段里有一句结构对不上 —— 字段是：${actual}`);
        }
        return { text: l.text, source: (l.source as PoolSection['lines'][number]['source']) ?? 'persona' };
      }),
    };
  });
}

/** 台词总句数（用于回显给外壳）。 */
function countPoolLines(sections: PoolSection[] | null): number {
  return (sections ?? []).reduce((n, s) => n + (s.lines?.length ?? 0), 0);
}

/**
 * 首屏握手：ready → 外壳回 overview + pools + history。
 * ⚠️ 必须在 window 'message' 监听器**注册之后**才发 ready，否则回包会丢。
 */
export async function bootstrap(): Promise<void> {
  state.connected = inShell();
  // 取证：把握手判定写进 console（外壳侧能通过 WebView2 的脚本日志看到）
  console.log('[家] bootstrap: inShell =', state.connected, '| chrome.webview =', typeof (window as any).chrome?.webview);
  if (!state.connected) {
    state.error = '当前不在只只的外壳里（这是 vite 开发预览，功能不完整）';
    return;
  }

  onMessage((msg) => {
    switch (msg.type) {
      case 'overview':
        state.overview = msg.data;
        state.ready = true;
        // ⭐ 验收回显（判据③：桥是双向的，不是只发不收）——
        //   收到 overview 后立刻把「我这边有几个字段」报回去，让外壳能证明前端真的渲染了。
        //   生产环境无害（外壳忽略这个 cmd）；--home-test 用它判双向通不通。
        send('echoOverview', { fields: Object.keys(msg.data).length });
        break;
      case 'history':
        state.history = msg.data;
        break;
      case 'pools':
        // ⚠️⚠️ 结构防御（2026-10-22 P0 回归留下的教训）：
        //   外壳曾经把 pools 序列化成 {"Sections": …}（PascalCase，.NET 默认行为），
        //   前端读 data.sections 拿到 undefined → state.pools 永远 null →
        //   页面**永远显示「正在读台词池…」**，而且不报任何错。
        //   → 这里**必须校验结构**：对不上就写清楚报错，别让用户对着一个永远转圈的页面发呆。
        //   → 并且**回显实际解析到的句数**给外壳（判据④c）—— 证明「真的渲染出来了」，
        //     而不是「外壳自称发过了」。
        try {
          state.pools = normalizePools(msg.data);
          state.poolsError = null;
          send('echoPools', { lines: countPoolLines(state.pools), sections: state.pools.length });
        } catch (e) {
          // ⚠️ **不许静默**：结构对不上 → 页面写清原因（Lines.vue 会读 state.poolsError）。
          const why = e instanceof Error ? e.message : String(e);
          state.pools = null;      // 保持 null → 页面走「读失败」分支（不是「读到但空」）
          state.poolsError = why;
          console.error('[家] pools 结构异常', e);
          // 仍然回显 —— 让外壳的判据④c 变红（0 句），别让问题只存在于界面里
          send('echoPools', { lines: 0, sections: 0, error: why });
        }
        break;
      case 'digest':
        state.digest = msg.data;
        break;
      case 'logs':
        state.logs = msg.data.items.slice();
        break;
      case 'logLine':
        pushLog(msg.data);
        break;
      case 'previewDone':
        state.error = msg.data.ok ? null : '试听失败（外壳没接住）';
        break;
    }
  });

  send('ready');
  // ⭐ 首页摘要（9.4）：ready 之后单独拉一次。
  //   ⚠️ **只在打开家时算一次，不做定时轮询** —— 这是低频界面，别学面板的 1Hz。
  //   ⚠️ 外壳的 ready 回包里已含 digest（见 HomeBridge），这里再拉一次是为了
  //   「刷新」后能重新算（今天跨零点、或用户手动刷新）。
  send('getDigest');
}

/** 刷新单个板块（页签切换时按需拉，避免首屏塞太多）。 */
export async function refresh(which: 'overview' | 'history' | 'pools' | 'logs' | 'digest'): Promise<void> {
  const cmd = { overview: 'getOverview', history: 'getHistory', pools: 'getPools', logs: 'getLogs', digest: 'getDigest' }[which];
  send(cmd, which === 'history' ? { limit: 200 } : which === 'logs' ? { limit: 300 } : {});
  const t = { overview: 'overview', history: 'history', pools: 'pools', logs: 'logs', digest: 'digest' }[which] as
    'overview' | 'history' | 'pools' | 'logs' | 'digest';
  await waitFor(t, 5000);
}

/** 试听一句台词：走外壳 → 球冒这句（纯预览，不进记忆）。 */
export function preview(text: string): void {
  send('previewLine', { text });
}

/**
 * 「随便说一句」（9.4 首页快捷按钮）：让只只**现在**说一句。
 * ⚠️ 走内核已有的 requestSay —— 是「用户点名」，不受沉默档/静音压制，也不占每日闲聊额度。
 */
export function requestSay(): void {
  send('requestSay');
}

/** 「静一下 / 恢复」（9.4 首页快捷按钮）：复用面板那个开关（同一个状态源）。 */
export function toggleMute(): void {
  send('toggleMute');
}

/** 日志实时推流开关。 */
export function setLogLive(on: boolean): void {
  state.logLive = on;
  send('subscribeLogs', { on });
}
