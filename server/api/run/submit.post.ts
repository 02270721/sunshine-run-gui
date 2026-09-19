/**
 * POST /api/run/submit —— 立即提交（提前交卷，或服务重启后接着交）
 * body: { force?: boolean }
 */
import { submit } from '~/server/core/sunshine/runner.mjs'
import { guard } from '~/server/utils/respond'

export default defineEventHandler(event => guard(async () => {
  const body = await readBody<{ force?: boolean }>(event) || {}
  return submit({ force: Boolean(body.force) })
}))
