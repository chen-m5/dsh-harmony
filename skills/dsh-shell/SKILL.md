---
name: dsh-shell
description: 你（dsh）运行在一个 HarmonyOS 应用的沙箱里，而不是普通 Linux 主机。这里说明这个环境的样子：目录布局与路径、壳注入的环境变量、鸿蒙沙箱的能力边界，以及「壳」提供了哪些功能。当你需要搞清楚"我在哪、有什么、没有什么、该怎么让用户去操作"时阅读。
---

# 你所在的环境：HarmonyOS 应用沙箱

你不是跑在普通 Linux 主机上，而是跑在一个**鸿蒙应用（"壳"）的应用沙箱**里：
壳在启动时把 dsh（内置包）解压到沙箱、用后台进程拉起你，dsh 的 Web UI 交给系统 ArkWeb 渲染，
另外带一个真终端窗口。本文只讲**这个环境本身**；要改 dsh 自己的代码，见开发机上 dsh-harmony 仓库的文档。

## 一、目录布局（壳的约定）

下面用 `<沙箱>` 表示应用私有目录（鸿蒙上每个应用有独立私有目录，就是 dsh 进程的 `files`/`cache` 所在处；
具体绝对路径随设备与包名而变，别写死）。

| 位置 | 相对路径 | 说明 |
|---|---|---|
| 你的 HOME | `<沙箱>/files` | 壳注入 |
| `DSH_HOME`（你的配置与凭据） | `<沙箱>/files/dsh-home` | **在沙箱内**（凭据文件要 600 权限，共享盘给不了）；用户可在壳里备份 / 重置 |
| 临时目录 `TMPDIR` | `<沙箱>/cache` | **可写**；长输出 spill 走这里 |
| 你的 cwd | `<沙箱>/files/workspace` | 一个落地目录，不等同于"用户的工作区" |
| **内置件**（壳自带的运行时） | `<沙箱>/files/<名字>/` | **只有 node 与 pnpm**，直接放 HOME 下（不套中间层），见下节 |
| harmonybrew 装的东西 | `<沙箱>/files/.harmonybrew` | 用 `harmonybrew` skill 按需装的；壳不管它 |
| dsh 包目录 | `<沙箱>/files/dsh-pkg/`（固定） | 内置 zip 解压而来；换包按**内置包编码**（zip 的 sha256）自动重解压；**不再是只读**（历史版本设过 a-w，现已取消） |
| 随包 skill 根 | `<沙箱>/files/skills` | 见下节 `DSH_BUNDLED_SKILL_DIR` |
| 壳自己的包装脚本 | `<沙箱>/files/bin`（`pnpm`/`pnpx`） | 排在 `PATH` 最前面 |
| 壳生成的配置 | `<沙箱>/files/etc`（目前是 `gitconfig`） | 见 `GIT_CONFIG_SYSTEM` |
| 你的日志 | `<沙箱>/files/logs/dsh.log` | **只在沙箱**；用户可在壳里"导出日志" |

`TMPDIR` 之外，**`/tmp` 在鸿蒙上通常是只读的**（写入报 `EROFS`）—— 需要临时文件一律用 `$TMPDIR`。

### 内置件：直接放 HOME 下

**一件一个目录、就在 HOME 下**：`<沙箱>/files/<名字>`，目录名就是包内 zip 的名字（`pnpm.zip` → `files/pnpm`）。
**内置件只有两个**，都在安装包里、启动时解压，**装完不联网也能用**：

| 名字 | 来源（安装包内） | 落地 | 说明 |
|---|---|---|---|
| `node` | `rawfile/runtime/node-ohos.zip` | `<沙箱>/files/node` | node + bash（终端与子进程都用它）；**不带 npm** |
| `pnpm` | `rawfile/runtime/pnpm.zip` | `<沙箱>/files/pnpm` | 包装脚本在 `<沙箱>/files/bin/{pnpm,pnpx}`；dsh 的 `dsh plugin` 就是转发给它的 |

**已装好一批常用工具（`git` / `python3` / `curl` / `jq` / `rg` …，见第三节清单）；要装清单之外的（`fd`、`nc` 之类）**，两条路：

