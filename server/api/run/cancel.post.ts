/**
 * POST /api/run/cancel —— 撤销这次跑步（不会产生任何记录）
 */
import { cancelRun } from '~/server/core/sunshine/runner.mjs'
import { guard } from '~/server/utils/respond'

export default defineEventHandler(event => guard(async () => {
  const body = await readBody<{ reason?: string }>(event) || {}
  return cancelRun({ reason: body.reason || '用户在网页上撤销了这次跑步' })
}))
