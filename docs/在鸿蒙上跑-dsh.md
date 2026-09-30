# 在鸿蒙设备上跑 dsh（命令行 + 浏览器）

在**设备本机**用命令行起一个 dsh 服务，再用系统浏览器打开它的 Web UI。

```
装 harmonybrew  →  brew install node  →  拿本仓库的鸿蒙包  →  bin/dsh web  →  浏览器打开
```

适用：鸿蒙 PC、或任何有终端环境、且系统版本达标的 HarmonyOS 设备。

> **这是「命令行路线」**：在设备终端里手动把 dsh 跑起来，用系统浏览器访问它的 Web UI。
> 本仓库只负责**把 dsh 适配到鸿蒙**（改造 + 随包资产 + `bin/dsh` 入口）；
> 至于由谁来托管它、用什么渲染 UI，是宿主侧的事。

---

## 快速开始（先把命令跑起来）

```sh
# 1) 装 harmonybrew（Homebrew 的鸿蒙移植）+ node（需要 ≥ 20.12）
zsh -c "$(curl -fsSL https://harmonybrew.atomgit.com/install.sh)"
eval "$(/storage/Users/currentUser/.harmonybrew/bin/brew shellenv)"
brew install node && node -v

# 2) 拿包：自己构建（已有 zip 的话，解压到 Documents/dsh/ 即可）
#    构建工具要单独装（见第四节）：brew install node 不带它们
brew install pnpm zip unzip
#    取仓库二选一（选 b 连 git 都不用装）：
#      a) 命令行克隆（需要 git：brew install git）
git clone https://gitcode.com/chen-qiongmeng/dsh-harmony.git && cd dsh-harmony
#      b) 打开仓库页面点「克隆/下载」下 zip，解开后进那个目录
node scripts/build-dsh.mjs 0.2.0-rc.2 --out /storage/Users/currentUser/Documents/dsh/dsh-ohos-0.2.0-rc.2.zip

# 3) 起服务（前台跑着），把打印出来的 URL **连 token 一起**粘进系统浏览器
export PATH=/storage/Users/currentUser/.harmonybrew/bin:$PATH
/storage/Users/currentUser/Documents/dsh/dsh-ohos-0.2.0-rc.2/bin/dsh web --no-open --port 32200
#   → dsh web: http://127.0.0.1:32200/?token=…
```

> **必须在含 `file_manager(1006)` 组的环境里执行**（PC 终端 / DevEco Studio 的终端 / BitFun 这类）。
> 普通应用沙箱（例如某个鸿蒙应用的沙箱内部）访问 `.harmonybrew` 会 `Operation not permitted`，
> 而且**绕不过去**（`chmod 777` 无效、软链也无效）。详见第一节。

下面是每一步的展开说明、常见问题与实测记录。

---

## 一、前置条件

| 项 | 要求 | 怎么确认 |
|---|---|---|
| 系统版本 | HarmonyOS ≥ **6.1.0.117(SP68)**，或 OpenHarmony 6.1 | `param get const.product.software.version` |
| 终端能访问用户目录 | 能读 `/storage/Users/currentUser/.harmonybrew` | `ls /storage/Users/currentUser/.harmonybrew` |
| Node | **≥ 20.12**（dsh 的工具链目标是 Node 22 LTS） | `node -v` |
| 构建工具（只有"自己构建"才需要）| `pnpm`、`zip`、`unzip`（`git` 仅"命令行克隆仓库"时才要）—— **`brew install node` 不带这些** | `pnpm -v; zip -v` |

### ⚠ 最容易卡住的一步：权限前提

`.harmonybrew` 的权限是 `drwxrws--x <uid> file_manager` —— **组有 rwx**，于是：

| 环境 | 在 `file_manager(1006)` 组 | 能否访问 `.harmonybrew` |
|---|---|---|
| 鸿蒙 PC 的终端 / DevEco Studio 的终端 / BitFun 这类开发工具 | ✅ | ✅ |
| **普通应用沙箱**（例如某个鸿蒙应用的沙箱内部） | ❌ | ❌ `Operation not permitted` |

普通应用的沙箱里**没有任何办法绕过去**：`chmod 777` 无效（不是权限位问题），
软链也不行（授权按最终解析路径查，实测两个方向都 EPERM）。所以下面这些步骤
**必须在有 `file_manager` 组的环境里执行**。

判断方法：`id` 看输出里有没有 `1006(file_manager)`。

---

## 二、装 harmonybrew

harmonybrew 是 Homebrew 的鸿蒙移植，bottle 全部按 `arm64_ohos` 重新构建，自带 portable-ruby / portable-git。

