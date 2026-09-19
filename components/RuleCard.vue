<script setup lang="ts">
/**
 * 学校规则卡 —— 把服务端下发的规则（里程/时长/配速区间）翻译成大白话。
 * 规则随学校和学期变化，所以永远显示「当前生效」的，不写死。
 */
import type { RulesInfo } from '~/types/api'

defineProps<{
  rules: RulesInfo | null
  loading?: boolean
}>()

const mmss = (s?: number | null) => (s == null ? '—' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`)
</script>

<template>
  <VCard variant="tonal" color="primary">
    <VCardTitle class="d-flex align-center text-subtitle-1">
      <VIcon start icon="mdi-school-outline" />
      学校当前要求
      <VSpacer />
      <span v-if="rules?.semesterName" class="text-caption">{{ rules.semesterName }}</span>
    </VCardTitle>
    <VCardText>
      <div v-if="loading" class="d-flex align-center">
        <VProgressCircular indeterminate size="18" class="mr-2" />
        正在读取规则…
      </div>

      <template v-else-if="rules?.known">
        <ul class="rule-lines">
          <li v-for="line in rules.lines" :key="line">{{ line }}</li>
        </ul>
        <VDivider class="my-3" />
        <div class="d-flex flex-wrap ga-4 text-caption">
          <span>最低里程 <strong>{{ rules.minDistanceKm ?? '—' }} km</strong></span>
          <span>用时 <strong>{{ mmss(rules.minDurationSec) }} ~ {{ mmss(rules.maxDurationSec) }}</strong></span>
          <span v-if="rules.speedRangeKmh">速度 <strong>{{ rules.speedRangeKmh.min }} ~ {{ rules.speedRangeKmh.max }} km/h</strong></span>
          <span v-if="rules.distanceRange">可跑 <strong>{{ rules.distanceRange.minKm.toFixed(1) }} ~ {{ rules.distanceRange.maxKm.toFixed(1) }} km</strong></span>
        </div>
      </template>

      <VAlert v-else type="warning" variant="tonal" density="compact" class="mb-0">
        读不到学校规则（接口不可用或还没接入）。可以先完成「接入向导」。
      </VAlert>
    </VCardText>
  </VCard>
</template>

<style scoped>
.rule-lines { margin: 0; padding-left: 18px; line-height: 2; }
</style>
