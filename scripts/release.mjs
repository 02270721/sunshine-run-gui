#!/usr/bin/env node
/**
 * 打包发布 —— 生成一个「解压双击就能用」的压缩包。
 *
 *   node scripts/release.mjs
 *
 * 做三件事：
 *   1. 构建生产版本（nuxt build → .output）
 *   2. 把 .output、启动脚本、演练后端、说明文档复制到 release/ 下的一个目录
 *   3. 压缩成 zip
 *
 * 为什么值得这么干：拿到压缩包的人**不需要装 pnpm、不需要联网装依赖、不需要看懂任何代码**，
 * 只要有 Node.js，双击「启动阳光跑.bat」就能用。
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const OUT_DIR = path.join(ROOT, 'release', `sunshine-run-gui-${pkg.version}`)
const ZIP = `${OUT_DIR}.zip`

/**
 * 用 stdio: 'inherit' 起子进程 —— 输出直接进当前终端。
 * （默认的 'pipe' 在受限沙箱里会 EPERM，而且这里本来也不需要捕获输出。）
 * Windows 上要经 shell 才能找到 npx.cmd / powershell，因此整条命令拼成一个字符串，
 * 不把参数数组交给 shell（那会触发 Node 的 DEP0190 警告）。
 */
function run(command, cwd = ROOT) {
  console.log(`\n$ ${command}`)
  const res = spawnSync(command, { cwd, stdio: 'inherit', shell: true })
  if (res.status !== 0) {
    console.error(`\n✗ 命令失败（退出码 ${res.status ?? res.error?.message}）`)
    process.exit(1)
  }
}

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.cpSync(from, to, { recursive: true })
}

// ---------------------------------------------------------------- 1. 构建

console.log('① 构建生产版本…')
run('npx nuxi build')

if (!fs.existsSync(path.join(ROOT, '.output', 'server', 'index.mjs'))) {
  console.error('✗ 构建产物缺失：.output/server/index.mjs')
  process.exit(1)
}

// ---------------------------------------------------------------- 2. 组装

console.log('\n② 组装发布目录…')
fs.rmSync(OUT_DIR, { recursive: true, force: true })
fs.rmSync(ZIP, { force: true })
fs.mkdirSync(OUT_DIR, { recursive: true })

copy(path.join(ROOT, '.output'), path.join(OUT_DIR, '.output'))
copy(path.join(ROOT, '启动阳光跑.bat'), path.join(OUT_DIR, '启动阳光跑.bat'))
copy(path.join(ROOT, 'Node.js-not-found.txt'), path.join(OUT_DIR, 'Node.js-not-found.txt'))
copy(path.join(ROOT, 'README.md'), path.join(OUT_DIR, 'README.md'))
copy(path.join(ROOT, 'scripts', 'launch.mjs'), path.join(OUT_DIR, 'scripts', 'launch.mjs'))
copy(path.join(ROOT, 'scripts', 'mock-server.mjs'), path.join(OUT_DIR, 'scripts', 'mock-server.mjs'))
copy(path.join(ROOT, 'scripts', 'selftest.mjs'), path.join(OUT_DIR, 'scripts', 'selftest.mjs'))
copy(path.join(ROOT, 'package.json'), path.join(OUT_DIR, 'package.json'))
// 协议说明随包带走，方便使用者核对「程序到底做了什么」
copy(path.join(ROOT, 'server', 'core', 'sunshine'), path.join(OUT_DIR, 'server', 'core', 'sunshine'))

// 发布包里不应该有本机数据（凭证、日志）
for (const junk of ['.data', 'node_modules', '.nuxt']) {
  fs.rmSync(path.join(OUT_DIR, junk), { recursive: true, force: true })
}

const size = (dir) => {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    total += entry.isDirectory() ? size(p) : fs.statSync(p).size
  }
  return total
}
console.log(`   目录 ${path.relative(ROOT, OUT_DIR)}  ${(size(OUT_DIR) / 1024 / 1024).toFixed(1)} MB`)

// ---------------------------------------------------------------- 3. 压缩

console.log('\n③ 压缩…')
if (process.platform === 'win32') {
  run(`powershell -NoProfile -Command "Compress-Archive -Path '${OUT_DIR}\\*' -DestinationPath '${ZIP}' -Force"`)
} else {
  run(`zip -qr "${ZIP}" "${path.basename(OUT_DIR)}"`, path.join(ROOT, 'release'))
}

console.log(`\n✓ 完成：${ZIP}`)
console.log('  把这个 zip 发给别人，解压后双击「启动阳光跑.bat」即可（只需装有 Node.js 18+）。')
