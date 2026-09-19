import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import { createVuetify } from 'vuetify'

/**
 * Vuetify 插件 —— 和 totoro-paradise 用的是同一套写法。
 * ssr 固定 false：本项目是本地 SPA，不需要服务端渲染。
 */
export default defineNuxtPlugin((nuxtApp) => {
  const vuetify = createVuetify({
    ssr: false,
    theme: {
      defaultTheme: 'light',
      themes: {
        light: {
          dark: false,
          colors: {
            primary: '#1976D2',
            secondary: '#00897B',
            success: '#2E7D32',
            warning: '#EF6C00',
            error: '#C62828',
          },
        },
      },
    },
    icons: { defaultSet: 'mdi' },
  })
  nuxtApp.vueApp.use(vuetify)
})
