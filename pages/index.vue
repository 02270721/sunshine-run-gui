<script setup lang="ts">
/**
 * 首页 —— 一眼看清三件事：我是谁、学校要求什么、还差多少次。
 * 未接入时只给两条路：接入向导（打真服务器）或演练模式（本机假后端，随时可退）。
 */
import type { RulesInfo } from '~/types/api'

const api = useApi()
const { status, refresh } = useStatus()
const { state: run, ensurePolling } = useRun()

interface RunRecord {
  id: number
  runDate: string
  distance: number
  duration: number
  pace: string
  status: number
  runType?: string
  routeName?: string
  invalidReason?: string
}

const rules = ref<RulesInfo | null>(null)
const stats = ref<Record<string, any> | null>(null)
const records = ref<RunRecord[]>([])
const loading = ref(true)
const switching = ref(false)

const standard = computed(() => stats.value?.standards?.[0] || null)
const overview = computed(() => stats.value?.overviewStats || null)
const progress = computed(() => {
  const s = standard.value
  if (!s?.standardValue) return 0
  return Math.min(100, Math.round(((s.currentValue || 0) / s.standardValue) * 100))
})

async function load() {
  loading.value = true
  try {
    await refresh()
    if (status.value?.loggedIn) {
      const [r, s, rec] = await Promise.all([
        api.get<RulesInfo>('/api/rules').catch(() => null),
        api.get<Record<string, any>>('/api/stats').catch(() => null),
        api.get<{ records: RunRecord[] }>('/api/records?page=1&size=3').catch(() => ({ records: [] })),
      ])
      rules.value = r
      stats.value = s
      records.value = rec?.records || []
    }
  } finally {
    loading.value = false
  }
}

async function startDemo() {
  switching.value = true
  try {
    await api.post('/api/config', { mode: 'demo' })
    await load()
  } finally {
    switching.value = false
  }
}

onMounted(() => {
  ensurePolling()
  load()
})
</script>

