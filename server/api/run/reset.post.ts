/**
 * POST /api/run/reset —— 清掉已结束的跑步状态，回到初始状态
 */
import { reset } from '~/server/core/sunshine/runner.mjs'
import { guard } from '~/server/utils/respond'

export default defineEventHandler(() => guard(() => reset()))
