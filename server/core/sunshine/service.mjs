/**
 * 业务层 —— 网页能做的每一件事都在这里，路由文件只负责收参数、转成 JSON。
 *
 * 这一层只依赖两样东西：
 *   core/sunshine 下已核实过的协议实现（request/api/…）
 *   store.mjs 的本机落盘
 *
 * 于是「网页点了会发生什么」在代码里只有一条路径，好读也好查。
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createClient, API_BASE_URL } from './request.mjs'
import { createApi } from './api.mjs'
import { describeRules } from './rules.mjs'
import * as store from './store.mjs'

// ---------------------------------------------------------------- 目标后端

/**
 * 本次请求要打哪个后端、用哪个 token。
 * 演练模式（demo）不需要真实凭证，直接打本机 mock。
 */
export function currentTarget() {
  const cfg = store.getConfig()
  const cred = store.getCredentials()
  const demo = cfg.mode === 'demo'
  const baseUrl = cfg.baseUrl || (demo
    ? `http://127.0.0.1:${cfg.mockPort}/sunshine`
    : (cred?.baseUrl || API_BASE_URL))

  return {
    mode: demo ? 'demo' : 'real',
    baseUrl,
    token: demo ? store.DEMO_TOKEN : (cred?.token || ''),
    deviceId: cred?.deviceId,
    deviceFingerprint: cred?.deviceFingerprint,
    loggedIn: demo || Boolean(cred?.token),
  }
}

/** 造一个 API 客户端（不校验是否已登录） */
export function makeApi() {
  const target = currentTarget()
  const client = createClient({
    baseUrl: target.baseUrl,
    token: target.token,
    deviceId: target.deviceId,
    deviceFingerprint: target.deviceFingerprint,
  })
  return { api: createApi(client), client, target }
}

/**
 * 造一个可用的 API 客户端，没登录就抛出**人话**错误。
 * 所有会真正发写请求的地方都走它。
 */
export function requireApi() {
  const ctx = makeApi()
  if (!ctx.target.loggedIn) {
    const err = new Error('还没有接入学校账号，请先完成「接入向导」')
    err.code = 'NOT_LOGGED_IN'
    throw err
  }
  return ctx
}

/** 把底层报错翻译成使用者能看懂的话 */
export function explainError(e) {
  if (!e) return '未知错误'
  if (e.code === 'NOT_LOGGED_IN') return e.message
  if (e.code === 401 || e.statusCode === 401) return '登录状态已失效（服务端返回 401），请重新做一次接入向导'
  if (e.code === 403) return '这个账号还没有绑定学号，请先在小程序里绑定学号'
  if (e.statusCode === 502) return '学校服务器 502（服务端故障），已尝试回退默认地址'
  return e.message || String(e)
}

// ---------------------------------------------------------------- 接入向导

/**
 * 解析用户喂进来的凭证文本。
 * 接受：裸 token 字符串，或开发者工具里那段 JSON（token/deviceId/userInfo 任选）。
 * （与 sunshine-run-client/src/cli.mjs 的 parseCredentialInput 一致）
 */
export function parseCredentialInput(text) {
  const raw = String(text || '').trim()
  if (!raw) throw new Error('内容是空的')
  if (!raw.startsWith('{')) {
    if (raw.length < 8) throw new Error('看起来不像 token（太短了）')
    return { token: raw }
  }
  let obj
  try {
    obj = JSON.parse(raw)
  } catch (e) {
    throw new Error(`不是合法的 JSON：${e.message}`)
  }
  const pickKey = (o, keys) => {
    for (const k of keys) if (o[k] != null && o[k] !== '') return o[k]
    return undefined
  }
  const userInfo = pickKey(obj, ['userInfo', 'user_info', 'user'])
  const out = {
    token: pickKey(obj, ['token', 'Token', 'accessToken']),
    deviceId: pickKey(obj, ['deviceId', 'device_id']),
    deviceFingerprint: pickKey(obj, ['deviceFingerprint', 'device_fp', 'fingerprint']),
    userInfo: userInfo && typeof userInfo === 'object' ? userInfo : null,
  }
  if (!out.token) throw new Error('这段 JSON 里没有 token 字段')
  return out
}

/**
 * 保存并校验凭证：先打 /auth/check 和 /users/profile，通过了才落盘。
 */
