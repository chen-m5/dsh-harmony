#!/usr/bin/env node
/**
 * 产物自检：node scripts/verify-dsh.mjs <zip> [版本]
 *
 * 检查：zip 顶层目录必须是 dsh-<版本>；含 bin/ 与 node_modules/@deepseek-ai/dsh/lib/bin.js；
 *       manifest 里每个替换文件的 sha256 与 zip 内一致；图片后端存在；报出文件数/体积。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const zip = resolve(process.argv[2] ?? '')
const version = process.argv[3] ?? '0.1.7-rc.2'
if (!existsSync(zip)) { console.error(`找不到 ${zip}`); process.exit(1) }
const manifest = JSON.parse(readFileSync(join(ROOT, version, 'manifest.json'), 'utf8'))

const list = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter(Boolean)
const files = list.filter(n => !n.endsWith('/'))
const tops = new Set(files.map(n => n.split('/')[0]))
const problems = []
if (tops.size !== 1 || !tops.has(`dsh-${version}`)) problems.push(`zip 顶层目录应为 dsh-${version}，实际 ${[...tops].join(', ')}`)
for (const need of ['bin', 'node_modules/@deepseek-ai/dsh/lib/bin.js']) {
  if (!files.some(n => n.startsWith(`dsh-${version}/${need}`))) problems.push(`缺 dsh-${version}/${need}`)
}
const sha = (member) => { const h = createHash('sha256'); h.update(execFileSync('unzip', ['-p', zip, member], { maxBuffer: 64 << 20 })); return h.digest('hex') }
console.log(`== 校验 ${zip} ==`)
console.log(`  文件条目 ${files.length}   体积 ${(statSync(zip).size / 1048576).toFixed(1)} MiB   顶层 ${[...tops].join(', ')}`)
for (const item of manifest.replace) {
  const member = `dsh-${version}/${item.path}`
  const got = sha(member)
  const ok = got === item.sha256
  console.log(`  ${ok ? '✓' : '✗'} ${item.path.replace('node_modules/@deepseek-ai/', '')}`)
  if (!ok) problems.push(`${member} sha256 不符（期望 ${item.sha256.slice(0, 12)}，实际 ${got.slice(0, 12)}）`)
}
const ibCount = files.filter(n => n.includes('@deepseek-ai/dsh-attachment-local/node_modules/')).length
console.log(`  图片后端文件 ${ibCount}（manifest 记录 ${manifest.imageBackend?.files ?? '-'}）`)
if (manifest.imageBackend && ibCount === 0) problems.push('图片后端没有进包')
if (problems.length > 0) { console.error('  ✗ 自检未通过：'); for (const p of problems) console.error(`      - ${p}`); process.exit(1) }
console.log('  ✓ 自检通过')
