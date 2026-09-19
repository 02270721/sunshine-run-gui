<script setup lang="ts">
/**
 * 应用外壳 —— 顶栏导航 + 内容区 + 页脚。
 * 页面本身只关心自己的内容，导航在这里统一维护。
 *
 * 注意：Vuetify 的 useDisplay 必须显式 import。
 * vite-plugin-vuetify 的 autoImport 只管组件，不管 composable ——
 * 少这一行不会构建报错，只会在浏览器里白屏 500。
 */
import { useDisplay } from 'vuetify'

const route = useRoute()
const display = useDisplay()
const drawer = ref(false)

const nav = [
  { title: '首页', to: '/', icon: 'mdi-home-variant' },
  { title: '校园跑', to: '/campus', icon: 'mdi-run-fast' },
  { title: '跑步记录', to: '/records', icon: 'mdi-chart-timeline-variant' },
  { title: '接入向导', to: '/setup', icon: 'mdi-key-variant' },
  { title: '诊断', to: '/diagnose', icon: 'mdi-stethoscope' },
]

const current = computed(() => nav.find((n) => n.to === route.path)?.title ?? '阳光跑助手')
</script>

<template>
  <VApp>
    <VAppBar color="primary" density="comfortable" flat>
      <VAppBarNavIcon v-if="display.mobile.value" @click="drawer = !drawer" />
      <VAppBarTitle class="font-weight-medium">
        {{ display.mobile.value ? current : '阳光跑助手' }}
      </VAppBarTitle>
      <template #append>
        <template v-if="!display.mobile.value">
          <VBtn
            v-for="item in nav"
            :key="item.to"
            :to="item.to"
            :prepend-icon="item.icon"
            variant="text"
            class="text-none"
          >
            {{ item.title }}
          </VBtn>
        </template>
        <VBtn
          v-else
          icon="mdi-dots-vertical"
          variant="text"
          @click="drawer = !drawer"
        />
      </template>
    </VAppBar>

    <VNavigationDrawer v-model="drawer" temporary>
      <VList nav>
        <VListItem
          v-for="item in nav"
          :key="item.to"
          :to="item.to"
          :prepend-icon="item.icon"
          :title="item.title"
          @click="drawer = false"
        />
      </VList>
    </VNavigationDrawer>

    <VMain>
      <VContainer class="py-6 app-container">
        <NuxtPage />
      </VContainer>

      <footer class="app-footer text-caption">
        <div>阳光跑助手 · 仅用于本人账号与自建测试后端的技术验证</div>
        <div>使用本程序产生的任何后果由使用者自行承担，请遵守所在学校的规定</div>
      </footer>
    </VMain>
  </VApp>
</template>

<style>
html { overflow-y: auto; }
.app-container { max-width: 980px; }
.app-footer {
  max-width: 980px;
  margin: 0 auto 24px;
  padding: 16px 24px 0;
  opacity: 0.6;
  text-align: center;
  line-height: 1.8;
}
</style>
