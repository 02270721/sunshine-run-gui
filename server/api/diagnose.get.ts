/**
 * GET /api/diagnose —— 只读体检：后端地址、设备身份、各接口连通性
 *
 * 只发 GET 请求，不会写入任何数据。
 */
import { diagnose } from '~/server/core/sunshine/service.mjs'
import { guard } from '~/server/utils/respond'

export default defineEventHandler(() => guard(() => diagnose()))
