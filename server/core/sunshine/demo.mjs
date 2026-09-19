/**
 * 演练模式的本地后端管理 —— 帮用户把 scripts/mock-server.mjs 拉起来。
 *
 * 为什么要有「演练模式」：
 *   第一次用的人不该拿真账号去试。演练模式在本机起一个假的学校后端，
 *   **规则、流程、服务端计时全都和真实一致**（包括真的等满 8~20 分钟），
 *   区别只有一个：请求打到 127.0.0.1，不会在学校系统里留下任何记录。
 */

import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'

let child = null

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

/** 探测端口是否已经有服务在听 */
export function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (v) => {
      socket.destroy()
      resolve(v)
    }
    socket.setTimeout(700)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/**
 * 确保演练后端在跑。已经有人在监听就直接复用（
 * 比如用户自己开了一个终端跑 pnpm mock）。
 */
export async function ensureMockServer(port = 8898) {
  if (await isPortOpen(port)) return { started: false, reused: true, port }

  const script = path.join(process.cwd(), 'scripts', 'mock-server.mjs')
  child = spawn(process.execPath, [script, '--port', String(port)], {
    cwd: process.cwd(),
    stdio: 'ignore',
    windowsHide: true,
    detached: false,
  })
  child.on('error', () => { child = null })
  child.unref?.()

  for (let i = 0; i < 40; i++) {
    await sleep(150)
    if (await isPortOpen(port)) return { started: true, reused: false, port }
  }
  throw new Error('演练后端没能在 6 秒内启动。可以手动在项目目录执行：pnpm mock')
}

/** 关掉本进程拉起的演练后端（如果用户是自己起的，就不动它） */
export function stopMockServer() {
  if (!child) return { stopped: false }
  try {
    child.kill()
  } catch { /* 已经退出了 */ }
  child = null
  return { stopped: true }
}
