/**
 * GET /api/run/state —— 当前跑步进度（网页每秒轮询一次）
 *
 * 轮询而不是 WebSocket：这个程序一次只有一个人在本地用，
 * 每秒一个 GET 的成本可以忽略，换来的是「关掉页面再打开照样接上」。
 */
import { snapshot } from '~/server/core/sunshine/runner.mjs'
import { guard } from '~/server/utils/respond'

export default defineEventHandler(() => guard(() => snapshot()))
