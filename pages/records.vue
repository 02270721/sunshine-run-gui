<script setup lang="ts">
/**
 * 跑步记录 —— 两张表：
 *   上面是学校服务器上的权威记录（GET /runs）
 *   下面是本机流水（含失败的、被撤销的，以及为什么）
 */
const api = useApi()
const { status, refresh } = useStatus()

const stats = ref<Record<string, any> | null>(null)
const page = ref(1)
const data = ref<{ records: any[], total: number, pages: number }>({ records: [], total: 0, pages: 1 })
const localLog = ref<any[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

const outcomeText: Record<string, string> = {
  done: '提交成功',
  invalid: '服务端判为无效',
  failed: '失败',
  cancelled: '已撤销',
}

const outcomeColor: Record<string, string> = {
  done: 'success',
  invalid: 'error',
  failed: 'error',
  cancelled: 'grey',
}

async function load() {
  loading.value = true
  error.value = null
  try {
    await refresh()
    if (!status.value?.loggedIn) return
    const [s, r, l] = await Promise.all([
      api.get<any>('/api/stats').catch(() => null),
      api.get<{ records: any[], total: number, pages: number }>(`/api/records?page=${page.value}&size=10`).catch(() => null),
      api.get<any[]>('/api/runs-log').catch(() => []),
    ])
    stats.value = s
    if (r) data.value = r
    localLog.value = l || []
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

watch(page, load)
onMounted(load)
</script>

<template>
  <div>
    <VCard v-if="!status?.loggedIn" class="mb-4">
      <VCardTitle class="text-h6">还没有接入账号</VCardTitle>
      <VCardText class="text-body-2">
        接入之后这里会显示学校服务器上的跑步记录和本学期达标进度。
      </VCardText>
      <VCardActions class="px-4 pb-4">
        <VBtn color="primary" to="/setup" prepend-icon="mdi-key-variant">去接入</VBtn>
      </VCardActions>
    </VCard>

    <template v-else>
      <VAlert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</VAlert>

      <VCard v-if="stats?.overviewStats" class="mb-4">
        <VCardTitle class="text-subtitle-1">
          <VIcon start icon="mdi-chart-box-outline" />{{ stats.currentSemesterName || '本学期' }}概览
        </VCardTitle>
        <VCardText>
          <VRow>
            <VCol cols="6" sm="3">
              <div class="text-caption text-medium-emphasis">有效次数</div>
              <div class="text-h6">{{ stats.overviewStats.qualifiedRuns }}</div>
            </VCol>
            <VCol cols="6" sm="3">
              <div class="text-caption text-medium-emphasis">总时长</div>
              <div class="text-h6">{{ Math.round((stats.overviewStats.totalDuration || 0) / 60) }} 分</div>
            </VCol>
            <VCol cols="6" sm="3">
              <div class="text-caption text-medium-emphasis">平均里程</div>
              <div class="text-h6">{{ Number(stats.overviewStats.avgDistance || 0).toFixed(2) }} km</div>
            </VCol>
            <VCol cols="6" sm="3">
              <div class="text-caption text-medium-emphasis">消耗</div>
              <div class="text-h6">{{ stats.overviewStats.totalCalories || 0 }} kcal</div>
            </VCol>
          </VRow>

          <template v-if="stats.standards?.length">
            <VDivider class="my-3" />
            <div v-for="s in stats.standards" :key="s.id" class="mb-3">
              <div class="d-flex align-center">
                <span class="text-body-2">{{ s.label }}</span>
                <VSpacer />
                <span class="text-body-2 font-weight-medium">{{ s.currentValue }} / {{ s.standardValue }}</span>
              </div>
              <VProgressLinear
                :model-value="Math.min(100, ((s.currentValue || 0) / (s.standardValue || 1)) * 100)"
                height="8"
                rounded
                :color="s.isMet ? 'success' : 'primary'"
              />
              <div class="text-caption text-medium-emphasis mt-1">{{ s.details }}</div>
            </div>
          </template>
        </VCardText>
      </VCard>

      <VCard class="mb-4">
        <VCardTitle class="text-subtitle-1 d-flex align-center">
          <VIcon start icon="mdi-cloud-check-outline" />学校服务器上的记录
          <VSpacer />
          <VChip size="small" variant="tonal">共 {{ data.total }} 条</VChip>
        </VCardTitle>
        <VTable v-if="data.records.length" density="compact" class="text-body-2">
          <thead>
            <tr>
              <th>日期</th>
              <th>类型</th>
              <th>里程</th>
              <th>用时</th>
              <th>配速</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="rec in data.records" :key="rec.id">
              <td>{{ rec.runDate }}</td>
              <td>
                {{ rec.runType === 'CAMPUS' ? '校园跑' : '自由跑' }}
                <div v-if="rec.routeName" class="text-caption text-medium-emphasis">{{ rec.routeName }}</div>
              </td>
              <td>{{ Number(rec.distance).toFixed(2) }} km</td>
              <td>{{ Math.round((rec.duration || 0) / 60) }} 分</td>
              <td>{{ rec.pace }}</td>
              <td>
                <VChip v-if="rec.status === 1" size="x-small" color="success" variant="tonal">有效</VChip>
                <VChip v-else size="x-small" color="error" variant="tonal">无效</VChip>
                <div v-if="rec.invalidReason" class="text-caption text-error">{{ rec.invalidReason }}</div>
              </td>
            </tr>
          </tbody>
        </VTable>
        <VCardText v-else class="text-caption text-medium-emphasis">
          还没有记录。跑完第一条校园跑之后就会出现在这里。
        </VCardText>
        <VCardActions v-if="data.pages > 1" class="justify-center">
          <VPagination v-model="page" :length="data.pages" density="comfortable" total-visible="7" />
        </VCardActions>
      </VCard>

      <VCard>
        <VCardTitle class="text-subtitle-1">
          <VIcon start icon="mdi-laptop" />本机执行流水
        </VCardTitle>
        <VCardText class="text-caption text-medium-emphasis pb-0">
          这一份存在你自己的电脑上，含失败的与被撤销的尝试 —— 用来回答「我那次到底怎么了」。
        </VCardText>
        <VTable v-if="localLog.length" density="compact" class="text-body-2">
          <thead>
            <tr>
              <th>时间</th>
              <th>跑道</th>
              <th>目标</th>
              <th>结果</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(item, i) in localLog" :key="i">
              <td>{{ item.at?.slice(5, 16).replace('T', ' ') }}</td>
              <td>{{ item.routeName || '—' }}</td>
              <td>{{ item.distanceKm ? `${Number(item.distanceKm).toFixed(2)} km` : '—' }}</td>
              <td>
                <VChip size="x-small" :color="outcomeColor[item.outcome] || 'grey'" variant="tonal">
                  {{ outcomeText[item.outcome] || item.outcome }}
                </VChip>
                <div v-if="item.reason" class="text-caption text-medium-emphasis">{{ item.reason }}</div>
                <div v-else-if="item.recordId" class="text-caption text-medium-emphasis">记录号 {{ item.recordId }}</div>
              </td>
            </tr>
          </tbody>
        </VTable>
        <VCardText v-else class="text-caption text-medium-emphasis">
          还没有本机记录。
        </VCardText>
      </VCard>
    </template>
  </div>
</template>
