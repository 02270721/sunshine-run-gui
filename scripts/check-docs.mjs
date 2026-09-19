/**
 * 文档一致性检查：README 里提到的命令与文件是否真实存在。
 * 只读，不改任何东西。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const md = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

let bad = 0
console.log('=== README 里提到的 pnpm 命令 ===')
for (const name of Object.keys(pkg.scripts)) {
  const mentioned = md.includes(`pnpm ${name}`)
  if (mentioned) console.log(`  ✓ pnpm ${name}`)
}
const mentionedScripts = [...md.matchAll(/pnpm ([a-z:]+)/g)].map(m => m[1])
for (const s of new Set(mentionedScripts)) {
  if (s === 'install') continue
  if (!pkg.scripts[s]) { console.log(`  ✗ README 提到 pnpm ${s}，但 package.json 里没有`); bad++ }
}

console.log('\n=== README 里提到的文件 ===')
const files = [...md.matchAll(/`([\w./-]+\.(?:mjs|ts|vue|bat|txt|json|md))`/g)].map(m => m[1])
for (const f of new Set(files)) {
  if (f.includes('sunshine-run-client') || f === 'PROTOCOL.md') continue
  const candidates = [
    path.join(ROOT, f),
    path.join(ROOT, 'server/core/sunshine', f),  // 核心层内部互相引用时只写文件名
    path.join(ROOT, 'scripts', f),
    path.join(ROOT, 'pages', f),
    path.join(ROOT, 'components', f),
  ]
  if (!candidates.some(p => fs.existsSync(p))) { console.log(`  ✗ 不存在: ${f}`); bad++ }
}

console.log(`\n${bad ? `✗ ${bad} 处不一致` : '✓ 文档与代码一致'}`)
process.exit(bad ? 1 : 0)
