<script setup lang="ts">
/**
 * 运行日志 —— 把 CLI 控制台里的那套输出搬进网页。
 * 看不懂代码的人也能从这里看见「程序每一步在做什么」。
 */
const props = defineProps<{
  entries: { t: string, level: string, text: string }[]
  title?: string
  height?: number
}>()

const box = ref<HTMLElement | null>(null)

const color = (level: string) =>
  level === 'error' ? 'error' : level === 'warn' ? 'warning' : 'medium-emphasis'

const icon = (level: string) =>
  level === 'error' ? 'mdi-alert-circle-outline' : level === 'warn' ? 'mdi-alert-outline' : 'mdi-chevron-right'

const clock = (iso: string) => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

watch(() => props.entries?.length, async () => {
  await nextTick()
  if (box.value) box.value.scrollTop = box.value.scrollHeight
})
</script>

<template>
  <VCard variant="outlined">
    <VCardTitle class="text-subtitle-2 d-flex align-center">
      <VIcon start icon="mdi-text-box-outline" size="18" />
      {{ title || '运行日志' }}
    </VCardTitle>
    <VDivider />
    <div ref="box" class="log-box" :style="{ maxHeight: `${height || 240}px` }">
      <div v-if="!entries?.length" class="text-caption text-medium-emphasis pa-3">
        还没有日志。
      </div>
      <div v-for="(e, i) in entries" :key="i" class="log-row">
        <span class="log-time">{{ clock(e.t) }}</span>
        <VIcon :icon="icon(e.level)" :color="color(e.level)" size="14" class="log-icon" />
        <span :class="`text-${color(e.level)}`">{{ e.text }}</span>
      </div>
    </div>
  </VCard>
</template>

<style scoped>
.log-box { overflow-y: auto; font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; padding: 8px 12px; }
.log-row { display: flex; gap: 6px; align-items: baseline; line-height: 1.9; }
.log-time { color: #90a4ae; flex: none; }
.log-icon { flex: none; position: relative; top: 2px; }
</style>
