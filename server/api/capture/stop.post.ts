/**
 * POST /api/capture/stop —— 停止抓取并还原系统（代理 + 证书）
 */
import { stop } from '~/server/core/sunshine/capture.mjs'
import { guard } from '~/server/utils/respond'

export default defineEventHandler(() => guard(() => stop({ reason: '用户手动停止' })))
