#!/usr/bin/env node
// ⚠ 本文件是 **0.1.7-rc.2 专属**实现（每个版本一份，互不影响）；顶层 scripts/build-dsh.mjs 只是转发入口。
/**
 * 按版本目录的清单把官方 dsh 改成"改造过的 dsh"，并打包成壳可用的 zip。
 *
 *   node scripts/build-dsh.mjs <版本> [--out <zip>]
 *
 * 流程（每一步都带校验，宁可报错停下也不静默覆盖）：
 *   1. 校验 work/<版本>/ 存在，且每个 manifest.replace[].path 的当前 sha256 == upstreamSha256（官方原样）
 *   2. 替换：files/<path> → work/<版本>/<path>
 *   3. 图片后端：image-backend/node_modules → node_modules/@deepseek-ai/dsh-attachment-local/node_modules
 *   4. 插件：plugins/ 下每个目录按 plugins.json（缺省按目录名推断）add / replace
 *   5. bin 别名：node_modules/.bin → node_modules/bin（壳读的是无点的那个）
 *   6. 打包：临时目录布局成 dsh-ohos-<版本>/{bin,node_modules} → zip（顶层目录名必须是 dsh-ohos-<版本>，与壳的 PkgVersion 同一规则）
 *   7. 自检：调 verify-dsh.mjs
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = process.argv.slice(2)
const version = args.find(a => !a.startsWith('--'))

// ── 统一命名（**唯一规则**）：zip 内顶层目录 / 沙箱版本目录 一律 dsh-ohos-<版本> ──
// 外层 zip 文件名由调用方 --out 决定（壳固定传 dsh-ohos.zip）；换版本只改 version。
const PKG_DIR_NAME = `dsh-ohos-${version}`;
if (!version) { console.error('用法: node scripts/build-dsh.mjs <版本> [--out <zip>]'); process.exit(1) }

// --clean：清掉打包中间产物（work/<版本>/ 官方树 与 work/.build-<版本>/ 构建副本）
// 它们只是缓存，可随时删；下次 build 需要先重新 fetch（有 lock，约 10 秒）。
if (args.includes('--clean')) {
  const targets = [join(ROOT, 'work', version), join(ROOT, 'work', `.build-${version}`)]
  let freed = 0
  for (const dir of targets) {
    if (!existsSync(dir)) continue
    const size = execFileSync('du', ['-sk', dir], { encoding: 'utf8' }).split('\t')[0]
    rmSync(dir, { recursive: true, force: true })
    freed += Number(size)
    console.log(`  · 删除 ${dir.replace(ROOT + '/', '')}`)
  }
  console.log(`  ✓ 清理完成，释放约 ${(freed / 1024).toFixed(0)} MB`)
  process.exit(0)
}
const outArg = args.indexOf('--out')
const out = outArg >= 0 ? resolve(args[outArg + 1]) : join(ROOT, 'dsh-ohos.zip')
const manifestPath = join(ROOT, version, 'manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
// work/<版本>/         = fetch 出来的**官方原样**树（只读，别动它）
// work/.build-<版本>/  = 每次 build 从上面拷一份副本，替换/加资产都在副本上做 → build 可反复跑
//   （目录名刻意不以 <版本> 开头：node 的 cpSync 按前缀判断嵌套，"<版本>-build" 会被误判成 "<版本>" 的子目录）
const workSource = join(ROOT, 'work', version)
const work = join(ROOT, 'work', `.build-${version}`)
const sha256 = p => { const h = createHash('sha256'); h.update(readFileSync(p)); return h.digest('hex') }
const fail = msg => { console.error(`  ✗ ${msg}`); process.exit(1) }
/** 整棵资产树的确定性指纹：相对路径 + 文件 sha256 排序后拼接再哈希 */
const treeSha = (dir) => {
  const rows = []
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      const r = rel === '' ? name : `${rel}/${name}`
      if (statSync(p).isDirectory()) walk(p, r)
      else rows.push(`${r}\u0000${sha256(p)}`)
    }
  }
  walk(dir, '')
  const h = createHash('sha256')
  h.update(rows.join('\n'))
  return { files: rows.length, sha256: h.digest('hex') }
}
/** 校验一份资产与 manifest 记录一致（防止资产被悄悄改掉） */
const checkAsset = (label, spec, srcDir) => {
  if (!spec) return
  if (!existsSync(srcDir)) fail(`缺资产 ${label}（${srcDir}）`)
  if (spec.sha256 == null || spec.files == null) fail(`${label} 没记 sha256/files，先跑 --refresh-sha`)
  const now = treeSha(srcDir)
  if (now.files !== spec.files || now.sha256 !== spec.sha256) {
    fail(`${label} 与 manifest 记录不一致（文件 ${now.files} vs ${spec.files}，哈希 ${now.sha256.slice(0, 12)} vs ${spec.sha256.slice(0, 12)}）`)
  }
  console.log(`  · ${label} 校验通过（${now.files} 文件）`)
}