export async function login({ text, baseUrl } = {}) {
  const parsed = parseCredentialInput(text)
  const cfg = store.getConfig()
  const base = baseUrl || store.getCredentials()?.baseUrl || API_BASE_URL

  const client = createClient({
    baseUrl: base,
    token: parsed.token,
    deviceId: parsed.deviceId,
    deviceFingerprint: parsed.deviceFingerprint,
  })
  const api = createApi(client)

  await api.checkLogin() // 失败会抛，交给上层显示
  let userInfo = parsed.userInfo
  try {
    userInfo = (await api.getUserProfile()) || userInfo
  } catch {
    // profile 读不到不影响保存
  }

  store.setCredentials({
    baseUrl: base,
    token: parsed.token,
    deviceId: client.identity.deviceId,
    deviceFingerprint: client.identity.deviceFingerprint,
    deviceInfo: client.identity.deviceInfo,
    userInfo,
  })
  // 真凭证一定意味着退出演练模式
  store.setConfig({ mode: 'real', baseUrl: null, mockPort: cfg.mockPort })

  return { user: userInfo, deviceId: client.identity.deviceId }
}

/** 从老客户端（sunshine-run-client）的 .auth 文件一键导入 */
export async function importLegacy() {
  const legacy = store.readLegacyCredentials()
  if (!legacy) throw new Error('没找到老客户端的凭证文件（sunshine-run-client/.auth/default.json）')
  return login({ text: JSON.stringify(legacy), baseUrl: legacy.baseUrl })
}

export function logout() {
  store.clearCredentials()
  store.setConfig({ mode: 'real' })
  return { ok: true }
}

/** 首页/向导要用的「当前状态」 */
export function authStatus() {
  const target = currentTarget()
  const cred = store.getCredentials()
  const legacy = store.readLegacyCredentials()
  return {
    mode: target.mode,
    loggedIn: target.loggedIn,
    baseUrl: target.baseUrl,
    deviceId: target.deviceId || null,
    deviceFingerprint: target.deviceFingerprint || null,
    tokenPrefix: cred?.token ? `${String(cred.token).slice(0, 8)}…` : null,
    savedAt: cred?.savedAt || null,
    user: cred?.userInfo || null,
    hasLegacy: Boolean(legacy),
    legacyFile: legacy ? store.legacyCredentialPath() : null,
    jitter: store.getConfig().jitter,
    mockPort: store.getConfig().mockPort,
  }
}

// ---------------------------------------------------------------- 规则 / 路线

export async function getRules() {
  const { api } = makeApi()
  let raw = null
  try {
    raw = await api.getCurrentRunRule()
  } catch {
    raw = null
  }
  return describeRules(raw)
}

/**
 * 列可用路线。
 *
 * 协议里没有一个「列出全部路线」的接口（/routes/nearby/rat-line 实测稳定 500），
 * 所以只能拿 /routes/{id} 从 1 开始逐个试 —— 纯只读，扫一次缓存 6 小时。
 */
export async function listRoutes({ refresh = false } = {}) {
  const { api, target } = makeApi()
  const cache = store.getRoutesCache()
  const fresh = cache
    && cache.baseUrl === target.baseUrl
    && !refresh
    && Date.now() - new Date(cache.at).getTime() < 6 * 3600 * 1000

  if (fresh) return { ...cache, cached: true }

  const items = []
  for (let id = 1; id <= 24; id++) {
    try {
      const r = await api.getRouteDetail(id)
      const cps = Array.isArray(r.checkpoints) ? r.checkpoints : []
      const start = cps.find((x) => x.startPoint === true) || cps[0] || {}
      items.push({
        id,
        name: r.name || `路线 ${id}`,
        passMode: r.passMode || null,
        checkpointHitRadiusM: r.checkpointHitRadiusM ?? 30,
        startAllowedRadiusM: r.startAllowedRadiusM ?? null,
        checkpointCount: cps.length,
        startLatitude: start.latitude != null ? Number(start.latitude) : null,
        startLongitude: start.longitude != null ? Number(start.longitude) : null,
      })
    } catch {
      // 不存在/未启用的 id 直接跳过（接口会返回「路线不存在或未启用」）
    }
    await new Promise((r) => setTimeout(r, 120))
  }

  const entry = { at: new Date().toISOString(), baseUrl: target.baseUrl, items }
  store.setRoutesCache(entry)
  return { ...entry, cached: false }
}

