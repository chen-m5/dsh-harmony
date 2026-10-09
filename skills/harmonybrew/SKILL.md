---
name: harmonybrew
description: 在这个鸿蒙沙箱里用 harmonybrew（brew）装没内置的工具时的说明：先看装没装、没装要先问用户、怎么装（随本 skill 的 install-harmonybrew.mjs）、装完怎么用、怎么记账，以及实测过的坑（bottle 的 rpath 写死官方 prefix，跑包要 LD_LIBRARY_PATH 兜底）。当用户要在沙箱里用某个工具、而它不在内置件里时阅读。
---

# 用 harmonybrew 按需装工具

沙箱内置只有 `node` / `pnpm`；`python3`、`git` 是 harmonybrew 装的（见 `dsh-shell` skill 的内置件一节）。
想用别的工具，除了直接下静态二进制，还可以用 **harmonybrew** —— 它是鸿蒙上的 Homebrew 移植，
`brew install <包名>` 就能装 —— **装什么由需求决定，这里不预设清单**。

## 一、先检查，再问用户（**不要不问就装**）

```sh
ls -l "$HOME/.harmonybrew/bin/brew"     # 默认 prefix = $HOME/.harmonybrew
```

- **已经装了** → 直接按第三节用。
- **没装** → **先问用户要不要装**，说明代价：首次要从 `harmonybrew.atomgit.com` 下载
  **约 122 MB** 的 brew 本体，装完再跑一次 `brew update`（还要拉数据），装出来约 **690 MB**
  （Cellar ~273 MB + 缓存 ~132 MB）。
  用户同意后再装；不同意就退回"下静态二进制"那条路，别自己闷头下。

> 为什么必须问：这是往沙箱里拉一个包管理器（几百 MB、后续还会继续下载），
> 流量、时间、磁盘都是用户的，替他做主不合适。

## 二、安装

```sh
node "$HOME/skills/harmonybrew/install-harmonybrew.mjs"
# 想换地方（prefix 越短越稳）：--prefix "$HOME/hb"
```

脚本自己会做前置检查并给出可读的报错：

| 检查 | 没有会怎样 |
|---|---|
| `zsh`（`/usr/bin/zsh`） | **直接退出** —— brew 本体就是 zsh 脚本，没它装完也跑不起来 |
| `/usr/bin/tar` | 直接退出（解压 brew 本体要用） |
| `curl` | ✅ 沙箱自带（`/usr/bin/curl`，2026-10-09 实测 8.8.0）—— brew 下载 bottle 用的就是它 |

`prefix` 默认 `$HOME/.harmonybrew`。**别弄太长**：harmonybrew 的 bottle 是「原地等长改写」prefix，
上游只保证 **< 65 字符**；脚本会在 prefix ≥65 字符时提示。

> **下载器（curl）**：2026-10-09 实测沙箱已自带 `/usr/bin/curl`，装包不需要额外准备。
> 若哪天又被撤掉，两条备选：① 壳内置一份 curl（0.28 MB，`scripts/build-curl-tools.mjs` 现成）；
> ② 用 node 写个 curl 子集 shim 放进 `files/bin`（零额外体积，贴合"只内置 node"）。
> **没有下载器时：brew 能装上，但 `brew install` 一个包都装不了。**

## 三、装完怎么用

```sh
eval "$($HOME/.harmonybrew/bin/brew shellenv)"     # 把 brew 加进 PATH（当前终端一次）
brew install <包名>
```

> **本机现状（2026-10-09 已装）**：沙箱里装好了 harmonybrew，入口是 `files/bin/brew`
> （在 PATH 最前，直接敲 `brew …` 就行）。它固化了 prefix 与 `HOMEBREW_EXTRA_PATH`，
> 装机时踩过的坑与必须保留的三个包装脚本见**第七节**。

⚠ **装出来的包直接跑可能报 `Error loading shared library libXXX.so`** —— 这是实测到的坑，见下节。
兜底办法：把新 prefix 下所有库目录塞进 `LD_LIBRARY_PATH`，再跑：

