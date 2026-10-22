<script setup lang="ts">
/**
 * 概览 —— 缩小版状态一句 + 内核死活。
 * 数据全部来自外壳的 `overview`（同一份内存字段，与浮窗面板同源），不重新采集。
 */
import { computed } from 'vue';
import { state } from '../store';

const ov = computed(() => state.overview);

/** 「醒了 3 小时 12 分」 */
const uptime = computed(() => {
  const s = ov.value?.uptimeSec ?? 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
});

/** 亲密度档位（与内核的信任档同口径） */
const tier = computed(() => {
  const t = ov.value?.trust;
  if (t === null || t === undefined) return '—';
  if (t < 10) return '沉默';
  if (t < 40) return '陌生';
  if (t < 80) return '熟悉';
  return '亲近';
});

const statusLine = computed(() => {
  if (!ov.value) return '正在连只只…';
  const cpu = ov.value.cpu === null ? '—' : `${ov.value.cpu.toFixed(0)}%`;
  const mem = ov.value.mem === null ? '—' : `${ov.value.mem.toFixed(0)}%`;
  return `醒了 ${uptime.value} · CPU ${cpu} · MEM ${mem} · 前台 ${ov.value.fgClass} · ${tier.value}（${ov.value.trust ?? '—'}）`;
});
</script>

<template>
  <div class="page">
    <div class="hero">
      <!-- 缩小版的「球」：纯 CSS 画一个，静态 -->
      <div class="orb" :class="{ dead: !ov?.kernelRunning }"></div>
      <div class="hero-text">
        <div class="big">{{ statusLine }}</div>
        <div class="sub">
          内核{{ ov?.kernelRunning ? '运行中' : '已停' }}
          <template v-if="ov && ov.muteLeftMin > 0"> · 静音剩 {{ ov.muteLeftMin }} 分</template>
          <template v-if="ov && ov.idleSec !== null"> · 空闲 {{ Math.round(ov.idleSec) }} 秒</template>
        </div>
      </div>
    </div>

    <div v-if="!ov" class="hint">正在等只只回话…（如果一直这样，外壳可能没连上内核）</div>

    <div class="grid" v-if="ov">
      <div class="cell"><div class="k">CPU</div><div class="v">{{ ov.cpu === null ? '—' : ov.cpu.toFixed(1) + '%' }}</div></div>
      <div class="cell"><div class="k">MEM</div><div class="v">{{ ov.mem === null ? '—' : ov.mem.toFixed(1) + '%' }}</div></div>
      <div class="cell"><div class="k">亲密度</div><div class="v">{{ ov.trust ?? '—' }}<small> · {{ tier }}</small></div></div>
      <div class="cell"><div class="k">前台</div><div class="v">{{ ov.fgClass }}</div></div>
      <div class="cell"><div class="k">静音</div><div class="v">{{ ov.muteLeftMin > 0 ? ov.muteLeftMin + ' 分' : '关' }}</div></div>
      <div class="cell"><div class="k">内核</div><div class="v">{{ ov.kernelRunning ? '活着' : '已停' }}</div></div>
    </div>
  </div>
</template>

<style scoped>
.page { padding: 18px 20px; }
.hero { display: flex; align-items: center; gap: 18px; margin-bottom: 18px; }
.orb {
  width: 64px; height: 64px; border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #8fe3d3, #1f8a7a 70%);
  box-shadow: 0 0 18px rgba(31, 138, 122, .35);
  flex: none;
}
.orb.dead { background: radial-gradient(circle at 35% 30%, #ccc, #888 70%); box-shadow: none; }
.hero-text { min-width: 0; }
.big { font-size: 15px; font-weight: 600; color: #222; line-height: 1.6; }
.sub { font-size: 12.5px; color: #888; margin-top: 2px; }
.hint { color: #999; font-size: 13px; }
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.cell { border: 1px solid #e8e8e8; border-radius: 8px; padding: 10px 12px; background: #fafafa; }
.k { font-size: 11.5px; color: #999; }
.v { font-size: 17px; font-weight: 600; color: #1f8a7a; margin-top: 2px; }
.v small { font-size: 12px; font-weight: 400; color: #888; }
</style>
