/**
 * 一键抓凭证 —— 在**这台电脑上**临时架一个 HTTPS 中间人代理，把小程序请求里的
 * `sunshine-run` 头（也就是登录凭证）取出来，然后立刻收拾干净。
 *
 * 为什么需要它：
 *   小程序的 token 由微信签发，只能在微信环境里产生（PROTOCOL.md 第 3 节）。
 *   而普通用户没有微信开发者工具 —— 官方的那条等价路径（Console 里读 storage）走不通。
 *   剩下的唯一办法就是从流量里取，也就是这个文件。
 *
 * ============================ 安全边界（刻意收窄）============================
 *   1. 只监听 127.0.0.1，外网连不上；只解密 allowHosts 里的域名（默认 *.sqcoe.com），
 *      其它域名一律**原样直通**，程序看不到内容。
 *   2. 根证书**每次现生成**（不是内置的），有效期 7 天，用完立刻从证书库里删除。
 *      —— 内置固定根证书等于把私钥公开，任何人都能拿它去中间人，那才是真的危险。
 *   3. 只保存 token / deviceId / 指纹，**不落任何流量内容**；日志里 token 只留前 8 位。
 *   4. 系统代理会先备份原值，抓完自动还原；就算程序被强杀，
 *      下次启动时 `cleanupOrphan()` 也会把代理和证书收拾干净。
 *   5. 全程需要用户主动点一次（导入根证书时 Windows 还会再弹一次确认框）。
 * ==========================================================================
 */

import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import path from 'node:path'
import tls from 'node:tls'
import { login } from './service.mjs'
import * as store from './store.mjs'

/** 默认只解密这个域名的流量 */
const DEFAULT_ALLOW = ['sports.sqcoe.com', 'sqcoe.com']
/** 抓不到就自动放弃（分钟），避免代理一直挂着 */
const AUTO_TIMEOUT_MS = 10 * 60 * 1000
/** 导入根证书后最多等这么久让用户去重启微信 */
const PROXY_PORT = Number(process.env.SUNSHINE_CAPTURE_PORT || 8899)