```sh
export LD_LIBRARY_PATH="$(ls -d "$HOME"/.harmonybrew/opt/*/lib 2>/dev/null | paste -sd: -):$LD_LIBRARY_PATH"
jq --version
```

## 四、实测到的坑（**装之前先知道**）

先说结论：**`brew install` 全程不报错**（倒瓶、Cellar 落地、`🍺` 都正常），
**问题出在你运行装出来的程序那一刻** —— 这是这套组合最容易误判的地方（"装完看着成功，一用就崩"）。

| 现象 | 原因 | 结论 |
|---|---|---|
| `brew install` 能成功、Cellar 也落了 | — | ✅ 装的时候不报错 |
| **运行**装出的二进制时报 `Error loading shared library libjq.so.1: (needed by …/bin/jq)` | bottle 里的 rpath 写死上游构建 prefix `/storage/Users/currentUser/.harmonybrew`（**不是**装的时候现算的），沙箱里没有那个路径；这句是动态加载器 exec 时抛的，不是 brew 抛的 | ⚠ 装在包里、但默认跑不起来 |
| 加了 `LD_LIBRARY_PATH=<新 prefix>/opt/*/lib` 后，`jq --version`、`ninja --version` 都正常 | 动态加载器优先用 `LD_LIBRARY_PATH`，绕开了错误的 rpath | ✅ **纯原生 CLI 工具这样能救** |
| 带内部绝对路径的包（python / node / perl 这类，或带脚本/数据文件的 formula） | 那些路径同样写死在上游 prefix，`LD_LIBRARY_PATH` 救不了 | ❌ 别指望 |

> 想提前探雷：`brew test <formula>` 会真的执行程序，撞的是同一个错；
> 只看 `brew install` 的退出码是看不出问题的（它是 0）。

适用范围：**"一个静态二进制或自带库的原生 CLI"** —— 具体装哪个看需求，本 skill 不预设。
要 python / node 这类"自带整套目录结构"的运行时，还是用内置的 node，或找静态发行版直接下载。

## 五、几条边界

- 装出来的东西都在 prefix 里（`$HOME/.harmonybrew`）—— **「重置 / 备份用户目录」碰不到它**，卸载应用才会清掉；
  反过来说，它也不在用户的备份里。
- **它是"设备本地"的**：换设备 / 新装机都没有，得重新装。想让它跟安装包走，那是壳侧的事（见 `dsh-shell`）。
- **上架相关的提醒**：应用内"下载并执行任意二进制"属于审核敏感面。这个 skill 是给**开发/自用**场景的；
  要对用户默认提供某个工具，走「内置工具」那套（打进 hap），别指望用户自己 brew install。
- 首次装完 `brew update` 慢是正常的（在拉 core 数据）；报错就把**原文**贴出来，别只看退出码。
## 六、已装的工具（清单 —— **装一个 / 删一个就回来改这里**）

> 规矩：`brew install` / `brew uninstall` 之后顺手更新这张表。否则下一次（你或别的会话）只能
> `brew list` 现查，还得重新判断"到底能不能用"。