// --refresh-sha：改过 files/ 之后刷新 manifest 里 files 的 sha256（上游基线 upstreamSha256 不动）
if (args.includes('--refresh-sha')) {
  let n = 0
  for (const item of manifest.replace) {
    const src = join(ROOT, version, 'files', item.path)
    if (!existsSync(src)) continue
    const h = sha256(src)
    if (h !== item.sha256) { item.sha256 = h; console.log(`  · 刷新 ${item.path.replace('node_modules/@deepseek-ai/', '')} → ${h.slice(0, 12)}`); n++ }
  }
  for (const [key, src] of [['imageBackend', 'image-backend/node_modules'], ['nativeAssets', 'native/node_modules'], ['binAssets', 'bin'], ['ptyAssets', 'pty-backend/prebuilds']]) {
    const spec = manifest[key]
    if (!spec) continue
    const tree = treeSha(join(ROOT, version, src))
    if (tree.sha256 !== spec.sha256 || tree.files !== spec.files) {
      spec.files = tree.files; spec.sha256 = tree.sha256; n++
      console.log(`  · 刷新资产 ${src} → ${tree.files} 文件 / ${tree.sha256.slice(0, 12)}`)
    }
  }
  if (n > 0) { writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n'); console.log(`  ✓ 已刷新 ${n} 项 sha256`) }
}

if (!existsSync(join(workSource, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))) {
  // 常见于刚跑过 --clean：自动补一次 fetch（有 lock，约 10 秒）；失败就给出清晰提示
  console.log(`== work/${version}/ 不在（可能被 --clean 清了），自动先 fetch ==`)
  try {
    execFileSync(process.execPath, [join(ROOT, version, 'scripts', 'fetch-dsh.mjs'), version], { stdio: 'inherit' })
  } catch {
    fail(`自动 fetch 失败（多半是找不到 pnpm）。先手动跑:\n      PNPM_CMD="node <pnpm.cjs>" node ${version}/scripts/fetch-dsh.mjs ${version}`)
  }
  if (!existsSync(join(workSource, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))) fail(`fetch 之后仍然没有 work/${version}/`)
}
console.log(`== 0/6 复制官方树 → work/.build-${version}/（保持官方原样可反复 build）==`)
rmSync(work, { recursive: true, force: true })
cpSync(workSource, work, { recursive: true })

// 1. 校验官方原样
console.log(`== 1/6 校验 ${manifest.replace.length} 个待替换文件的官方原文件 ==`)
for (const item of manifest.replace) {
  const p = join(work, item.path)
  if (!existsSync(p)) fail(`官方树里缺 ${item.path}`)
  const now = sha256(p)
  if (item.upstreamSha256 == null) fail(`${item.path} 的 upstreamSha256 为空，先跑 fetch-dsh.mjs`)
  if (now !== item.upstreamSha256) fail(`${item.path} 与记录的上游不一致（上游可能改过这个文件）\n      期望 ${item.upstreamSha256}\n      实际 ${now}`)
  console.log(`  · ${item.path.replace('node_modules/@deepseek-ai/', '')} 与上游一致 ✓`)
}

// 2. 替换
console.log(`== 2/6 替换改造过的文件 ==`)
for (const item of manifest.replace) {
  const src = join(ROOT, version, 'files', item.path)
  if (!existsSync(src)) fail(`files/${item.path} 不存在`)
  if (sha256(src) !== item.sha256) fail(`files/${item.path} 与 manifest 记录的 sha256 不符`)
  mkdirSync(dirname(join(work, item.path)), { recursive: true })
  cpSync(src, join(work, item.path))
  console.log(`  · → ${item.path.replace('node_modules/@deepseek-ai/', '')}`)
}

// 3. 图片后端
const ib = manifest.imageBackend
checkAsset('图片后端（jimp）', ib, join(ROOT, version, manifest.imageBackend?.source ?? 'image-backend/node_modules'))
if (ib) {
  console.log(`== 3/6 装图片后端（jimp）→ ${ib.target.replace('node_modules/@deepseek-ai/', '')} ==`)
  const src = join(ROOT, version, ib.source)
  if (!existsSync(src)) fail(`缺 ${ib.source}`)
  const dst = join(work, ib.target)
  rmSync(dst, { recursive: true, force: true })
  mkdirSync(dirname(dst), { recursive: true })
  cpSync(src, dst, { recursive: true })
  console.log(`  · 拷入 ${readdirSync(src).length} 个顶层项`)
} else console.log('== 3/6 无图片后端 ==')

// 3.5 OHOS 原生包（公共 registry 上没有，随版本目录入库）
const na = manifest.nativeAssets
checkAsset('OHOS 原生包', na, join(ROOT, version, manifest.nativeAssets?.source ?? 'native/node_modules'))
if (na) {
  console.log(`== 3.5/6 拷 OHOS 原生包 → ${na.target} ==`)
  cpSync(join(ROOT, version, na.source), join(work, na.target), { recursive: true })
  // 计数要容忍某个 scope 目录整个不存在（2026-09-30：flock 改成打桩后，
  // 自造的 @deepseek-ai/node-addon-system-openharmony-arm64 已删除，只剩 @vscode/ripgrep-openharmony-arm64）
  const countPkgs = (scope) => {
    try { return readdirSync(join(ROOT, version, na.source, scope)).length } catch (e) { return 0 }
  };
  console.log(`  · ${countPkgs('@deepseek-ai') + countPkgs('@vscode')} 个平台包`)
}

// 3.6 pty 原生模块（自己为鸿蒙编的；node-pty 自带 prebuilds 只有 darwin/linux/win32）
// 注意用 cpSync **合并**（不能 rm 目标目录 —— 那里还有其它平台的 prebuilds）
const pa = manifest.ptyAssets
checkAsset('pty 原生模块', pa, join(ROOT, version, manifest.ptyAssets?.source ?? 'pty-backend/prebuilds'))
if (pa) {
  console.log(`== 3.6/6 装 pty 原生模块 → ${pa.target} ==`)
  cpSync(join(ROOT, version, pa.source), join(work, pa.target), { recursive: true })
  console.log(`  · ${pa.files} 个文件（${Object.keys(pa).includes('note') ? '鸿蒙交叉编译' : ''}）`)
}

// 4. 插件
console.log('== 4/6 放插件 ==')
const plugDir = join(ROOT, version, 'plugins')
const listPath = join(plugDir, 'plugins.json')
const plugins = existsSync(listPath) ? JSON.parse(readFileSync(listPath, 'utf8'))
  : (existsSync(plugDir) ? readdirSync(plugDir).filter(n => statSync(join(plugDir, n)).isDirectory()).map(name => ({ name, mode: 'add' })) : [])
if (plugins.length === 0) console.log('  · 这个版本没有插件')
for (const p of plugins) {
  const src = join(plugDir, p.name)
  if (!existsSync(src)) fail(`plugins/${p.name} 不存在`)
  const target = p.target ?? `node_modules/${p.name}`
  const dst = join(work, target)
  if (p.mode === 'replace' && !existsSync(dst)) fail(`${target} 不存在，不能 replace`)
  if (p.mode !== 'replace' && existsSync(dst)) fail(`${target} 已存在，新增会覆盖（改成 mode:"replace" 或换目标）`)
  mkdirSync(dirname(dst), { recursive: true })
  cpSync(src, dst, { recursive: true })
  console.log(`  · ${p.mode ?? 'add'} ${p.name} → ${target}`)
}

// 4.5 顶层 bin/ 资产（壳要用的 bash shim，官方包不含）
const ba = manifest.binAssets
checkAsset('顶层 bin/', ba, join(ROOT, version, manifest.binAssets?.source ?? 'bin'))
if (ba) {
  console.log(`== 4.5/6 放顶层 ${ba.target}/ ==`)
  // 只拷可执行入口，说明文件（*.md）不进包
  mkdirSync(join(work, ba.target), { recursive: true })
  const entries = readdirSync(join(ROOT, version, ba.source)).filter(n => !n.endsWith('.md'))
  for (const e of entries) cpSync(join(ROOT, version, ba.source, e), join(work, ba.target, e))
  console.log(`  · ${entries.join(', ')}`)
}

// 5. bin 别名（壳读 node_modules/bin，pnpm 生成 .bin）
console.log('== 5/6 生成 bin/ 别名 ==')
const dotBin = join(work, 'node_modules/.bin')
const plainBin = join(work, 'node_modules/bin')
if (existsSync(dotBin)) {
  rmSync(plainBin, { recursive: true, force: true })
  cpSync(dotBin, plainBin, { recursive: true })
  console.log(`  · .bin → bin（${readdirSync(dotBin).length} 项）`)
} else console.log('  · 没有 .bin，跳过')

// 6. 打包
console.log(`== 6/6 打包 → ${out} ==`)
const stage = join(ROOT, 'work', `stage-${version}`)
rmSync(stage, { recursive: true, force: true })
mkdirSync(join(stage, PKG_DIR_NAME), { recursive: true })
// 与壳解包后的布局保持一致：dsh-ohos-<版本>/{bin,node_modules}
for (const entry of ['bin', 'node_modules']) {
  const p = join(work, entry)
  if (existsSync(p)) cpSync(p, join(stage, PKG_DIR_NAME, entry), { recursive: true })
}
// 包目录里的版本号文件：壳的「外挂包」读它把版本号显示出来（内置包有编译期常量，但保持一致；
// 约定见壳仓库 PkgVersion.ets 的 PKG_VERSION_FILE）
writeFileSync(join(stage, PKG_DIR_NAME, 'VERSION'), `${version}\n`);
// 命令行入口 bin/dsh：让这个包在鸿蒙的**终端里能直接跑**（不依赖 HMDSH 壳）。
// 三个环境坑都固化进脚本，免得每次手敲：
//   · --expose-internals：dsh 启动器要拿 Node 内部模块
//   · OPENSSL_armcap=0：OHOS/arm64 上 OpenSSL 的 CPU 能力探测会让进程起不来
//   · TMPDIR：鸿蒙沙箱里没有可写的 /tmp，必须先兜底出一个可写目录
const binDir = join(stage, PKG_DIR_NAME, 'bin');
mkdirSync(binDir, { recursive: true });
writeFileSync(join(binDir, 'dsh'), `#!/bin/sh
# dsh 命令行入口（由 dsh-harmony/scripts/build-dsh.mjs 生成）
# 用法：dsh web [--port 32100] / dsh --profile headless "..."
set -u
PKG_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

OPENSSL_armcap=0
export OPENSSL_armcap

if [ -z "\${TMPDIR:-}" ] || [ ! -d "\${TMPDIR:-}" ] || [ ! -w "\${TMPDIR:-}" ]; then
  TMPDIR="\${HOME:-$PKG_DIR}/.dsh-tmp"
  mkdir -p "$TMPDIR" 2>/dev/null || true
  export TMPDIR
fi

NODE=$(command -v node 2>/dev/null || true)
if [ -z "$NODE" ]; then
  for c in "$PKG_DIR/node-bin/node" /data/service/hnp/bin/node /usr/bin/node; do
    if [ -x "$c" ]; then NODE="$c"; break; fi
  done
fi
if [ -z "$NODE" ]; then
  echo "dsh: 找不到 node。装一个（例如 harmonybrew: brew install node）或把它放进 PATH 再试。" >&2
  exit 127
fi

exec "$NODE" --expose-internals "$PKG_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"
`, { mode: 0o755 });
console.log('  · bin/dsh（命令行入口）');
rmSync(out, { force: true })
execFileSync('zip', ['-r', '-q', out, PKG_DIR_NAME], { cwd: stage, stdio: 'inherit' })
rmSync(stage, { recursive: true, force: true })
console.log(`  · ${out}（${(statSync(out).size / 1048576).toFixed(1)} MiB）`)
execFileSync(process.execPath, [join(ROOT, version, 'scripts/verify-dsh.mjs'), out, version], { stdio: 'inherit' })
