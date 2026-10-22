<script setup lang="ts">
/**
 * 首页 —— 「它今天过得怎么样、我们相处得怎么样」（开工单 9.4）。
 *
 * ⚠️ 纪律：
 *   · **全部现成数据，不新增采集**（overview / digest / history / pools 都来自外壳）；
 *   · **CPU/MEM 降级成右下角一行小字**（面板天天看，首页不抢主视觉）；
 *   · **空状态写人话**（今天还没说话 → 「今天它还没开口」，不许显示「0 句」/ NaN）；
 *   · **不放「它最常说的一句」**（池子耗尽后会重复，放首页会让人误以为是 bug）。
 */
import { computed } from 'vue';
import { state, preview, requestSay, toggleMute } from '../store';

const ov = computed(() => state.overview);
const dg = computed(() => state.digest);

/** 「醒了 3 小时 12 分」 */
const uptime = computed(() => {
  const s = ov.value?.uptimeSec ?? 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分`;
  return '不到 1 分钟';
});

/** 亲密度档位（与内核的信任档同口径：10/40/80 分界） */
const tier = computed(() => {
  const t = ov.value?.trust;
  if (t === null || t === undefined) return '—';
  return tierOf(t);
});

function tierOf(t: number): string {
  if (t < 10) return '沉默';
  if (t < 40) return '陌生';
  if (t < 80) return '熟悉';
  return '亲近';
}

/**
 * 亲密度进度条的刻度（**四档，与内核完全同口径**：10/40/80 分界，顶档=亲近）。
 * ⚠️ 别自己加档 —— 内核只有沉默/陌生/熟悉/亲近四档（threshold 0~9/10~39/40~79/80~100）。
 *   我曾多加一档「亲密」(100)，结果 trust=85 显示「再 15 到『亲密』」——
 *   内核根本没有这一档，是凭空造的（开工单 9.5 判据④ 明写 trust=85 应显示「已经很亲近了」）。
 */
const NEXT_TIER = [
  { at: 10, name: '陌生' },
  { at: 40, name: '熟悉' },
  { at: 80, name: '亲近' },
];

/** 进度条图例（0 + 三个档位分界 + 100 端点）—— 由刻度生成，别手写另一套。 */
const BAR_LEGEND = [0, ...NEXT_TIER.map((x) => x.at), 100];

/**
 * 亲密度进度条：填到 trust%，右边标「再 N 到下一档」。
 * ⚠️ trust=85 时显示「已经很亲近了」（顶到「亲近」档 80 之后不再说「再 N 到…」）。
 */
const progress = computed(() => {
  const t = ov.value?.trust;
  if (t === null || t === undefined) return null;
  const next = NEXT_TIER.find((x) => x.at > t);
  return {
    pct: Math.max(0, Math.min(100, t)),
    // 顶到最后一档（>= 80 亲近）就不再报「还差几」
    hint: next ? `再 ${next.at - t} 到「${next.name}」` : '已经很亲近了',
    // ⚠️ 刻度是**档位分界**（10/40/80），图例另有一套（0/10/40/80/100 含两端点）—— 别混
    marks: NEXT_TIER.map((x) => x.at),
  };
});

/** 今天说了几句（空状态写人话，不显示 0） */
const todayText = computed(() => {
  const d = dg.value;
  if (!d) return '—';
  if (!d.hasFile) return '还没有记录（第一天就是这样）';
  if (d.today === 0) return '今天它还没开口';
  return `${d.today} 句`;
});

/** 昨天说了几句 */
const yesterdayText = computed(() => {
  const d = dg.value;
  if (!d || !d.hasFile) return '—';
  if (d.yesterday === 0) return '昨天没开口';
  return `${d.yesterday} 句`;
});

/** 今天打过招呼没（greeting 不算进「今天说了」，但值得露个脸） */
const greetText = computed(() => {
  const n = dg.value?.greetedToday ?? 0;
  return n > 0 ? `（另打了 ${n} 次招呼）` : '';
});

/** 它注意到你（写码/网页/开会/戳）—— 今天各类型计数 */
const noticed = computed(() => {
  const n = dg.value?.noticed;
  if (!n) return null;
  const parts: string[] = [];
  if (n.code > 0) parts.push(`写码 ${n.code}`);
  if (n.browser > 0) parts.push(`网页 ${n.browser}`);
  if (n.meeting > 0) parts.push(`开会 ${n.meeting}`);
  if (n.poke > 0) parts.push(`戳 ${n.poke}`);
  return parts.length > 0 ? parts.join(' · ') : '今天还没留意到';
});

/** 台词「说过 N / 池 M」 */
const linesText = computed(() => {
  const d = dg.value;
  if (!d) return '—';
  return `说过 ${d.uniqueSaid} / ${d.poolTotal}`;
});

/** 还剩多少句没说 */
const remainText = computed(() => {
  const d = dg.value;
  if (!d) return '';
  const left = d.poolTotal - d.uniqueSaid;
  if (left <= 0) return '池子说完了';
  return `还剩 ${left} 句没说`;
});

/** 它最近说的 5 条（history 已有，前端取前 5） */
const recent = computed(() => (state.history?.items ?? []).slice(0, 5));

function timeOf(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 「再说」= 试听（纯预览，不进记忆） */
function again(text: string) {
  preview(text);
}

/** 「随便说一句」= 点名让它现在开口（走内核 requestSay，不受静音/沉默档压制） */
function sayNow() {
  requestSay();
}

/** 「静一下 / 恢复」—— 文案跟面板那个开关同步（同一个状态源） */
const muteText = computed(() => {
  const m = ov.value?.muteLeftMin ?? 0;
  return m > 0 ? `恢复（${m} 分）` : '静一下';
});
</script>

<template>
  <div class="page">
    <!-- ① 状态区：球 + 醒了多久 + 亲密度进度条 + 快捷按钮 -->
    <section class="hero">
      <div class="orb" :class="{ dead: !ov?.kernelRunning }"></div>
      <div class="hero-body">
        <div class="hero-top">
          <div>
            <div class="big">醒了 {{ uptime }}</div>
            <div class="sub">亲密度 {{ ov?.trust ?? '—' }} · {{ tier }}</div>
          </div>
          <div class="quick">
            <button class="qbtn" @click="sayNow">随便说一句</button>
            <button class="qbtn ghost" @click="toggleMute">{{ muteText }}</button>
          </div>
        </div>

        <!-- 亲密度进度条 -->
        <div v-if="progress" class="bar-wrap">
          <div class="bar">
            <div class="fill" :style="{ width: progress.pct + '%' }"></div>
            <span v-for="m in progress.marks" :key="m" class="mark" :style="{ left: m + '%' }"></span>
          </div>
          <!-- ⚠️ 图例由刻度数组生成（0 + 三个分界 + 100 端点）—— 别在这里手写死一套数字，
               那会和刻度线对不上（手写版只有 5 个数，刻度线只有 3 条）。 -->
          <div class="bar-legend">
            <span v-for="t in BAR_LEGEND" :key="t">{{ t }}</span>
          </div>
          <div class="bar-hint">{{ progress.hint }}</div>
        </div>
      </div>
    </section>

    <div v-if="!ov" class="hint">正在等只只回话…（如果一直这样，外壳可能没连上内核）</div>

    <!-- ② 四个小卡 -->
    <section v-if="dg" class="cards">
      <div class="card">
        <div class="k">今天说了</div>
        <div class="v">{{ todayText }}</div>
        <div class="v-sub">{{ greetText }}</div>
      </div>
      <div class="card">
        <div class="k">昨天</div>
        <div class="v">{{ yesterdayText }}</div>
      </div>
      <div class="card">
        <div class="k">它注意到你</div>
        <div class="v small">{{ noticed }}</div>
      </div>
      <div class="card">
        <div class="k">台词</div>
        <div class="v">{{ linesText }}</div>
        <div class="v-sub">{{ remainText }}</div>
      </div>
    </section>

    <!-- ③ 它最近说的 -->
    <section v-if="recent.length > 0" class="recent">
      <div class="sec-title">它最近说的</div>
      <div v-for="r in recent" :key="r.ts + r.text" class="line">
        <span class="t">{{ timeOf(r.ts) }}</span>
        <span class="x">{{ r.text }}</span>
        <button class="again" @click="again(r.text)">再说</button>
      </div>
      <div class="more">看全部 {{ state.history?.total ?? 0 }} 条 →</div>
    </section>

    <!-- ④ 右下角小字：CPU/MEM（面板天天看，首页不抢主视觉） -->
    <footer class="foot">
      CPU {{ ov?.cpu === null || ov?.cpu === undefined ? '—' : ov.cpu.toFixed(0) + '%' }}
      · MEM {{ ov?.mem === null || ov?.mem === undefined ? '—' : ov.mem.toFixed(0) + '%' }}
    </footer>
  </div>
</template>

<style scoped>
.page { padding: 18px 20px 14px; position: relative; min-height: 100%; box-sizing: border-box; }

/* ① 状态区 */
.hero { display: flex; gap: 16px; align-items: flex-start; margin-bottom: 16px; }
.orb {
  width: 52px; height: 52px; border-radius: 50%; flex: none;
  background: radial-gradient(circle at 35% 30%, #8fe3d3, #1f8a7a 70%);
  box-shadow: 0 0 14px rgba(31, 138, 122, .3);
}
.orb.dead { background: radial-gradient(circle at 35% 30%, #ccc, #888 70%); box-shadow: none; }
.hero-body { flex: 1; min-width: 0; }
.hero-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.big { font-size: 16px; font-weight: 600; color: #222; line-height: 1.5; }
.sub { font-size: 12.5px; color: #888; margin-top: 1px; }
.quick { display: flex; gap: 6px; flex: none; }
.qbtn {
  border: 1px solid #1f8a7a; background: #1f8a7a; color: #fff;
  font-size: 12px; padding: 4px 10px; border-radius: 12px; cursor: pointer;
  font-family: inherit;
}
.qbtn.ghost { background: #fff; color: #1f8a7a; }
.qbtn:hover { opacity: .85; }

/* 亲密度进度条 */
.bar-wrap { margin-top: 10px; position: relative; padding-bottom: 14px; }
.bar {
  position: relative; height: 8px; border-radius: 4px;
  background: #eef1f0; overflow: hidden;
}
.fill {
  height: 100%; border-radius: 4px;
  background: linear-gradient(90deg, #8fe3d3, #1f8a7a);
  transition: width .4s ease;
}
.mark {
  position: absolute; top: 0; width: 1px; height: 100%;
  background: rgba(255, 255, 255, .85);
}
.bar-legend {
  display: flex; justify-content: space-between;
  font-size: 10px; color: #aaa; margin-top: 2px; padding-right: 2px;
}
.bar-hint { font-size: 11.5px; color: #1f8a7a; margin-top: 1px; }

/* ② 四个小卡 */
.cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 18px; }
.card { border: 1px solid #ececec; border-radius: 8px; padding: 9px 11px; background: #fafafa; min-width: 0; }
.k { font-size: 11px; color: #999; }
.v { font-size: 15px; font-weight: 600; color: #1f8a7a; margin-top: 3px; line-height: 1.4; word-break: break-word; }
.v.small { font-size: 12.5px; font-weight: 500; color: #555; }
.v-sub { font-size: 11px; color: #aaa; margin-top: 2px; }

/* ③ 最近说的 */
.sec-title { font-size: 12.5px; color: #888; margin-bottom: 6px; }
.line {
  display: flex; align-items: center; gap: 10px;
  padding: 5px 0; border-bottom: 1px solid #f2f2f2;
}
.t { font-size: 11.5px; color: #bbb; flex: none; width: 38px; }
.x { flex: 1; font-size: 13px; color: #333; min-width: 0; }
.again {
  flex: none; border: 1px solid #e0e0e0; background: #fff; color: #666;
  font-size: 11px; padding: 2px 8px; border-radius: 10px; cursor: pointer; font-family: inherit;
}
.again:hover { border-color: #1f8a7a; color: #1f8a7a; }
.more { font-size: 11.5px; color: #1f8a7a; margin-top: 8px; text-align: right; }

/* ④ 右下角小字 */
.foot { position: absolute; right: 20px; bottom: 10px; font-size: 11px; color: #bbb; }

.hint { color: #999; font-size: 13px; }
</style>
