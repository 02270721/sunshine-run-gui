<script setup lang="ts">
/**
 * 一键抓凭证向导 —— 给「只有 PC 微信、没有微信开发者工具」的人用。
 *
 * 它会临时做两件敏感的事，所以页面上必须写清楚，并且必须由用户勾选确认后才开始：
 *   1. 装一张**临时**根证书（用完立刻删）
 *   2. 把系统代理临时指向本机代理（用完立刻还原）
 *
 * 抓取本身只解密 *.sqcoe.com 的流量，其余域名原样直通。
 */
const api = useApi()
const { refresh } = useStatus()

interface CaptureStep {
  key: string
  title: string
  status: 'pending' | 'running' | 'done' | 'failed'
  detail?: string
}

interface CaptureState {
  running: boolean
  phase: 'idle' | 'preparing' | 'waiting' | 'captured' | 'failed' | 'stopped'
  port: number
  steps: CaptureStep[]
  log: { t: string, level: string, text: string }[]
  captured: { at: string, host: string, path: string, tokenPrefix: string, source: string } | null
  user: { name?: string, studentName?: string, studentId?: string, studyCode?: string } | null
  error: string | null
  allowHosts: string[]
  platformSupported: boolean
}

const state = ref<CaptureState | null>(null)
const agreed = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

const active = computed(() => Boolean(state.value?.running))

const stepIcon = (s: CaptureStep) =>
  s.status === 'done' ? 'mdi-check-circle'
  : s.status === 'failed' ? 'mdi-close-circle'
  : s.status === 'running' ? 'mdi-progress-clock' : 'mdi-circle-outline'

const stepColor = (s: CaptureStep) =>
  s.status === 'done' ? 'success' : s.status === 'failed' ? 'error' : s.status === 'running' ? 'primary' : 'grey'

async function poll() {
  try {
    state.value = await api.get<CaptureState>('/api/capture/state')
    if (!state.value.running && timer) stopPolling()
    if (state.value.phase === 'captured') refresh()
  } catch { /* 忽略单次失败 */ }
}

function startPolling() {
  if (timer) return
  timer = setInterval(poll, 1000)
}

function stopPolling() {
  if (timer) { clearInterval(timer); timer = null }
}