// ---------------------------------------------------------------- 小工具

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function runFile(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 60_000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${explainSpawnError(cmd, err)}\n${String(stderr || '').trim()}`.trim()
        reject(err)
        return
      }
      resolve(String(stdout || '').trim())
    })
  })
}

/**
 * 把「起不了子进程」翻译成人话。
 *
 * EPERM/ENOENT 这两个码只有一种现实含义：powershell.exe / certutil.exe 没能被拉起来 ——
 * 通常是杀毒软件、公司管控策略，或者程序本身跑在受限环境里。
 * 直接甩一个 "spawn EPERM" 给用户是没有意义的。
 */
function explainSpawnError(cmd, err) {
  if (err.code === 'EPERM') {
    return `无法启动 ${cmd}.exe：被安全软件或系统策略拦住了。`
      + `请允许本程序调用 ${cmd}，或改用「手动方式」接入（需要微信开发者工具）。`
  }
  if (err.code === 'ENOENT') {
    return `找不到 ${cmd}.exe —— 这个功能需要 Windows 自带的 PowerShell 与 certutil。`
  }
  return err.message
}

function captureDir() {
  return path.join(store.dataDir(), 'capture')
}

function backupFile() {
  return path.join(captureDir(), 'proxy-backup.json')
}

// ---------------------------------------------------------------- 状态（给网页看）

let state = null

function nowIso() {
  return new Date().toISOString()
}

function ensureState() {
  if (!state) state = { running: false, phase: 'idle', steps: [], log: [], port: PROXY_PORT }
  return state
}

function log(text, level = 'info') {
  const s = ensureState()
  s.log.push({ t: nowIso(), level, text })
  if (s.log.length > 120) s.log = s.log.slice(-120)
}

function step(key, title) {
  const s = ensureState()
  let item = s.steps.find((x) => x.key === key)
  if (!item) {
    item = { key, title, status: 'pending', detail: '' }
    s.steps.push(item)
  }
  return {
    running(detail = '') { item.status = 'running'; item.detail = detail },
    done(detail = '') { item.status = 'done'; item.detail = detail },
    failed(detail = '') { item.status = 'failed'; item.detail = detail },
  }
}

export function snapshot() {
  const s = ensureState()
  return {
    running: s.running,
    phase: s.phase,
    port: s.port,
    steps: s.steps,
    log: s.log,
    captured: s.captured || null,
    user: s.user || null,
    error: s.error || null,
    startedAt: s.startedAt || null,
    allowHosts: s.allowHosts || DEFAULT_ALLOW,
    platformSupported: process.platform === 'win32',
  }
}

// ---------------------------------------------------------------- 系统代理（注册表）

const PROXY_KEY = process.env.SUNSHINE_CAPTURE_REGKEY
  || 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

async function readProxySetting(name) {
  try {
    const out = await runFile('reg', ['query', PROXY_KEY, '/v', name])
    const m = out.match(/REG_\w+\s+(.*)$/m)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

async function writeProxySetting(name, type, value) {
  await runFile('reg', ['add', PROXY_KEY, '/v', name, '/t', type, '/d', value, '/f'])
}

async function deleteProxySetting(name) {
  await runFile('reg', ['delete', PROXY_KEY, '/v', name, '/f']).catch(() => {})
}

/**
 * 通知系统代理设置变了。
 * 浏览器会自己轮询注册表，但有些程序要收到这个通知才刷新；
 * 微信反正只在启动时读一次，所以这里失败也不影响主流程（best-effort）。
 */
async function notifyProxyChanged() {
  const ps = `
$sig = '[DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);'
$t = Add-Type -MemberDefinition $sig -Name WinInet -Namespace Sunshine -PassThru
[void]$t::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
[void]$t::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
`.trim()
  try {
    await runFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps])
    return true
  } catch {
    return false
  }
}

/** 备份当前代理设置（只备份一次，重复调用不会覆盖） */
async function backupProxy() {
  if (fs.existsSync(backupFile())) return JSON.parse(fs.readFileSync(backupFile(), 'utf8'))
  const snapshotBefore = {
    ProxyEnable: await readProxySetting('ProxyEnable'),
    ProxyServer: await readProxySetting('ProxyServer'),
    ProxyOverride: await readProxySetting('ProxyOverride'),
    at: nowIso(),
    port: PROXY_PORT,
  }
  fs.mkdirSync(captureDir(), { recursive: true })
  fs.writeFileSync(backupFile(), `${JSON.stringify(snapshotBefore, null, 2)}\n`)
  return snapshotBefore
}

/** 把系统代理指向本机抓包端口 */
async function takeOverProxy() {
  await backupProxy()
  await writeProxySetting('ProxyServer', 'REG_SZ', `127.0.0.1:${PROXY_PORT}`)
  await writeProxySetting('ProxyEnable', 'REG_DWORD', '1')
  await notifyProxyChanged()
}

/**
 * 还原系统代理。
 * @param {boolean} force 即使备份文件不在也把 ProxyEnable 关掉（用于兜底清理）
 */
export async function restoreProxy(force = false) {
  const file = backupFile()
  if (!fs.existsSync(file)) {
    if (force) {
      // 没有备份可依，保守起见直接关掉代理，总比让电脑连不上网好
      await writeProxySetting('ProxyEnable', 'REG_DWORD', '0')
      await notifyProxyChanged()
      return { restored: true, fallback: true }
    }
    return { restored: false, fallback: false }
  }

  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (saved.ProxyServer) await writeProxySetting('ProxyServer', 'REG_SZ', saved.ProxyServer)
  else await deleteProxySetting('ProxyServer')

  if (saved.ProxyOverride) await writeProxySetting('ProxyOverride', 'REG_SZ', saved.ProxyOverride)
  else await deleteProxySetting('ProxyOverride')

  await writeProxySetting('ProxyEnable', 'REG_DWORD', String(saved.ProxyEnable ?? '0'))
  await notifyProxyChanged()
  fs.rmSync(file, { force: true })
  return { restored: true, fallback: false, saved }
}

// ---------------------------------------------------------------- 证书

/**
 * 生成临时根证书 + 叶子证书的 PowerShell 脚本。
 *
 * ⚠️ 这里刻意**不用反引号续行** —— 它是 JS 模板字符串，反引号会把字符串提前截断
 * （真踩过：整个服务直接起不来）。每条 cmdlet 写在一行里就好。
 */
const CERT_PS = `
param([string]$OutDir, [string]$CaPass, [string]$LeafPass, [string]$HostName, [string]$WildcardName, [string]$Trust)
$ErrorActionPreference = 'Stop'
$ca = New-SelfSignedCertificate -Subject 'CN=Sunshine Run Helper (temporary MITM root)' -CertStoreLocation Cert:\\CurrentUser\\My -KeyExportPolicy Exportable -KeyUsage CertSign,CRLSign,DigitalSignature -KeyAlgorithm RSA -KeyLength 2048 -NotAfter (Get-Date).AddDays(7) -TextExtension @('2.5.29.19={text}CA=true&pathlength=0')
$caSec = ConvertTo-SecureString -String $CaPass -Force -AsPlainText
Export-PfxCertificate -Cert $ca -FilePath (Join-Path $OutDir 'ca.pfx') -Password $caSec | Out-Null
Export-Certificate -Cert $ca -FilePath (Join-Path $OutDir 'ca.cer') | Out-Null

$leaf = New-SelfSignedCertificate -Subject "CN=$HostName" -DnsName $HostName, $WildcardName -Signer $ca -CertStoreLocation Cert:\\CurrentUser\\My -KeyExportPolicy Exportable -NotAfter (Get-Date).AddDays(7)
$leafSec = ConvertTo-SecureString -String $LeafPass -Force -AsPlainText
Export-PfxCertificate -Cert $leaf -FilePath (Join-Path $OutDir 'leaf.pfx') -Password $leafSec | Out-Null

# 导入到「当前用户 → 受信任的根证书颁发机构」。
# 证书进的是**当前用户**的库，不需要管理员权限。
# 用 certutil 而不是 Import-Certificate —— 后者会弹一个阻塞的确认框，把无人值守的流程卡死。
if ($Trust -eq 'yes') {
  & certutil.exe -user -addstore Root (Join-Path $OutDir 'ca.cer') | Out-Null
}

Write-Output ("THUMBS " + $ca.Thumbprint + " " + $leaf.Thumbprint)
`.trim()

async function setupCertificates(hostName) {
  const dir = captureDir()
  fs.mkdirSync(dir, { recursive: true })
  const script = path.join(dir, 'setup-cert.ps1')
  // ⚠️ 必须带 UTF-8 BOM：Windows PowerShell 5.1 读无 BOM 的 .ps1 会按 GBK 解释，
  // 脚本里中文注释的尾字节会把换行"吃掉"，导致后面莫名其妙报语法错误（真踩过）。
  fs.writeFileSync(script, `\uFEFF${CERT_PS}\n`)

  const caPass = crypto.randomBytes(18).toString('hex')
  const leafPass = crypto.randomBytes(18).toString('hex')
  const wildcard = `*.${hostName.split('.').slice(1).join('.')}`
  const trust = process.env.SUNSHINE_CAPTURE_SKIP_TRUST === '1' ? 'no' : 'yes'

  const out = await runFile('powershell', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script,
    '-OutDir', dir,
    '-CaPass', caPass,
    '-LeafPass', leafPass,
    '-HostName', hostName,
    '-WildcardName', wildcard,
    '-Trust', trust,
  ])

  const thumbs = (out.match(/THUMBS\s+(\w+)\s+(\w+)/) || [])
  const info = {
    dir,
    caPass,
    leafPass,
    caThumb: thumbs[1] || null,
    leafThumb: thumbs[2] || null,
    host: hostName,
    createdAt: nowIso(),
  }
  fs.writeFileSync(path.join(dir, 'certs.json'), `${JSON.stringify({ caThumb: info.caThumb, leafThumb: info.leafThumb, host: hostName }, null, 2)}\n`)
  return info
}

/** 把生成的证书从证书库里删掉，并删除私钥文件 */
export async function removeCertificates() {
  const dir = captureDir()
  const metaFile = path.join(dir, 'certs.json')
  if (!fs.existsSync(metaFile)) return { removed: false }

  let meta = {}
  try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) } catch { /* ignore */ }

  const thumbs = [meta.caThumb, meta.leafThumb].filter(Boolean)
  for (const thumb of thumbs) {
    // ⚠️ 必须用 certutil：PowerShell 的 Remove-Item 删「用户根证书存储」会被拒绝
    // （报 "operation is on user root store and UI is not allowed"），
    // 结果就是那张受信任的根证书留在用户电脑上 —— 实测踩过。
    await runFile('certutil', ['-user', '-delstore', 'Root', thumb]).catch(() => {})
    await runFile('certutil', ['-user', '-delstore', 'My', thumb]).catch(() => {})
  }

  for (const f of ['ca.pfx', 'leaf.pfx', 'ca.cer', 'certs.json', 'setup-cert.ps1']) {
    fs.rmSync(path.join(dir, f), { force: true })
  }
  return { removed: true, thumbs }
}

// ---------------------------------------------------------------- 中间人代理

/**
 * 启动代理。
 * @param {object} o
 * @param {number} o.port
 * @param {string[]} o.allowHosts  需要解密的域名（其余直通）
 * @param {object} o.upstreamMap   仅测试用：host → "ip:port"，把上游指向别处
 * @param {(info:object)=>void} o.onCapture  抓到凭证时回调
 */
export async function startProxy({ port = PROXY_PORT, allowHosts = DEFAULT_ALLOW, upstreamMap = {}, onCapture } = {}) {
  const caPfX = path.join(captureDir(), 'ca.pfx')
  const leafPfX = path.join(captureDir(), 'leaf.pfx')
  const certMeta = JSON.parse(fs.readFileSync(path.join(captureDir(), 'certs.json'), 'utf8'))
  const secrets = readSecrets()

  const leafContext = tls.createSecureContext({
    pfx: fs.readFileSync(leafPfX),
    passphrase: secrets.leafPass,
  })
  // CA 只为测试时给客户端做校验用（真实场景是 Windows 信任它）
  const caPem = readCaPem()

  const allow = (host) => allowHosts.some((d) => host === d || host.endsWith(`.${d}`))

  /** 被解密的请求都在这里处理：抓头发给 onCapture，然后转发给真服务器 */
  const inner = http.createServer((req, res) => {
    const host = req.headers.host?.split(':')[0] || certMeta.host
    const headerToken = req.headers['sunshine-run']

    if (headerToken) {
      onCapture?.({
        source: 'header',
        token: String(headerToken),
        deviceId: req.headers['sunshine-run-device-id'] ? String(req.headers['sunshine-run-device-id']) : null,
        deviceFingerprint: req.headers['sunshine-run-device-fp'] ? String(req.headers['sunshine-run-device-fp']) : null,
        host,
        path: req.url,
      })
    }

    const [upHost, upPort] = (upstreamMap[host] || `${host}:443`).split(':')
    const proxyReq = https.request({
      host: upHost,
      port: Number(upPort || 443),
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host },
      servername: host, // SNI 用真实域名，否则真服务器会拒绝
      timeout: 20_000,
    }, (proxyRes) => {
      // 登录接口的响应体里也带 token，顺手看一眼（有些版本不发请求头）
      const isLogin = /wx-login/.test(req.url || '')
      if (isLogin) {
        let body = ''
        proxyRes.on('data', (c) => {
          if (body.length < 65536) body += c.toString('utf8')
        })
        proxyRes.on('end', () => {
          try {
            const json = JSON.parse(body)
            const data = json?.data || json
            if (data?.token) {
              onCapture?.({
                source: 'wx-login-response',
                token: String(data.token),
                deviceId: null,
                deviceFingerprint: null,
                host,
                path: req.url,
                userInfo: data.userInfo || null,
              })
            }
          } catch { /* 不是 JSON 就算了 */ }
        })
      }
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers)
      proxyRes.pipe(res)
    })

    proxyReq.on('error', (e) => {
      log(`转发失败 ${req.method} ${host}${req.url}：${e.code || e.message}`, 'warn')
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`代理转发失败: ${e.message}`)
    })
    proxyReq.on('timeout', () => proxyReq.destroy(new Error('超时')))

    req.pipe(proxyReq)
  })

  const server = http.createServer((req, res) => {
    // 明文 HTTP 一般用不到（目标都是 HTTPS），直接拒绝，避免误当成开放代理
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('这个代理只用于 HTTPS（CONNECT）')
  })

  server.on('connect', (req, clientSocket, head) => {
    const [host, portStr] = String(req.url).split(':')
    const portNum = Number(portStr || 443)

    if (!allow(host)) {
      // 不在白名单：原样直通，程序看不到任何内容（客户端看到的是对方**自己的**证书）
      const [upHost, upPort] = (upstreamMap[host] || `${host}:${portNum}`).split(':')
      const upstream = net.connect(Number(upPort || portNum), upHost, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head?.length) upstream.write(head)
        upstream.pipe(clientSocket)
        clientSocket.pipe(upstream)
      })
      upstream.on('error', () => clientSocket.destroy())
      clientSocket.on('error', () => upstream.destroy())
      return
    }

    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    // CONNECT 之后可能已经有一部分 TLS 字节被读进 head 里，必须先塞回流里再做握手
    if (head?.length) clientSocket.unshift(head)
    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      secureContext: leafContext,
      ALPNProtocols: ['http/1.1'],
    })
    tlsSocket.on('error', () => clientSocket.destroy())
    inner.emit('connection', tlsSocket)
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })

  return {
    port,
    server,
    caPem,
    close: () => new Promise((resolve) => {
      try { server.close(() => resolve()) } catch { resolve() }
      setTimeout(resolve, 1500) // 有长连接时不干等
    }),
  }
}

/** 证书口令：只放在进程内存里（证书只用这一次，没必要落盘） */
let secretsInMemory = null

function readSecrets() {
  if (!secretsInMemory) throw new Error('证书口令丢失，请重新开始抓取')
  return secretsInMemory
}

function readCaPem() {
  try {
    const der = fs.readFileSync(path.join(captureDir(), 'ca.cer'))
    const b64 = der.toString('base64').match(/.{1,64}/g).join('\n')
    return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 编排

let proxyHandle = null
let timer = null

/** 停掉一切：关代理、还原系统代理、删证书 */
export async function stop({ reason = '用户停止', removeCert = true } = {}) {
  const s = ensureState()
  if (timer) { clearTimeout(timer); timer = null }

  if (proxyHandle) {
    await proxyHandle.close().catch(() => {})
    proxyHandle = null
  }
  if (s.tookOverProxy) {
    const r = await restoreProxy().catch((e) => {
      log(`还原系统代理失败：${e.message}（可在诊断页点「一键还原」）`, 'error')
      return null
    })
    if (r?.restored) log(r.fallback ? '系统代理已关闭（没有找到原始设置）' : '系统代理已还原成原来的设置')
    s.tookOverProxy = false
  }
  if (removeCert) await removeCertificates().catch(() => {})
  secretsInMemory = null

  s.running = false
  if (s.phase !== 'captured' && s.phase !== 'failed') s.phase = 'stopped'
  log(`已停止：${reason}`)
  return snapshot()
}

/**
 * 抓到凭证后的收尾：校验并保存，然后立刻收拾干净。
 *
 * ⚠️ 注意 phase 是**最后**才翻成 captured/failed 的。
 * 如果一抓到就先翻状态，网页（或测试）会在「代理还没还原、证书还没删」的瞬间
 * 就以为一切结束了 —— 这个竞态真踩过。
 */
async function finishWithCapture(info) {
  const s = ensureState()
  if (s.saving || s.phase === 'captured') return
  s.saving = true

  s.captured = { at: nowIso(), host: info.host, path: info.path, tokenPrefix: `${info.token.slice(0, 8)}…`, source: info.source }
  log(`✓ 抓到凭证（${info.token.slice(0, 8)}…，来自 ${info.source}）`)

  const verify = step('save', '校验并保存凭证')
  verify.running()
  try {
    const res = await login({
      text: JSON.stringify({
        token: info.token,
        deviceId: info.deviceId || undefined,
        deviceFingerprint: info.deviceFingerprint || undefined,
        userInfo: info.userInfo || undefined,
      }),
    })
    s.user = res.user || null
    verify.done(res.user?.name || res.user?.studentName || '已保存')
    log('✓ 凭证已保存到本机，接下来会自动还原系统代理并删除证书')
  } catch (e) {
    verify.failed(e.message)
    s.error = `凭证校验失败：${e.message}`
    log(`✗ ${s.error}`, 'error')
  }

  await stop({ reason: '抓取完成，自动收拾', removeCert: true })
  s.saving = false
  s.phase = s.error ? 'failed' : 'captured'
  return snapshot()
}

/**
 * 开始抓取。
 * @param {object} o
 * @param {string} [o.host]      要解密的域名，默认 sports.sqcoe.com
 * @param {number} [o.timeoutMs]
 */
export async function start({ host = DEFAULT_ALLOW[0], timeoutMs = AUTO_TIMEOUT_MS } = {}) {
  if (process.platform !== 'win32') {
    throw new Error('一键抓取目前只支持 Windows（需要用到系统证书库与系统代理）')
  }
  const s = ensureState()
  if (s.running) throw new Error('已经有一次抓取在进行中')

  state = {
    running: true,
    phase: 'preparing',
    port: PROXY_PORT,
    steps: [],
    log: [],
    captured: null,
    user: null,
    error: null,
    startedAt: nowIso(),
    tookOverProxy: false,
    allowHosts: [host, host.split('.').slice(1).join('.')],
  }

  const onCapture = (info) => {
    finishWithCapture(info).catch((e) => log(`保存失败：${e.message}`, 'error'))
  }

  try {
    log(`开始抓取，只解密 ${state.allowHosts.join(' / ')} 的流量，其余原样直通`)

    const certStep = step('cert', '生成临时根证书并导入（Windows 会弹一次确认框）')
    certStep.running()
    const certs = await setupCertificates(host)
    secretsInMemory = { caPass: certs.caPass, leafPass: certs.leafPass }
    certStep.done(certs.caThumb ? `指纹 ${String(certs.caThumb).slice(0, 12)}…` : '')

    const proxyStep = step('proxy', `启动本机代理 127.0.0.1:${PROXY_PORT}`)
    proxyStep.running()
    const skipProxy = process.env.SUNSHINE_CAPTURE_SKIP_PROXY === '1'
    if (!skipProxy) {
      await takeOverProxy()
      state.tookOverProxy = true
    }
    const upstreamMap = {}
    if (process.env.SUNSHINE_CAPTURE_UPSTREAM) {
      for (const pair of process.env.SUNSHINE_CAPTURE_UPSTREAM.split(',')) {
        const [k, v] = pair.split('=')
        if (k && v) upstreamMap[k.trim()] = v.trim()
      }
      log(`（测试模式：上游映射 ${JSON.stringify(upstreamMap)}）`, 'warn')
    }
    proxyHandle = await startProxy({
      port: PROXY_PORT,
      allowHosts: state.allowHosts,
      upstreamMap,
      onCapture,
    })
    proxyStep.done(skipProxy ? '（已跳过系统代理设置）' : '系统代理已临时指向它')

    const waitStep = step('wait', '等你在 PC 微信里打开小程序并登录')
    waitStep.running('如果微信本来开着，需要**先完全退出再打开**（微信只在启动时读一次系统代理）')
    state.phase = 'waiting'
    log('请按顺序做：① 完全退出 PC 微信 ② 重新打开微信 ③ 进入「酷动·阳光跑」完成登录')

    timer = setTimeout(() => {
      log('等太久没抓到，自动放弃并还原（可以再点一次重试）', 'warn')
      stop({ reason: '超时自动放弃' }).catch(() => {})
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    return snapshot()
  } catch (e) {
    state.error = e.message
    state.phase = 'failed'
    step('cert').failed(e.message)
    log(`✗ 启动失败：${e.message}`, 'error')
    await stop({ reason: '启动失败，回滚' }).catch(() => {})
    state.phase = 'failed'
    state.error = e.message
    return snapshot()
  }
}

/**
 * 兜底清理 —— 服务启动时调用。
 *
 * 场景：抓取过程中程序被强杀/断电，系统代理还指着已经不存在的端口，电脑会连不上网。
 * 只要备份文件还在，就说明上次没收拾干净，这里自动还原。
 */
export async function cleanupOrphan() {
  if (process.platform !== 'win32') return { cleaned: false }
  const hasBackup = fs.existsSync(backupFile())
  const hasCerts = fs.existsSync(path.join(captureDir(), 'certs.json'))
  if (!hasBackup && !hasCerts) return { cleaned: false }

  const current = await readProxySetting('ProxyServer')
  const pointsAtUs = current && current.includes(`127.0.0.1:${PROXY_PORT}`)
  if (hasBackup && pointsAtUs) {
    await restoreProxy().catch(() => {})
  } else if (hasBackup) {
    fs.rmSync(backupFile(), { force: true })
  }
  if (hasCerts) await removeCertificates().catch(() => {})
  secretsInMemory = null
  return { cleaned: true, restoredProxy: Boolean(hasBackup && pointsAtUs) }
}

/** 供诊断页手动兜底 */
export async function forceCleanup() {
  const r = await cleanupOrphan()
  const s = ensureState()
  if (!s.running && !r.cleaned) {
    // 即使没有备份，也把代理关掉，避免"程序没了但电脑还在走代理"
    await restoreProxy(true).catch(() => {})
  }
  return r
}
