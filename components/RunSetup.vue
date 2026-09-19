<script setup lang="ts">
/**
 * 校园跑设置 —— 选路线、定里程与用时，并**实时预演**一遍。
 *
 * 预演（POST /api/run/plan）只在本机算，不创建会话、不发写请求，
 * 所以参数怎么调都不会产生脏数据；等到「开始跑步」才真的建会话。
 */
import { formatDuration, formatPace } from '~/utils/format'
import type { RouteItem, RulesInfo, RunPreview } from '~/types/api'

const props = defineProps<{
  rules: RulesInfo | null
  routes: RouteItem[]
  routesLoading?: boolean
  defaultRouteId?: number | null
  jitterDefault?: boolean
  busy?: boolean
  /** 演练模式：流程与真实一致，但后端是本机假后端（提示文案不同） */
  demo?: boolean
}>()

const emit = defineEmits<{ (e: 'start', v: Record<string, unknown>): void }>()

const { plan } = useRun()

const routeId = ref<number | null>(null)
const distanceKm = ref(0)
const durationSec = ref(0)
const jitter = ref(Boolean(props.jitterDefault))
const preview = ref<RunPreview | null>(null)
const previewError = ref<string | null>(null)
const previewing = ref(false)
const inited = ref(false)

const r = computed<RulesInfo>(() => props.rules || { known: false, lines: [] })
const hasRules = computed(() => Boolean(props.rules?.known))

/** 这条里程对应的、规则允许的用时窗口（秒） */
const timeWindow = computed(() => {
  const d = Number(distanceKm.value || 0)
  const minT = r.value.minDurationSec ?? 0
  const maxT = r.value.maxDurationSec ?? Number.POSITIVE_INFINITY
  const minPace = r.value.minPaceSec ?? 0
  const maxPace = r.value.maxPaceSec ?? Number.POSITIVE_INFINITY
  return {
    lo: Math.max(minT, minPace * d),
    hi: Math.min(maxT, maxPace * d),
  }
})

const windowInvalid = computed(() => !(timeWindow.value.hi > 0 && timeWindow.value.hi >= timeWindow.value.lo))
const step = computed(() => {
  const span = timeWindow.value.hi - timeWindow.value.lo
  return Math.max(1, Math.min(15, Math.round(span / 40) || 1))
})

const paceText = computed(() => formatPace(durationSec.value, distanceKm.value))

const distanceItems = computed(() => {
  const range = r.value.distanceRange
  if (!range) return { min: 0.5, max: 20, step: 0.1 }
  return { min: range.minKm, max: range.maxKm, step: 0.1 }
})

/** 规则的推荐上限是否真的比硬上限更低（低了才值得提示一句） */
const recommendMax = computed(() => {
  const range = r.value.distanceRange
  if (!range || range.recommendMaxKm >= range.maxKm) return null
  return range.recommendMaxKm
})

async function runPreview() {
  if (!routeId.value || !hasRules.value) return
  previewing.value = true
  previewError.value = null
  try {
    preview.value = await plan({
      routeId: routeId.value,
      distanceKm: distanceKm.value,
      durationSec: durationSec.value,
      jitter: jitter.value,
    })
    // 服务端会按规则把参数夹进合法区间，用它回填，保证「显示的就是要发的」
    if (preview.value?.distanceKm) distanceKm.value = preview.value.distanceKm
    if (preview.value?.durationSec) durationSec.value = preview.value.durationSec
  } catch (e) {
    previewError.value = (e as Error).message
    preview.value = null
  } finally {
    previewing.value = false
  }
}

let debounce: ReturnType<typeof setTimeout> | null = null
function schedulePreview() {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(runPreview, 350)
}

/** 首次进来：让服务端按规则挑一组默认参数（而不是前端写死 3km/12分钟） */
async function init() {
  if (inited.value || !props.routes.length || !hasRules.value) return
  inited.value = true
  routeId.value = props.defaultRouteId && props.routes.some(x => x.id === props.defaultRouteId)
    ? props.defaultRouteId
    : props.routes[0].id
  await runPreview()
}

watch(() => [props.routes.length, hasRules.value], init)
watch([routeId, distanceKm, durationSec, jitter], () => {
  if (inited.value) schedulePreview()
})

const routeLabel = (rt: RouteItem) =>
  `${rt.name} · ${rt.checkpointCount} 个打卡点${rt.startLatitude ? '' : '（无起点坐标）'}`

const canStart = computed(() =>
  Boolean(preview.value?.ok) && !windowInvalid.value && !props.busy && Boolean(routeId.value))

function start() {
  emit('start', {
    routeId: routeId.value,
    distanceKm: distanceKm.value,
    durationSec: durationSec.value,
    jitter: jitter.value,
  })
}
</script>

