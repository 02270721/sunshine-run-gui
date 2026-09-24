/**
 * POST /api/run/submit —— 提前提交（也用于服务重启后接着交）
 * body: { force?: boolean }
 *
 * 注意：上报的 duration 一律按**真实经过秒数**重算（v29 会与真实会话时长对账，
 * 差太多判「作弊」）；不足学校最低时长时会拒绝并继续等待。详见 docs/PROTOCOL.md 12.9.1。
 */
import { submit } from '~/server/core/sunshine/runner.mjs'
import { guard } from '~/server/utils/respond'

export default defineEventHandler(event => guard(async () => {
  const body = await readBody<{ force?: boolean }>(event) || {}
  return submit({ force: Boolean(body.force) })
}))
