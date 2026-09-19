#!/usr/bin/env node
/**
 * 启动器 —— 双击「启动阳光跑.bat」实际跑的就是它。
 *
 *   node scripts/launch.mjs          跑已构建好的版本（.output）
 *   node scripts/launch.mjs --dev    跑开发服务器（需要先 pnpm install）
 *
 * 它比「直接 node .output/server/index.mjs」多做了三件事，每一件都是给普通人踩过的坑：
 *
 *   1. **自动挑一个能用的端口**。
 *      首选 2727，但如果这个端口被占用、或者被上一次没退干净的连接占着
 *      （Windows 上会直接报 EACCES，光看 netstat 的 LISTENING 是查不出来的），
 *      就依次试 2728、2729…，所以永远不会出现"莫名其妙打不开"。
 *
 *   2. **等服务器真的起来了再开浏览器**。
 *      固定 sleep 几秒在慢机器上会开出 404 页面。
 *
 *   3. **把最终地址打在窗口最显眼的地方**，因为端口可能不是 2727。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEV = process.argv.includes('--dev')

/**
 * Node 版本闸门。
 * Nuxt 3.9 要求 Node 18+；版本太低时报的错会非常难懂，
 * 所以在这里先拦一下，直接告诉用户去升级。
 */
const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor < 18) {
  console.error('')
  console.error(`  [X] Node.js 版本太低：当前 v${process.versions.node}，需要 v18 或更高。`)
  console.error('      请到 https://nodejs.org/zh-cn 下载 LTS 版本覆盖安装，然后重新双击启动。')
  console.error('')
  process.exit(1)
}

/** 首选端口 + 备用端口（都刻意避开了 Windows 常见的动态保留端口段） */
const CANDIDATES = [2727, 2728, 2729, 2730, 2731, 2732, 2740, 2750]

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * 上次成功用过的端口。
 *
 * 为什么记它：2727 正常情况下永远是空的，但万一被占（别的程序、
 * 或者系统把这一带划进了动态保留段），启动器会退到 2728 —— 
 * 这时如果不记住，每次启动的地址都可能不一样，用户就得每次重新找地址。
 */
function dataFile() {
  return path.join(ROOT, '.data', 'config.json')
}

function readRememberedPort() {
  try {
    const cfg = JSON.parse(fs.readFileSync(dataFile(), 'utf8'))
    const p = Number(cfg.preferredPort)
    return Number.isInteger(p) && p > 1024 && p < 65535 ? p : null
  } catch {
    return null
  }
}

function rememberPort(port) {
  try {
    const file = dataFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    let cfg = {}
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* 第一次运行 */ }
    cfg.preferredPort = port
    fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`)
  } catch { /* 记不住也不影响使用，顶多下次换个端口 */ }
}

/** 能不能在这个端口上监听？不能就说明它被占了（或处于半关闭状态） */
function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

/** 服务器是不是真的能应答了 */
async function isServing(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1200) })
    return res.status > 0
  } catch {
    return false
  }
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true, detached: true }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref()
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref()
    }
  } catch { /* 打不开浏览器不影响服务本身，地址已经打在窗口里了 */ }
}

// ---------------------------------------------------------------- 1. 挑端口

const remembered = readRememberedPort()
// 上次用过的端口优先；2727 永远是第一顺位，所以正常情况下地址不会变
const order = remembered && !CANDIDATES.includes(remembered)
  ? [remembered, ...CANDIDATES]
  : CANDIDATES

let port = null
for (const candidate of order) {
  if (await canListen(candidate)) {
    port = candidate
    break
  }
  console.log(`   端口 ${candidate} 被占用，换一个…`)
}
if (!port) {
  console.error('\n✗ 2727~2750 之间的端口都被占用了。请关掉占用它们的程序后重试。')
  process.exit(1)
}
if (port !== remembered) rememberPort(port)

const url = `http://127.0.0.1:${port}`

// ---------------------------------------------------------------- 2. 起服务

const entry = path.join(ROOT, '.output', 'server', 'index.mjs')
if (!DEV && !fs.existsSync(entry)) {
  console.error('\n✗ 没有找到构建产物 .output/server/index.mjs')
  console.error('  请先执行一次：pnpm install && pnpm build（发布包里已经带好了，不会遇到这个）')
  process.exit(1)
}

const child = DEV
  ? spawn('npx', ['nuxi', 'dev', '--port', String(port)], { cwd: ROOT, stdio: 'inherit', shell: true })
  : spawn(process.execPath, [entry], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, PORT: String(port), NITRO_PORT: String(port), HOST: '127.0.0.1' },
    })

child.on('exit', (code) => process.exit(code ?? 0))

// ---------------------------------------------------------------- 3. 等就绪并开浏览器

let opened = false
for (let i = 0; i < 60; i++) {
  await sleep(500)
  if (await isServing(port)) {
    opened = true
    break
  }
  if (child.exitCode !== null) break
}

console.log('')
console.log('════════════════════════════════════════════════════════')
if (opened) {
  console.log(`  阳光跑助手已启动：${url}`)
  console.log('')
  console.log('  · 跑步过程中可以关掉浏览器，计时会继续；')
  console.log('  · 用完直接关闭这个黑色窗口，程序就停了。')
  openBrowser(url)
} else {
  console.log(`  服务好像没能起来。可以手动打开看看：${url}`)
  console.log('  如果打不开，把上面窗口里的报错截图反馈。')
}
console.log('════════════════════════════════════════════════════════')
console.log('')

// 保持前台运行：Ctrl+C 时把子进程一并带走
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { child.kill() } catch { /* 已经退出了 */ }
    process.exit(0)
  })
}
