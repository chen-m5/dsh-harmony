# dsh-harmony

**DeepSeek Harness（dsh）的 HarmonyOS / OpenHarmony 适配层**：改造过的文件 + 图片处理后端 + 新增插件 + 打包脚本。

- 上游：`@deepseek-ai/dsh` **0.2.0-rc.2**（MIT）
- **本仓库不含 dsh 源码**：打包时用 pnpm 拉官方包，再按版本目录里的清单做替换/新增 —— 仓库只有几 MB，且"我们改了什么"一目了然。

两种用法，按你的场景挑：

| 用法 | 适合 | 看哪 |
|---|---|---|
| **在 HMDSH 里用 dsh**（图形壳，推荐） | 想在设备上有个开箱可用的 dsh：Web UI、设置面板、会话管理都由壳提供 | 「二、在 HMDSH 里使用」 |
| **命令行自己起 dsh** | 想在设备终端里直接跑 dsh 本体、自己管进程 | 「一、命令行在设备上跑起来」 |

---

## 一、命令行在设备上跑起来

想在设备的终端里直接起 dsh？三步：

```sh
# 1) 装 harmonybrew（Homebrew 的鸿蒙移植）+ node（需要 ≥ 20.12）
zsh -c "$(curl -fsSL https://harmonybrew.atomgit.com/install.sh)"
eval "$(~/.harmonybrew/bin/brew shellenv)"
brew install node

# 2) 拿本仓库的鸿蒙包
#    最快：到 Release 下载 dsh-ohos-<版本>.zip，解开即可
#      https://gitcode.com/chen-qiongmeng/dsh-harmony/releases
unzip dsh-ohos-0.2.0-rc.2.zip -d ~/dsh-ohos/
#    或者自己构建（要多装几个工具；取仓库可 git clone，也可页面点「克隆/下载」）
# brew install pnpm zip unzip
# git clone https://gitcode.com/chen-qiongmeng/dsh-harmony.git && cd dsh-harmony
# node scripts/build-dsh.mjs 0.2.0-rc.2 --out ~/dsh-ohos/dsh-ohos-0.2.0-rc.2.zip

# 3) 起服务，把打印出来的 URL（带 token）粘进系统浏览器
~/dsh-ohos/dsh-ohos-0.2.0-rc.2/bin/dsh web --no-open --port 32200
#   → dsh web: http://127.0.0.1:32200/?token=…
```

⚠ 请在**设备的终端里**跑（别把命令放进应用内部执行）——
应用沙箱读不到 `.harmonybrew`，会报 `Operation not permitted`，`chmod 777` 与软链都绕不过去。

完整说明（权限前提、拿包、常见问题、实测记录）见
**[docs/在鸿蒙上跑-dsh.md](docs/在鸿蒙上跑-dsh.md)**。

> 目录选择器（「创建工作区」）**跟随上游行为，本仓库不做限制**；
> 若被收窄在某个目录里，那是宿主应用加的限制。

## 二、在 HMDSH 里使用

**HMDSH** 是承载 dsh 的 HarmonyOS 应用（图形壳）：它内置一份已经适配好的 dsh 包，装好就有 Web UI、
设置面板、会话管理，不用自己在终端里起服务、管进程。

### 装与起

1. 装 HMDSH，启动它；
2. 在它的「设置 → dsh 控制」里启停 dsh（Web UI 端口默认 `32100`，以你的配置为准）；
3. **要试 dsh 侧的改动**：别重启正在用的实例 —— 另起一个临时进程，用**独立的 `DSH_HOME`** 和空闲端口，
   确认无报错后停掉并释放端口，再让正式实例重启。

### 建议装的三个 skill（**不随包**，从本仓库取）

dsh 的 skill 有两个根：

| 根 | rank | 谁维护 |
|---|---|---|
| `<沙箱>/files/skills/` | 600 | 随 HMDSH 一起分发（它启动时注入） |
| `<沙箱>/files/dsh-home/skills/` | 400 | 用户目录（dsh 里的 `$DSH_HOME/skills`），**放进去即时生效** |

下面三个 skill 刻意**不随包**，源码就在本仓库 `skills/` 下 —— 它们讲的都是**跑起来之后才会踩到的事**，
跟着实测环境走（装了新工具、发现某句说明过时就要改），打进应用等于每修一句话都要重装一次：

| skill | 干什么 |
|---|---|
| [`dsh-shell`](skills/dsh-shell/SKILL.md) | 这个沙箱长什么样：目录布局、壳提供了什么、能力边界（哪些命令有 / 没有）、`DSH_*` 变量的传递规则 |
| [`harmonybrew`](skills/harmonybrew/SKILL.md) | 缺工具怎么装：Homebrew 的鸿蒙移植、`brew install`，以及装完**必须补一个 `files/bin/<工具>` 包装脚本**（bottle 的 rpath 写死在上游 prefix，裸跑会报缺共享库）、已装工具清单 |
| [`dsh-plugin-install`](skills/dsh-plugin-install/SKILL.md) | 给 dsh 装 / 更新 skill 或插件的流程：先导出用户目录留退路 → 装 → 重启验证 → 失败用归档回滚 |