```sh
zsh -c "$(curl -fsSL https://harmonybrew.atomgit.com/install.sh)"
```

官方脚本会装到 **`/storage/Users/currentUser/.harmonybrew`**（这个位置写死，没有自定义开关）。

装完让它对**当前终端**生效：

```sh
eval "$(/storage/Users/currentUser/.harmonybrew/bin/brew shellenv)"
brew --version        # 期望：Homebrew 7.0.6_3 之类
```

想长期生效，把那行 `eval …` 追加到 `~/.zshrc`（或 `~/.mkshrc`，看你的终端用哪个）。

---

## 三、装 node

```sh
brew install node     # 会自动 link 进 .harmonybrew/bin
node -v               # 必须 ≥ v20.12
```

想要指定大版本用 `brew install node@22`（**keg-only**，不会自动 link，需要手动加 PATH）：

```sh
export PATH=/storage/Users/currentUser/.harmonybrew/opt/node@22/bin:$PATH
```

> **为什么专门强调版本**：dsh 的 `package.json` 里**没有声明 `engines`** ——
> npm 会把 dsh 装到老 Node 上而不报错，然后在启动时炸出 `SyntaxError: util.parseEnv`。
> 看到这个错，第一件事就是查 `node -v`。

顺带一提，harmonybrew 里 `python`(3.12–3.14)、`openjdk@21`（21.0.12.1）、`jq`/`wget`/`rg`/`fd`/`tmux`/`htop`
等都有 `arm64_ohos` bottle，需要什么直接 `brew install` 即可（`openjdk` 实测 JIT 正常）。

---

## 四、拿 dsh 的鸿蒙包

有两种来源，任选其一。

### A. 自己构建（可复现，推荐）

**除了 node，构建还要几个命令行工具**（`brew install node` 只给 node + npm/npx）：

| 命令 | 谁在用 | 不给会怎样 |
|---|---|---|
| **`pnpm`** | `fetch-dsh.mjs` 用它拉官方 `@deepseek-ai/dsh` | `pnpm: command not found`，构建直接失败 |
| `zip` / `unzip` | `build-dsh.mjs` 打产物 zip；`stage.mjs` 解压校验 | 打不出包 / 解不开 |
| `git` | **只有你想用命令行克隆仓库时才需要**（见下）| `git: command not found` |

```sh
brew install pnpm zip unzip
```

> `pnpm` 也可以用 npm 装（`npm i -g pnpm`）—— 但既然都用 harmonybrew 了，`brew install pnpm` 更一致。
> 另外 `fetch-dsh.mjs` 留了逃生口：`PNPM_CMD="node /path/to/pnpm.cjs" node scripts/build-dsh.mjs …`。

**取仓库二选一：**

```sh
# a) 命令行克隆 —— 需要 git
brew install git
git clone https://gitcode.com/chen-qiongmeng/dsh-harmony.git
cd dsh-harmony
```

**b) 下载（推荐，连 git 都不用装）**：打开 <https://gitcode.com/chen-qiongmeng/dsh-harmony>
页面点「克隆/下载」拿 zip，解开后 `cd` 进去即可。

然后构建：

```sh
cd dsh-harmony
node scripts/build-dsh.mjs 0.2.0-rc.2 --out /storage/Users/currentUser/Documents/dsh/dsh-ohos-0.2.0-rc.2.zip
```

脚本会用 pnpm 拉官方 `@deepseek-ai/dsh` 再做替换/补资产（首次 1–2 分钟），
跑完会打印产物大小并**自检**（13 个替换文件、rg shim、图片后端、`bin/dsh`）。

### B. 用现成的 zip

```sh
unzip dsh-ohos-0.2.0-rc.2.zip -d /storage/Users/currentUser/Documents/dsh/
```

> **仓库里为什么不放 zip**：65 MB，而且 `.gitignore` 明确排除了 `dsh-ohos*.zip`。
> 分发走网盘 / Release 附件 / 直接传文件都行。

解压后目录应当是这样（`bin/dsh` 是命令行入口，`VERSION` 里是版本号）：

```
/storage/Users/currentUser/Documents/dsh/dsh-ohos-0.2.0-rc.2/
├── bin/dsh
├── VERSION
└── node_modules/…
```

---

## 五、起服务

```sh
export PATH=/storage/Users/currentUser/.harmonybrew/bin:$PATH
/storage/Users/currentUser/Documents/dsh/dsh-ohos-0.2.0-rc.2/bin/dsh web --no-open --port 32200
```

看到这一行就成了：

