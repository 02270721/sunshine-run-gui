/**
 * GET /api/rules —— 学校当前生效的跑步规则（已翻译成大白话）
 */
import { getRules } from '~/server/core/sunshine/service.mjs'
import { guard } from '~/server/utils/respond'

export default defineEventHandler(() => guard(() => getRules()))