/** 取一条路线的完整打卡点（生成轨迹要用） */
export async function getRouteDetail(routeId) {
  const { api } = makeApi()
  const detail = await api.getRouteDetail(routeId)
  const checkpoints = Array.isArray(detail?.checkpoints) ? detail.checkpoints : []
  if (checkpoints.length < 2) throw new Error(`路线 ${routeId} 没有可用的轨迹点`)
  return { detail, checkpoints }
}

// ---------------------------------------------------------------- 记录 / 统计

export async function getRecords({ page = 1, size = 10 } = {}) {
  const { api } = makeApi()
  const data = await api.getRunRecords({ dateType: 'semester', page, size })
  return {
    records: Array.isArray(data?.records) ? data.records : [],
    total: data?.total ?? 0,
    pages: data?.pages ?? 1,
    current: data?.current ?? page,
    size: data?.size ?? size,
  }
}

export async function getStats() {
  const { api } = makeApi()
  return (await api.getStats()) || null
}

// ---------------------------------------------------------------- 只读诊断

/**
 * 逐个接口探活 —— 只读，不写任何东西。
 * 对应 CLI 的 probe / rules / routes / whoami 的只读部分。
 */
export async function diagnose() {
  const target = currentTarget()
  const { api, client } = makeApi()

  const checks = [
    ['GET /auth/check', () => api.checkLogin()],
    ['GET /users/profile', () => api.getUserProfile()],
    ['GET /users/run-settings', () => api.getRunSettings()],
    ['GET /run-rules/current', () => api.getCurrentRunRule()],
    ['GET /stats', () => api.getStats()],
    ['GET /runs', () => api.getRunRecords({ dateType: 'semester', page: 1, size: 1 })],
  ]

  const results = []
  for (const [name, fn] of checks) {
    try {
      const data = await fn()
      results.push({ name, ok: true, brief: JSON.stringify(data ?? null)?.slice(0, 180) ?? 'null' })
    } catch (e) {
      results.push({
        name,
        ok: false,
        brief: explainError(e),
        code: e?.code ?? null,
        http: e?.statusCode ?? null,
      })
    }
  }

  return {
    target: {
      mode: target.mode,
      baseUrl: target.baseUrl,
      loggedIn: target.loggedIn,
      tokenPrefix: target.token ? `${target.token.slice(0, 8)}…` : null,
    },
    device: {
      deviceId: client.identity.deviceId,
      deviceFingerprint: client.identity.deviceFingerprint,
      deviceInfo: client.identity.deviceInfo,
    },
    core: readCoreManifest(),
    checks: results,
    dataDir: store.dataDir(),
  }
}

/**
 * 读核心模块的来源清单（由 scripts/sync-core.mjs 生成）。
 * 打包运行（.output）时源码不在旁边，读不到就返回 null —— 不是错误。
 */
export function readCoreManifest() {
  try {
    const p = path.join(process.cwd(), 'server', 'core', 'sunshine', 'CORE-VERSION.json')
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
    return { source: raw.source, syncedAt: raw.syncedAt, files: Object.keys(raw.files || {}) }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 剪贴板

/**
 * 读系统剪贴板（Windows / macOS / Linux）。
 * 失败不抛异常，把**原因**原样返回 —— 用户在网页上点一下就知道该怎么办。
 */
export function readClipboardText() {
  const attempts = process.platform === 'win32'
    ? [['powershell', ['-NoProfile', '-Command', 'Get-Clipboard', '-Raw']], ['pwsh', ['-NoProfile', '-Command', 'Get-Clipboard', '-Raw']]]
    : process.platform === 'darwin'
      ? [['pbpaste', []]]
      : [['xclip', ['-selection', 'clipboard', '-o']], ['xsel', ['-b']]]

  return new Promise((resolve) => {
    const errors = []
    const tryAt = (i) => {
      if (i >= attempts.length) return resolve({ text: null, errors })
      const [cmd, args] = attempts[i]
      execFile(cmd, args, { encoding: 'utf8', timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (!err && stdout && stdout.trim()) return resolve({ text: stdout.trim(), errors })
        errors.push(err ? `${cmd}: ${err.code || err.message}` : `${cmd}: 剪贴板是空的`)
        tryAt(i + 1)
      })
    }
    tryAt(0)
  })
}
