/**
 * GET /api/stats —— 本学期达标进度（还差几次、总里程…）
 */
import { getStats } from '~/server/core/sunshine/service.mjs'
import { guard } from '~/server/utils/respond'

export default defineEventHandler(() => guard(() => getStats()))
