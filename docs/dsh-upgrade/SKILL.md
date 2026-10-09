<!-- 归档说明（2026-10-10）：本文件原为沙箱用户级 skill `dsh-upgrade`
     （$DSH_HOME/skills/dsh-upgrade/），已从运行时移除、归档于此。
     它讲的是**壳侧**把某个版本的 dsh 适配到 HarmonyOS 并实测的流程（含验收 7 步）；
     dsh 侧的改造清单权威文件仍是 <版本>/CHANGES.md。 -->

---
name: dsh-upgrade
description: 把某个版本的 dsh 适配到 HarmonyOS（openharmony-arm64）并验证它真能启动。当需要换 dsh 版本、按改造清单适配、或排查 dsh 起不来时使用。
---

> **职责边界**：dsh 侧的改造与打包在 [dsh-harmony](https://gitcode.com/chen-qiongmeng/dsh-harmony) 仓库（每版一个版本目录 + 独立 `scripts/`）；
> 本技能只管**壳侧**的适配、装入与验证。

# 适配 / 升级 dsh（HarmonyOS）

> **来源说明**：本文件原为沙箱用户级 skill `dsh-upgrade`，放在 `$DSH_HOME/skills/dsh-upgrade/`
> （user-dsh 根，rank 400；dsh 监视这个根，**放进去即时生效**）。2026-10-10 起从运行时移除、
> 归档到此，作为**壳侧升级流程**的参考 —— dsh 侧的改造清单权威文件仍是 `<版本>/CHANGES.md`。


把一个版本的 dsh 改到能在鸿蒙上跑起来：**取新版 → 按改造清单适配 → 产出包 → 另起进程实测**。
本 skill 只讲 **dsh 本身**的适配，不涉及承载它的应用。

> ⚠ **本 skill 与 `reference.md` 只是参考** —— 列出的是「已知改动」，**不等于适配成功**；
> 而且 **`reference.md` 只对它的标题里那个版本成立，每个版本的改造都可能不一致**
> （上游会改、改动可能失效或需要换做法）。升级时**逐版本重新核对、重放、重写**，别照抄。
> 每次改完，**必须另起一个独立进程实测**（见[验收](#验收必做别只看改完文件)），确认真能起来、能跑通。

## 约定

| 项 | 值 / 规则 |
|---|---|
| 目标平台 | `openharmony-arm64`（`process.platform === 'openharmony'`） |
| 改造形态 | **整文件替换**（`<版本>/files/`，保留包内相对路径）+ 随包资产（图片后端 / 原生平台包 / `bin`）—— 不再对构建产物打 patch |
| 产物 | 一个含 `node_modules/` 的包目录（顶层目录名 `dsh-<版本>`），打成 `dsh-ohos-<版本>.zip` |
| 启动命令 | `node --expose-internals <包>/node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open --port <端口>` |
| 入口为什么不用 `node_modules/.bin/dsh` | `node_modules/.bin/dsh` 内部 `import("./profile-boot.js")` 是**相对路径**，而鸿蒙沙箱里的 `.bin` 是**平铺**目录 → 解析失败。壳固定直接用 `.../@deepseek-ai/dsh/lib/bin.js` |
| `--expose-internals` | **不能少**：`require-builtin` 在鸿蒙上是纯 JS 适配，靠 `require('internal/*')` |
| `DSH_HOME` | 必须放在**权限位能设成 600** 的位置（共享盘固定 660，放那儿 dsh 的凭据插件起不来） |
| `DSH_PERMISSION_MODE` | 鸿蒙无 bwrap/landlock，用 `danger-full-access` |
| `TMPDIR` | 壳注入，**必需**：spill / 子进程临时目录走 `os.tmpdir()`，丢了会在**插件装载期**就抛错（退回只读 `/tmp` → EROFS） |

## 流程

1. **新建版本目录**：在 dsh-harmony 里 `mkdir <新版本>/`，拷一份上一版的 `scripts/` 按需改
   （**每个版本自带独立脚本**；确实共用的放顶层 `scripts/`，别的版本要用就 import 它的路径）。
2. **取官方包**：`node scripts/fetch-dsh.mjs <新版本>` —— 按 `pnpm-lock.yaml` 精确装出官方树到
   `work/<版本>/`（`--ignore-scripts --node-linker=hoisted`；原生模块在沙箱里编译不了）。
3. **按清单适配**：读 **`<新版本>/CHANGES.md`**（权威清单；升级用的自包含副本是**本 skill 同级**的
   [`reference.md`](./reference.md)），把它当**起点而不是答案** ——
   **逐条核对**在新版本上还成不成立、要不要换做法，上游已修的就删掉。
   改动落成 `<新版本>/files/` 下的整文件替换，并在 `manifest.json` 的 `replace` 里记
   **官方原文件与改造版的 sha256**；资产（jimp 闭包 / OHOS 平台包 / `bin`）放对应目录并在 manifest 登记。
4. **产出包**：`node scripts/build-dsh.mjs <新版本> [--out <zip>]`
   （校验官方树 → 替换 → 资产 → `bin` → 打包 → 自检）。
5. **验收**（见下，必做）。
6. **写说明并同步**：`<新版本>/CHANGES.md` 按本次实际改动重写（别沿用上一版）；
   本 skill 的 `reference.md` 同步更新；**在壳仓库跑 `sh scripts/check-dsh-docs.sh`** 确认
   「manifest ↔ 两份文档 ↔ 壳版本」一致（版本在 `entry/src/main/ets/common/PkgVersion.ets` 的 `DSH_VERSION` 一行）。

## 验收（必做，别只看「改完文件」）

**文件改对了、包装好了，都不算适配成功。** 必须**另起一个独立进程**实测：

1. **起临时实例**：换个端口（如 `--port 32101`），并尽量在干净环境里起
   （新目录 + 干净 `DSH_HOME`），模拟一次「首装」。
2. **确认进程活着**：起完进程还在，日志里出现 `dsh web: http://127.0.0.1:<port>/?token=…`。
3. **确认服务可用**：按日志里的 URL 请求一次，页面返回 200
   （dsh 用 cookie 认证：先带 token 访问拿 cookie，再访问 `/`）。
4. **跑一次最小任务**：真让它干一件小事（如 `--profile headless "1+1"`），确认 agent 链路通。
5. **能力抽查**（用到对应改造才查）：`grep` / `glob` 工具能出结果（不报 `ripgrep launch failed`）；
   `write` 工具能往共享盘（`/storage/Users/...`）写**新文件**（不报 `EPERM … link`）。
6. **看有没有报错**：日志里不能有 `plugin tree failed to load`、`Cannot find module`、
   `[execve 失败] errno=…`、`Error loading shared library` 这类硬错误。
7. **收尾**：停掉临时实例、删掉临时目录，别留后台进程。

这 7 步全过，才算「适配成功」。装进壳之后再跑一次 `sh scripts/check-dsh-runtime.sh`（只读自检）。

## 出包与试跑（固定约定，2026-09-30 起）

**dsh 一有改动，先在设备的终端里跑起来验证，别直接换内置包** —— 内置包是安全网：

1. **出包**（在 dsh-harmony 仓库根）：
   ```sh
   node scripts/stage.mjs <版本>          # 换位置：--out-dir <目录>；不重新打包：--no-build
   ```
   它做四件事：打包 → 拷贝**带版本号的 zip** 到 `Documents/dsh/`（**上传 Release 用**）→
   解压出**同版本目录**（同名目录**先删再解压**，不让新旧混着）→
   补执行位（rg shim 与 `node_modules/.bin`）→ 自检。
2. **试跑：设备终端 + 浏览器**（详见 dsh-harmony 的 `docs/在鸿蒙上跑-dsh.md`）：
   ```sh
   export PATH=$HOME/bin:$HOME/node:$PATH
   /storage/Users/currentUser/Documents/dsh/dsh-ohos-<版本>/bin/dsh web --no-open --port 32200
   # 浏览器打开它打印的 URL（连 token 一起）；**别加 node** —— bin/dsh 是 shell 脚本
   ```
   这条路**完全不碰壳**：跑坏了，手机上正在用的 dsh 一点事没有 —— 比当年那套"外挂包"还安全，
   而且省掉一次装 hap。
3. **确认没问题了**，才把 `PkgVersion.ets` 的 `DSH_VERSION` 改到新版本、`sh scripts/build-hap.sh` 重出 hap，
   装到设备上之后再跑一次 `sh scripts/check-dsh-runtime.sh`。

**为什么**：内置包换错 = 装完壳起不来，而 **dsh 起不来时没法用 dsh 自救**（会话直接没了）。
先在终端跑一遍，等于把风险留在壳外面。

> 壳侧注：壳里原来有个「编辑启动命令」（外挂包）入口，2026-09-30 **已移除** ——
> 有了上面这条终端 + 浏览器路线，没必要在壳里切包，也不必为试跑装一次 hap。

**hap 产物不外拷**：`build-hap.sh` 把产物留在
`entry/build/default/outputs/default/entry-default-{signed,unsigned}.hap`
（要另外拷一份用 `--out <目录>`）；建议改名为 `...-dsh<dsh版本>.hap` 以便区分是哪版内核出的。

**出包后必查**：hap 内 `rawfile/pkg/dsh-ohos.zip` 的**顶层目录名**必须与产物名里的 dsh 版本一致 ——
`build-hap.sh` 有「dsh 打包失败就沿用现有 zip」的 fallback，**名不符实过一次**
（0.1.7 的 `bin/` 资产哈希没刷新 → 打包失败 → 沿用上次 0.2.0 的 zip，于是 `-dsh0.1.7-rc.2.hap` 里装的其实是 0.2.0）。

## 起不来的常见原因（先查这些）

- 少了启动参数 `--expose-internals`；
- `node-addon-require-builtin` 没换成纯 JS 实现 → host preparation 阶段直接失败
  （`Cannot find module 'internal/modules/esm/loader'`）；
- 需要 flock 的流程 → `@deepseek-ai/node-addon-system` 白名单没放行 `openharmony`、或缺平台包；
- 二进制缺 `.codesign` 段 → `Error loading shared library`；缺执行位 → `execve` errno=13；
- `DSH_HOME` 在权限位固定 660 的位置 → 凭据插件起不来。

## 不要做

- 不要拿「文件改好了」「包装上了」「上次能跑」当验证 —— 必须当前版本、当前环境实测；
- 不要把版本差异散落到别处 —— 一律收敛到 dsh-harmony 的**版本目录**里
  （`files/` + `manifest.json` + `CHANGES.md`），两个仓库的分工见 README。