async function begin() {
  busy.value = true
  error.value = null
  try {
    state.value = await api.post<CaptureState>('/api/capture/start', {})
    startPolling()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

async function stopIt() {
  busy.value = true
  try {
    state.value = await api.post<CaptureState>('/api/capture/stop', {})
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
    stopPolling()
  }
}

function dismiss() {
  state.value = null
  error.value = null
  agreed.value = false
}

onMounted(async () => {
  await poll()
  if (state.value?.running) startPolling()
})
onUnmounted(stopPolling)
</script>

<template>
  <VCard class="mb-4">
    <VCardTitle class="text-subtitle-1 d-flex align-center">
      <VIcon start icon="mdi-auto-fix" />
      一键自动抓取凭证
      <VChip size="small" color="primary" variant="tonal" class="ml-3">推荐</VChip>
    </VCardTitle>

    <VCardText>
      <!-- 还没开始 -->
      <template v-if="!state || state.phase === 'idle' || state.phase === 'stopped'">
        <p class="text-body-2">
          只要电脑上装了 <strong>PC 微信</strong>，不用开发者工具也能拿到凭证：
          程序会临时接管系统代理，在你自己电脑上把登录凭证取出来，然后立刻收拾干净。
        </p>

        <VAlert type="warning" variant="tonal" density="comfortable" class="my-3">
          <div class="font-weight-medium mb-1">它会临时做两件敏感的事，用完自动还原：</div>
          <ul class="mb-0 pl-5">
            <li>装一张<strong>临时根证书</strong>（现生成、有效期 7 天，抓完立刻从证书库删除）——Windows 会弹一次确认框</li>
            <li>把<strong>系统代理</strong>临时指向本机（抓完自动还原成原来的设置）</li>
          </ul>
          <div class="mt-2">
            抓取过程<strong>只解密 {{ (state?.allowHosts || ['sports.sqcoe.com']).join(' / ') }}</strong> 的流量，
            其它网站原样直通、看不到内容；也不会保存任何流量内容。
          </div>
        </VAlert>

        <VAlert v-if="!state?.platformSupported" type="info" variant="tonal" density="compact">
          这个功能只支持 Windows（要用到系统证书库和系统代理）。其它系统请用手动方式。
        </VAlert>

        <VCheckbox
          v-else
          v-model="agreed"
          density="comfortable"
          hide-details
          label="我了解它会临时修改系统代理并安装一张临时证书，抓完会自动还原"
        />

        <VAlert v-if="error" type="error" variant="tonal" density="compact" class="mt-3">{{ error }}</VAlert>

        <VBtn
          class="mt-3"
          color="primary"
          size="large"
          prepend-icon="mdi-auto-fix"
          :disabled="!agreed || !state?.platformSupported"
          :loading="busy"
          @click="begin"
        >
          开始自动抓取
        </VBtn>
      </template>

      <!-- 进行中 -->
      <template v-else-if="active">
        <VAlert type="info" variant="tonal" class="mb-3">
          <div class="font-weight-medium mb-1">现在按顺序做这三步：</div>
          <ol class="mb-0 pl-5">
            <li><strong>完全退出 PC 微信</strong>（右下角托盘也要退出，不只是关窗口）</li>
            <li><strong>重新打开微信</strong> —— 微信只在启动时读一次系统代理，不重启就走了老路</li>
            <li>进入「酷动·阳光跑」小程序，完成微信登录</li>
          </ol>
          <div class="mt-2 text-caption">
            登录成功后这里会自动抓到凭证并收尾，不用你点任何东西。
          </div>
        </VAlert>

        <VList density="compact" class="py-0">
          <VListItem v-for="s in state.steps" :key="s.key">
            <template #prepend>
              <VProgressCircular v-if="s.status === 'running'" indeterminate size="18" width="2" />
              <VIcon v-else :icon="stepIcon(s)" :color="stepColor(s)" />
            </template>
            <VListItemTitle class="text-body-2">{{ s.title }}</VListItemTitle>
            <VListItemSubtitle v-if="s.detail" class="text-caption">{{ s.detail }}</VListItemSubtitle>
          </VListItem>
        </VList>

        <LogPanel :entries="state.log" title="抓取过程" :height="180" class="mt-3" />

        <VBtn class="mt-3" variant="text" color="error" prepend-icon="mdi-cancel" :loading="busy" @click="stopIt">
          停止并还原系统
        </VBtn>
      </template>

      <!-- 成功 -->
      <template v-else-if="state.phase === 'captured'">
        <VAlert type="success" variant="tonal" class="mb-3">
          <div class="text-body-1 font-weight-medium">
            ✓ 已抓到并保存凭证{{ state.user?.name || state.user?.studentName ? `：${state.user.name || state.user.studentName}` : '' }}
          </div>
          <div class="text-caption mt-1">
            系统代理已还原，临时证书已从证书库删除。凭证只保存在这台电脑的
            <code>.data/credentials.json</code> 里。
          </div>
        </VAlert>

        <VAlert type="warning" variant="tonal" density="comfortable" class="mb-3">
          <strong>最后一步：再重启一次 PC 微信。</strong>
          它启动时记住的还是那个临时代理，不重启的话微信会连不上网（网页不受影响）。
        </VAlert>

        <LogPanel :entries="state.log" title="抓取过程" :height="160" class="mb-3" />

        <VBtn color="primary" prepend-icon="mdi-check" @click="dismiss">我知道了</VBtn>
      </template>

      <!-- 失败 -->
      <template v-else>
        <VAlert type="error" variant="tonal" class="mb-3">
          <div class="font-weight-medium">抓取没有成功</div>
          <div class="text-body-2 mt-1">{{ state.error || '没有抓到凭证（可能是没等到登录，或中途停止了）' }}</div>
          <div class="text-caption mt-1">系统代理和证书已经还原，不会有残留。</div>
        </VAlert>

        <LogPanel :entries="state.log" title="抓取过程" :height="160" class="mb-3" />

        <div class="d-flex ga-2">
          <VBtn color="primary" prepend-icon="mdi-refresh" :loading="busy" @click="dismiss">重新试一次</VBtn>
          <VBtn variant="text" @click="dismiss">用手动方式</VBtn>
        </div>
      </template>
    </VCardText>
  </VCard>
</template>
