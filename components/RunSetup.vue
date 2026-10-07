<script setup lang="ts">
/**
 * 校园跑设置 —— 选路线、**手填**里程与用时，并实时预演一遍。
 *
 * 为什么是手填而不是滑杆（2026-10-07 改）：
 *   滑杆的上下限来自学校规则。而实测有的学校/学期**根本不下发规则**
 *   （`GET /run-rules/current` 返回 `{code:200,message:"成功"}`，连 data 都没有），
 *   此时滑杆没有可用的区间 —— 要么被禁用点不动，要么给一个编出来的范围。
 *   里程和用时的真实来源是学校下发的规则，规则没有就应当由使用者填，
 *   程序负责「校验 + 预演 + 拦截」，而不是假装知道区间。
 *
 * 预演（POST /api/run/plan）只在本机算，不创建会话、不发写请求，
 * 所以参数怎么填都不会产生脏数据；等到「开始跑步」才真的建会话。
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
const distanceInput = ref<number | null>(null)
const minutesInput = ref<number | null>(null)
const secondsInput = ref<number | null>(null)
const jitter = ref(Boolean(props.jitterDefault))
const preview = ref<RunPreview | null>(null)
const previewError = ref<string | null>(null)
const previewing = ref(false)
const inited = ref(false)

const r = computed<RulesInfo>(() => props.rules || { known: false, lines: [] })
const hasRules = computed(() => Boolean(props.rules?.known))

/** 手填的数值 → 计算值。填了才算数，不替用户猜 */
const distanceKm = computed(() => {
  const v = Number(distanceInput.value)
  return Number.isFinite(v) && v > 0 ? Number(v.toFixed(2)) : 0
})
const durationSec = computed(() => {
  const m = Math.max(0, Math.floor(Number(minutesInput.value) || 0))
  const s = Math.min(59, Math.max(0, Math.floor(Number(secondsInput.value) || 0)))
  return m * 60 + s
})
const paceText = computed(() =>
  distanceKm.value > 0 && durationSec.value > 0 ? `${formatPace(durationSec.value, distanceKm.value)}/km` : '—')

/** 这一档里程对应的、规则允许的用时窗口（秒）；规则没下发就是 0 ~ ∞ */
const timeWindow = computed(() => {
  const d = distanceKm.value
  const minT = r.value.minDurationSec ?? 0
  const maxT = r.value.maxDurationSec ?? Number.POSITIVE_INFINITY
  const minPace = r.value.minPaceSec ?? 0
  const maxPace = r.value.maxPaceSec ?? Number.POSITIVE_INFINITY
  return {
    lo: Math.max(minT, minPace * d),
    hi: Math.min(maxT, maxPace * d),
  }
})

/** 学校到底有没有给「用时」这件事设限（没设就别显示一个编出来的区间） */
const hasTimeLimit = computed(() =>
  r.value.minDurationSec != null || r.value.maxDurationSec != null
  || r.value.minPaceSec != null || r.value.maxPaceSec != null)

const windowInvalid = computed(() =>
  hasTimeLimit.value && !(timeWindow.value.hi > 0 && timeWindow.value.hi >= timeWindow.value.lo))

/** 只做**格式**校验；「是否违反学校规则」交给预演（那份才是权威） */
const durationSecZero = computed(() => durationSec.value <= 0)
const inputIssues = computed(() => {
  const list: string[] = []
  if (!(distanceKm.value > 0)) list.push('里程请填一个大于 0 的数字')
  if (durationSecZero.value) list.push('用时请填「分」或「秒」')
  else if (durationSec.value < 60) list.push('用时至少 1 分钟')
  return list
})

/** 低于已知的最低里程时给一句提示（学校规则 / 达标标准推导都算） */
const belowMinKm = computed(() => {
  const minKm = r.value.minDistanceKm
  if (minKm == null || !(distanceKm.value > 0)) return null
  return distanceKm.value + 1e-9 < minKm ? minKm : null
})

const minKmHint = computed(() => {
  const minKm = r.value.minDistanceKm
  if (minKm == null) return null
  return { minKm, from: r.value.derived ? '本学期达标标准推导' : '学校下发规则' }
})

