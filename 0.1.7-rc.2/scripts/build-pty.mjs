// 交叉编译 node-pty 的 HarmonyOS(openharmony-arm64) 原生模块（pty.node）。
//
// 背景：node-pty 自带的 prebuilds 只有 darwin/linux/win32 —— 没有 openharmony，
// 所以 dsh 的「常驻 shell 会话」与侧栏终端在鸿蒙上都起不来
// （报 Failed to load native module: pty.node, checked: …/prebuilds/openharmony-arm64）。
// 官方没有发布鸿蒙版（@deepseek-ai/node-pty-openharmony-arm64 之类都不存在），只能自己编。
//
// 难度不高：非 Windows 平台**只有一个源文件** `src/unix/pty.cc`，依赖 node-addon-api（纯头文件）
// 与 `-lutil`。真正的前提只有两样：
//   ① OHOS NDK（含 aarch64 的 clang）—— 在 DevEco Studio 里装（见下方提示）
//   ② node 头文件（按目标 node 版本下，脚本会自动下并缓存）
//
// 用法：
//   node <版本>/scripts/build-pty.mjs                 # 用环境里的 NDK 编，产物拷进 files/
//   OHOS_NDK=/path/to/ndk node …/build-pty.mjs        # 显式指定 NDK
//   node …/build-pty.mjs --check                      # 只报告前提是否就绪（不编）
//
// 目标：产物落到 `<版本>/files/node_modules/node-pty/prebuilds/openharmony-arm64/pty.node`，
// 由 build-dsh.mjs 随包分发；manifest 的 replace 里记它的 sha256。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');       // <版本>/
const REPO = resolve(ROOT, '..');                                          // 仓库根
const VERSION = ROOT.split('/').pop();
const CACHE = join(REPO, 'work', 'pty-build');

/** 目标 node（跑 dsh 的那个）。默认取常见位置，也可用 DSH_NODE 指定 */
const NODE_BIN = process.env.DSH_NODE
  || ['/data/storage/el2/base/haps/entry/files/node-bin/node'].find(existsSync)
  || 'node';

/** node-pty 源码：优先取已 fetch 的官方树，其次取现役包里的（带 src/ 的完整包） */
const PTY_CANDIDATES = [
  join(REPO, 'work', VERSION, 'node_modules', 'node-pty'),
  '/data/storage/el2/base/haps/entry/files/pkg/dsh-ohos-' + VERSION + '/node_modules/node-pty'
];

/** NDK 里 aarch64 的 clang（OHOS SDK 的 native/llvm/bin） */
const NDK_CANDIDATES = [
  process.env.OHOS_NDK,
  process.env.OHOS_SDK ? join(process.env.OHOS_SDK, 'native', 'llvm', 'bin') : undefined,
  '/storage/Users/currentUser/OpenHarmony/Sdk/latest/native/llvm/bin',
  '/storage/Users/currentUser/Documents/OpenDesk/sdk/default/openharmony/native/llvm/bin',
  '/storage/Users/currentUser/Library/OpenHarmony/Sdk/latest/native/llvm/bin'
].filter(Boolean);

const log = (...a) => console.log(...a);
const ok = (b) => (b ? '✓' : '✗');

function findClang() {
  for (const dir of NDK_CANDIDATES) {
    for (const name of ['aarch64-linux-ohos-clang++', 'clang++']) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}
function findPty() {
  for (const p of PTY_CANDIDATES) {
    if (existsSync(join(p, 'src', 'unix', 'pty.cc'))) return p;
  }
  return undefined;
}

const check = process.argv.includes('--check');
const clang = findClang();
const pty = findPty();

log('== 前提检查 ==');
log(`  node          ${NODE_BIN}`);
try {
  log(`  目标 node      ${execFileSync(NODE_BIN, ['-e', 'process.stdout.write(process.versions.node+" (ABI "+process.versions.modules+", "+process.platform+"/"+process.arch+")")'], { encoding: 'utf8' })}`);
} catch { log('  目标 node      取不到版本（可设 DSH_NODE 指定）'); }
log(`  ${ok(pty)} node-pty 源码  ${pty ?? '未找到（先 node scripts/fetch-dsh.mjs ' + VERSION + '）'}`);
log(`  ${ok(clang)} OHOS clang    ${clang ?? '未找到 —— 需要在 DevEco Studio 里装 NDK'}`);
if (!clang) {
  log('');
  log('  安装 NDK：DevEco Studio → File → Settings → SDK → 勾选 "Native"（或 OpenHarmony SDK 的');
  log('  native/llvm）→ Apply。装好后把路径给我（或设 OHOS_NDK=<ndk>/native/llvm/bin）。');
  log('  已试过的候选路径：');
  for (const d of NDK_CANDIDATES) log('    · ' + d);
}
if (check || !clang || !pty) process.exit(clang && pty ? 0 : 1);

// ── node 头文件（按目标 node 版本下，缓存到 work/pty-build）────────────────
const nodeVer = execFileSync(NODE_BIN, ['-e', 'process.stdout.write(process.versions.node)'], { encoding: 'utf8' }).trim();
const inc = join(CACHE, `node-v${nodeVer}`, 'include', 'node');
if (!existsSync(join(inc, 'node_api.h'))) {
  mkdirSync(CACHE, { recursive: true });
  const tgz = join(CACHE, `node-v${nodeVer}-headers.tar.gz`);
  log(`== 下载 node 头文件 v${nodeVer} ==`);
  execFileSync('curl', ['-sSL', '-o', tgz, `https://nodejs.org/dist/v${nodeVer}/node-v${nodeVer}-headers.tar.gz`], { stdio: 'inherit' });
  execFileSync('tar', ['xzf', tgz, '-C', CACHE], { stdio: 'inherit' });
  log(`  ✓ ${inc}`);
} else {
  log(`== node 头文件已缓存 ${inc} ==`);
}
const napiDir = join(pty, '..', 'node-addon-api');

// ── 编译 ───────────────────────────────────────────────────────────────────
const outDir = join(ROOT, 'files', 'node_modules', 'node-pty', 'prebuilds', 'openharmony-arm64');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'pty.node');
log('== 编译 pty.node ==');
const args = [
  '-shared', '-fPIC', '-O2', '-std=c++17',
  '-Wall',
  '--target=aarch64-linux-ohos',
  '-DNAPI_VERSION=10',
  '-I' + inc,
  '-I' + join(napiDir),
  '-o', outFile,
  join(pty, 'src', 'unix', 'pty.cc'),
  '-lutil'
];
log('  ' + clang + ' ' + args.join(' '));
execFileSync(clang, args, { stdio: 'inherit' });
log(`  ✓ 产出 ${outFile}`);

// 拷进现役包（方便立刻验证，不必重打包）
const live = '/data/storage/el2/base/haps/entry/files/pkg/dsh-ohos-' + VERSION
  + '/node_modules/node-pty/prebuilds/openharmony-arm64';
try {
  mkdirSync(live, { recursive: true });
  copyFileSync(outFile, join(live, 'pty.node'));
  log(`  · 已同步到现役包（重启 dsh 后生效）：${live}`);
} catch (e) {
  log(`  · 现役包同步失败（可忽略）：${e.message}`);
}

log('');
log('下一步：');
log('  1) 更新 manifest.json 里该文件的 sha256（或跑一次 build-dsh.mjs 让它报出来）');
log('  2) node scripts/build-dsh.mjs ' + VERSION + ' --out <壳>/entry/src/main/resources/rawfile/pkg/dsh-ohos-' + VERSION + '.zip');
log('  3) 重装 hap 后试 dsh 侧栏终端 / 常驻 shell');