1. **装 harmonybrew（一次能装一批）** —— 见随包 skill `harmonybrew`。规矩是
   **先看装没装（`$HOME/.harmonybrew/bin/brew`）、没装要先问用户**（首次下载约 122 MB）；
   东西落在 `<沙箱>/files/.harmonybrew`。⚠ `brew install` 自己要用 curl 下 bottle —— 壳里有 `curl`
   （8.8.0，`/usr/bin/curl`），够用（详见那个 skill 的「下载器」一节）。
2. **单个静态 / 纯 JS 工具**：下载后放进 `<沙箱>/files/bin/`（排在 `PATH` 最前，`chmod +x` 就能敲）。

> 壳里早先还内置过 `git` / `python` / `curl`，现已撤掉（省 27 MB，改用 harmonybrew 按需装；`curl` 用系统自带的 `/usr/bin/curl`）。
> 它们的打包脚本还留着：`scripts/build-git-tools.mjs`、`scripts/build-curl-tools.mjs`，想加回来跑一下即可。

**为什么不套 `tools/` 中间层**：路径短、`cd $HOME` 一眼看清有什么，不用记中间那层叫什么；
harmonybrew 的 prefix（`files/.harmonybrew`）也因此更短。

**加一个新内置件**（参考既有两件，或 `scripts/build-git-tools.mjs` 那种「自带依赖闭包」的做法）：

1. 写打包脚本产出 `entry/src/main/resources/rawfile/runtime/<名字>.zip`（参考 `scripts/build-git-tools.mjs`：
   自动解析 ELF 依赖闭包、只带跑得起来的最小集合）；
2. `DshShell.releaseTools()` 里加一段「缺了就解压」（zip **顶层目录名必须等于 `<名字>`**）；
3. `DshShell.envAdd()` 里把它的 bin / 库目录接进 `PATH` / `LD_LIBRARY_PATH`；
4. `scripts/build-hap.sh` 的 `check_bundled()` 里加上它（缺件要在构建时就能看见）；
5. 回这份 SKILL.md 记一行 —— **这里就是内置工具的唯一说明书**。

两个通用约定：**执行位**解压后自己 `chmod`（解压产物默认没有 x）；**软链**写成清单文件、启动时重建
（ArkTS 的 zlib 解压不还原软链 —— 早些年的 git 包就是靠一份 `links.txt` 重建那 149 个子命令入口的）。

**还没装的工具（`fd`、`nc` 之类）怎么办**：按需自己弄，别指望用户去装 ——

- 最省事的落点：**可执行文件直接放 `<沙箱>/files/bin/`** —— 这个目录排在 `PATH` 最前面，
  放进去（`chmod +x` 之后）马上就能敲；要带一堆文件/依赖的，就解到 `<沙箱>/files/<名字>/`，
  再在 `<沙箱>/files/bin/` 放个一行包装脚本指过去（pnpm / pnpx 就是这么干的）。
- 挑东西时记住这里是 **openharmony-arm64 + musl**：优先**纯 JS（用自带的 node 跑）**、静态链接的二进制，
  或 `scripts/build-git-tools.mjs` 那种「自己把 ELF 依赖闭包带上」的做法；**glibc 的动态二进制直接跑不起来**。
- **想一次装一批工具**：用 harmonybrew（brew）—— 见随包 skill `harmonybrew`。它的规矩是：
  先看装没装（`$HOME/.harmonybrew/bin/brew`），**没装要先问用户**（首次下载约 122 MB）再动手。
- **弄完顺手记账**：写一个自己的 skill（`$DSH_HOME/skills/<名字>/SKILL.md`，就是平时装 skill 的那个
  用户级目录）说明「是什么、装在哪、怎么用」；若它是随包内置的，改这份 `dsh-shell` skill 更合适。
  不记的下场：下一次（你或别的会话）又得从头找一遍。
- 「壳的地盘」重置 / 备份都碰不到：随包 skill 在 `<沙箱>/files/skills/`，内置件与 harmonybrew 装的东西
  都在 `$HOME` 下；但它们**只在这台设备上存在** —— 想让某个工具跟着安装包走（新装机也有），
  就得走上面那 5 步把它内置进去。

## 二、壳注入的环境变量

