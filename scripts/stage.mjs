#!/usr/bin/env node
/**
 * 把一个版本的 dsh **备到壳约定的位置**（默认 `/storage/Users/currentUser/Documents/dsh`）：
 *
 *   1. 打一份 **带版本号的 zip**（`dsh-ohos-<版本>.zip`）—— **用来上传 Release**
 *   2. 顺手解压出 **同版本目录**（`dsh-ohos-<版本>/`）—— **用来在壳里「外挂」试跑**
 *      · 目录已存在 → **先删掉再解压**（避免新旧文件混在一起）
 *   3. 补执行位：外挂目录壳**不会** chmod（那不是它的目录），
 *      必须自己把 rg shim（要能直接 spawn）与 `node_modules/.bin` 补上，否则 grep/glob 报
 *      `ripgrep launch failed`
 *   4. 自检壳那边 `PkgMgr.verifyExternal()` 会查的几项，避免"填进去才发现不可用"
 *
 * 用法：
 *   node scripts/stage.mjs <版本> [--out-dir <目录>] [--no-build]
 *
 * 为什么固化这一步：**dsh 一有改动先外挂试跑、内置包当安全网**
 * （内置包换错 = 装完壳起不来，而 dsh 起不来时没法自救）。详见壳仓库
 * `skills/dsh-upgrade/SKILL.md` 的「出包与试跑」。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const version = args.find((a) => !a.startsWith('--'))
if (!version) {
  console.error('用法: node scripts/stage.mjs <版本> [--out-dir <目录>] [--no-build]')
  process.exit(1)
}
const outIdx = args.indexOf('--out-dir')
const OUT = resolve(outIdx >= 0 ? args[outIdx + 1] : '/storage/Users/currentUser/Documents/dsh')
const noBuild = args.includes('--no-build')
const base = `dsh-ohos-${version}`
const zip = join(OUT, `${base}.zip`)
const dir = join(OUT, base)

mkdirSync(OUT, { recursive: true })

// 1. 打包（默认重新打，保证 zip 就是当前版本目录的内容）
if (!noBuild) {
  console.log(`== 打包 ${version} ==`)
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-dsh.mjs'), version, '--out', zip], { stdio: 'inherit' })
} else if (!existsSync(zip)) {
  console.error(`✗ --no-build 但 ${zip} 不存在`)
  process.exit(1)
}
console.log(`\n  · zip（**上传用**）：${zip}  ${(statSync(zip).size / 1048576).toFixed(1)} MiB`)

// 2. 解压出外挂目录：同名目录先删再解（不让新旧混着）
if (existsSync(dir)) {
  console.log(`  · 同名目录已存在，先删除：${dir}`)
  rmSync(dir, { recursive: true, force: true })
}
console.log(`== 解压出外挂目录 ${base}/ ==`)
execFileSync('unzip', ['-q', zip, '-d', OUT], { stdio: 'inherit' })
if (!existsSync(dir)) {
  const tops = readdirSync(OUT)
    .filter((n) => n.startsWith('dsh-ohos-') && statSync(join(OUT, n)).isDirectory())
    .join(', ')
  console.error(`✗ 解压后没找到 ${dir}（当前包目录：${tops}）—— zip 顶层目录名应为 ${base}`)
  process.exit(1)
}

// 3. 补执行位（壳对外挂目录只读校验、不 chmod）
const soft = (cmd, a) => {
  try {
    execFileSync(cmd, a, { stdio: 'ignore' })
  } catch (e) {
    console.log(`  ! ${cmd} ${a.join(' ')} 失败（可忽略，但 grep/glob 可能会报 ripgrep launch failed）`)
  }
}
soft('chmod', ['755', join(dir, 'node_modules/@vscode/ripgrep-openharmony-arm64/bin/rg')])
soft('chmod', ['-R', 'a+x', join(dir, 'node_modules/.bin')])
soft('chmod', ['755', join(dir, 'bin/bash')])

// 4. 自检：壳 verifyExternal() 会查的几项
console.log('== 自检（壳预检会查这些）==')
let bad = 0
const checks = [
  ['dsh 入口 bin.js', join(dir, 'node_modules/@deepseek-ai/dsh/lib/bin.js')],
  ['require-builtin JS 垫片', join(dir, 'node_modules/node-addon-require-builtin/lib/index.js')],
  ['rg shim（可直接 spawn）', join(dir, 'node_modules/@vscode/ripgrep-openharmony-arm64/bin/rg')],
  ['版本号文件 VERSION', join(dir, 'VERSION')],
]
for (const [label, p] of checks) {
  const ok = existsSync(p)
  console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  if (!ok) bad++
}
if (bad > 0) {
  console.error('\n✗ 自检没过：这个目录拿去外挂会被壳拒绝')
  process.exit(1)
}

console.log(`
完成 —— 两份都在 ${OUT}：
  · 上传用（带版本号的 zip）：${zip}
  · 外挂用（解压目录）：      ${dir}

壳里「设置 → 提示 → 外挂」填上面那个**目录**（版本号可留空，壳会读目录里的 VERSION）；
试完没问题再换内置包（改 PkgVersion.ets 的 DSH_VERSION → sh scripts/build-hap.sh）。`)
