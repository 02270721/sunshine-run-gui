/**
 * GET /api/records?page=1&size=10 —— 学期内的跑步记录（来自学校服务器）
 */
import { getRecords } from '~/server/core/sunshine/service.mjs'
import { guard } from '~/server/utils/respond'

export default defineEventHandler(event => guard(() => {
  const q = getQuery(event)
  return getRecords({ page: Number(q.page || 1), size: Number(q.size || 10) })
}))
