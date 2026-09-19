#!/usr/bin/env node
/**
 * 白屏检查 —— 用无头浏览器真的把页面渲染一遍，确认没有客户端报错。
 *
 *   node scripts/verify-render.mjs                     检查 http://127.0.0.1:2727
 *   BASE=http://127.0.0.1:2728 node scripts/verify-render.mjs
 *
 * 为什么需要它：这个项目是纯前端 SPA（ssr: false），服务器返回的永远是一个空壳 HTML。
 * 所以「curl 首页返回 200」根本证明不了页面能打开 ——
 * 我们就是这么漏掉过一次 `useDisplay is not defined` 的白屏事故
 * （Vuetify 的 composable 不在自动导入范围内，构建不报错，只在浏览器里炸）。
 *
 * 它做的事：用 Edge/Chrome 的无头模式渲染每个页面，然后检查
 *   1. DOM 里有没有真正出现应用内容（v-application + 中文标记）
 *   2. 有没有 "xxx is not defined" / 500 这类错误痕迹
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BASE = process.env.BASE || 'http://127.0.0.1:2727'
const PAGES = ['/', '/campus', '/records', '/setup', '/diagnose']
/** 页面里必须出现的中文标记（应用真的渲染了才会有） */
const MARKERS = ['阳光跑助手', '校园跑']

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

const browser = CANDIDATES.find(p => fs.existsSync(p))
if (!browser) {
  console.error('✗ 找不到 Edge/Chrome，无法做渲染检查。')
  console.error('  （这只影响开发时的自动检查，不影响程序本身。）')
  process.exit(2)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshine-render-'))
const profile = path.join(tmp, 'profile')
let failed = 0

console.log(`浏览器  ${browser}`)
console.log(`目标    ${BASE}\n`)

for (const page of PAGES) {
  const out = path.join(tmp, `page${page.replace(/\W/g, '_')}.html`)
  const err = `${out}.err`
  // 用文件描述符接住浏览器的 stdout/stderr —— 不走管道，受限环境里也能用
  const outFd = fs.openSync(out, 'w')
  const errFd = fs.openSync(err, 'w')
  const res = spawnSync(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    '--virtual-time-budget=9000',
    '--dump-dom',
    `${BASE}${page}`,
  ], { stdio: ['ignore', outFd, errFd], timeout: 60000 })
  fs.closeSync(outFd)
  fs.closeSync(errFd)

  const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : ''
  const errText = fs.existsSync(err) ? fs.readFileSync(err, 'utf8') : ''

  const mounted = text.includes('v-application')
  const marked = MARKERS.filter(m => text.includes(m))
  const whiteScreen = /is not defined|Internal Server Error|Cannot read propert/.test(text)

  const ok = mounted && marked.length > 0 && !whiteScreen && text.length > 500
  if (!ok) failed++

  console.log(`${ok ? '✓' : '✗'} ${page.padEnd(10)} 渲染=${text.length} 字节  应用挂载=${mounted}  中文标记=${marked.join('/') || '无'}  报错=${whiteScreen}`)
  if (!ok && errText) console.log(`    ${errText.split('\n')[0]}`)
}

fs.rmSync(tmp, { recursive: true, force: true })

if (failed) {
  console.error(`\n✗ ${failed} 个页面没有正常渲染。`)
  process.exit(1)
}
console.log('\n✓ 所有页面都能正常渲染。')
