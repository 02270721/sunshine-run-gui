/**
 * 请求层 —— 对照 app-service.js 里 webpack module 722 的 `request`。
 *
 * 小程序侧真实行为：
 *   header  = { "Content-Type": "application/json", ...调用方自定义 }
 *           + { "sunshine-run":            <token>       }   // 仅在 token 非空时
 *           + { "sunshine-run-device-id":  <deviceId>    }
 *           + { "sunshine-run-device-fp":  <fingerprint> }
 *   响应信封 = { code, message, data }
 *   成功     = HTTP 200 且 (code === 200 || code === 0) → 取 data
 *   401      = token 失效；403 = 未绑定学号；502 = 学校 server_url 挂了，回退默认 API 重试一次
 *
 * 注意：baseUrl 有三级回退 —— 学校专属 server_url > 用户信息里的 serverUrl > 默认 API_BASE_URL。
 */

import { getDeviceIdentity } from './device.mjs';

/** 对照 module 709：API_DOMAIN / API_BASE_URL / SCHOOL_SERVER_BASE_URL 三个常量 */
export const API_DOMAIN = 'https://sports.sqcoe.com';
/** 业务接口的默认前缀 —— 注意结尾是 /sunshine，不是裸域名 */
export const API_BASE_URL = `${API_DOMAIN}/sunshine`;
/** 仅用于文件上传（`${SCHOOL_SERVER_BASE_URL}/api/attachment/upload`） */
export const SCHOOL_SERVER_BASE_URL = `${API_DOMAIN}/schoolServer`;
/** 上传接口路径（wx.uploadFile，multipart，只带 token 头，不带设备头） */
export const ATTACHMENT_UPLOAD_URL = `${SCHOOL_SERVER_BASE_URL}/api/attachment/upload`;

/**
 * 对照 module 709 的 STORAGE_KEYS —— 字面值必须精确，不然在开发者工具里找不到。
 * 全部带 `sunshine-run-` 前缀。
 */
export const STORAGE_KEYS = {
  TOKEN: 'sunshine-run-token',
  USER_INFO: 'sunshine-run-user-info',
  DEVICE_ID: 'sunshine-run-device-id',
  SERVER_URL: 'sunshine-run-server-url',
  ACTIVE_RUN: 'sunshine-run-active-run',
  RUN_SETTINGS: 'sunshine-run-run-settings',
  RUN_RECORDS: 'sunshine-run-records',
  PENDING_SYNC: 'sunshine-run-pending-sync',
};

export class ApiError extends Error {
  constructor(message, code, statusCode) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const trimSlash = (u) => (u && u.endsWith('/') ? u.slice(0, -1) : u || '');

/**
 * @param {object} opts
 * @param {string} opts.baseUrl       默认 API 根
 * @param {string} [opts.token]
 * @param {string} [opts.deviceId]
 * @param {string} [opts.deviceFingerprint]
 * @param {boolean} [opts.dryRun]     true 时不发请求，只把请求描述返回
 */
export function createClient(opts = {}) {
  const {
    baseUrl = API_BASE_URL,
    token = '',
    deviceId,
    deviceFingerprint,
    dryRun = false,
    onLog = () => {},
  } = opts;

  const identity = getDeviceIdentity({ deviceId });
  const fp = deviceFingerprint || identity.deviceFingerprint;
  const did = identity.deviceId;

  let currentBase = trimSlash(baseUrl);

  function buildHeaders(extra = {}) {
    const h = { 'Content-Type': 'application/json', ...extra };
    if (token) h['sunshine-run'] = token;
    if (did) h['sunshine-run-device-id'] = did;
    if (fp) h['sunshine-run-device-fp'] = fp;
    return h;
  }

  /**
   * @param {object} req
   * @param {string} req.url      以 / 开头的路径
   * @param {string} [req.method]
   * @param {object} [req.data]   GET 时拼 query，其余作为 JSON body
   * @param {object} [req.header]
   */
  async function request({ url, method = 'GET', data, header = {} } = {}) {
    const doFetch = async (origin, allowFallback) => {
      const isGet = method.toUpperCase() === 'GET';
      let target = `${origin}${url}`;
      let body;
      if (isGet && data && Object.keys(data).length) {
        const qs = new URLSearchParams(
          Object.entries(data).filter(([, v]) => v !== undefined && v !== null),
        ).toString();
        if (qs) target += `?${qs}`;
      } else if (data !== undefined) {
        body = JSON.stringify(data);
      }

      // dry-run 只拦**写**请求。读请求照发 —— 否则像"拉规则算默认参数"这种事
      // 在预览时拿不到真值，预览出来的 payload 和实发不一致，dry-run 就失去意义了。
      const isWrite = method.toUpperCase() !== 'GET';
      if (dryRun && isWrite) {
        onLog(`[dry-run] ${method} ${target}${body ? ` body=${body}` : ''}`);
        return { __dryRun: true, url: target, method, body: data, header: buildHeaders(header) };
      }

      const res = await fetch(target, { method, headers: buildHeaders(header), body });
      const status = res.status;
      const text = await res.text();
      let payload;
      try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }

      const code = payload && typeof payload === 'object' ? payload.code : undefined;
      const message = (payload && typeof payload === 'object' ? payload.message : '') || '';

      // 502 → 回退默认 API 重试一次（对照小程序 a(p, !1)）
      if (status === 502 && allowFallback) {
        onLog(`学校 server_url 返回 502，回退 ${API_BASE_URL} 重试: ${url}`);
        currentBase = trimSlash(API_BASE_URL);
        return doFetch(currentBase, false);
      }
      if (status === 200) {
        if (code === 200 || code === 0) return payload.data;
        throw new ApiError(message || '请求失败', code, status);
      }
      if (status === 401) throw new ApiError('未授权', code, status);
      if (status === 403 || code === 403) throw new ApiError(message || '请先绑定学号', 403, status);
      throw new ApiError(message || '网络错误', code, status);
    };

    return doFetch(currentBase, true);
  }

  return {
    request,
    get: (url, data, header) => request({ url, method: 'GET', data, header }),
    post: (url, data, header) => request({ url, method: 'POST', data, header }),
    put: (url, data, header) => request({ url, method: 'PUT', data, header }),
    del: (url, data, header) => request({ url, method: 'DELETE', data, header }),
    identity: { deviceId: did, deviceFingerprint: fp, deviceInfo: identity.deviceInfo },
    get baseUrl() { return currentBase; },
  };
}
