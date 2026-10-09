# dsh-harmony

**DeepSeek Harness（dsh）的 HarmonyOS / OpenHarmony 适配层**：改造过的文件 + 图片处理后端 + 新增插件 + 打包脚本。

- 上游：`@deepseek-ai/dsh` **0.2.0-rc.2**（MIT）
- **本仓库不含 dsh 源码**：打包时用 pnpm 拉官方包，再按版本目录里的清单做替换/新增 —— 仓库只有几 MB，且"我们改了什么"一目了然。

## 在鸿蒙设备上跑起来（命令行 + 浏览器）

想在设备的终端里直接起 dsh？三步：

```sh
# 1) 装 harmonybrew（Homebrew 的鸿蒙移植）+ node（需要 ≥ 20.12）
zsh -c "$(curl -fsSL https://harmonybrew.atomgit.com/install.sh)"
eval "$(/storage/Users/currentUser/.harmonybrew/bin/brew shellenv)"
brew install node

# 2) 拿本仓库的鸿蒙包
#    最快：到 Release 下载 dsh-ohos-<版本>.zip，解开即可
#      https://gitcode.com/chen-qiongmeng/dsh-harmony/releases
unzip dsh-ohos-0.2.0-rc.2.zip -d /storage/Users/currentUser/Documents/dsh/
#    或者自己构建（要多装几个工具；取仓库可 git clone，也可页面点「克隆/下载」）
# brew install pnpm zip unzip
# git clone https://gitcode.com/chen-qiongmeng/dsh-harmony.git && cd dsh-harmony
# node scripts/build-dsh.mjs 0.2.0-rc.2 --out /storage/Users/currentUser/Documents/dsh/dsh-ohos-0.2.0-rc.2.zip

# 3) 起服务，把打印出来的 URL（带 token）粘进系统浏览器
export PATH=/storage/Users/currentUser/.harmonybrew/bin:$PATH
/storage/Users/currentUser/Documents/dsh/dsh-ohos-0.2.0-rc.2/bin/dsh web --no-open --port 32200
#   → dsh web: http://127.0.0.1:32200/?token=…
```

⚠ 请在**设备的终端里**跑（别把命令放进应用内部执行）——
应用沙箱读不到 `.harmonybrew`，会报 `Operation not permitted`，`chmod 777` 与软链都绕不过去。

完整说明（权限前提、拿包、常见问题、实测记录）见
**[docs/在鸿蒙上跑-dsh.md](docs/在鸿蒙上跑-dsh.md)**。

> 目录选择器（「创建工作区」）**跟随上游行为，本仓库不做限制**；
> 若被收窄在某个目录里，那是宿主应用加的限制。

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
session-memory/             **可选组件**（不参与打包）：dsh 的跨会话检索 —— MCP 工具 + 使用纪律 skill
HMDSH.md                    **壳（HMDSH）使用说明**：装与起、该装哪几个 skill、为什么它们不随包
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
