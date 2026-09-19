/**
 * 统一的返回格式 —— 所有接口都返回这两种形状之一：
 *
 *   { ok: true,  data: … }
 *   { ok: false, error: '给人看的一句话', code?: '…', issues?: [...] }
 *
 * 为什么不用 HTTP 状态码表达业务错误：
 *   这个程序的使用者不需要懂 4xx/5xx。把「失败原因」放在 body 里，
 *   网页就能原样显示「登录状态已失效，请重新接入」这种话。
 */

export interface ApiFail {
  ok: false
  error: string
  code?: string | null
  issues?: unknown[]
}

export function ok<T>(data: T) {
  return { ok: true as const, data }
}

export function fail(e: unknown): ApiFail {
  const err = e as { message?: string; code?: string | number | null; issues?: unknown[] }
  return {
    ok: false,
    error: err?.message || String(e),
    code: err?.code != null ? String(err.code) : null,
    ...(err?.issues ? { issues: err.issues } : {}),
  }
}

/** 把「读 body / 调核心」包起来，任何异常都变成可读的失败响应 */
export async function guard<T>(fn: () => Promise<T> | T) {
  try {
    return ok(await fn())
  } catch (e) {
    return fail(e)
  }
}
