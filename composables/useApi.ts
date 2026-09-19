/**
 * 接口调用 —— 把服务端统一的 { ok, data | error } 形状拆开：
 * 成功返回 data，失败抛出带原文的错误（页面直接显示这句话就行）。
 */

export interface ApiEnvelope<T> {
  ok: boolean
  data?: T
  error?: string
  code?: string | null
  issues?: { code: string, text: string }[]
}

export class ApiError extends Error {
  issues: { code: string, text: string }[]
  code: string | null

  constructor(message: string, issues: { code: string, text: string }[] = [], code: string | null = null) {
    super(message)
    this.name = 'ApiError'
    this.issues = issues
    this.code = code
  }
}

export function useApi() {
  async function unwrap<T>(promise: Promise<ApiEnvelope<T>>): Promise<T> {
    let res: ApiEnvelope<T>
    try {
      res = await promise
    } catch (e) {
      // 真正的网络层失败（服务没起来之类）
      throw new ApiError(`连接本机服务失败：${(e as Error)?.message || e}`)
    }
    if (!res || res.ok !== true) {
      throw new ApiError(res?.error || '请求失败', res?.issues || [], res?.code ?? null)
    }
    return res.data as T
  }

  return {
    get: <T>(url: string) => unwrap<T>($fetch<ApiEnvelope<T>>(url)),
    post: <T>(url: string, body?: unknown) =>
      unwrap<T>($fetch<ApiEnvelope<T>>(url, { method: 'POST', body: (body || {}) as never })),
  }
}
