/**
 * POST /api/run/plan —— 干跑预演（不创建会话、不发任何写请求）
 *
 * 使用者拖滑杆改参数时实时调它，把「会不会通过、轨迹长什么样、
 * 打卡点能不能全中」提前算出来。参数不合法当场就知道，不会产生脏数据。
 *
 * body: { routeId, distanceKm?, durationSec?, jitter? }
 */
import { plan } from '~/server/core/sunshine/runner.mjs'
import { guard } from '~/server/utils/respond'

export default defineEventHandler(event => guard(async () => {
  const body = await readBody<Record<string, unknown>>(event) || {}
  return plan({
    routeId: Number(body.routeId),
    distanceKm: body.distanceKm == null ? null : Number(body.distanceKm),
    durationSec: body.durationSec == null ? null : Number(body.durationSec),
    jitter: Boolean(body.jitter),
  })
}))