| 工具 | 怎么装的 | 能跑吗 | 备注 |
|---|---|---|---|
| `jq` 1.8.2_1 | `brew install jq`（2026-10-09，连带依赖 `oniguruma` 6.9.10_1） | ✅ 能跑（`jq --version` → jq-1.8.2；`jq -c` 实测正常） | 裸跑 `opt/jq/bin/jq` 会报 `Error loading shared library libjq.so.1 / libonig.so.5`；已在 `files/bin/jq` 包装里拼好 `LD_LIBRARY_PATH=$HOME/.harmonybrew/opt/*/lib`，沙箱里直接敲 `jq` 即可 |
| `ripgrep` 15.2.0_1（`rg`） | `brew install ripgrep`（2026-10-10，连带依赖 `pcre2` 10.49） | ✅ 能跑（`rg --version` → ripgrep 15.2.0；`rg -c` 实测正常） | 同 jq：裸跑 `opt/ripgrep/bin/rg` 会缺 `libpcre2`；已在 `files/bin/rg` 包装里拼好 `LD_LIBRARY_PATH`，直接敲 `rg` 即可 |
| `zstd` 1.5.7 | 随 brew 本体就有（非本次 `brew install`；2026-10-10 补包装） | ✅ 能跑（`zstd -dc <会话日志> \| head` 直接解多帧 zstd） | 裸跑即可用、无需补库；已在 `files/bin/zstd` 包装里暴露到 PATH。**会话日志就是 zstd 多帧拼接**，排查时这条最省事（实测一次解出 13373 个事件） |
| `npm` 11.19.1（随 `node` 26.10.0） | `brew install node`（2026-10-10；185 MB。**只为拿到 npm**） | ✅ 能跑（`npm -v` → 11.19.1；`pnpm view` 不再报 `spawnSync npm ENOENT`） | 沙箱内置 node（`files/node`）不带 npm，而 **pnpm 某些操作会 spawn `npm`** → 补了 `files/bin/npm` 包装：用内置 node 跑 `opt/node/libexec/lib/node_modules/npm/bin/npm-cli.js`。brew 的 node 按名字跑会被 `files/node` 遮蔽（这是预期的，只用它带的 npm） |
| `sqlite3` 3.53.0 | 同上（brew 的 `sqlite` formula；2026-10-10 补包装） | ✅ 能跑（直接查记忆库：`select count(*) from events` → 30319） | 裸跑即可用；已在 `files/bin/sqlite3` 包装里暴露到 PATH |
| `git` 2.55.0 | **不是 `brew install` 的包**：brew 自带的 `vendor/portable-git`（arm64_ohos，brew 首启时自动下载） | ✅ 能跑（`git --version`、`log -1`、`status --short` 实测） | 已在 `files/bin/git` 包成沙箱命令，指向 `vendor/portable-git/current`（brew 升级后自动跟随） |

两条备注里要写清的经验：

- **装完必须验一下**：`<工具> --version`。brew 的退出码 0 不代表程序能跑（见第四节）。
- **装了 CLI 就补一个包装脚本**（照第七节模板）：包装自己会拼 `LD_LIBRARY_PATH`，所以**装完即可用、不必重启**
  （`jq` / `rg` 2026-10-10 实测：`brew install` 后写完 `files/bin/<工具>`，当场 `--version` 就通）。
- **重启才生效的是另一种情况**：没写包装、指望壳注入的库路径 —— 壳是**在启动时**扫
  `files/.harmonybrew/opt/<包>/lib` 拼进 `LD_LIBRARY_PATH` 的，会话中途装的包不会进当前环境。当前会话想立刻用，就手动：
  ```sh
  export LD_LIBRARY_PATH="$LD_LIBRARY_PATH:$(ls -d "$HOME"/.harmonybrew/opt/*/lib | paste -sd: -)"
  ```

## 七、沙箱适配：脚本已内置，一条命令装好（2026-10-09 三次从零验证）

**重装 / 换壳之后只要一条命令** —— 沙箱适配层（tar shim、brew 入口、git 包装）由脚本自己落盘，全程幂等：

```sh
node "$HOME/skills/harmonybrew/install-harmonybrew.mjs"
# 想彻底重来：rm -rf "$HOME/.harmonybrew" && rm -f "$HOME/bin"/{brew,tar,git} 后再跑（或加 --force）
```

脚本内部按这个顺序自愈：

1. **先落沙箱适配层**：`files/bin/tar`（shim）、`files/bin/brew`（入口）、`files/bin/git`（brew 自带的 portable-git）；
2. 下载 122 MB 本体 → 解压（**容忍 toybox tar 的 settime 噪音**）→ 改名 `Homebrew` + 建 `bin/brew` 软链；
3. `brew update` —— **第一次大概率失败**（见坑⑤：`portable-git/current` 建不上，brew 报
   `Please update your system Git`）→ 脚本补链 → 跑 `brew config` 把 **portable-ruby** 也拉下来并补链 →
   **重跑 `brew update`**（这次 `Already up-to-date`）；
