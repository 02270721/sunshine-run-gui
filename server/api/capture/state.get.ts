/**
 * GET /api/capture/state —— 抓取进度（网页每秒轮询）
 */
import { snapshot } from '~/server/core/sunshine/capture.mjs'
import { guard } from '~/server/utils/respond'

export default defineEventHandler(() => guard(() => snapshot()))
