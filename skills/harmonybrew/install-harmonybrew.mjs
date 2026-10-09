#!/usr/bin/env node
/**
 * 在壳的沙箱里安装 harmonybrew（brew）—— 上游 install.sh 的 node 版。
 *
 * 为什么要重写而不是直接跑上游脚本：
 *   1. 上游把 prefix 写死成 `/storage/Users/currentUser/.harmonybrew` —— 应用沙箱无权写那里；
 *   2. 上游是 1100 行 zsh，用了一堆沙箱里没有的东西（`/bin/install`、`strings /lib/ld-musl-*`、
 *      探测 shell rcfile 等），在沙箱里要改的地方比留下的还多；
 *   3. 我们本来就内置了 node：下载用 fetch、解压用系统 tar、建链接用 ln —— 依赖面小得多。
 *
 * 但有一件事绕不开：**brew 本体是 zsh 脚本**（`#!/usr/bin/zsh`），所以设备上必须有可执行的 zsh。
 * 本脚本会先检查，没有就直接报错退出（别装了才发现跑不起来）。
 *
 * 用法：
 *   node install-harmonybrew.mjs                    # 装到 $HOME/.harmonybrew
 *   node install-harmonybrew.mjs --prefix <目录>     # 换 prefix（越短越稳，见下）
 *   node install-harmonybrew.mjs --force            # 已装也重装
 *
 * 关于 prefix 长度：harmonybrew 的 bottle 是**原地等长改写** prefix 的（官方 relocatable-bottles
 * 只保证 **< 65 字符**），所以别把 prefix 弄得太长。默认 `$HOME/.harmonybrew`。
 *
 * 首次安装要从 ${server}/brew/brew.tar.gz 下约 122 MB 的本体，装完还会跑一次 `brew update`。
 *
 * ── 2026-10-09 沙箱适配（鸿蒙玩具箱 + brew 的 PATH 过滤所致，细节见 skill 第七节）──────
 *   A. toybox tar 解 **symlink** 时给链接设 mtime 会 EPERM：`tar: settime …: Permission denied`
 *      → `tar: had errors` → 退出码 1。**文件其实全解出来了**，所以本脚本对这类噪音宽容
 *      （只在"错的不是 settime"时才判失败）。
 *   B. brew 自己的 pour 吃同一个退出码 ⇒ 先往 `files/bin/tar` 落一个包装（PATH 最前）：
 *      参数原样透传，只在"错的全部是 settime/had errors"时把退出码改成 0；
 *      **不落盘**（brew 子进程里 TMPDIR 会丢，而 /tmp 只读），用 fd 3 + 命令替换在内存里过滤。
 *   C. brew 会把子进程 PATH 重写成 `/usr/bin:/bin:/usr/sbin:/sbin` ⇒ 往 `files/bin/brew` 落一个
 *      入口包装，里面 `HOMEBREW_EXTRA_PATH=$HOME/bin`，否则 brew 看不见 B 那个 shim。
 *   D. brew 建 `vendor/<件>/current` 软链可能 EPERM（手动建同样的链却成功）⇒ 收尾时自动补链。
 *   A–D 全部幂等：**重装 hap / 换壳之后，再跑一次本脚本就能恢复整个适配层。**
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const FORCE = args.includes('--force');
const HOME = process.env.HOME ?? os.homedir();
const PREFIX = path.resolve(opt('--prefix', process.env.HB_PREFIX ?? path.join(HOME, '.harmonybrew')));
const SERVER = opt('--server', process.env.HOMEBREW_BOTTLE_DOMAIN ?? 'https://harmonybrew.atomgit.com').replace(/\/+$/, '');
const REPO = path.join(PREFIX, 'Homebrew');
const BREW = path.join(PREFIX, 'bin/brew');
const TARBALL = path.join(PREFIX, 'brew.tar.gz');
const TAR = '/usr/bin/tar'; // 沙箱里可用的就是它（toybox 的 tar）
const BIN_DIR = path.join(HOME, 'bin'); // 壳排在 PATH 最前的目录（= files/bin）
const TAR_SHIM = path.join(BIN_DIR, 'tar');
const BREW_WRAPPER = path.join(BIN_DIR, 'brew');

const say = (msg) => console.log(msg);
const die = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};

// ── 沙箱适配层：tar 包装 + brew 入口（幂等，覆盖写）──────────────────────────
const TAR_SHIM_SRC = `#!/bin/sh
# tar 包装（沙箱补丁，由 harmonybrew 的 install-harmonybrew.mjs 落盘）——PATH 最前，覆盖 /usr/bin/tar。
#
# 鸿蒙上 toybox tar 解压**符号链接**时，给 symlink 设 mtime 会被拒：
#   tar: settime 1791539128 a/link: Permission denied
#   tar: had errors          → 退出码 1
# 文件其实都解出来了，但退出码非 0 会让调用方（典型：brew 的 pour）判定"解压失败"并回滚 ——
# 表现是 bottle 下载成功、Cellar/opt 却什么都没落地。
#
# 做法：参数原样透传（toybox 要求 -txc 打头，不能在前面插 -m），
# 只在"错的全部是 settime / had errors"时把退出码改成 0；其它错误原样透传。
# ⚠ 不写临时文件：brew 子进程里 TMPDIR 不保证存在，而 /tmp 在鸿蒙上只读。
exec 3>&1
err=$(/usr/bin/tar "$@" 2>&1 1>&3)
rc=$?
exec 3>&-

if [ -z "$err" ]; then
  exit "$rc"
fi
filtered=$(printf '%s\\n' "$err" | grep -v -E '^tar: (settime |had errors)')
if [ -n "$filtered" ]; then
  printf '%s\\n' "$filtered" >&2
  exit "$rc"
fi
exit 0
`;

const BREW_WRAPPER_SRC = `#!/bin/sh
# harmonybrew 入口（沙箱包装，由 install-harmonybrew.mjs 落盘）——PATH 最前，直接敲 \`brew\` 走这里。
#
# 固化三件事：
#   1. prefix / 仓库 / 缓存路径（brew 装在应用私有目录，不是 /home/linuxbrew）；
#   2. HOMEBREW_EXTRA_PATH=$HOME/bin —— **必须**：brew 会把子进程 PATH 重写成
#      /usr/bin:/bin:/usr/sbin:/sbin，只有 EXTRA_PATH 里的目录能回来，否则它看不见
#      files/bin/tar（沙箱补丁）与 files/bin 下其它工具；
#   3. 用 /usr/bin/zsh 执行 brew 本体（brew 头部是 \`#!/usr/bin/zsh -pu\`）。
P="\${HOME}/.harmonybrew"
export HOMEBREW_PREFIX="$P"
export HOMEBREW_REPOSITORY="$P/Homebrew"
export HOMEBREW_CACHE="\${HOMEBREW_CACHE:-$P/.cache}"
export HOMEBREW_EXTRA_PATH="\${HOME}/bin\${HOMEBREW_EXTRA_PATH:+:$HOMEBREW_EXTRA_PATH}"
exec /usr/bin/zsh "$P/bin/brew" "$@"
`;

const GIT_WRAPPER = path.join(BIN_DIR, 'git');
const GIT_WRAPPER_SRC = `#!/bin/sh
# git —— harmonybrew 自带的 portable-git（arm64_ohos 原生），由 install-harmonybrew.mjs 落盘。
# 走 vendor 下的 \`current\` 而不是写死版本号：brew 升级 portable-git 后自动跟随。
P="\${HOME}/.harmonybrew/Homebrew/Library/Homebrew/vendor/portable-git/current"
exec "$P/bin/git" "$@"
`;

function writeSandboxShims() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.writeFileSync(TAR_SHIM, TAR_SHIM_SRC, { mode: 0o755 });
  fs.writeFileSync(BREW_WRAPPER, BREW_WRAPPER_SRC, { mode: 0o755 });
  fs.writeFileSync(GIT_WRAPPER, GIT_WRAPPER_SRC, { mode: 0o755 });
  say(`沙箱适配层就位：${TAR_SHIM}、${BREW_WRAPPER}、${GIT_WRAPPER}`);
}

/** brew 建 `vendor/<件>/current` 软链可能 EPERM —— 收尾时补齐（幂等）。 */
function ensureVendorCurrent(name, versionFile) {
  const dir = path.join(REPO, 'Library/Homebrew/vendor', name);
  const vf = path.join(REPO, 'Library/Homebrew/vendor', versionFile);
  if (!fs.existsSync(dir) || !fs.existsSync(vf)) return;
  const version = fs.readFileSync(vf, 'utf8').trim();
  if (!version) return;
  const link = path.join(dir, 'current');
  try {
    if (fs.existsSync(link)) {
      say(`  ${name}/current 已在（-> ${version}）`);
      return;
    }
    fs.symlinkSync(version, link);
    say(`  ${name}/current 补建成功（-> ${version}）`);
  } catch (e) {
    say(`  ⚠ ${name}/current 补建失败：${e.message}（不影响 brew 本体，装包时可能报错）`);
  }
}