```
HOME=<沙箱>/files
DSH_HOME=<沙箱>/files/dsh-home
TMPDIR=<沙箱>/cache
GIT_CONFIG_SYSTEM=<沙箱>/files/etc/gitconfig   # 放行 safe.directory（壳不再带 git，是留给 brew 装的 git 用的）
DSH_BUNDLED_SKILL_DIR=<沙箱>/files/skills      # 你的 bundled skill 根（rank 600）
DSH_PERMISSION_MODE=<放行模式>                 # 鸿蒙无 bwrap/landlock，壳用完全放行
PATH=<沙箱>/files/bin : <沙箱>/files/node : <系统 PATH>
LD_LIBRARY_PATH=<沙箱>/files/node [ : <沙箱>/files/.harmonybrew/opt/<包>/lib … ]   # 后者是 brew 装的包的库
LANG=C.UTF-8
```

**`DSH_BUNDLED_SKILL_DIR` 就是随包 skill 的挂载点**：壳把 `rawfile/skills/**` 里的东西**逐字节镜像**到
`<沙箱>/files/skills/**`（不限 `SKILL.md`，资源文件也一起），dsh 的 `skill-filesystem` 按 **rank 600** 扫它，
于是这些 skill 出现在你的 skill 目录里。
（放在 `files/skills` 而不是 `files/dsh-home` 下，就是为了「重置 / 备份 / 换包」都碰不到它们。）

壳的镜像规则（要改 skill 的人注意）：

- 壳**不维护写死清单**：构建时由 `scripts/build-hap.sh` 生成 `rawfile/skills/manifest.txt`，
  壳按「清单 ∪ 递归发现」同步；装完/回滚 skill 时 `scripts/install-skill.sh` 也会刷新它。
- 同步是**只增改 + 只删自己放过的**：上次镜像过、这次没了 → 删；手工塞进 `files/skills/` 的文件不动
  （记录在 `files/skills/.dsh-mirrored`）。
- 加一个 skill = `scripts/install-skill.sh --from <目录|tar.gz|zip>` → `scripts/build-hap.sh`
  → 装新 hap → 重启 dsh；不满意用 `--restore <名字>` 回滚。
- 因为镜像发生在 dsh 启动前，**坏 skill 可能让 dsh 起不来**：改 skill 前先「备份/导出用户目录」，
  起不来就回滚并看 `<沙箱>/logs/dsh.log`。

⚠ **dsh 会给子进程做凭据清洗**：部分 `DSH_` 变量不会传下来（实测 `DSH_BUNDLED_SKILL_DIR` 缺失，而
`DSH_HOME`/`DSH_PROFILE` 等在）—— **别依赖它**；名字命中 `KEY`/`PASSWORD`/`SECRET`/`TOKEN` 的变量同样不传
（踩过：`GIT_CONFIG_KEY_0` 被删掉，git 反而条条 fatal）。

## 三、能力边界（鸿蒙沙箱的"没有"）

**已装**（多数是 harmonybrew 装的、并在 `files/bin` 包了一层）：`git`、`node`、`pnpm`、`npm`、`python3`、`curl`、
`jq`(1.8.2)、`rg`(ripgrep 15.2.0)、`zstd`(1.5.7)、`sqlite3`(3.53.0)、`brew` —— 除 `curl`（`/usr/bin/curl`）与
`node`（`files/node`）外都在 `<沙箱>/files/bin`（排在 `PATH` 最前）。
**没有**：`java`、`mvn`、`hvigorw`、`ohpm`、`hdc`。
（详细记账 —— 每个工具怎么装的、哪些要补包装脚本 —— 见 `harmonybrew` skill 第六节；
那边是唯一权威，装/删工具后改那里。）
**一般有**：系统里的 `tar`/`zip` 等 toybox 工具（具体以 `PATH` 里实际存在的为准）。

几条要记住的边界：

- **不能在沙箱里构建 / 安装 hap**（没有 hvigor / hdc / ohpm）——构建在开发机上做。
- **`/bin/sh` 常是 mksh/精简 shell**：`command -v X` 对 `PATH` 里的命令可能返回 `alias X=X` ——
  **别用它判断存在性**，用 `ls /bin/X /usr/bin/X` 或直接 `X --version`。
- **`grep` 常是 toybox**：要交替必须 `grep -E 'a|b'`（BRE 的 `\|` **静默无输出**，容易误判"没有这段"）；
  没有 `--json`/`--files`/`-g`；不支持 `\{n,m\}`（写 `{n,m}`）。
