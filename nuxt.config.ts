import vuetify from 'vite-plugin-vuetify'

/**
 * 阳光跑助手 —— Nuxt 配置
 *
 * 与 totoro-paradise 保持同一套结构：
 *   ssr: false（纯前端 SPA）+ Vuetify 自动按需引入
 *
 * 去掉了 totoro 里本项目用不上的东西：unocss、高德地图、buffer 注入。
 * 端口固定 2727，避免和三方工具常用的 3000/8080 撞车。
 */
export default defineNuxtConfig({
  ssr: false,
  devtools: { enabled: false },

  devServer: { port: 2727 },

  app: {
    head: {
      title: '阳光跑助手',
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
    },
  },

  // Vuetify 的组件与样式按需引入（照 totoro 的写法，但不引 unocss）
  modules: [
    (_options, nuxt) => {
      nuxt.hooks.hook('vite:extendConfig', (config) => {
        config.plugins ||= []
        config.plugins.push(vuetify({ autoImport: true }))
      })
    },
  ],

  build: { transpile: ['vuetify'] },

  vite: {
    optimizeDeps: { include: ['vuetify'] },
  },

  nitro: {
    // 运行期要用 node:child_process 拉起演练用的 mock 后端
    externals: { inline: [] },
    compatibilityDate: '2024-11-01',
  },
})
