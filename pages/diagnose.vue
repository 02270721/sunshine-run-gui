<script setup lang="ts">
/**
 * 诊断 —— 只看不写。
 *
 * 这里发出去的每一个请求都是 GET：探活、看设备身份、看原始规则。
 * 不放「发异常请求试探服务端」那类功能 —— 那是命令行版（sunshine-run-client）的活，
 * 普通人误点一次就会往账号里塞一条删不掉的记录。
 */
const api = useApi()
const { status, refresh, setMode } = useStatus()

const data = ref<Record<string, any> | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const demoBusy = ref(false)
const cleanupBusy = ref(false)
const cleanupResult = ref('')

async function runCleanup() {
  cleanupBusy.value = true
  cleanupResult.value = ''
  try {
    const r = await api.post<{ cleaned: boolean, restoredProxy?: boolean }>('/api/capture/cleanup', {})
    cleanupResult.value = r.cleaned
      ? `已还原${r.restoredProxy ? '（系统代理已恢复成原来的设置）' : ''}`
      : '没有发现需要还原的东西'
  } catch (e) {
    cleanupResult.value = `还原失败：${(e as Error).message}`
  } finally {
    cleanupBusy.value = false
  }
}

async function load() {
  loading.value = true
  error.value = null
  try {
    await refresh()
    data.value = await api.get('/api/diagnose')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

async function toggleDemo(value: boolean) {
  demoBusy.value = true
  try {
    await setMode(value ? 'demo' : 'real')
    await load()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    demoBusy.value = false
  }
}

onMounted(load)
</script>

<template>
  <div>
    <VAlert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</VAlert>

    <VCard class="mb-4">
      <VCardTitle class="text-h6 d-flex align-center">
        <VIcon start icon="mdi-stethoscope" />环境体检
        <VSpacer />
        <VBtn variant="text" size="small" prepend-icon="mdi-refresh" :loading="loading" @click="load">
          重新检测
        </VBtn>
      </VCardTitle>
      <VCardText class="text-body-2">
        下面这些检查全部是只读请求，不会在你的账号里产生任何数据。
      </VCardText>
    </VCard>

    <VCard v-if="data" class="mb-4">
      <VCardTitle class="text-subtitle-2">
        <VIcon start icon="mdi-server-network" size="18" />后端与身份
      </VCardTitle>
      <VCardText>
        <VList density="compact" class="py-0">
          <VListItem prepend-icon="mdi-link-variant">
            <VListItemTitle class="text-body-2">
              {{ data.target?.baseUrl }}
              <VChip v-if="data.target?.mode === 'demo'" size="x-small" color="warning" variant="tonal" class="ml-2">演练模式</VChip>
            </VListItemTitle>
            <VListItemSubtitle class="text-caption">当前打向的服务器</VListItemSubtitle>
          </VListItem>
          <VListItem prepend-icon="mdi-cellphone-link">
            <VListItemTitle class="text-body-2">{{ data.device?.deviceId }}</VListItemTitle>
            <VListItemSubtitle class="text-caption">
              本机设备号 · 指纹 {{ data.device?.deviceFingerprint }}
              （由品牌/机型/系统等 9 个字段哈希得到，与真机算法逐字一致）
            </VListItemSubtitle>
          </VListItem>
          <VListItem prepend-icon="mdi-key-outline">
            <VListItemTitle class="text-body-2">{{ data.target?.tokenPrefix || '（无）' }}</VListItemTitle>
            <VListItemSubtitle class="text-caption">凭证（只显示前 8 位，完整内容只存在本机文件里）</VListItemSubtitle>
          </VListItem>
          <VListItem prepend-icon="mdi-folder-outline">
            <VListItemTitle class="text-body-2">{{ data.dataDir }}</VListItemTitle>
            <VListItemSubtitle class="text-caption">本机数据目录（凭证、进行中的跑步、日志都在这里）</VListItemSubtitle>
          </VListItem>
        </VList>
      </VCardText>
    </VCard>

    <VCard v-if="data" class="mb-4">
      <VCardTitle class="text-subtitle-2">
        <VIcon start icon="mdi-access-point-check" size="18" />接口连通性
      </VCardTitle>
      <VList density="compact">
        <VListItem v-for="c in data.checks" :key="c.name">
          <template #prepend>
            <VIcon :icon="c.ok ? 'mdi-check-circle' : 'mdi-close-circle'" :color="c.ok ? 'success' : 'error'" />
          </template>
          <VListItemTitle class="text-body-2">{{ c.name }}</VListItemTitle>
          <VListItemSubtitle class="text-caption" style="white-space: normal;">
            {{ c.brief }}
            <span v-if="!c.ok && c.http"> （http {{ c.http }} / code {{ c.code }}）</span>
          </VListItemSubtitle>
        </VListItem>
      </VList>
    </VCard>

    <VCard class="mb-4">
      <VCardTitle class="text-subtitle-2">
        <VIcon start icon="mdi-flask-outline" size="18" />演练模式
      </VCardTitle>
      <VCardText class="d-flex align-center flex-wrap ga-3">
        <div>
          <div class="text-body-2">用本机假后端跑一遍（不需要账号，流程与真实一致）</div>
          <div class="text-caption text-medium-emphasis">
            程序会自动在 {{ status?.mockPort }} 端口拉起 scripts/mock-server.mjs。
          </div>
        </div>
        <VSpacer />
        <VSwitch
          :model-value="status?.mode === 'demo'"
          :loading="demoBusy"
          color="warning"
          hide-details
          @update:model-value="v => toggleDemo(Boolean(v))"
        />
      </VCardText>
    </VCard>

    <VCard class="mb-4">
      <VCardTitle class="text-subtitle-2">
        <VIcon start icon="mdi-shield-alert-outline" size="18" />抓包环境兜底还原
      </VCardTitle>
      <VCardText>
        <p class="text-body-2 mb-2">
          「一键抓取凭证」会临时改<strong>系统代理</strong>并装一张<strong>临时证书</strong>，
          正常情况下抓完就自动还原了。但如果抓取过程中程序被强杀或断电，
          代理可能还指着已经不存在的端口 —— 那样<strong>整台电脑都上不了网</strong>。
          程序下次启动时会自动收拾；也可以在这里手动点一下。
        </p>
        <div class="d-flex align-center ga-3 flex-wrap">
          <VBtn
            variant="tonal"
            color="warning"
            prepend-icon="mdi-backup-restore"
            :loading="cleanupBusy"
            @click="runCleanup"
          >
            一键还原（恢复系统代理 + 删除临时证书）
          </VBtn>
          <span v-if="cleanupResult" class="text-caption">{{ cleanupResult }}</span>
        </div>
      </VCardText>
    </VCard>

    <VCard v-if="data?.core" variant="outlined">
      <VCardTitle class="text-subtitle-2">
        <VIcon start icon="mdi-source-branch" size="18" />协议核心的来源
      </VCardTitle>
      <VCardText class="text-caption">
        <div>同步自：<code>{{ data.core.source }}</code></div>
        <div>同步时间：{{ data.core.syncedAt }}</div>
        <div>包含：{{ (data.core.files || []).join('、') }}</div>
        <div class="mt-2">
          这几个文件不是手写的，而是由 <code>scripts/sync-core.mjs</code> 从命令行版
          （sunshine-run-client）原样复制过来的 —— 协议实现只有一份真源。
        </div>
      </VCardText>
    </VCard>
  </div>
</template>
