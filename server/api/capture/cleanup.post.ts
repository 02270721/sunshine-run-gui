/**
 * POST /api/capture/cleanup —— 一键还原（诊断页的兜底按钮）
 *
 * 用于「抓取中途程序被强杀 / 断电」之后：系统代理可能还指着已经不存在的抓包端口，
 * 那样整台电脑都上不了网。这个接口把代理设置和证书收拾干净。
 */
import { forceCleanup } from '~/server/core/sunshine/capture.mjs'
import { guard } from '~/server/utils/respond'

export default defineEventHandler(() => guard(() => forceCleanup()))
