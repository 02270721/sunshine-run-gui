<script setup lang="ts">
/**
 * 接入向导 —— 整个程序唯一需要「动手」的地方。
 *
 * 为什么必须手动：小程序的登录凭证来自微信客户端签发的 code，
 * 只能在微信环境里产生，任何外部程序都拿不到（PROTOCOL.md 第 3 节）。
 * 所以这里把这件事压到最小：复制一段脚本 → 在开发者工具里回车 → 回来点一下。
 */
const api = useApi()
const { status, refresh, logout, setMode } = useStatus()

const step = ref(1)
const pasted = ref('')
const busy = ref(false)
const message = ref<{ type: 'success' | 'error' | 'info', text: string } | null>(null)
const baseUrl = ref('')
const showAdvanced = ref(false)
const demoBusy = ref(false)

const snippet = `(function () {
  var g = function (k) { try { return wx.getStorageSync(k); } catch (e) { return null; } };
  var out = {
    token: g('sunshine-run-token'),
    deviceId: g('sunshine-run-device-id'),
    userInfo: g('sunshine-run-user-info')
  };
  if (!out.token) return '没读到 token —— 请先在小程序里完成微信登录';
  var s = JSON.stringify(out);
  try { copy(s); return '已复制到剪贴板，回到网页点「从剪贴板读取」'; }
  catch (e) { return s; }
})()`

async function copySnippet() {
  try {
    await navigator.clipboard.writeText(snippet)
    message.value = { type: 'success', text: '脚本已复制，去开发者工具的 Console 里粘贴并回车' }
  } catch {
    message.value = { type: 'info', text: '浏览器不让自动复制，请手动选中上面的代码复制' }
  }
}

async function loginFrom(body: Record<string, unknown>) {
  busy.value = true
  message.value = null
  try {
    await api.post('/api/auth/login', { baseUrl: baseUrl.value || undefined, ...body })
    await refresh()
    message.value = { type: 'success', text: '接入成功，凭证已保存在本机' }
    step.value = 3
  } catch (e) {
    message.value = { type: 'error', text: (e as Error).message }
  } finally {
    busy.value = false
  }
}

async function toggleDemo(value: boolean) {
  demoBusy.value = true
  message.value = null
  try {
    await setMode(value ? 'demo' : 'real')
    message.value = value
      ? { type: 'info', text: '已切到演练模式：请求都打到本机假后端，不会影响真实账号' }
      : { type: 'info', text: '已切回真实后端' }
  } catch (e) {
    message.value = { type: 'error', text: (e as Error).message }
  } finally {
    demoBusy.value = false
  }
}

onMounted(refresh)
</script>

