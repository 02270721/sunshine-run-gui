<script setup lang="ts">
/**
 * 执行页 —— 唯一的目标：让人放心地把页面关掉。
 *
 * 因此这里必须显示三件事：
 *   1. 现在到哪一步了（阶段时间线）
 *   2. 还剩多久（进度环 + 大字）
 *   3. 关掉页面会不会出问题（明确写「不会」）
 */
import type { RunSnapshot } from '~/composables/useRun'
import { formatDuration } from '~/utils/format'

const props = defineProps<{ state: RunSnapshot, busy?: boolean }>()
const emit = defineEmits<{ (e: 'submit'): void, (e: 'cancel'): void }>()

const total = computed(() => props.state.expectedDurationSec || props.state.durationSec || 0)
const elapsed = computed(() => props.state.elapsedSec || 0)
const remaining = computed(() => props.state.remainingSec || 0)
const percent = computed(() => (total.value > 0 ? Math.min(100, (elapsed.value / total.value) * 100) : 0))

const phaseText = computed(() => {
  switch (props.state.phase) {
    case 'starting': return '正在创建会话'
    case 'waiting': return '等待中（服务端计时）'
    case 'submitting': return '正在提交'
    case 'interrupted': return '需要你决定'
    default: return props.state.phase
  }
})

const steps = computed(() => {
  const p = props.state.phase
  const reached = (names: string[]) => names.includes(p)
  return [
    { title: '创建跑步会话', detail: props.state.sessionId ? `sessionId ${props.state.sessionId}` : '', done: Boolean(props.state.sessionId) },
    { title: '生成轨迹并体检', detail: props.state.track ? `${props.state.track.pointCount} 点 / ${Number(props.state.track.actualKm).toFixed(2)} km` : '', done: Boolean(props.state.track) },
    { title: '打卡点自检', detail: props.state.checkpoints ? `${props.state.checkpoints.passed}/${props.state.checkpoints.total}` : '', done: Boolean(props.state.checkpoints) },
    { title: '等待真实时间', detail: reached(['waiting']), done: reached(['submitting', 'done', 'failed']), active: p === 'waiting' },
    { title: '提交记录', detail: '', done: p === 'done', active: p === 'submitting' },
  ]
})
</script>

<template>
  <div>
    <VAlert
      v-if="state.phase === 'interrupted'"
      type="warning"
      variant="tonal"
      class="mb-4"
    >
      <div class="font-weight-medium mb-1">程序重启时有一次跑步没跑完</div>
      <div>{{ state.error }}</div>
    </VAlert>

    <VCard class="mb-4">
      <VCardText class="text-center py-6">
        <VProgressCircular
          :model-value="percent"
          :size="170"
          :width="12"
          color="primary"
          bg-color="grey-lighten-2"
        >
          <div>
            <div class="text-h4 font-weight-medium">{{ formatDuration(remaining) }}</div>
            <div class="text-caption text-medium-emphasis">后自动提交</div>
          </div>
        </VProgressCircular>

        <div class="mt-4 text-body-2">
          {{ phaseText }} · 已经过 {{ formatDuration(elapsed) }} / 目标 {{ formatDuration(total) }}
        </div>
        <div v-if="state.routeName" class="text-caption text-medium-emphasis mt-1">
          {{ state.routeName }} · {{ Number(state.distanceKm || 0).toFixed(2) }} km
          <span v-if="state.jittered">（已加随机浮动）</span>
        </div>
      </VCardText>
      <VDivider />
      <VCardActions class="justify-center py-3">
        <VBtn
          v-if="state.canSubmitNow"
          color="primary"
          variant="flat"
          prepend-icon="mdi-send-check"
          :loading="busy"
          @click="emit('submit')"
        >
          立即提交
        </VBtn>
        <VBtn
          v-if="state.canCancel"
          color="error"
          variant="text"
          prepend-icon="mdi-cancel"
          :disabled="busy"
          @click="emit('cancel')"
        >
          撤销这次跑步
        </VBtn>
      </VCardActions>
    </VCard>

    <VAlert type="success" variant="tonal" icon="mdi-check-circle-outline" class="mb-4">
      <strong>现在可以关掉这个页面。</strong>
      计时在本机程序里继续，到点会自动提交；重新打开网页会自动接上进度。
      只要本机的黑窗口（命令提示符）还开着就行。
    </VAlert>

    <VCard class="mb-4">
      <VCardTitle class="text-subtitle-2">
        <VIcon start icon="mdi-progress-check" size="18" />执行步骤
      </VCardTitle>
      <VCardText>
        <VTimeline density="compact" side="end" align="start" truncate-line="both">
          <VTimelineItem
            v-for="s in steps"
            :key="s.title"
            :dot-color="s.done ? 'success' : s.active ? 'primary' : 'grey-lighten-1'"
            :icon="s.done ? 'mdi-check' : undefined"
            size="small"
          >
            <div :class="['text-body-2', { 'text-medium-emphasis': !s.done && !s.active }]">
              {{ s.title }}
              <span v-if="s.detail" class="text-caption text-medium-emphasis ml-2">{{ s.detail }}</span>
            </div>
          </VTimelineItem>
        </VTimeline>
      </VCardText>
    </VCard>

    <LogPanel :entries="state.log || []" title="这一步在做什么" :height="260" />
  </div>
</template>
