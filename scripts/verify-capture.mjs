#!/usr/bin/env node
/**
 * 一键抓凭证的端到端验证（开发用，不随发布包分发）。
 *
 *   node scripts/verify-capture.mjs
 *
 * 全程在本机闭环，**不碰任何真实域名**：
 *   · 用 SUNSHINE_CAPTURE_REGKEY 把「系统代理」写到 HKCU\Software\SunshineRunHelperTest
 *     （测试键，不是真的 Internet Settings），既验证了写入/还原逻辑，又不会影响这台电脑上网
 *   · 用 SUNSHINE_CAPTURE_UPSTREAM 把上游指向本机假服务器
 *   · 用 SUNSHINE_CAPTURE_SKIP_TRUST 跳过把根证书装进 Windows 信任库（那是给真机用的）
 *
 * 验证的内容：
 *   ① 临时根证书能生成，且签出来的叶子证书**链是有效的**（客户端拿 CA 去校验能过）
 *   ② 白名单域名（sports.sqcoe.com）的请求会被解密，能抓到 sunshine-run 头
 *   ③ 非白名单域名**不会被中间人**：客户端看到的是对方自己的证书
 *   ④ 抓到之后凭证会被保存，并且自动还原系统代理 + 删除证书
 */

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP_PORT = 2731
const PROXY_PORT = 8899
const UPSTREAM_TLS_PORT = 8443 // 白名单域名的假上游（HTTPS，自签证书 —— 代理转发会 502，但不影响抓取）
const UPSTREAM_TUNNEL_PORT = 9443 // 非白名单域名的假上游（TLS，用它自己的证书）
const FAKE_API_PORT = 8444 // 假「学校服务器」，供凭证校验走一遍（纯 HTTP，避免再碰证书）
const TEST_REGKEY = 'HKCU\\Software\\SunshineRunHelperTest'

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshine-capture-'))
const CA_PEM = path.join(DATA_DIR, 'capture', 'ca.cer')
const FAKE_TOKEN = `test-token-${crypto.randomBytes(6).toString('hex')}`

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let passed = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`   ✓ ${name}`) }
  else { failures.push(name); console.log(`   ✗ ${name}${detail ? ` —— ${detail}` : ''}`) }
}

// ---------------------------------------------------------------- 假上游

/**
 * 自签证书用 Node 造不出来，借 PowerShell 生成一张一次性证书。
 * 生成完立刻从证书库里删掉，只留 pfx 文件给假上游用。
 */
async function makeSelfSigned(host) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshine-upstream-'))
  const ps = `
$ErrorActionPreference='Stop'
$c = New-SelfSignedCertificate -Subject 'CN=${host}' -DnsName '${host}' -CertStoreLocation Cert:\\CurrentUser\\My -KeyExportPolicy Exportable -NotAfter (Get-Date).AddDays(1)
$sec = ConvertTo-SecureString -String 'testpass' -Force -AsPlainText
Export-PfxCertificate -Cert $c -FilePath '${dir.replace(/\\/g, '\\\\')}\\up.pfx' -Password $sec | Out-Null
Remove-Item ("Cert:\\CurrentUser\\My\\" + $c.Thumbprint) -Force
Write-Output $c.Thumbprint
`.trim()
  await new Promise((resolve, reject) => {
    const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', d => { err += d })
    p.on('exit', c => (c === 0 ? resolve() : reject(new Error(err || `退出码 ${c}`))))
  })
  return { pfx: path.join(dir, 'up.pfx'), passphrase: 'testpass' }
}

// ---------------------------------------------------------------- 启动被测服务

const child = spawn(process.execPath, [path.join(ROOT, '.output', 'server', 'index.mjs')], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PORT: String(APP_PORT),
    NITRO_PORT: String(APP_PORT),
    HOST: '127.0.0.1',
    SUNSHINE_DATA_DIR: DATA_DIR,
    SUNSHINE_CAPTURE_PORT: String(PROXY_PORT),
    SUNSHINE_CAPTURE_REGKEY: TEST_REGKEY,
    SUNSHINE_CAPTURE_UPSTREAM: `sports.sqcoe.com=127.0.0.1:${UPSTREAM_TLS_PORT},blocked.test=127.0.0.1:${UPSTREAM_TUNNEL_PORT}`,
  },
})
let serverLog = ''
child.stdout.on('data', d => { serverLog += d })
child.stderr.on('data', d => { serverLog += d })

process.on('exit', () => {
  try { child.kill() } catch { /* ignore */ }
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
})

async function api(pathname, body) {
  const res = await fetch(`http://127.0.0.1:${APP_PORT}${pathname}`, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {})
  const json = await res.json()
  if (!json.ok) throw new Error(`${pathname} → ${json.error}`)
  return json.data
}