4. 收尾复验：`brew config` 必须通过。

第三次从零验证的实际输出：`✓ brew config 通过（ruby 就位）` → `✓ brew update 通过` → `✓ 安装完成`，exit 0。
`brew config` 关键行：`HOMEBREW_VERSION: 7.0.6_3`、`Homebrew Ruby: 4.0.7`、
`Git: 2.55.0 => files/bin/git`、`Curl: 8.8.0 => /usr/bin/curl`、`Kernel: HarmonyOS … aarch64 Toybox`；
占地约 690 MB（Cellar ~273 MB + 缓存 ~132 MB）。`brew install jq` 端到端通过（`brew list` → jq / oniguruma）。

### 五个坑（脚本为什么写成这样；以后报错时对照）

| # | 现象 | 真实原因 | 脚本里的对策 |
|---|---|---|---|
| ① | 解压阶段就 `die`（exit 1） | toybox tar 解 **symlink** 时给链接设 mtime 被拒：`tar: settime …: Permission denied` → `tar: had errors` → 退出码 1；**文件其实全解出来了** | `runTarGz()` 只在这类噪音之外才判失败 |
| ② | `brew install` / vendor-install 的 pour 反复失败：bottle 下完了，Cellar/opt 却空的 | 同一个 settime 问题 —— brew 把 tar 的非 0 退出码当"解压失败"回滚 | 落 **`files/bin/tar`** shim（PATH 最前）：参数原样透传，只在"错的全部是 `settime`/`had errors`"时把退出码改 0。⚠ 不能改成前置 `-m`：toybox 要求 `-txc` 打头 |
| ③ | 装了 shim 也没被 brew 看见 | `Homebrew/bin/brew:300` 把子进程 `PATH` 重写成 `/usr/bin:/bin:/usr/sbin:/sbin`，只有 `HOMEBREW_EXTRA_PATH` 能加回来 | **`files/bin/brew`** 里 `export HOMEBREW_EXTRA_PATH="$HOME/bin"`，脚本调用 brew 时也带这个 env |
| ④ | shim 自己报 `can't create /tmp/.tar-shim.NNN.err: Read-only file system`，tar 根本没跑 | brew 子进程里 `TMPDIR` 不保证传进去 → `${TMPDIR:-/tmp}` 落到**只读的 /tmp** | shim 用 fd 3 兜 stdout、命令替换收 stderr，**全程不落盘** |
| ⑤ | `ln: cannot create symbolic link from '4.0.7' to 'current': Permission denied`（同一条命令手动敲却成功），ruby/git 因此"没装上" | 只出现在 brew 的 vendor 安装路径（shell `ln`），原因未完全定论；`brew install` 自己的 `opt/<包>` 链接是 Ruby 建的，**不受影响**（jq 装成功即证） | `ensureVendorCurrent()` 自动补 `portable-git` / `portable-ruby` 的 `current`，并在补链后**重跑 update**（坑⑤ + 顺序依赖） |

### 包装脚本（沙箱适配层，别删）

`brew` / `tar` / `git` 三个由安装脚本落盘并保持在 PATH 最前（重装 hap、换壳后再跑一次脚本即可恢复）；
`jq` 这类"brew 装出来的 CLI"要单独补一行包装（照下面写），因为 bottle 的 rpath 写死在上游 prefix：

```sh
# files/bin/<工具>：补 LD_LIBRARY_PATH 后再 exec 真身
P="$HOME/.harmonybrew"
LL=$(ls -d "$P"/opt/*/lib 2>/dev/null | tr '\n' ':')
exec env LD_LIBRARY_PATH="$LL${LD_LIBRARY_PATH:-}" "$P/opt/<包>/bin/<工具>" "$@"
```
