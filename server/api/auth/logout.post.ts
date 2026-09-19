/**
 * POST /api/auth/logout —— 清除本机凭证（不会影响学校服务器上的任何数据）
 */
import { logout } from '~/server/core/sunshine/service.mjs'
import { guard } from '~/server/utils/respond'

export default defineEventHandler(() => guard(() => logout()))
