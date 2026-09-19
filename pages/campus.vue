<script setup lang="ts">
/**
 * 校园跑 —— 全程序的主线。一个页面三种形态，由服务端状态决定：
 *
 *   设置（idle）→ 执行（waiting）→ 结果（done / failed / cancelled）
 *
 * 之所以由状态决定而不是由用户点来点去：状态在服务端，
 * 刷新页面、关掉浏览器再打开，都会回到正确的那一屏。
 */
import { ensureNotifyPermission, notifyDone } from '~/utils/notify'

import type { RulesInfo, RouteItem } from '~/types/api'

const api = useApi()
const { status, refresh } = useStatus()
const { state: run, busy, ensurePolling, start, submitNow, cancel, reset } = useRun()

const rules = ref<RulesInfo | null>(null)
const routes = ref<RouteItem[]>([])
const routesLoading = ref(false)
const error = ref<string | null>(null)
const defaultRouteId = ref<number | null>(null)

const view = computed(() => {
  const p = run.value.phase
  if (['starting', 'waiting', 'submitting', 'interrupted'].includes(p)) return 'execution'
  if (['done', 'failed', 'cancelled'].includes(p)) return 'result'
  return 'setup'
})

async function load() {
  error.value = null
  await refresh()
  if (!status.value?.loggedIn) return

  rules.value = await api.get<RulesInfo>('/api/rules').catch(() => null)

  routesLoading.value = true
  try {
    const res = await api.get<{ items: RouteItem[] }>('/api/routes')
    routes.value = res.items || []
    if (!routes.value.length) error.value = '没有读到任何可用跑道，请到「诊断」页看看接口是否正常。'
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    routesLoading.value = false
  }

  const remembered = Number(localStorage.getItem('sunshine.lastRouteId') || 0)
  defaultRouteId.value = routes.value.some(r => r.id === remembered) ? remembered : null
}

async function onStart(params: Record<string, unknown>) {
  error.value = null
  try {
    localStorage.setItem('sunshine.lastRouteId', String(params.routeId))
    // 借用这次点击（用户手势）申请通知权限，否则等到 12 分钟后浏览器会拒绝
    ensureNotifyPermission()
    await start(params)
  } catch (e) {
    error.value = (e as Error).message
  }
}

/**
 * 到点提交完要主动喊人 —— 等十几分钟期间用户肯定切走了。
 * 只认「等待 → 结束」这一次跃迁，避免刷新页面时重复提醒。
 */
watch(() => run.value.phase, (now, before) => {
  if (before !== 'waiting' && before !== 'submitting') return
  if (!['done', 'failed', 'cancelled'].includes(now)) return
  const result = (run.value.result || {}) as Record<string, unknown>
  if (now === 'done' && Number(result.status) === 1) {
    notifyDone('✅ 校园跑已完成', `${run.value.routeName || ''} ${run.value.distanceKm}km，记录号 ${result.id}`)
  } else if (now === 'done') {
    notifyDone('⚠️ 记录被判无效', String(result.invalidReason || '服务端判定这条记录无效'))
  } else if (now === 'cancelled') {
    notifyDone('跑步已撤销', '这次没有产生任何记录')
  } else {
    notifyDone('⚠️ 跑步没有完成', run.value.error || '请查看页面上的说明')
  }
})

async function onCancel() {
  try {
    await cancel()
  } catch (e) {
    error.value = (e as Error).message
  }
}

async function onAgain() {
  await reset()
  await load()
}

async function refreshRoutes() {
  routesLoading.value = true
  try {
    const res = await api.get<{ items: RouteItem[] }>('/api/routes?refresh=1')
    routes.value = res.items || []
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    routesLoading.value = false
  }
}

onMounted(() => {
  ensurePolling()
  load()
})
</script>

<template>
  <div>
    <!-- 没有接入 -->
    <VCard v-if="status && !status.loggedIn">
      <VCardTitle class="text-h6">先接入学校账号</VCardTitle>
      <VCardText>
        <p class="text-body-2">
          校园跑需要用到你的账号和学校下发的跑步规则。点下面的按钮走一遍接入向导，
          或者先打开演练模式熟悉流程。
        </p>
      </VCardText>
      <VCardActions class="px-4 pb-4">
        <VBtn color="primary" to="/setup" prepend-icon="mdi-key-variant">去接入</VBtn>
      </VCardActions>
    </VCard>

    <template v-else>
      <VAlert
        v-if="status?.mode === 'demo'"
        type="warning"
        variant="tonal"
        density="comfortable"
        class="mb-4"
        icon="mdi-flask-outline"
      >
        <strong>演练模式：这次走的是和真实完全一样的校园跑流程</strong> ——
        建会话 → 生成轨迹 → 打卡点复算 → 学校规则计时 → 到点自动提交。
        唯一的区别是请求打到本机的假后端：不碰你的账号，也不会在学校系统里留下记录。
        所以它<strong>和真跑一样要等满时间</strong>。
      </VAlert>

      <VAlert v-if="error" type="error" variant="tonal" class="mb-4" closable @click:close="error = null">
        {{ error }}
      </VAlert>

      <!-- 设置 -->
      <template v-if="view === 'setup'">
        <VCard class="mb-4">
          <VCardTitle class="text-h6">
            <VIcon start icon="mdi-run-fast" />校园跑
          </VCardTitle>
          <VCardText class="text-body-2">
            校园跑是<strong>唯一计入学期标准</strong>的跑步方式：学校服务器亲自计时、
            亲自核对打卡点，所以它要求真的等够时间。
            助手负责生成合法轨迹、盯住打卡点、到点自动提交。
          </VCardText>
        </VCard>

        <RuleCard :rules="rules" class="mb-4" />

        <RunSetup
          :rules="rules"
          :routes="routes"
          :routes-loading="routesLoading"
          :default-route-id="defaultRouteId"
          :jitter-default="status?.jitter"
          :demo="status?.mode === 'demo'"
          :busy="busy"
          @start="onStart"
        />

        <div class="text-center mt-4">
          <VBtn variant="text" size="small" prepend-icon="mdi-refresh" :loading="routesLoading" @click="refreshRoutes">
            重新扫描跑道列表
          </VBtn>
        </div>
      </template>

      <!-- 执行 -->
      <RunExecution
        v-else-if="view === 'execution'"
        :state="run"
        :busy="busy"
        @submit="submitNow(false)"
        @cancel="onCancel"
      />

      <!-- 结果 -->
      <RunResult v-else :state="run" @again="onAgain" />
    </template>
  </div>
</template>
