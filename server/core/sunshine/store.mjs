/**
 * 落盘 —— 本项目所有「本机状态」都走这里，一共 5 个 JSON 文件，都在 .data/ 下：
 *
 *   credentials.json  凭证（token / deviceId / 指纹 / 用户信息）—— 明文，已在 .gitignore
 *   config.json       用户偏好（演练模式开关、上次选的路线/里程…）
 *   state.json        进行中的跑步状态（关掉浏览器、甚至重启服务都能接上）
 *   runs-log.json     本机执行日志（谁在什么时候提交了什么、结果如何）
 *   routes-cache.json 路线扫描结果缓存（/routes/{id} 要逐个试，扫一次缓存起来）
 *
 * 为什么不放数据库：这些数据量都很小（最多几百条），JSON 最直观 ——
 * 打开文件就能看懂程序存了什么，出问题也好排查。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 官方默认后端（照抄小程序常量，注意结尾是 /sunshine） */
export const DEFAULT_BASE_URL = 'https://sports.sqcoe.com/sunshine'
/** 演练模式指向本机 mock 后端 */
export const DEMO_BASE_URL = 'http://127.0.0.1:8898/sunshine'
export const DEMO_TOKEN = 'mock'

const DATA_DIR = process.env.SUNSHINE_DATA_DIR
  ? path.resolve(process.env.SUNSHINE_DATA_DIR)
  : path.join(process.cwd(), '.data')

const FILES = {
  credentials: 'credentials.json',
  config: 'config.json',
  state: 'state.json',
  runsLog: 'runs-log.json',
  routesCache: 'routes-cache.json',
}

export function dataDir() {
  return DATA_DIR
}

function filePath(key) {
  return path.join(DATA_DIR, FILES[key])
}

function readJson(key, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath(key), 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') return fallback
    // 文件存在但坏了 —— 明确报出来，别静默当成「没数据」
    throw new Error(`本机数据文件损坏：${filePath(key)}\n  ${e.message}\n  删掉它重新开始即可。`)
  }
}

function writeJson(key, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const target = filePath(key)
  // 先写临时文件再改名 —— 中途断电也不会留下半个坏文件
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, target)
  return target
}

function removeJson(key) {
  try {
    fs.unlinkSync(filePath(key))
    return true
  } catch (e) {
    if (e.code === 'ENOENT') return false
    throw e
  }
}

// ---------------------------------------------------------------- 配置

const DEFAULT_CONFIG = {
  mode: 'real',        // 'real' 打真后端 | 'demo' 打本机演练后端
  baseUrl: null,       // 非空则覆盖上面两者的地址
  mockPort: 8898,      // 演练后端端口
  jitter: true,        // 默认加随机浮动（同 totoro 的 ±0.09km / ±0.15km/h）
  lastRouteId: null,
  lastDistanceKm: null,
}

export function getConfig() {
  return { ...DEFAULT_CONFIG, ...(readJson('config', {}) || {}) }
}

export function setConfig(patch) {
  const next = { ...getConfig(), ...patch }
  writeJson('config', next)
  return next
}

// ---------------------------------------------------------------- 凭证

export function getCredentials() {
  return readJson('credentials', null)
}

export function setCredentials(data) {
  const payload = { ...data, savedAt: new Date().toISOString() }
  writeJson('credentials', payload)
  return payload
}

export function clearCredentials() {
  return removeJson('credentials')
}

/**
 * 老客户端（sunshine-run-client）的凭证文件位置。
 * 用户如果已经用 CLI 引导过，这里可以直接一键导入，不用再抓一次 token。
 */
export function legacyCredentialPath() {
  return process.env.SUNSHINE_LEGACY_AUTH
    ? path.resolve(process.env.SUNSHINE_LEGACY_AUTH)
    : path.resolve(process.cwd(), '..', 'sunshine-run-client', '.auth', 'default.json')
}

export function readLegacyCredentials() {
  const p = legacyCredentialPath()
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
    return raw?.token ? { ...raw, __file: p } : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 进行中的跑步

export function getRunState() {
  return readJson('state', null)
}

export function setRunState(state) {
  return writeJson('state', state)
}

export function clearRunState() {
  return removeJson('state')
}

// ---------------------------------------------------------------- 路线缓存

export function getRoutesCache() {
  return readJson('routesCache', null)
}

export function setRoutesCache(entry) {
  return writeJson('routesCache', entry)
}

// ---------------------------------------------------------------- 本机执行日志

const LOG_LIMIT = 300

export function getRunLog() {
  const list = readJson('runsLog', [])
  return Array.isArray(list) ? list : []
}

export function appendRunLog(entry) {
  const list = getRunLog()
  list.unshift({ at: new Date().toISOString(), ...entry })
  writeJson('runsLog', list.slice(0, LOG_LIMIT))
  return list[0]
}
