<script setup lang="ts">
/**
 * 结果页 —— 记录到底算不算数，这里给一个不含糊的结论。
 *
 * 服务端 status：1 = 有效，2 = 无效（附 invalidReason）。
 * 无效记录不计入学期统计，而且协议里没有删除接口，所以在提交前就要拦住。
 */
import type { RunSnapshot } from '~/composables/useRun'
import { formatDuration } from '~/utils/format'

const props = defineProps<{ state: RunSnapshot }>()
const emit = defineEmits<{ (e: 'again'): void }>()

const result = computed(() => (props.state.result || {}) as Record<string, any>)
const status = computed(() => Number(result.value.status))
const valid = computed(() => props.state.phase === 'done' && status.value === 1)
const invalid = computed(() => props.state.phase === 'done' && status.value === 2)

const headline = computed(() => {
  if (valid.value) return '记录有效，已经计入学期统计'
  if (invalid.value) return '服务端判定这条记录无效'
  if (props.state.phase === 'cancelled') return '这次跑步已撤销，没有产生任何记录'
  return '这次跑步没有完成'
})

const reason = computed(() => {
  if (invalid.value) return result.value.invalidReason || '服务端没有说明原因'
  return props.state.error || null
})

const color = computed(() => (valid.value ? 'success' : props.state.phase === 'cancelled' ? 'info' : 'error'))
const icon = computed(() => (valid.value ? 'mdi-check-decagram' : props.state.phase === 'cancelled' ? 'mdi-cancel' : 'mdi-alert-circle-outline'))
</script>

<template>
  <div>
    <VCard :color="color" variant="tonal" class="mb-4">
      <VCardText class="text-center py-6">
        <VIcon :icon="icon" size="56" />
        <div class="text-h6 mt-2">{{ headline }}</div>
        <div v-if="reason" class="text-body-2 mt-2">{{ reason }}</div>
        <div v-if="valid && result.id" class="text-caption mt-2">记录号 {{ result.id }}</div>
      </VCardText>
    </VCard>

    <VCard v-if="state.track || result.distance" class="mb-4">
      <VCardTitle class="text-subtitle-2">
        <VIcon start icon="mdi-chart-box-outline" size="18" />这次跑了什么
      </VCardTitle>
      <VCardText>
        <VRow>
          <VCol cols="6" sm="3">
            <div class="text-caption text-medium-emphasis">里程</div>
            <div class="text-h6">{{ Number(result.distance ?? state.distanceKm ?? 0).toFixed(2) }} km</div>
          </VCol>
          <VCol cols="6" sm="3">
            <div class="text-caption text-medium-emphasis">用时</div>
            <div class="text-h6">{{ formatDuration(result.duration ?? state.durationSec) }}</div>
          </VCol>
          <VCol cols="6" sm="3">
            <div class="text-caption text-medium-emphasis">配速</div>
            <div class="text-h6">{{ result.pace || '—' }}</div>
          </VCol>
          <VCol cols="6" sm="3">
            <div class="text-caption text-medium-emphasis">消耗</div>
            <div class="text-h6">{{ result.calories ?? '—' }} kcal</div>
          </VCol>
        </VRow>
        <VDivider class="my-3" />
        <div class="text-body-2">
          <span v-if="state.routeName">跑道：{{ state.routeName }}　</span>
          <span v-if="state.track">轨迹 {{ state.track.pointCount }} 点 / {{ state.track.laps }} 圈　</span>
          <span v-if="state.checkpoints">
            打卡点 {{ result.passedCheckpointCount ?? state.checkpoints.passed }}/{{ result.selectedCheckpointCount ?? state.checkpoints.total }}
          </span>
        </div>
        <div v-if="result.runDate" class="text-caption text-medium-emphasis mt-1">
          学校记录的日期：{{ result.runDate }}
          <span v-if="result.startTime"> · {{ result.startTime }} → {{ result.endTime }}</span>
        </div>
      </VCardText>
    </VCard>

    <VAlert v-if="invalid" type="warning" variant="tonal" class="mb-4">
      无效记录不计入学期标准，而且这套协议**没有删除记录的接口** —— 所以程序会在提交前
      先做一遍体检，尽量不让你产生无效记录。这次的失败原因见上面。
    </VAlert>

    <VCardActions class="justify-center">
      <VBtn color="primary" prepend-icon="mdi-restart" @click="emit('again')">
        再来一次
      </VBtn>
      <VBtn variant="text" prepend-icon="mdi-chart-timeline-variant" to="/records">
        查看跑步记录
      </VBtn>
    </VCardActions>

    <LogPanel :entries="state.log || []" title="这次跑步的完整过程" :height="240" class="mt-4" />
  </div>
</template>
