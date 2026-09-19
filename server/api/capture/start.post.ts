/**
 * POST /api/capture/start —— 开始一键抓凭证
 *
 * ⚠️ 这一步会做两件敏感的事（所以必须由用户主动点、且页面上写清楚了）：
 *   1. 生成一张临时根证书并导入「当前用户 → 受信任的根证书颁发机构」（Windows 会弹确认框）
 *   2. 把系统代理临时指向本机抓包端口
 * 抓完（或失败、超时）会自动还原代理并删除证书。
 *
 * body: { host?: string }
 */
import { start } from '~/server/core/sunshine/capture.mjs'
import { guard } from '~/server/utils/respond'

export default defineEventHandler(event => guard(async () => {
  const body = await readBody<{ host?: string }>(event) || {}
  return start({ host: body.host || undefined })
}))
