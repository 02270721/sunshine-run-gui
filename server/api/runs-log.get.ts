/**
 * GET /api/runs-log —— 本机执行日志（谁在什么时候提交了什么、结果如何）
 *
 * 和上面的 /api/records 不是一回事：
 *   records  是学校服务器上的记录（权威，但只有成功的）
 *   runs-log 是本机的流水（含失败、被撤销、以及为什么）
 */
import { runLog } from '~/server/core/sunshine/runner.mjs'
import { guard } from '~/server/utils/respond'

export default defineEventHandler(() => guard(() => runLog()))