<template>
  <div>
    <VCard class="mb-4">
      <VCardTitle class="text-subtitle-1">
        <VIcon start icon="mdi-map-marker-path" />1. 选择跑道
      </VCardTitle>
      <VCardText>
        <VSelect
          v-model="routeId"
          :items="routes"
          :item-title="routeLabel"
          item-value="id"
          label="跑道"
          variant="outlined"
          density="comfortable"
          :loading="routesLoading"
          :disabled="!routes.length"
          hide-details="auto"
        >
          <template #prepend-item>
            <div class="text-caption text-medium-emphasis px-4 py-2">
              路线是从学校服务器读出来的（协议里没有「列出全部路线」的接口，只能逐条试，已缓存）
            </div>
            <VDivider class="mb-2" />
          </template>
        </VSelect>
        <div v-if="!routesLoading && !routes.length" class="text-caption text-warning mt-2">
          没读到任何路线。确认已接入账号，或打开「演练模式」先熟悉流程。
        </div>
      </VCardText>
    </VCard>

    <VCard class="mb-4">
      <VCardTitle class="text-subtitle-1">
        <VIcon start icon="mdi-tune" />2. 定里程与用时
      </VCardTitle>
      <VCardText>
        <div class="mb-2 d-flex align-center">
          <span class="text-body-2">里程</span>
          <VSpacer />
          <span class="text-h6">{{ Number(distanceKm || 0).toFixed(2) }} km</span>
        </div>
        <VSlider
          v-model="distanceKm"
          :min="distanceItems.min"
          :max="distanceItems.max"
          :step="distanceItems.step"
          :disabled="!hasRules"
          thumb-label
          color="primary"
          hide-details
        >
          <template #thumb-label="{ modelValue }">
            {{ Number(modelValue).toFixed(1) }}km
          </template>
        </VSlider>
        <div class="d-flex text-caption text-medium-emphasis mt-1">
          <span>{{ distanceItems.min }} km</span>
          <VSpacer />
          <span v-if="recommendMax">
            按正常慢跑配速，建议不超过 {{ recommendMax.toFixed(1) }} km
          </span>
          <span v-else>{{ distanceItems.max }} km</span>
        </div>

        <VDivider class="my-4" />

        <div class="mb-2 d-flex align-center">
          <span class="text-body-2">用时</span>
          <VSpacer />
          <span class="text-h6">{{ formatDuration(durationSec) }}</span>
          <VChip size="small" variant="tonal" color="secondary" class="ml-3">
            配速 {{ paceText }}/km
          </VChip>
        </div>
        <VSlider
          v-model="durationSec"
          :min="Math.round(timeWindow.lo)"
          :max="Math.round(timeWindow.hi)"
          :step="step"
          :disabled="!hasRules || windowInvalid"
          thumb-label
          color="secondary"
          hide-details
        >
          <template #thumb-label="{ modelValue }">
            {{ formatDuration(Number(modelValue)) }}
          </template>
        </VSlider>
        <div class="d-flex text-caption text-medium-emphasis mt-1">
          <span>{{ formatDuration(timeWindow.lo) }}</span>
          <VSpacer />
          <span>{{ formatDuration(timeWindow.hi) }}</span>
        </div>
        <p class="text-caption text-medium-emphasis mt-2 mb-0">
          滑杆两端就是学校允许的用时范围：超出上限的记录会被判无效，低于下限也一样。
        </p>

        <VDivider class="my-4" />

        <div class="d-flex align-center">
          <div>
            <div class="text-body-2">随机浮动</div>
            <div class="text-caption text-medium-emphasis">
              在目标值上做 ±0.09km / ±0.15km/h 的小幅浮动（同 totoro-paradise），
              让每条记录略有不同；浮动后仍会重新校验学校规则。
            </div>
          </div>
          <VSpacer />
          <VSwitch v-model="jitter" color="primary" hide-details />
        </div>
      </VCardText>
    </VCard>

    <VCard class="mb-4">
      <VCardTitle class="text-subtitle-1 d-flex align-center">
        <VIcon start icon="mdi-clipboard-check-outline" />3. 先预演一遍
        <VSpacer />
        <VProgressCircular v-if="previewing" indeterminate size="16" />
      </VCardTitle>
      <VCardText>
        <VAlert v-if="windowInvalid" type="warning" variant="tonal" density="compact">
          这个里程在当前规则下凑不出合法用时，请调整里程。
        </VAlert>

        <VAlert v-else-if="previewError" type="error" variant="tonal" density="compact">
          {{ previewError }}
        </VAlert>

        <template v-else-if="preview">
          <VRow>
            <VCol cols="12" sm="7">
              <VList density="compact" class="py-0">
                <VListItem prepend-icon="mdi-map-marker-distance">
                  <VListItemTitle class="text-body-2">
                    轨迹 {{ preview.track?.pointCount }} 个点 ·
                    {{ Number(preview.track?.actualKm).toFixed(2) }} km ·
                    绕 {{ preview.track?.laps }} 圈
                  </VListItemTitle>
                </VListItem>
                <VListItem prepend-icon="mdi-replay">
                  <VListItemTitle class="text-body-2">
                    真机算法重放：入点 {{ preview.replay?.input }} → 接受 {{ preview.replay?.accepted }}
                    <span v-if="preview.replay?.dropped" class="text-warning">
                      （丢 {{ preview.replay.dropped }} 个点）
                    </span>
                    <span v-else class="text-success">（无丢失）</span>
                  </VListItemTitle>
                  <VListItemSubtitle class="text-caption">
                    真机的中值滤波会削掉一点弧长，重放后约
                    {{ (Number(preview.replay?.meters || 0) / 1000).toFixed(2) }} km；
                    申报里程仍用完整轨迹长度，否则会掉到学校最低里程以下
                  </VListItemSubtitle>
                </VListItem>
                <VListItem :prepend-icon="preview.checkpoints?.passed === preview.checkpoints?.total ? 'mdi-check-circle-outline' : 'mdi-alert-outline'">
                  <VListItemTitle class="text-body-2">
                    打卡点 {{ preview.checkpoints?.passed }}/{{ preview.checkpoints?.total }}
                    <span class="text-caption text-medium-emphasis">
                      （{{ preview.checkpoints?.mode }}，命中半径 {{ preview.checkpoints?.radius }}m）
                    </span>
                  </VListItemTitle>
                </VListItem>
                <VListItem prepend-icon="mdi-timer-sand">
                  <VListItemTitle class="text-body-2">
                    实际会在 {{ preview.timing?.submitAtText }} 提交（{{ preview.timing?.note }}）
                  </VListItemTitle>
                </VListItem>
              </VList>

              <VAlert
                v-for="w in (preview.track?.warnings || [])"
                :key="w"
                type="warning"
                variant="tonal"
                density="compact"
                class="mt-2"
              >
                {{ w }}
              </VAlert>
              <VAlert
                v-if="preview.checkpoints && preview.checkpoints.passed < preview.checkpoints.total"
                type="error"
                variant="tonal"
                density="compact"
                class="mt-2"
              >
                有打卡点没经过，这条轨迹不会被提交。换一条路线，或调整里程（里程太短可能跑不完一圈）。
              </VAlert>
            </VCol>
            <VCol cols="12" sm="5">
              <RoutePreview :points="preview.route?.points || []" :height="170" />
              <div class="text-caption text-medium-emphasis mt-2">
                跑道单圈约 {{ preview.route?.lapMeters }} m，共 {{ preview.route?.checkpointCount }} 个打卡点
              </div>
            </VCol>
          </VRow>
        </template>

        <div v-else class="text-caption text-medium-emphasis">
          选好跑道与参数后，这里会先算一遍轨迹会发生什么。
        </div>
      </VCardText>
    </VCard>

    <VAlert v-if="demo" type="warning" variant="tonal" class="mb-4" icon="mdi-flask-outline">
      <strong>演练模式：流程和真实完全一致，只是后端换成了本机的假后端。</strong>
      建会话、生成轨迹、打卡点复算、学校规则计时、到点自动提交 —— 一步都不少，
      所以它<strong>和真跑一样要等满时间</strong>。好处是不需要账号，也不会在学校系统里留下记录。
    </VAlert>
    <VAlert v-else type="info" variant="tonal" class="mb-4">
      <strong>关于等待：</strong>校园跑的用时由学校服务器按「开始 → 提交」的真实间隔计算，
      所以点开始之后是真的要等这么久。等待期间<strong>可以关掉网页</strong>，
      计时在本机程序里继续跑，到点自动提交；重新打开页面会自动接上进度。
    </VAlert>

    <VBtn
      size="large"
      color="primary"
      block
      :disabled="!canStart"
      :loading="busy"
      prepend-icon="mdi-run-fast"
      @click="start"
    >
      {{ demo ? '开始演练' : '开始跑步' }}（{{ Number(distanceKm || 0).toFixed(1) }} km / {{ formatDuration(durationSec) }}）
    </VBtn>
    <p v-if="!canStart && !busy" class="text-caption text-medium-emphasis text-center mt-2">
      预演通过后才能开始。
    </p>
  </div>
</template>
