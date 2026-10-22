/**
 * 只只的家 · 桥（前端 ↔ WPF 外壳）
 *
 * ⭐ 这是**唯一**与外壳耦合的文件 —— 协议在《只只的家-形态定案与第一版开工单》3.3 节。
 *
 * 约定：
 *   前端 → 外壳：window.chrome.webview.postMessage({ cmd, ...args })
 *   外壳 → 前端：webView.CoreWebView2.PostWebMessageAsJson(json)
 *
 * 纪律：
 *   - **本文件只搬数据，不含业务逻辑**（业务在内核/外壳侧）；
 *   - 没收到外壳消息时（比如用 `pnpm dev` 单跑前端）**不能崩** —— 所有调用都走 Promise + 超时兜底。
 */

// ── 外壳 → 前端 的消息类型 ───────────────────────────────────────────

export interface Overview {
  cpu: number | null;
  mem: number | null;
  trust: number | null;
  fgClass: string;
  idleSec: number | null;
  muteLeftMin: number;
  uptimeSec: number;
  kernelRunning: boolean;
}

export interface HistoryItem {
  ts: number;
  type: string;
  severity: string;
  text: string;
}

export interface PoolLine {
  text: string;
  source: 'user' | 'persona' | 'learned';
}

export interface PoolSection {
  type: string;
  lines: PoolLine[];
}

export interface LogLine {
  ts: number;
  source: 'shell' | 'kernel';
  text: string;
}

export type HostMessage =
  | { type: 'overview'; data: Overview }
  | { type: 'history'; data: { total: number; items: HistoryItem[] } }
  | { type: 'pools'; data: { sections: PoolSection[] } }
  | { type: 'logs'; data: { items: LogLine[] } }
  | { type: 'logLine'; data: LogLine }
  | { type: 'previewDone'; data: { ok: boolean } };

// ── 发送侧 ───────────────────────────────────────────────────────────

interface WebViewHost {
  postMessage(msg: unknown): void;
}

function host(): WebViewHost | null {
  // 在 WebView2 里才有 chrome.webview；纯浏览器/vite dev 下没有 → 返回 null
  const w = window as unknown as { chrome?: { webview?: WebViewHost } };
  return w.chrome?.webview ?? null;
}

/** 家是不是跑在只只的外壳里（false = vite dev 单跑，界面会显示提示条）。 */
export function inShell(): boolean {
  return host() !== null;
}

/**
 * 发一条命令给外壳。**不返回 Promise** —— 外壳的响应走 onMessage 广播。
 *
 * ⚠️ **必须发 JSON 字符串，不能发对象** ——
 *   WebView2 的 `TryGetWebMessageAsString()` 收到**对象**时会抛
 *   "Value does not fall within the expected range"（且不告诉你原因）——
 *   外壳那边会整条消息收不到，表现就是「前端明明发了，外壳就是没反应」。
 *   （这是本项目实测踩过的坑：外壳侧只在 try/catch 里记了一行 ERR 才定位到。）
 */
export function send(cmd: string, args: Record<string, unknown> = {}): boolean {
  const h = host();
  if (!h) return false;
  h.postMessage(JSON.stringify({ cmd, ...args }));
  return true;
}

// ── 接收侧 ───────────────────────────────────────────────────────────

type Listener = (msg: HostMessage) => void;

const listeners = new Set<Listener>();

/** 注册外壳消息监听。返回退订函数。 */
export function onMessage(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function dispatch(msg: HostMessage): void {
  for (const fn of listeners) {
    try {
      fn(msg);
    } catch (e) {
      // 监听器自己的错不该拖垮整条链
      console.error('[bridge] 监听器抛错', e);
    }
  }
}

// 注册一次：外壳消息 → 广播给所有监听器
//
// ⚠️ **必须监听 `chrome.webview` 而不是 `window`** —— WebView2 的
//   `PostWebMessageAsString` 把消息投递给 `window.chrome.webview` 的 'message' 事件；
//   挂在 `window` 上收不到（实测踩过：外壳明明回包了、前端就是没反应）。
//   （Web 标准 postMessage 走 window，但 WebView2 宿主消息走 chrome.webview —— 两者不是一回事。）
if (typeof window !== 'undefined') {
  const handler = (ev: MessageEvent) => {
    // 外壳用 PostWebMessageAsString 发的是 **JSON 字符串** —— 也兼容对象（两种都能收）
    let data: HostMessage | undefined;
    const raw = ev.data;
    if (typeof raw === 'string') {
      try {
        data = JSON.parse(raw) as HostMessage;
      } catch {
        return;
      }
    } else if (raw && typeof raw === 'object') {
      data = raw as HostMessage;
    }
    if (!data || typeof data.type !== 'string') return;
    dispatch(data);
  };

  const wv = host();
  if (wv && typeof (wv as unknown as { addEventListener?: unknown }).addEventListener === 'function') {
    // 官方路径：chrome.webview.addEventListener('message', handler)
    (wv as unknown as { addEventListener(t: string, f: (e: MessageEvent) => void): void })
      .addEventListener('message', handler);
  } else {
    // 兜底：普通浏览器 / vite dev
    window.addEventListener('message', handler);
  }
}

// ── 便捷调用 ─────────────────────────────────────────────────────────

/** 等某一种类型的消息（超时返回 null —— 不无限等，避免界面卡在「加载中」）。 */
export function waitFor<T extends HostMessage['type']>(
  type: T,
  timeoutMs = 8000,
): Promise<Extract<HostMessage, { type: T }> | null> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      off();
      resolve(null);
    }, timeoutMs);
    const off = onMessage((msg) => {
      if (done || msg.type !== type) return;
      done = true;
      clearTimeout(timer);
      off();
      resolve(msg as Extract<HostMessage, { type: T }>);
    });
  });
}