// ── 前置检查 ────────────────────────────────────────────────────────────────
function check(cmd, argv, hint) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    return { ok: false, hint };
  }
  return { ok: true, out: (r.stdout ?? '').trim() };
}

const zsh = check('zsh', ['--version']);
if (!zsh.ok) {
  die(`找不到可执行的 zsh —— harmonybrew 的 brew 本体就是 zsh 脚本，没它装完也跑不起来。\n  排查：echo $PATH；ls -l /usr/bin/zsh`);
}
const tar = fs.existsSync(TAR) ? check(TAR, ['--version']) : { ok: false };
if (!tar.ok) {
  die(`找不到 ${TAR} —— 需要它解压 brew 本体。`);
}
const curl = check('curl', ['--version']);
if (!curl.ok) {
  say('⚠ PATH 里没有 curl：brew 能装上，但 `brew install` 下载 bottle 时要用 curl，装上包也会失败。');
  say('  2026-10-09 实测沙箱自带 /usr/bin/curl；若确实缺，参考 skill 的「下载器」一节。');
}

if (fs.existsSync(BREW) && !FORCE) {
  say(`已经装过了：${BREW}`);
  say('要重装加 --force。');
  writeSandboxShims(); // 适配层可能被换壳清掉了，顺手补回
  printUsage();
  process.exit(0);
}
if (PREFIX.length >= 65) {
  say(`⚠ prefix 有 ${PREFIX.length} 个字符（≥65）：harmonybrew 的 bottle 只保证 <65 字符的 prefix 能就地改写，`);
  say('  装包时可能失败。建议换短一点的，例如 --prefix "$HOME/hb"。');
}

