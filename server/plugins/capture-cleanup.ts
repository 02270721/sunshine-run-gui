/**
 * 启动时兜底清理 —— 如果上一次抓凭证没能正常收尾（程序被强杀、断电），
 * 系统代理可能还指着已经不存在的端口，那样整台电脑都上不了网。
 * 这里在服务一启动时就把代理和临时证书收拾掉。
 */
import { cleanupOrphan } from '~/server/core/sunshine/capture.mjs'

export default defineNitroPlugin(() => {
  cleanupOrphan()
    .then((r) => {
      if (r?.cleaned) {
        console.log(`[capture] 发现上次没收拾干净的抓包环境，已自动还原（代理=${r.restoredProxy ? '已还原' : '无需还原'}，证书=已删除）`)
      }
    })
    .catch((e) => {
      console.warn(`[capture] 兜底清理失败（不影响使用）：${e.message}`)
    })
})
