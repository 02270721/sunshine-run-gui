import vuetify from 'vite-plugin-vuetify'

/**
 * 阳光跑助手 —— Nuxt 配置
 *
 * 结构参考 totoro-paradise：ssr: false（纯前端 SPA）+ Vuetify 组件按需引入。
 * 去掉了 totoro 里本项目用不上的东西：unocss、高德地图、buffer 注入。
 * 端口固定 2727（启动器会在被占用时自动换）。
 *
 * ⚠️ 两个踩过的坑，别改回去：
 *
 *   1. `vite-plugin-vuetify` 必须 ≥ 2.1.3。
 *      2.0.1 的 parseId() 用 url.parse() 解析模块 id，遇到 Nuxt 的虚拟模块
 *      `virtual:nuxt:D:/.../nuxt.config.mjs` 会在新版 Node 上直接抛
 *      「Invalid port in url」，dev 模式整个起不来（生产构建反而没事）。
 *      2.1.3 改成了 id.split('?')，问题消失。
 *
 *   2. 不要加 `build: { transpile: ['vuetify'] }`。
 *      本项目 ssr:false，服务端不渲染任何组件，transpile 只会让 Nitro 的
 *      esbuild 报「The entry point "vuetify" cannot be marked as external」。
 */
export default defineNuxtConfig({
  ssr: false,
  devtools: { enabled: false },

  // dev 必须显式绑 127.0.0.1：默认只监听 IPv6 的 [::1]，
  // 那样启动器打印的 http://127.0.0.1:2727 会打不开（生产构建本来就绑 127.0.0.1）
  devServer: { host: '127.0.0.1', port: 2727 },

  app: {
    head: {
      title: '阳光跑助手',
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
    },
  },

  // Vuetify 的组件与样式按需引入
  modules: [
    (_options, nuxt) => {
      nuxt.hooks.hook('vite:extendConfig', (config) => {
        config.plugins ||= []
        config.plugins.push(vuetify({ autoImport: true }))
      })
    },
  ],

  vite: {
    optimizeDeps: { include: ['vuetify'] },
  },

  nitro: {
    // 运行期要用 node:child_process 拉起演练用的 mock 后端
    externals: { inline: [] },
    compatibilityDate: '2024-11-01',
  },
})
