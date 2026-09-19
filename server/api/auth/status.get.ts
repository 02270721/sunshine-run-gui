/**
 * GET /api/auth/status —— 当前接入状态（首页与向导用）
 */
import { authStatus } from '~/server/core/sunshine/service.mjs'
import { guard } from '~/server/utils/respond'

export default defineEventHandler(() => guard(() => authStatus()))