```
dsh web: http://127.0.0.1:32200/?token=XXXXXXXX
```

> ⚠ **别在它前面加 `node`。** `bin/dsh` 是个 **shell 脚本**（`#!/bin/sh`），直接执行即可；
> 写成 `node …/bin/dsh web …` 会让 node 去解析一个 shell 脚本，报
> `SyntaxError: Invalid or unexpected token`（脚本第 2 行的 `#` 注释对 JS 不是合法 token）——
> 这是最容易踩的一个误用。
>
> 不方便直接执行时（例如拷贝后丢了执行位），用 `sh …/bin/dsh web …` 也一样。

`bin/dsh` 已经替你做掉三件鸿蒙上必须的事，不用自己记：

| 它做了什么 | 为什么 |
|---|---|
| `--expose-internals` | dsh 启动器要拿 Node 内部模块 |
| `OPENSSL_armcap=0` | OHOS/arm64 上 OpenSSL 的 CPU 能力探测会让进程直接起不来 |
| `TMPDIR` 兜底 | 鸿蒙没有可写的 `/tmp` |

node 依次从 `PATH` → 包内 `node-bin` → 系统常见位置找，都找不到才报错，并会告诉你怎么办。

> 端口别和别的服务撞（有些应用会占 32100）。

---

## 六、浏览器打开

把上面打印的 URL（**要连 `?token=…` 一起**）粘进系统浏览器即可，首次启动会在 `~/.dsh/` 下建配置。

### ⚠ 账号 / 登录 UI 不会出现

dsh 的账号客户端插件第一行就是：

```js
if (!('dshDesktop' in globalThis)) return
```

纯浏览器表面下**整个账号 UI 都不注册**（侧栏没账号菜单、设置里没账号、模型页没登录入口）。
所以第一次要这样配模型：**在 `dsh web` 的 Models 页填 API key** ——
它会写进 `~/.dsh/settings.yaml` 与 `~/.dsh/.credentials.yaml`，之后就一直可用。

（若宿主注入了 `dshDesktop` 垫片，账号 UI 就会出现 —— 那是宿主侧集成的做法。）

---

## 七、常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `ls: …/.harmonybrew: Operation not permitted` | 当前环境不在 `file_manager` 组（典型：应用沙箱内）。换到有该组的环境执行 |
| `SyntaxError: util.parseEnv` | Node 太老（< 20.12）。`node -v` 确认，必要时 `brew install node` |
| `dsh: 找不到 node。装一个…` | PATH 里没有 node：先 `eval "$(brew shellenv)"`，或把 node 加到 PATH |
| `…/bin/dsh:2` + `SyntaxError: Invalid or unexpected token` | **在 `bin/dsh` 前面多写了 `node`**。它是 shell 脚本，直接执行（或 `sh …/bin/dsh …`）—— 见第五节 |
| 构建时 `pnpm: command not found` | **`brew install node` 只带 node/npm，不带 pnpm** → `brew install pnpm`（或 `npm i -g pnpm`）|
| `zip: command not found` / 解压失败 | 同上：`brew install zip unzip` |
| `git: command not found` | 只有用命令行克隆时才需要：`brew install git`。**不想装 git 就在仓库页面点「克隆/下载」拿 zip 解开** |
| `Error loading shared library libXXX.so` | 拿错了包 —— 那是 harmonybrew 装在**非默认前缀**下的 bottle 才会有的问题；本流程用的 dsh 包自带依赖，不该出现 |
| 网页打开报 401 | URL 少了 `?token=…`。token 每次启动都变，要重新复制 |
| 端口被占 | 换 `--port`（别和别的服务撞）|
| 侧栏终端报错 / 图片附件失败 | 你用的可能是 harmonybrew 官方那版 dsh（缺 ohos pty prebuild、缺图片后端）。换成本仓库的包 |

---

## 八、实测记录（2026-09-30）

环境：HarmonyOS 7.0.0.107(SP7)，harmonybrew 装在默认前缀，`brew install node` → **v26.10.0**，
包为本仓库 `0.2.0-rc.2`（含 flock 打桩、无自造平台包）。

```
== 环境 ==
node      : /storage/Users/currentUser/.harmonybrew/bin/node  v26.10.0    ← 用的就是 brew 的 node
bin/dsh   : 在（可执行）
flock.js  : 1 处打桩        平台包: 已删（符合预期）

== bin/dsh web ==
dsh web: http://127.0.0.1:32114/?token=…                                  ← 服务起来了
```

同一组合还在 BitFun 环境里跑过一次（`node=v26.10.0  pkg=ok  pty=ohos-ok`），结果一致。
