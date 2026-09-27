#!/usr/bin/env node
// ⚠ 本文件是 **0.1.7-rc.2 专属**实现（每个版本一份，互不影响）；顶层 scripts/fetch-dsh.mjs 只是转发入口。
/**
 * 拉取并安装指定版本的官方 dsh（不拉源码，只装 npm 包）。
 *
 *   node scripts/fetch-dsh.mjs <版本>            # 例：0.1.7-rc.2
 *   PNPM_CMD="node /path/to/pnpm.cjs" node scripts/fetch-dsh.mjs <版本>
 *
 * 做三件事：
 *   1. 用 pnpm 装 @deepseek-ai/dsh@<版本>（--ignore-scripts --node-linker=hoisted）
 *      · --ignore-scripts：沙箱里没有 node-gyp，node-pty/koffi 这类原生模块的 install 脚本必失败
 *      · --node-linker=hoisted：扁平布局，与壳解包后的用法一致（壳直接用 node_modules/@deepseek-ai/...）
 *   2. 装 manifest.install.extraPackages：OHOS(openharmony-arm64) 专用包（官方装时会按平台跳过）
 *   3. 把 manifest.replace[] 里每个文件的**官方原文件 sha256** 写回 manifest（供 build 校验）
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const version = process.argv[2] ?? '0.1.7-rc.2'
const verDir = join(ROOT, version)
const manifestPath = join(verDir, 'manifest.json')
if (!existsSync(manifestPath)) { console.error(`找不到 ${version}/manifest.json`); process.exit(1) }
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const work = join(ROOT, 'work', version)

function run(cmd, args, opts = {}) {
  console.log(`  $ ${cmd} ${args.join(' ')}`)
  return execFileSync(cmd, args, { stdio: 'inherit', cwd: work, ...opts })
}
/** 调 pnpm：默认 pnpm 在 PATH 里；也可用 PNPM_CMD="node /path/pnpm.cjs" 指定 */
function pnpm(args) {
  const custom = process.env.PNPM_CMD
  if (custom) { const [c, ...rest] = custom.split(' '); return run(c, [...rest, ...args]) }
  return run('pnpm', args)
}
const sha256 = p => { const h = createHash('sha256'); h.update(readFileSync(p)); return h.digest('hex') }

console.log(`== 拉取官方 dsh@${manifest.dsh.version} → work/${version}/ ==`)
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
// 版本目录里存了 pnpm-lock.yaml 就精确复现（首次跑会生成并保存）
const lockSrc = join(verDir, 'pnpm-lock.yaml')
const lockWork = join(work, 'pnpm-lock.yaml')
if (existsSync(lockSrc)) { copyFileSync(lockSrc, lockWork); console.log('  · 用版本目录里的 pnpm-lock.yaml 精确复现依赖') }
writeFileSync(join(work, 'package.json'), JSON.stringify({
  name: `dsh-fetch-${version}`, private: true, version: '0.0.0',
  dependencies: { [manifest.dsh.package]: manifest.dsh.version },
}, null, 2) + '\n')

const baseArgs = ['--ignore-scripts', '--node-linker=hoisted', ...(manifest.install.pnpmArgs ?? []).filter(a => !['--ignore-scripts', '--node-linker=hoisted'].includes(a))]
pnpm(existsSync(lockWork) ? ['install', ...baseArgs, '--frozen-lockfile'] : ['install', ...baseArgs])
if (!existsSync(lockSrc) && existsSync(lockWork)) {
  copyFileSync(lockWork, lockSrc)
  console.log('  · 已把 pnpm-lock.yaml 存进版本目录（以后每次都能精确复现）')
}

// OHOS 平台专用包不在公共 registry 上（见 native/README.md），由 build-dsh.mjs 从 native/ 资产拷入

console.log('== 记录官方原文件 sha256 到 manifest ==')
let filled = 0
for (const item of manifest.replace ?? []) {
  const p = join(work, item.path)
  if (!existsSync(p)) { console.error(`  ! 官方树里找不到 ${item.path}（上游可能改了结构）`); continue }
  item.upstreamSha256 = sha256(p)
  filled++
  console.log(`  · ${item.path.replace('node_modules/@deepseek-ai/', '')}  ${item.upstreamSha256.slice(0, 12)}`)
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
const pkg = join(work, 'node_modules/@deepseek-ai/dsh/package.json')
const ok = existsSync(pkg)
console.log(`== 完成：${ok ? `已装 ${JSON.parse(readFileSync(pkg, 'utf8')).name}@${JSON.parse(readFileSync(pkg, 'utf8')).version}` : '⚠ 顶层包缺失'}，写回 ${filled} 个 upstreamSha256 ==`)
if (!ok) process.exit(1)
