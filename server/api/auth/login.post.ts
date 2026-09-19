/**
 * POST /api/auth/login
 *
 * body:
 *   { text }                粘贴进来的 token 或 JSON
 *   { from: 'clipboard' }   读系统剪贴板
 *   { from: 'legacy' }      从老客户端 sunshine-run-client/.auth 导入
 *   { baseUrl }             可选，指定后端地址
 */
import { login, readClipboardText, importLegacy } from '~/server/core/sunshine/service.mjs'
import { guard } from '~/server/utils/respond'

export default defineEventHandler(event => guard(async () => {
  const body = await readBody<{ text?: string, from?: string, baseUrl?: string }>(event) || {}

  if (body.from === 'legacy') return importLegacy()

  if (body.from === 'clipboard') {
    const clip = await readClipboardText()
    if (!clip.text) {
      throw new Error(`读不到剪贴板内容（${clip.errors.join('；')}）。可以改成手动粘贴。`)
    }
    return login({ text: clip.text, baseUrl: body.baseUrl })
  }

  return login({ text: body.text, baseUrl: body.baseUrl })
}))