<template>
  <div>
    <VCard class="mb-4">
      <VCardTitle class="text-h6">
        <VIcon start icon="mdi-key-variant" />接入学校账号
      </VCardTitle>
      <VCardText>
        <p class="text-body-2">
          助手需要一次你的登录凭证（一个 token）。它由微信签发，
          <strong>任何外部程序都无法自己获取</strong> —— 所以这一步需要你手动完成，之后就不用再做了。
        </p>
        <p class="text-body-2 mb-0 text-medium-emphasis">
          凭证只保存在这台电脑的 <code>.data/credentials.json</code> 里，
          网页本身拿不到它，也不会发往任何第三方。
        </p>
      </VCardText>
    </VCard>

    <VAlert
      v-if="message"
      :type="message.type"
      variant="tonal"
      class="mb-4"
      closable
      @click:close="message = null"
    >
      {{ message.text }}
    </VAlert>

    <!-- 已接入 -->
    <VCard v-if="status?.loggedIn && status.mode === 'real'" class="mb-4" color="success" variant="tonal">
      <VCardText class="d-flex align-center flex-wrap ga-3">
        <VIcon icon="mdi-check-decagram" size="32" />
        <div>
          <div class="text-body-1 font-weight-medium">
            已接入：{{ status.user?.name || status.user?.studentName || '（未读到姓名）' }}
          </div>
          <div class="text-caption">
            {{ status.user?.schoolName || status.baseUrl }}
            · 凭证 {{ status.tokenPrefix }} · 保存于 {{ status.savedAt?.slice(0, 19).replace('T', ' ') }}
          </div>
        </div>
        <VSpacer />
        <VBtn variant="text" color="error" prepend-icon="mdi-logout" @click="logout()">清除凭证</VBtn>
      </VCardText>
    </VCard>

    <!-- 推荐路径：一键抓取（不需要开发者工具） -->
    <CaptureWizard />

    <VCard class="mb-4">
      <VCardTitle class="text-subtitle-1 d-flex align-center">
        <VIcon start icon="mdi-numeric-3-circle-outline" />手动方式
        <VChip size="small" variant="tonal" class="ml-3">没有 PC 微信时用</VChip>
      </VCardTitle>
      <VCardText>
        <p class="text-caption text-medium-emphasis">
          下面这三步需要<strong>微信开发者工具</strong>（或者你已经从别处拿到了 token）。
          电脑上只装了 PC 微信的话，用上面那个「一键自动抓取」更省事。
        </p>
        <VStepper :model-value="step" hide-actions flat class="pa-0">
          <VStepperHeader>
            <VStepperItem :value="1" title="登录小程序" />
            <VDivider />
            <VStepperItem :value="2" title="取出凭证" />
            <VDivider />
            <VStepperItem :value="3" title="粘贴回来" />
          </VStepperHeader>

          <VStepperWindow>
            <VStepperWindowItem :value="1">
              <p class="text-body-2">
                用<strong>微信开发者工具</strong>打开「酷动·阳光跑」小程序，完成微信一键登录。
                也可以用 PC 微信打开小程序 —— 但两边的本地存储是分开的，
                哪边登录就在哪边取凭证。
              </p>
              <VAlert type="info" variant="tonal" density="compact">
                开发者工具里如果提示没有登录，先在小程序界面上点一次登录按钮。
              </VAlert>
            </VStepperWindowItem>

            <VStepperWindowItem :value="2">
              <p class="text-body-2">
                在开发者工具里打开 Console（菜单：视图 → 调试器 → Console），
                把下面这段粘贴进去回车：
              </p>
              <pre class="snippet">{{ snippet }}</pre>
              <VBtn color="primary" prepend-icon="mdi-content-copy" @click="copySnippet">复制脚本</VBtn>
              <p class="text-caption text-medium-emphasis mt-3 mb-0">
                它只做一件事：把小程序自己存在本地的 token 读出来放进剪贴板，没有别的副作用。
              </p>
            </VStepperWindowItem>

            <VStepperWindowItem :value="3">
              <p class="text-body-2">回到这里，二选一：</p>
              <div class="d-flex flex-wrap ga-3 mb-4">
                <VBtn
                  color="primary"
                  size="large"
                  prepend-icon="mdi-clipboard-text-outline"
                  :loading="busy"
                  @click="loginFrom({ from: 'clipboard' })"
                >
                  从剪贴板读取并接入
                </VBtn>
                <VBtn
                  v-if="status?.hasLegacy"
                  variant="tonal"
                  size="large"
                  prepend-icon="mdi-import"
                  :loading="busy"
                  @click="loginFrom({ from: 'legacy' })"
                >
                  从命令行版导入（检测到已有凭证）
                </VBtn>
              </div>

              <VTextarea
                v-model="pasted"
                label="或者把 token（或那段 JSON）直接粘贴到这里"
                variant="outlined"
                rows="3"
                hide-details="auto"
                placeholder="粘贴 token，或 { &quot;token&quot;: &quot;…&quot; } 这样的 JSON"
              />
              <VBtn
                class="mt-3"
                variant="tonal"
                :disabled="!pasted.trim()"
                :loading="busy"
                prepend-icon="mdi-content-save-check-outline"
                @click="loginFrom({ text: pasted })"
              >
                保存并校验
              </VBtn>
            </VStepperWindowItem>
          </VStepperWindow>
        </VStepper>
      </VCardText>
    </VCard>

    <VCard class="mb-4">
      <VCardTitle class="text-subtitle-1">
        <VIcon start icon="mdi-flask-outline" />演练模式（不需要账号）
      </VCardTitle>
      <VCardText class="d-flex align-center flex-wrap ga-3">
        <div>
          <div class="text-body-2">用本机的假后端把整个流程走一遍</div>
          <div class="text-caption text-medium-emphasis">
            规则、流程、服务端计时都与真实一致（同样要等满 8~20 分钟），
            只是不会碰你的账号、也不会在学校系统里留下记录。
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

    <VExpansionPanels v-model="showAdvanced">
      <VExpansionPanel>
        <VExpansionPanelTitle>高级：后端地址</VExpansionPanelTitle>
        <VExpansionPanelContent>
          <VTextField
            v-model="baseUrl"
            label="后端地址（留空使用官方地址）"
            :placeholder="status?.baseUrl"
            variant="outlined"
            density="comfortable"
            hide-details="auto"
            persistent-placeholder
          />
          <p class="text-caption text-medium-emphasis mt-2 mb-0">
            当前生效：<code>{{ status?.baseUrl }}</code>。
            这个程序默认打官方域名，但它的设计用途是<strong>你自己的测试后端</strong>；
            填别的地址只影响这一台电脑。
          </p>
        </VExpansionPanelContent>
      </VExpansionPanel>
    </VExpansionPanels>
  </div>
</template>

<style scoped>
.snippet {
  background: #263238;
  color: #eceff1;
  padding: 12px 14px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.6;
  overflow-x: auto;
  max-height: 260px;
}
</style>
