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
import crypto from 'node:crypto';

/**
 * ============================ 请求签名（v29 起）============================
 *
 * 小程序 2026-09 更新到 v29 后，服务端对**三个写接口**开始强制校验签名，
 * 不带签名的请求会返回 `code:403 请求校验失败，请更新小程序后重试`：
 *
 *   POST /runs                          自由跑落库
 *   POST /runs/sessions/start           校园跑建会话
 *   POST /runs/sessions/{id}/finish     校园跑提交
 *
 * 算法（从 v29 的 app-service.js 复刻，已实测通过）：
 *
 *   timestamp = 秒级时间戳（字符串）
 *   nonce     = 16 个随机字节 → 32 位小写 hex
 *   canonical = ["v1", 方法大写, 路径, timestamp, nonce,
 *                sha256hex(token), sha256hex(deviceId), sha256hex(bodyString)]
 *               .join("\n") + "\n"
 *   sign      = hmacSHA256hex(key = SIGN_KEY, message = canonical)
 *
 * 三个头：sunshine-run-timestamp / sunshine-run-nonce / sunshine-run-sign
 *
 * ⚠️ bodyString 必须是**实际发出去的那份 JSON 字符串**（先序列化、再用同一个字符串去算签名）。
 */
const SIGN_KEY = '11b88c5d08744fdcba39ae5727fd689c7b08bac9876353e79ec223441fb24ea3';

/** 哪些请求需要签名（照抄 v29 的判定） */
function needsSignature(method, url) {
  return String(method).toUpperCase() === 'POST'
    && (url === '/runs'
      || url === '/runs/sessions/start'
      || /^\/runs\/sessions\/[0-9]+\/finish$/.test(url));
}

const sha256hex = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const hmacHex = (key, msg) => crypto.createHmac('sha256', key).update(msg, 'utf8').digest('hex');

/** 生成三个签名头 */
export function signHeaders({ method, url, token, deviceId, bodyString }) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const canonical = [
    'v1',
    String(method).toUpperCase(),
    url,
    timestamp,
    nonce,
    sha256hex(token || ''),
    sha256hex(deviceId || ''),
    sha256hex(bodyString || ''),
  ].join('\n') + '\n';

  return {
    'sunshine-run-timestamp': timestamp,
    'sunshine-run-nonce': nonce,
    'sunshine-run-sign': hmacHex(SIGN_KEY, canonical),
  };
}

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

      // v29 起：三个写接口必须带签名（用**实际发出去的那份 body 字符串**去算）
      let sign = {};
      if (needsSignature(method, url)) {
        if (token && did) {
          sign = signHeaders({ method, url, token, deviceId: did, bodyString: body });
        } else {
          onLog(`⚠ ${url} 需要签名，但缺少 token 或 deviceId，服务端会返回 403`);
        }
      }

      // dry-run 只拦**写**请求。读请求照发 —— 否则像"拉规则算默认参数"这种事
      // 在预览时拿不到真值，预览出来的 payload 和实发不一致，dry-run 就失去意义了。
      const isWrite = method.toUpperCase() !== 'GET';
      if (dryRun && isWrite) {
        onLog(`[dry-run] ${method} ${target}${body ? ` body=${body}` : ''}`);
        return { __dryRun: true, url: target, method, body: data, header: buildHeaders({ ...header, ...sign }) };
      }

      const res = await fetch(target, { method, headers: buildHeaders({ ...header, ...sign }), body });
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
