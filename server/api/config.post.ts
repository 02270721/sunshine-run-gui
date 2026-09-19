/**
 * POST /api/config —— 切换演练模式 / 保存偏好
 *
 * body: { mode?: 'real'|'demo', jitter?: boolean, mockPort?: number }
 */
import { getConfig, setConfig } from '~/server/core/sunshine/store.mjs'
import { ensureMockServer, stopMockServer } from '~/server/core/sunshine/demo.mjs'
import { authStatus } from '~/server/core/sunshine/service.mjs'
import { isRunning, reset } from '~/server/core/sunshine/runner.mjs'
import { guard } from '~/server/utils/respond'

export default defineEventHandler(event => guard(async () => {
  const body = await readBody<{ mode?: string, jitter?: boolean, mockPort?: number }>(event) || {}
  const before = getConfig()

  const patch: Record<string, unknown> = {}
  if (body.mode) patch.mode = body.mode === 'demo' ? 'demo' : 'real'
  if (typeof body.jitter === 'boolean') patch.jitter = body.jitter
  if (body.mockPort) patch.mockPort = Number(body.mockPort)

  const next = setConfig(patch)

  // 换了后端就清掉上一条跑步的快照，免得打开页面看到的是另一套后端的旧结果。
  // ⚠️ 但正在跑的时候绝不能清 —— 那会丢掉会话，留下一条悬挂的服务端会话。
  if (next.mode !== before.mode && !isRunning()) reset()

  let mock: unknown = null
  if (next.mode === 'demo') mock = await ensureMockServer(next.mockPort)
  else stopMockServer()

  return { config: getConfig(), mock, status: authStatus() }
}))