**怎么装：把仓库拿到设备上，然后交给 dsh 自己装。**

```sh
# 在设备的终端里（arm64 的 git，装法见 docs/在鸿蒙上跑-dsh.md）：
git clone https://gitcode.com/chen-qiongmeng/dsh-harmony.git
```

接着**在 dsh 里对它说一句**就行：

> 把 `<仓库路径>/skills/` 下的 `dsh-shell`、`harmonybrew`、`dsh-plugin-install` 装到用户 skill 目录

dsh 会自己把这三个目录拷到用户 skill 根（`$DSH_HOME/skills/`，沙箱里是 `<沙箱>/files/dsh-home/skills/`）。
那个根是**实时扫描**的：装完即时生效，**不用重启 dsh，也不用重装 HMDSH**。
（`harmonybrew` 的安装脚本 `install-harmonybrew.mjs` 跟 skill 放在一起，别漏。）

### 其他可选组件

| 组件 | 位置 | 说明 |
|---|---|---|
| `session-memory` | 本仓库 [`session-memory/`](session-memory/README.md) | 跨会话检索（MCP 工具 + skill）：让 dsh 能回查"以前说过 / 做过什么"。索引跑在 dsh 进程之外，库在沙箱本地 |

---

## 目录

```
scripts/                    顶层：**共用件**
  fetch-dsh.mjs             薄转发入口 → <版本>/scripts/fetch-dsh.mjs
  build-dsh.mjs             薄转发入口 → <版本>/scripts/build-dsh.mjs
  verify-dsh.mjs            薄转发入口 → <版本>/scripts/verify-dsh.mjs
  trim-jimp.mjs             通用工具：裁剪 jimp 依赖闭包
<版本>/                     **每个 dsh 版本一套，互不影响**（当前 0.2.0-rc.2/）
  scripts/                  ★ 这一版**独立**的脚本（权威实现；下个版本可能不一样）
  patches/                  ★ 这一版**独立**的补丁留档（+ jimp-deps.json）
  manifest.json             上游版本 + 替换/资产清单 + sha256 校验基线
  files/                    ★ 改造过的文件（保留包内相对路径，如 node_modules/@deepseek-ai/<包>/lib/x.js）
  image-backend/            ★ 图片后端（jimp 依赖闭包，替换掉 OHOS 上用不了的 sharp）
  native/                   ★ OHOS(openharmony-arm64) 平台专用包（公共 registry 上没有；现只剩 rg shim）
  bin/                      ★ 顶层 bin/（bash shim，运行时用）
  plugins/                  ★ 新增/替换的 dsh 插件（每插件一目录 + plugins.json）
  CHANGES.md                ★ 这个版本改了什么、为什么
skills/                     **给 dsh 装的 skill**（不随应用分发，装着三个：dsh-shell / harmonybrew / dsh-plugin-install）
session-memory/             **可选组件**（不参与打包）：dsh 的跨会话检索 —— MCP 工具 + 使用纪律 skill
```

约定：**每个版本自带独立脚本**；确实共用的东西放顶层 `scripts/`，其它版本要用就 **import 它的路径（引用，而不是复制）**。

## 用法

```sh
node scripts/fetch-dsh.mjs 0.2.0-rc.2      # 拉官方包到 work/0.2.0-rc.2/（需要 pnpm）
node scripts/build-dsh.mjs 0.2.0-rc.2      # 出 dsh-ohos.zip（需要 zip；顶层目录 dsh-ohos-0.2.0-rc.2/）
node scripts/verify-dsh.mjs dsh-ohos.zip
```

> **前置**：`node`（≥ 20.12）、**`pnpm`**（用它拉官方包）、`zip`（打包）、`unzip`（stage 解压）。
> 光装 node 是**不够**的 —— 这些在 harmonybrew 里都是单独的包：`brew install pnpm zip unzip`
> （`git` 只在 clone 仓库时才需要）。`pnpm` 也可以用 `npm i -g pnpm` 装。

## 许可与免责

上游以 MIT 发布（见 `LICENSE`）；本仓库的改造与脚本同样以 MIT 提供，并保留上游版权与许可声明。
这是**非官方**移植，与 DeepSeek 官方及其关联公司无隶属或合作关系，未获其赞助或背书。

## 反馈 / 下载

- **下载 zip 包**：<https://gitcode.com/chen-qiongmeng/dsh-harmony/releases>
- **提 Issue**（跑不起来、要适配新版本、发现问题）：<https://gitcode.com/chen-qiongmeng/dsh-harmony/issues>

## 清理中间产物

打包会在 `work/` 下留缓存（`work/<版本>/` 官方树、`work/.build-<版本>/` 构建副本，合计约 900 MB），
它们**可以随时删**；下次 build 会发现官方树不在、**自动 fetch** 一次（按 `pnpm-lock.yaml`，约 10 秒）：

```sh
node scripts/build-dsh.mjs <版本> --clean     # 只清理，不构建
```
