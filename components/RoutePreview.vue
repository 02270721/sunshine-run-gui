<script setup lang="ts">
/**
 * 路线预览 —— 用 SVG 画一条折线，不依赖任何地图服务（不需要 Key、不联网）。
 * 校园跑的路线就是一串打卡点坐标，画出来足够让人确认「选的是不是我要的跑道」。
 */
const props = defineProps<{
  /** [[纬度, 经度], …] */
  points: number[][]
  /** 打卡点坐标，可选 */
  checkpoints?: number[][]
  height?: number
}>()

const W = 320

const geometry = computed(() => {
  const pts = (props.points || []).filter(p => Array.isArray(p) && p.length >= 2)
  if (pts.length < 2) return null

  const lats = pts.map(p => p[0])
  const lngs = pts.map(p => p[1])
  const minLat = Math.min(...lats); const maxLat = Math.max(...lats)
  const minLng = Math.min(...lngs); const maxLng = Math.max(...lngs)

  // 经度方向按纬度收缩，保证形状不被拉扁
  const cos = Math.cos(((minLat + maxLat) / 2 * Math.PI) / 180)
  const spanX = Math.max(1e-9, (maxLng - minLng) * cos)
  const spanY = Math.max(1e-9, maxLat - minLat)
  const scale = Math.min((W - 24) / spanX, ((props.height || 200) - 24) / spanY)
  const offX = (W - spanX * scale) / 2
  const offY = ((props.height || 200) - spanY * scale) / 2

  const project = (p: number[]) => [
    offX + ((p[1] - minLng) * cos) * scale,
    (props.height || 200) - offY - (p[0] - minLat) * scale,
  ] as [number, number]

  const line = pts.map(project)
  const path = `M ${line.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L ')}`
  const cps = (props.checkpoints || []).map(project)
  const start = line[0]

  return { path, cps, start, viewBox: `0 0 ${W} ${props.height || 200}` }
})
</script>

<template>
  <div class="route-preview">
    <svg v-if="geometry" :viewBox="geometry.viewBox" class="route-svg">
      <path :d="geometry.path" fill="none" stroke="#1976D2" stroke-width="2.5" stroke-linejoin="round" />
      <circle
        v-for="(cp, i) in geometry.cps"
        :key="i"
        :cx="cp[0]"
        :cy="cp[1]"
        r="3"
        fill="#fff"
        stroke="#00897B"
        stroke-width="1.5"
      />
      <circle :cx="geometry.start[0]" :cy="geometry.start[1]" r="5" fill="#C62828" />
    </svg>
    <div v-else class="text-caption text-medium-emphasis pa-4 text-center">
      还没有路线数据
    </div>
    <div v-if="geometry" class="text-caption text-medium-emphasis text-center">
      <VIcon icon="mdi-map-marker" size="14" color="error" /> 起点
      <span class="ml-3"><VIcon icon="mdi-circle-outline" size="12" color="secondary" /> 打卡点</span>
    </div>
  </div>
</template>

<style scoped>
.route-preview { background: #f5f7fa; border-radius: 8px; padding: 8px; }
.route-svg { width: 100%; height: auto; display: block; }
</style>