// ── 建目录 + 先落沙箱适配层（brew 的 pour 依赖 files/bin/tar）─────────────────
fs.mkdirSync(path.join(PREFIX, 'bin'), { recursive: true });
say(`prefix: ${PREFIX}（${PREFIX.length} 字符）`);
say(`server: ${SERVER}`);
writeSandboxShims();

// ── 下载 brew 本体 ──────────────────────────────────────────────────────────
async function download(url, dest) {
  say(`下载 ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    die(`下载失败：HTTP ${res.status} ${res.statusText} —— ${url}`);
  }
  const total = Number(res.headers.get('content-length') ?? 0);
  let got = 0;
  let mark = 0;
  const out = fs.createWriteStream(dest);
  for await (const chunk of res.body) {
    got += chunk.length;
    if (!out.write(chunk)) {
      await new Promise((r) => out.once('drain', r));
    }
    if (total > 0) {
      const pct = Math.floor((got / total) * 100);
      if (pct >= mark + 5) {
        mark = pct;
        process.stdout.write(`\r  已下载 ${pct}%（${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB）`);
      }
    }
  }
  await new Promise((r) => out.end(r));
  process.stdout.write('\r');
  say(`  完成：${(got / 1048576).toFixed(1)} MB → ${path.basename(dest)}`);
  if (total > 0 && got !== total) {
    die(`下载不完整：期望 ${total} 字节，实到 ${got} 字节`);
  }
}

// ── 解压 → 改名 → 建 brew 软链 ──────────────────────────────────────────────
/** toybox tar 的 settime 噪音不算失败（文件已解出），见文件头 A。 */
function runTarGz(file, dir) {
  const r = spawnSync(TAR, ['xzf', file, '-C', dir], { encoding: 'utf8' });
  const err = (r.stderr ?? '').trim();
  const lines = err.split('\n').map((l) => l.trim()).filter(Boolean);
  const onlySetimeNoise = lines.length > 0 && lines.every((l) => /^tar: (settime |had errors)/.test(l));
  if (r.status !== 0 && !onlySetimeNoise) {
    die(`解压失败（tar exit ${r.status}）：\n${err}`);
  }
  if (onlySetimeNoise) {
    say('  ⚠ tar 报了 settime 噪音（鸿蒙对 symlink 设 mtime 会 EPERM）—— 文件已解出，继续');
  }
}

await download(`${SERVER}/brew/brew.tar.gz`, TARBALL);
runTarGz(TARBALL, PREFIX);
await fsp.rm(TARBALL, { force: true });

const extracted = path.join(PREFIX, 'brew');
if (!fs.existsSync(extracted)) {
  die(`解压后没看到 ${extracted} —— 包结构可能变了`);
}
await fsp.rm(REPO, { recursive: true, force: true });
await fsp.rename(extracted, REPO);

// brew 本体要可执行（zip/tar 落盘后位可能丢）
fs.chmodSync(path.join(REPO, 'bin/brew'), 0o755);
// 上游是 `ln -sf ../Homebrew/bin/brew <prefix>/bin/brew`
await fsp.rm(BREW, { force: true });
fs.symlinkSync('../Homebrew/bin/brew', BREW);
if (!fs.existsSync(BREW)) {
  die(`软链没建起来：${BREW}`);
}
await fsp.chmod(PREFIX, 0o755);

// ── brew 调用封装：brew 会重写子进程 PATH，只有 HOMEBREW_EXTRA_PATH 里的目录能回来 ──
const BREW_ENV = () => ({
  ...process.env,
  HOMEBREW_PREFIX: PREFIX,
  HOMEBREW_REPOSITORY: REPO,
  HOMEBREW_CACHE: path.join(PREFIX, '.cache'),
  HOMEBREW_EXTRA_PATH: BIN_DIR,
});
const runBrew = (argv, { quiet = false } = {}) => spawnSync('zsh', [BREW, ...argv], quiet
  ? { encoding: 'utf8', env: BREW_ENV() }
  : { stdio: 'inherit', env: BREW_ENV() });

const ensureVendorBits = () => {
  ensureVendorCurrent('portable-git', 'portable-git-version');
  ensureVendorCurrent('portable-ruby', 'portable-ruby-version');
};

// ── 第一次 brew update（上游也做；会拉 core/API 数据、portable-git、portable-ruby）──
say('运行 brew update（首次要拉 core 数据 + portable-git/ruby，慢一点正常）…');
let upd = runBrew(['update', '--force']);
if (upd.status !== 0) {
  // 顺序坑：update 自己依赖 git（vendor/portable-git），而 portable-git 与 portable-ruby 的
  // `current` 软链**正是会被 EPERM 的那个**（见文件头 D）——所以第一次多半会报
  // "Please update your system Git"。正确顺序是：补链 → 让 brew 把 ruby 也装出来 → 重跑 update。
  say('  ⚠ 首次 update 失败（多半是 vendor/*/current 软链没建成）—— 补链后重试');
  ensureVendorBits();
  say('  触发依赖就位（brew config）…');
  let cfg = runBrew(['config'], { quiet: true });
  ensureVendorBits();
  cfg = runBrew(['config'], { quiet: true });
  say(cfg.status === 0 ? '  ✓ brew config 通过（ruby 就位）' : `  ⚠ brew config 仍失败（exit ${cfg.status}）`);
  say('  重跑 brew update…');
  upd = runBrew(['update', '--force']);
}
ensureVendorBits();
say(upd.status === 0
  ? '  ✓ brew update 通过'
  : `  ⚠ brew update 仍未通过（exit ${upd.status}）—— brew 本体可用，可稍后手动重试`);

say('\n✓ 安装完成');
printUsage();

function printUsage() {
  say('');
  say('用法：');
  say(`  brew install jq ripgrep        # 直接敲（入口 ${BREW_WRAPPER} 已在 PATH 最前）`);
  say(`  或 eval "$(${BREW} shellenv)"  # 把 brew 的 bin 加进 PATH（另一条路）`);
  say('');
  say(`装出来的东西都在 ${PREFIX}（应用私有目录）：「重置 / 备份用户目录」碰不到，卸载应用才会清掉。`);
  say('');
  say('⚠ 装出的包若报 "Error loading shared library libXXX.so"：bottle 的 rpath 写死在上游 prefix');
  say('  （/storage/Users/currentUser/.harmonybrew），沙箱里没有那个路径。兜底办法：');
  say(`    export LD_LIBRARY_PATH="$(ls -d ${PREFIX}/opt/*/lib 2>/dev/null | paste -sd: -):$LD_LIBRARY_PATH"`);
  say('  纯原生 CLI（jq / ripgrep / ninja）这样就能跑；带内部绝对路径的包（python / node 等）不保证。');
}