// ---------------------------------------------------------------- 主流程

console.log(`数据目录 ${DATA_DIR}\n`)

// 等应用起来
for (let i = 0; i < 40; i++) {
  try { await api('/api/auth/status'); break } catch { await sleep(500) }
}

// 假「学校服务器」：让凭证校验这一步在本地闭环，绝不发往真实域名
const fakeApi = http.createServer((req, res) => {
  const p = req.url.split('?')[0]
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  if (p.endsWith('/auth/check')) return res.end(JSON.stringify({ code: 200, message: '', data: true }))
  if (p.endsWith('/users/profile')) {
    return res.end(JSON.stringify({ code: 200, message: '', data: { id: 1, name: '抓取测试', studentId: 'TEST001', schoolName: '本机假服务器' } }))
  }
  res.end(JSON.stringify({ code: 200, message: '', data: {} }))
})
await new Promise(r => fakeApi.listen(FAKE_API_PORT, '127.0.0.1', r))

// 把应用的后端地址指向假服务器（这样 login() 不会碰真域名）。
// 注意：login() 取的是**凭证文件**里的 baseUrl（不是 config.json），所以这里预置一份凭证。
await api('/api/config', { mode: 'real' })
fs.writeFileSync(
  path.join(DATA_DIR, 'credentials.json'),
  `${JSON.stringify({ baseUrl: `http://127.0.0.1:${FAKE_API_PORT}/sunshine` }, null, 2)}\n`,
)

// 假上游（非白名单域名）：用自签证书，验证「不会被中间人」
const up = await makeSelfSigned('blocked.test')
const tunnelUpstream = tls.createServer({ pfx: fs.readFileSync(up.pfx), passphrase: up.passphrase }, (socket) => {
  socket.on('data', () => socket.write('HTTP/1.1 200 OK\r\nContent-Length: 12\r\n\r\nfrom-upstream'))
})
await new Promise(r => tunnelUpstream.listen(UPSTREAM_TUNNEL_PORT, '127.0.0.1', r))

// 白名单上游（HTTPS，自签）——代理转发会因为证书不被信任而 502，但抓取在转发前就完成了
const tlsUpstream = tls.createServer({ pfx: fs.readFileSync(up.pfx), passphrase: up.passphrase }, (socket) => {
  socket.on('data', () => socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'))
})
await new Promise(r => tlsUpstream.listen(UPSTREAM_TLS_PORT, '127.0.0.1', r))

console.log('① 开始抓取')
const started = await api('/api/capture/start', {})
if (started.phase !== 'waiting') {
  console.log('   抓取没能进入等待阶段，服务端说：')
  console.log(`   ${started.error || '(没有错误信息)'}`)
  for (const l of started.log || []) console.log(`     [${l.level}] ${l.text}`)
  console.log('\n--- 服务进程日志 ---')
  console.log(serverLog.split('\n').slice(-20).join('\n'))
  child.kill()
  process.exit(1)
}
check('进入等待阶段', started.phase === 'waiting', started.phase)
check('根证书已生成', fs.existsSync(CA_PEM))

// 记下这次用的证书指纹，稍后要确认它们真的从证书库里删掉了
const certMeta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'capture', 'certs.json'), 'utf8'))

/** 问 Windows：这张证书还在不在某个存储里 */
async function certStillThere(store, thumb) {
  return new Promise((resolve) => {
    const p = spawn('certutil', ['-user', '-store', store, thumb], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { out += d })
    p.on('exit', () => resolve(out.toLowerCase().includes(String(thumb).toLowerCase())))
  })
}

check('根证书已进入「受信任的根证书颁发机构」', await certStillThere('Root', certMeta.caThumb))

// Export-Certificate 导出的是 DER（二进制），Node 的 ca: 选项要 PEM，这里转一下
const caDer = fs.readFileSync(CA_PEM)
const caPem = `-----BEGIN CERTIFICATE-----\n${caDer.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`

console.log('\n② 非白名单域名不能被中间人（趁代理还开着先测）')
const tunnel = await new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PROXY_PORT, method: 'CONNECT', path: 'blocked.test:443' })
  req.on('connect', (_res, socket) => {
    const tlsSocket = tls.connect({ socket, servername: 'blocked.test', rejectUnauthorized: false }, () => {
      resolve({ issuer: tlsSocket.getPeerCertificate()?.issuer?.CN })
      tlsSocket.end()
    })
    tlsSocket.on('error', reject)
  })
  req.on('error', reject)
  req.end()
  setTimeout(() => reject(new Error('超时')), 8000)
})
check('直通时客户端看到的是上游自己的证书（不是伪造的）', tunnel.issuer === 'blocked.test', `issuer=${tunnel.issuer}`)

