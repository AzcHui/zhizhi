/**
 * 只只的家 · 全局状态
 *
 * 极简 store（不引 Pinia —— 四个页面共 6 个字段，Vue 的 reactive 足够）。
 * 单一事实源 = 外壳推过来的数据；本地只存「当前选中页」这种纯 UI 状态。
 */

import { reactive, computed } from 'vue';
import { send, onMessage, inShell, waitFor, type Overview, type HistoryItem, type PoolSection, type LogLine } from './bridge';

export interface HomeState {
  /** 概览 */
  overview: Overview | null;
  /** 消息历史 */
  history: { total: number; items: HistoryItem[] } | null;
  /** 台词池 */
  pools: PoolSection[] | null;
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
}

export const state = reactive<HomeState>({
  overview: null,
  history: null,
  pools: null,
  logs: [],
  logLive: true,
  connected: false,
  ready: false,
  error: null,
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
        state.pools = msg.data.sections;
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
}

/** 刷新单个板块（页签切换时按需拉，避免首屏塞太多）。 */
export async function refresh(which: 'overview' | 'history' | 'pools' | 'logs'): Promise<void> {
  const cmd = { overview: 'getOverview', history: 'getHistory', pools: 'getPools', logs: 'getLogs' }[which];
  send(cmd, which === 'history' ? { limit: 200 } : which === 'logs' ? { limit: 300 } : {});
  const t = { overview: 'overview', history: 'history', pools: 'pools', logs: 'logs' }[which] as
    'overview' | 'history' | 'pools' | 'logs';
  await waitFor(t, 5000);
}

/** 试听一句台词：走外壳 → 球冒这句（纯预览，不进记忆）。 */
export function preview(text: string): void {
  send('previewLine', { text });
}

/** 日志实时推流开关。 */
export function setLogLive(on: boolean): void {
  state.logLive = on;
  send('subscribeLogs', { on });
}
