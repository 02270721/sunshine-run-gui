/**
 * GET /api/routes?refresh=1 —— 可用路线列表
 *
 * 协议里没有「列出全部路线」的接口，只能拿 /routes/{id} 从 1 逐个试，
 * 所以结果会缓存 6 小时；refresh=1 强制重扫。
 */
import { listRoutes } from '~/server/core/sunshine/service.mjs'
import { guard } from '~/server/utils/respond'

export default defineEventHandler(event => guard(() => {
  const refresh = getQuery(event).refresh === '1'
  return listRoutes({ refresh })
}))