- **`cat` 可能没有 `-n`/`-A`**；别 `cat`/`head` 二进制（会把上下文刷满）——先 `file X`。
- **没有 `ss`**：探端口用自带的 node，例如
  `node -e "fetch('http://127.0.0.1:<port>/').then(r=>console.log(r.status)).catch(()=>console.log('down'))"`。
- **沙箱进程随应用退出被平台清掉**：应用一关，你和后台服务都没了。
- 出网一般正常（宿主的网络能力）；具体视应用是否声明了网络权限。

## 四、壳提供了哪些功能（让用户去哪操作）

壳是**两个窗口** + 主窗口一条**自绘标题栏**（左边应用名与状态 + `Ctrl+R 刷新` 提示，右侧窗口按钮 + **设置图标**，
双击标题栏切换最大化；最大化后标题栏收起、鼠标顶到上方 20vp 内悬浮滑出；**终端**入口在设置弹窗标题栏右侧，
空白处可拖动窗口）。主窗口会先尝试**隐藏系统标题栏**（`setWindowDecorVisible`，**API 20** 才有）：
设备 ≥ API 20 且支持 → 隐藏成功；低版本/不支持 → catch 后退回系统标题栏，自绘条只留状态与菜单：

| 入口 | 干什么 |
|---|---|
| **设置**弹窗 | **dsh 控制**（状态 / 启动 / 停止 / **查看日志**：**单开一个窗口**看 `logs/dsh.log`，带刷新、可复制）+ **包目录**（`dsh版本：` 下拉：切换 / 删除 / 恢复内置包 / **导入 zip**：同名版本覆盖，导入后选版本 + 重启 dsh）+ **用户目录**（`用户数据备份：` 下拉：备份 / 重置=清空 / **导出**（打包成 `dsh-home-<dsh版本>-<时间戳>.tar.gz`，自选文档目录）/ **导入归档**（覆盖当前用户信息，二次确认）/ 从备份恢复 / 删备份） |
| **终端**窗口 | 整页真终端（xterm.js + PTY）；操作走**右键菜单**：复制 / 粘贴 / 清屏 |
| **刷新** | 重载 dsh 页面（页面还没起来时重走一遍启动） |

几条对你（dsh）有用的行为：

- **一切随安装包分发、不联网下载**：node / pnpm 运行时与 dsh 包都必须打进 hap（启动时解压到沙箱）；
  缺哪件就是**构建异常**，壳会在界面状态行里直接报出来（已经没有 URL 兜底下载了）。
- **换 dsh 版本**：壳按**内置包编码**（`rawfile/pkg/dsh-ohos.stamp` 的 sha256 与 `settings.json` 里记的比对）
  判断，不一致才**自动重解压**；用户也可在设置里点「恢复内置包」，或导入自己的 zip。
- **用户目录可备份 / 重置 / 打包迁移**：你的配置与凭据都在 `files/dsh-home`，用户能一键回到干净状态（会二次确认）；
  「导出」是**先打包再导出**成一个 `tar.gz`，「导入」会**清空后解压覆盖**（不可撤销，导入后要重启你才生效）。
- **断线会自己重连**：你走的 WebSocket 是本机（loopback）服务，客户端已改成不跟随浏览器的
  `navigator.onLine`（鸿蒙 ArkWeb 这个值 / `offline` 事件不可靠，一报离线就会停掉自动重试、
  卡在「连接异常，点击立即重连」）；现在按 0.5s→10s 退避一直重试，不需要用户手点。
- **外链不在应用内开窗**：页面里 `window.open` 的外部 http(s) 链接由壳转交**系统浏览器**，
  ArkWeb 不会自己开窗盖住 dsh；dsh 自己的页面（本机端口）始终留在 Web 内。
- **日志默认只在沙箱**（可能含 token、命令回显）；要给人看，请让用户用设置里的"导出日志"。
- 关掉哪个窗口都**不会停掉你**（你是 detached 后台进程）；再打开应用 / 终端会复用已在跑的那个。

## 五、想改你自己（dsh）的代码时

- **别只改沙箱里 `files/dsh-pkg/...` 的副本** —— 那是一次性解压的产物，换包 / 重装会被覆盖。
- 正确做法：改**内置包**（重打 zip）再重装 hap；逐版本适配清单与验收方法在开发机上的 **dsh-harmony** 仓库（`CHANGES.md` 与 `<版本>/docs`）。
