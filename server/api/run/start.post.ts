/**
 * POST /api/run/start —— 真正开始一次校园跑
 *
 * 这一步会创建服务端会话，之后就进入「等时间」阶段
 * （时长由学校服务器按会话起止计时，客户端说了不算）。
 *
 * body: { routeId, distanceKm?, durationSec?, jitter? }
 */
import { start } from '~/server/core/sunshine/runner.mjs'
import { guard } from '~/server/utils/respond'

export default defineEventHandler(event => guard(async () => {
  const body = await readBody<Record<string, unknown>>(event) || {}
  return start({
    routeId: Number(body.routeId),
    distanceKm: body.distanceKm == null ? null : Number(body.distanceKm),
    durationSec: body.durationSec == null ? null : Number(body.durationSec),
    jitter: Boolean(body.jitter),
  })
}))