async function runPreview() {
  if (!routeId.value || distanceKm.value <= 0 || durationSec.value <= 0) return
  previewing.value = true
  previewError.value = null
  try {
    preview.value = await plan({
      routeId: routeId.value,
      distanceKm: distanceKm.value,
      durationSec: durationSec.value,
      jitter: jitter.value,
    })
    // ⚠️ 不回填用户填的数值：手填的就是要发的（服务端只会四舍五入到 2 位小数）
    if (preview.value?.distanceKm && Math.abs(preview.value.distanceKm - distanceKm.value) > 0.02) {
      distanceInput.value = preview.value.distanceKm
    }
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

/**
 * 首次进来：路线选第一条，里程/用时给一组**保守默认值**（用户随时改）。
 * 默认里程优先用已知下限（学校规则或达标标准推导），没有就用 2km；
 * 默认用时按 6'00"/km 折算。
 */
async function init() {
  if (inited.value || !props.routes.length) return
  inited.value = true
  routeId.value = props.defaultRouteId && props.routes.some(x => x.id === props.defaultRouteId)
    ? props.defaultRouteId
    : props.routes[0].id
  if (distanceInput.value == null) distanceInput.value = r.value.minDistanceKm ?? 2
  if (minutesInput.value == null && secondsInput.value == null) {
    const sec = Math.round(distanceKm.value * 360) // 6'00"/km
    minutesInput.value = Math.floor(sec / 60)
    secondsInput.value = sec % 60
  }
  await runPreview()
}

watch(() => props.routes.length, init)
watch([routeId, distanceInput, minutesInput, secondsInput, jitter], () => {
  if (inited.value) schedulePreview()
})

const routeLabel = (rt: RouteItem) =>
  `${rt.name} · ${rt.checkpointCount} 个打卡点${rt.startLatitude ? '' : '（无起点坐标）'}`

const canStart = computed(() =>
  Boolean(preview.value?.ok) && !windowInvalid.value && !props.busy
  && Boolean(routeId.value) && distanceKm.value > 0 && durationSec.value > 0)

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
        <VIcon start icon="mdi-tune" />2. 填里程与用时
      </VCardTitle>
      <VCardText>
        <VAlert
          v-if="!hasRules"
          type="info"
          variant="tonal"
          density="compact"
          class="mb-4"
        >
          学校没有下发跑步规则，里程与用时由你填（默认给了一组保守值）。
          程序仍会在提交前算出轨迹、复算打卡点，并按已知的达标标准提醒你是否偏短。
        </VAlert>
        <VRow dense>
          <VCol cols="12" sm="5">
            <VTextField
              v-model.number="distanceInput"
              type="number"
              label="里程"
              suffix="km"
              variant="outlined"
              density="comfortable"
              :min="0.1"
              :max="50"
              step="0.01"
              hide-details="auto"
              placeholder="例如 2.00"
            />
            <div class="text-caption text-medium-emphasis mt-1">
              <template v-if="minKmHint">
                已知下限 {{ minKmHint.minKm }} km（{{ minKmHint.from }}）
              </template>
              <template v-else>学校未下发里程要求，按需填写</template>
            </div>
          </VCol>
          <VCol cols="6" sm="3">
            <VTextField
              v-model.number="minutesInput"
              type="number"
              label="用时"
              suffix="分"
              variant="outlined"
              density="comfortable"
              :min="0"
              :max="600"
              step="1"
              hide-details="auto"
              placeholder="12"
            />
          </VCol>
          <VCol cols="6" sm="2">
            <VTextField
              v-model.number="secondsInput"
              type="number"
              label=" "
              suffix="秒"
              variant="outlined"
              density="comfortable"
              :min="0"
              :max="59"
              step="1"
              hide-details="auto"
              placeholder="0"
            />
          </VCol>
          <VCol cols="12" sm="2" class="d-flex align-center">
            <VChip size="small" variant="tonal" color="secondary">
              配速 {{ paceText }}
            </VChip>
          </VCol>
        </VRow>

        <div class="text-caption text-medium-emphasis mt-2">
          <template v-if="hasTimeLimit && !windowInvalid">
            学校允许的用时：{{ formatDuration(timeWindow.lo) }} ~ {{ formatDuration(timeWindow.hi) }}
          </template>
          <template v-else-if="windowInvalid">
            这个里程在当前规则下凑不出合法用时，请调整里程或用时。
          </template>
          <template v-else>
            学校未下发用时限制，程序提交前仍会做轨迹体检与打卡点复算。
          </template>
        </div>

        <VAlert
          v-for="msg in inputIssues"
          :key="msg"
          type="warning"
          variant="tonal"
          density="compact"
          class="mt-3"
        >
          {{ msg }}
        </VAlert>
        <VAlert
          v-if="belowMinKm"
          type="warning"
          variant="tonal"
          density="compact"
          class="mt-3"
        >
          里程 {{ distanceKm.toFixed(2) }} km 低于{{ r.derived ? '本学期达标标准' : '学校要求' }}的
          {{ belowMinKm }} km，这条记录可能不计入有效次数。
        </VAlert>

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
          <VAlert
            v-if="preview.issues?.length"
            type="warning"
            variant="tonal"
            density="compact"
            class="mb-3"
          >
            <div class="font-weight-medium mb-1">按服务端规则算下来有问题：</div>
            <ul class="rule-lines mb-0">
              <li v-for="i in preview.issues" :key="i.code">{{ i.text }}</li>
            </ul>
          </VAlert>
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
          选好跑道、填好里程与用时后，这里会先算一遍轨迹会发生什么。
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
      {{ demo ? '开始演练' : '开始跑步' }}（{{ distanceKm.toFixed(1) }} km / {{ formatDuration(durationSec) }}）
    </VBtn>
    <p v-if="!canStart && !busy" class="text-caption text-medium-emphasis text-center mt-2">
      预演通过后才能开始。
    </p>
  </div>
</template>