console.log('\n③ 白名单域名的流量应当被解密并抓到凭证')
const captured = await new Promise((resolve, reject) => {
  const req = http.request({
    host: '127.0.0.1',
    port: PROXY_PORT,
    method: 'CONNECT',
    path: 'sports.sqcoe.com:443',
  })
  req.on('connect', (_res, socket) => {
    const tlsSocket = tls.connect({
      socket,
      servername: 'sports.sqcoe.com',
      ca: caPem, // ★ 拿我们刚生成的 CA 去校验 → 顺便验证证书链是有效的
    }, () => {
      tlsSocket.write(
        `GET /sunshine/auth/check HTTP/1.1\r\nHost: sports.sqcoe.com\r\n` +
        `sunshine-run: ${FAKE_TOKEN}\r\nsunshine-run-device-id: dev_capturetest\r\n` +
        `Connection: close\r\n\r\n`,
      )
      resolve({ authorized: tlsSocket.authorized, error: tlsSocket.authorizationError })
    })
    tlsSocket.on('error', reject)
  })
  req.on('error', reject)
  req.end()
  setTimeout(() => reject(new Error('超时')), 8000)
})

check('客户端用 CA 校验通过（证书链有效）', captured.authorized === true, String(captured.error))

// 等抓取回调与保存流程走完
let st
for (let i = 0; i < 30; i++) {
  await sleep(500)
  st = await api('/api/capture/state')
  if (st.phase === 'captured' || st.phase === 'failed') break
}

check('抓到了凭证', Boolean(st.captured), JSON.stringify(st.captured))
check('抓到的是我们发的那一个', st.captured?.tokenPrefix === `${FAKE_TOKEN.slice(0, 8)}…`, st.captured?.tokenPrefix)
check('凭证已保存并完成校验', st.phase === 'captured' && !st.error, st.error || st.phase)
check('日志里没有完整 token（只留前缀）',
  !st.log.some(l => l.text.includes(FAKE_TOKEN)),
  '日志泄露了完整凭证')

const credFile = path.join(DATA_DIR, 'credentials.json')
check('凭证落盘', fs.existsSync(credFile) && JSON.parse(fs.readFileSync(credFile, 'utf8')).token === FAKE_TOKEN)

console.log('\n④ 抓完代理要关掉（不能一直挂着）')
const closed = await new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port: PROXY_PORT, method: 'CONNECT', path: 'sports.sqcoe.com:443' })
  req.on('connect', () => { resolve(false); req.destroy() })
  req.on('error', () => resolve(true))
  req.end()
  setTimeout(() => resolve(false), 3000)
})
check('抓取结束后代理端口已关闭', closed === true)

console.log('\n④ 收尾：代理与证书都要收拾干净')
const reg = await new Promise((resolve) => {
  const p = spawn('reg', ['query', TEST_REGKEY, '/v', 'ProxyEnable'], { stdio: ['ignore', 'pipe', 'ignore'] })
  let out = ''
  p.stdout.on('data', d => { out += d })
  p.on('exit', () => resolve(out))
})
check('测试注册表里代理已还原为 0（还原逻辑生效）', /ProxyEnable\s+REG_DWORD\s+0x0/.test(reg), reg.trim().split('\n').pop())
check('临时证书文件已删除', !fs.existsSync(CA_PEM) && !fs.existsSync(path.join(DATA_DIR, 'capture', 'leaf.pfx')))
check('临时根证书已从「受信任的根证书颁发机构」删除',
  !(await certStillThere('Root', certMeta.caThumb)),
  `指纹 ${certMeta.caThumb} 还留在系统信任库里`)
check('叶子证书已从个人证书存储删除',
  !(await certStillThere('My', certMeta.leafThumb)),
  `指纹 ${certMeta.leafThumb} 还留在个人证书库里`)

// 清掉测试用的注册表键
await new Promise((resolve) => {
  const p = spawn('reg', ['delete', TEST_REGKEY, '/f'], { stdio: 'ignore' })
  p.on('exit', () => resolve())
})

child.kill()
tlsUpstream.close()
tunnelUpstream.close()
fakeApi.close()

console.log(`\n抓取：通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过'}`)
if (failures.length) {
  console.log('\n失败项：')
  for (const f of failures) console.log(`  · ${f}`)
  console.log('\n--- 服务端日志尾部 ---')
  console.log(serverLog.split('\n').slice(-25).join('\n'))
  process.exit(1)
}