<template>
  <div>
    <VProgressLinear v-if="loading" indeterminate color="primary" class="mb-4" />

    <!-- 未接入 -->
    <template v-if="!loading && !status?.loggedIn">
      <VCard class="mb-4">
        <VCardTitle class="text-h6">欢迎使用阳光跑助手</VCardTitle>
        <VCardText>
          <p class="text-body-2">
            这是一个跑在学校「酷动·阳光跑」系统上的<strong>校园跑</strong>助手。
            它会在本机生成一条符合学校规则的轨迹，按学校要求真实计时，然后提交。
          </p>
          <p class="text-body-2 mb-0">
            开始之前需要接入一次你的账号 —— 这一步没法自动化，因为登录凭证只能从微信里取，
            程序自己拿不到。跟着向导走，两分钟就好。
          </p>
        </VCardText>
        <VCardActions class="px-4 pb-4">
          <VBtn color="primary" size="large" prepend-icon="mdi-key-variant" to="/setup">
            开始接入向导
          </VBtn>
          <VBtn
            variant="tonal"
            size="large"
            prepend-icon="mdi-flask-outline"
            :loading="switching"
            @click="startDemo"
          >
            先试试演练模式
          </VBtn>
        </VCardActions>
      </VCard>

      <VAlert type="info" variant="tonal">
        演练模式在本机起一个假的学校后端：<strong>规则、流程、服务端计时都和真实一致</strong>
        （包括真的等满 8~20 分钟），区别只有一个 —— 不碰你的账号，也不会在学校系统里留下记录。
        第一次用建议先演练一遍，把界面和流程看明白。
      </VAlert>
    </template>

    <!-- 已接入 -->
    <template v-else-if="!loading && status">
      <VAlert
        v-if="status.mode === 'demo'"
        type="warning"
        variant="tonal"
        class="mb-4"
        icon="mdi-flask-outline"
      >
        当前是<strong>演练模式</strong>：所有请求都打到本机的假后端，
        提交的记录只存在于这台电脑上。要打真服务器，去
        <NuxtLink to="/setup">接入向导</NuxtLink> 完成一次接入。
      </VAlert>

      <!-- 有任务在进行 -->
      <VCard v-if="run.phase !== 'idle' && run.canCancel" color="primary" variant="tonal" class="mb-4">
        <VCardText class="d-flex align-center flex-wrap ga-3">
          <VIcon icon="mdi-run-fast" size="32" />
          <div>
            <div class="text-body-1 font-weight-medium">有一次校园跑正在进行</div>
            <div class="text-caption">
              {{ run.routeName }} · 已过 {{ run.elapsedText }} · 还剩 {{ run.remainingText }}
            </div>
          </div>
          <VSpacer />
          <VBtn color="primary" to="/campus">回到跑步页面</VBtn>
        </VCardText>
      </VCard>

      <VCard class="mb-4">
        <VCardText class="d-flex align-center flex-wrap ga-3">
          <VIcon icon="mdi-account-circle-outline" size="36" color="primary" />
          <div>
            <div class="text-body-1">
              {{ status.user?.name || status.user?.studentName || '已接入' }}
              <span v-if="status.user?.studentId || status.user?.studyCode" class="text-medium-emphasis">
                · {{ status.user?.studentId || status.user?.studyCode }}
              </span>
            </div>
            <div class="text-caption text-medium-emphasis">
              {{ status.user?.schoolName || '—' }}
              <span v-if="status.tokenPrefix"> · 凭证 {{ status.tokenPrefix }}</span>
              <span v-if="status.mode === 'demo'"> · 演练后端</span>
            </div>
          </div>
          <VSpacer />
          <VBtn color="primary" size="large" prepend-icon="mdi-run-fast" to="/campus">
            开始校园跑
          </VBtn>
        </VCardText>
      </VCard>

      <RuleCard :rules="rules" class="mb-4" />

      <VCard v-if="standard" class="mb-4">
        <VCardTitle class="text-subtitle-1">
          <VIcon start icon="mdi-trophy-outline" />本学期达标进度
        </VCardTitle>
        <VCardText>
          <div class="d-flex align-center mb-1">
            <span class="text-body-2">{{ standard.label }}</span>
            <VSpacer />
            <span class="text-h6">{{ standard.currentValue }} / {{ standard.standardValue }}</span>
          </div>
          <VProgressLinear :model-value="progress" height="10" rounded color="success" />
          <div class="text-caption text-medium-emphasis mt-2">
            {{ standard.details }}
            <span v-if="overview"> · 本学期有效 {{ overview.qualifiedRuns }} 次，共 {{ Number(overview.totalDuration / 60).toFixed(0) }} 分钟</span>
          </div>
        </VCardText>
      </VCard>

      <VCard>
        <VCardTitle class="text-subtitle-1 d-flex align-center">
          <VIcon start icon="mdi-history" />最近记录
          <VSpacer />
          <VBtn variant="text" size="small" to="/records">全部</VBtn>
        </VCardTitle>
        <VList v-if="records.length" lines="two">
          <VListItem v-for="rec in records" :key="rec.id">
            <VListItemTitle class="text-body-2">
              {{ rec.runDate }} · {{ Number(rec.distance).toFixed(2) }} km · {{ rec.pace }}
            </VListItemTitle>
            <VListItemSubtitle class="text-caption">
              {{ rec.runType === 'CAMPUS' ? `校园跑${rec.routeName ? ` · ${rec.routeName}` : ''}` : '自由跑' }}
              · 用时 {{ Math.round((rec.duration || 0) / 60) }} 分钟
              <VChip v-if="rec.status === 1" size="x-small" color="success" variant="tonal" class="ml-2">有效</VChip>
              <VChip v-else size="x-small" color="error" variant="tonal" class="ml-2">无效</VChip>
            </VListItemSubtitle>
          </VListItem>
        </VList>
        <VCardText v-else class="text-caption text-medium-emphasis">
          还没有记录。
        </VCardText>
      </VCard>
    </template>
  </div>
</template>
