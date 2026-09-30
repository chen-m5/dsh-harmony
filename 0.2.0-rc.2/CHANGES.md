# dsh 改造记录（0.2.0-rc.2）

> **本文件是 dsh 侧改造的权威清单。** 只记 **dsh 本身**的改动，不涉及承载它的鸿蒙壳（HMDSH）。
> 壳侧内容（ArkTS、运行时、会话/设置 UI、打出 hap）在壳仓库：
> <https://gitcode.com/chen-qiongmeng/dsh-harmonyos-app>。
>
> **升级 dsh 版本时**：先读壳仓库的
> [`skills/dsh-upgrade/SKILL.md`](https://gitcode.com/chen-qiongmeng/dsh-harmonyos-app/blob/master/skills/dsh-upgrade/SKILL.md)
> （流程与验收 7 步），再回来逐条核对本文件；
> 其中「改造清单」一节在壳侧有一份**升级用的自包含副本**
> [`skills/dsh-upgrade/reference.md`](https://gitcode.com/chen-qiongmeng/dsh-harmonyos-app/blob/master/skills/dsh-upgrade/reference.md)
> —— **改这里就要同步改那里**（同步检查：壳仓库 `sh scripts/check-dsh-docs.sh`）。

| 项 | 值 |
|---|---|
| 上游 | `@deepseek-ai/dsh` **0.2.0-rc.2**（MIT） |
| 改造形态 | **13 个文件整文件替换** + 4 类随包资产（不是 patch 重放） |
| 本仓库不含 | dsh 源码、dsh 包体 —— 打包时用 pnpm 拉官方包，再按本清单替换/新增 |
| 上次更新 | 2026-09-30（从 0.1.7-rc.2 升上来，含真机验收） |

## 一、运行方式（dsh 自身）

与 0.1.7-rc.2 **完全一致**，本次升级没有变化：

| 项 | 值 |
|---|---|
| 启动命令 | `node --expose-internals <包目录>/node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open --port <端口>` |
| 入口为什么不用 `node_modules/.bin/dsh` | `node_modules/.bin/dsh` 内部 `import("./profile-boot.js")` 是**相对路径**，而鸿蒙沙箱里的 `.bin` 是**平铺**目录 → 解析失败。壳固定直接用 `.../@deepseek-ai/dsh/lib/bin.js` |
| `--expose-internals` | **不能少**：`require-builtin` 在鸿蒙上是纯 JS 适配，靠 `require('internal/*')` |
| `DSH_HOME` | 壳给。**必须在权限位可设成 600 的位置**（共享盘挂载固定 660，放那儿 dsh 的凭据插件起不来） |
| 权限模式 | `DSH_PERMISSION_MODE=danger-full-access`（鸿蒙无 bwrap/landlock；切回 `workspace-write` 会让共享盘整片不可写） |
| `TMPDIR` | 壳给。**必需**：spill / 子进程临时目录都走 `os.tmpdir()`，丢了会退回只读的 `/tmp`，`mkdtempSync` 直接 EROFS，**在插件装载期就抛错** |

## 二、改造清单

### 2.1 本次升级与上一版的关系（2026-09-30 实测）

拿 `work/0.1.7-rc.2/`（上一版官方树）与 `work/0.2.0-rc.2/`（本次官方树）逐文件 `cmp`：

| 类别 | 数量 | 处理 |
|---|---|---|
| 官方内容**逐字节未变** | **11** | 上一版的 `files/` 那份**原样复用**（改动基于的官方内容没变） |
| 官方内容**变了** | **2** | `dsh-client-ui-conversation/lib/client.js`、`dsh-client-ui-settings-account/lib/client.js` —— 按**新版官方内容**重新应用我们的改动（改动落点都还在，见 2.4） |
| 随包资产（4 类） | — | **全部原样复用**，依据见 2.3 的版本比对 |

> **上游依然不支持 openharmony**：`native/system/docs/support-matrix.md` 只列
> `linux-x64/arm64`（glibc+musl）与 `darwin-x64/arm64`；全仓库 grep `openharmony` = **0 处**。
> 所以「纯 JS 垫片 + 平台白名单 + 自造平台包」这三条**一个都不能少**。

### 2.2 替换的 13 个文件（= `files/`，保留包内相对路径）

`manifest.json` 的 `replace[]` 逐项记着**官方原文件 sha256**（`upstreamSha256`）与**我们这份 sha256**；
`build-dsh.mjs` 每次打包前校验「官方树确实是官方原样」，不符就**报错停下**。

| # | 文件（`node_modules/` 下） | 改了什么 | 必需性 |
|---|---|---|---|
| 1 | `node-addon-require-builtin/lib/index.js` | 换成**纯 JS 实现**（`createRequire` + `requireBuiltin`/`isAllowedInternalId`/`getBindingInfo`），替代预编译 addon；配合 `--expose-internals` | **必需**（不换起不来：host preparation 阶段直接失败） |
| 2 | `@deepseek-ai/node-addon-system/lib/flock.js` | 在**官方原版**上加一段：`platform === 'openharmony'` 时 `tryLock` **直接桩成立即成功**（只保留进程内写声明，放弃跨进程排他）。理由：鸿蒙上 `flock(2)` 与 hmdfs 的锁在这套内核/沙箱模型下都不可靠 —— 上游 browser worker 也是这么桩掉这个入口的，取舍一致 | **必需**（headless 硬前置；`web` 走到加锁路径同样需要） |
| 3 | `@deepseek-ai/dsh-attachment-local/lib/index.js` | ① **fsync 边界** —— `ensureDurableHome()` 从 `DSH_HOME` 逐级 fsync 到 `/`，沙箱里 `/data/storage/el2`（及 `/data/storage`、`/data`）不可读 → `EACCES`，整次附件准入失败；改成遇到 `EACCES`/`EPERM` 就当持久边界。② **无 sharp 时的图片后端** —— `sharp` 在 openharmony-arm64 上没有任何平台二进制，`require` 直接抛错；补两层（头部嗅探 + 精简 Jimp）：PNG/JPEG 真解码校验、EXIF 定向、按预算缩放重编码，WebP/GIF 走头解析原样透传；Jimp 只当**增强不当闸门** | **必需**（不补：附件存不下来、图片全废） |
| 4 | `@deepseek-ai/dsh-api-session-controller/lib/index.js` | **别吞真因**：`prompt()` 的兜底 catch 把非 `RemoteError`/`AttachmentError` 都转成 `session/agent-busy, "prompt rejected"`，真因只塞进 `details.reason`（前端不显示）。改成 `console.error` 记日志并把原文带进消息：`prompt rejected (cause: …)` | **必需**（否则准入类故障没法定位） |
| 5 | `@deepseek-ai/dsh-client-ui-conversation/lib/client.js` | **图片类型判定只信浏览器**：`isImageMediaType()`/`imageMediaType()` 只认四个精确串，而 ArkWeb 给的 `file.type` 可能是空/`application/octet-stream`/旧别名（`image/jpg`、`image/x-png`）。补：① 别名归一；② 声明不可信时按**文件头魔数**识别 | **必需**（容器适配） |
| 6 | `@deepseek-ai/dsh-client-connection/lib/client.js` | **loopback 页面不跟随浏览器联网状态**：`stopNetworkWatch: handle.isLoopback ? () => {} : watchBrowserNetwork(controller)`。ArkWeb 的 `navigator.onLine`/`offline` 不可靠，一旦报离线，重连循环 `emitState("disconnected")` 后**无限期停住** —— 而页面本身就是 `127.0.0.1` 的本机服务 | **必需**（容器适配；不补要用户手点重连） |
| 7 | `@deepseek-ai/dsh-client-ui-settings-account/lib/client.js` | ① **登录授权链接交给宿主壳** —— 钩在插件的**状态流循环**里（`for await (const frame of stream)`），拿到新 `authorizeUrl` 就调 `globalThis.dshShell.openLogin(url)`；放在 `startSignIn` 返回之后**无效**（那时 URL 还没到）。② **余额条** —— 账号启动器上方显示「充值余额 / 赠金余额」+ ↻ 刷新（挂载时拉一次、刷新有转圈反馈、赠金为 0 也显示、颜色走主题变量） | 体验 |
| 8 | `@deepseek-ai/dsh-fs-local/lib/index.js` | no-clobber 发布用 `link(2)`，**共享盘（hmdfs）不支持硬链接** → `write` 工具报 `EPERM … link`。命中 `EPERM`/`EOPNOTSUPP`/`ENOSYS`/`EXDEV` 时降级 `rename`；目标已存在仍按原语义报错 | **能力**（不补则 `write` 写不进共享盘） |
| 9 | `@deepseek-ai/dsh-client-ui-directory-picker-browse/lib/client.js` | 摘除面包屑行尾的「编辑路径」铅笔按钮（路径只能逐级点选） | 产品定制 |
| 10 | `@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.js` | 预览不再被 `meta.status="none"` 拦（`canRead=true`）、加载态加刷新按钮 | 产品定制（代价：缺 `version`/`absolutePath`，外部改动不再自动重载，用刷新按钮） |
| 11 | `@deepseek-ai/dsh-subprocess-local/lib/runner-launch-B2zsQ1Dz.js` | `process.platform` 在 OpenHarmony 上是 `"openharmony"`，而终端 inspector 只认 linux/darwin/win32 → 原来直接抛「terminal inspection is unsupported on platform openharmony」。改成**把 openharmony 与 linux 同等对待**（读 `/proc` 的 LinuxProcessInspector 在鸿蒙可用） | **能力**（不补侧栏终端报错） |
| 12 | `@deepseek-ai/dsh-client-ui-sidebar-terminal/lib/client.terminal.js` | 终端复制/粘贴改用鼠标与 Ctrl+V：选中后**单击右键=复制**、双击右键=粘贴、Ctrl+V=粘贴（走 Web 剪贴板，不占系统权限）；Ctrl+C 保持 SIGINT 不拦；底部显示操作提示 | 体验 |
| 13 | `@deepseek-ai/dsh-credentials-local/lib/index.js` | **owner-only 检查豁免 `openharmony`**：鸿蒙共享盘（hmdfs）挂载固定 660，`chmod 600` 不生效 → 原检查必然失败 → `credentials` 插件不激活 → **启动直接失败**。照上游给 `win32` 的豁免，同样豁免 `openharmony`（凭据文件仍只对 `file_manager` 组的应用可见）| **必需**（DSH_HOME 落在共享盘时）|

> 这 13 个都是**我们的改动**（不是官方内容）—— 升级时可用改动特征自查：
> `flock.js` 里的 `'openharmony'`、`dshShell.openLogin`、`js-shim`、
> `@jimp/core` 的懒加载在**官方原文件里都应该是 0 处**。

### 2.3 随包资产（官方树里没有，必须随版本目录自带）——本次全部原样复用

| 资产 | 内容 | 去向 |
|---|---|---|
| `image-backend/` | jimp 闭包 **270 个文件 / 约 2 MB**（`@jimp/core`、`js-png`、`js-jpeg`、`plugin-resize/rotate/flip` + 依赖闭包；与官方 npm 包逐字节一致，只裁掉 `*.d.ts`/`*.map`） | `node_modules/@deepseek-ai/dsh-attachment-local/node_modules/` |
| `native/` | OHOS 平台包 **2 个文件**：只剩 `@vscode/ripgrep-openharmony-arm64@1.18.0`（**rg shim**，纯 JS，按 dsh 实际 argv 实现 `--files`/`--json --regexp` 两种调用）—— **公共 registry 上 404**。<br>原先还有自造的 `@deepseek-ai/node-addon-system-openharmony-arm64@0.1.2`（flock 原生加载器），2026-09-30 随 flock 改成打桩**一并删除**（省掉交叉编译 + 签名 + 跟版本维护） | `node_modules/` |
| `bin/` | 壳要用的顶层 `bin/bash`（28 字节 shim：`exec /bin/sh "$@"`）—— 官方 npm 包**没有**顶层 `bin/` | 包顶层 `bin/` |
| `pty-backend/` | 为鸿蒙交叉编译的 `node-pty` 原生模块（自带 prebuilds 只有 darwin/linux/win32） | `node_modules/node-pty/prebuilds` |

**为什么能原样复用**（本次逐个比对版本，全部未变）：

| 依赖 | 0.1.7-rc.2 | 0.2.0-rc.2 |
|---|---|---|
| `node-pty` | 1.2.0-beta.15 | 1.2.0-beta.15 |
| `@vscode/ripgrep` | 1.18.0 | 1.18.0 |
| `sharp` | 0.35.5 | 0.35.5 |
| `@deepseek-ai/node-addon-system` | 0.1.2 | 0.1.2 |
| `node-addon-require-builtin` | 0.1.6 | 0.1.6 |

另有一处**改名**：pnpm（hoisted）给的是 `node_modules/.bin/`，而壳里用的是 `node_modules/bin/`（无点），
打包时改名/复制（12 个入口：`dsh`、`cordis`、`pi-ai`…）。打包脚本自动做。

### 2.4 升级必查的三处契约（本次结论：都不用改）

| 契约 | 为什么要查 | 本次实测 |
|---|---|---|
| `dsh-tool-fs-search` 调 rg 的 argv | `native/` 里的 rg 是 **shim**，只覆盖 dsh 实际用到的两种调用；argv 变了 shim 就废 → grep/glob 工具报 `ripgrep launch failed` | `dsh-tool-fs-search/lib/index.js` 与 0.1.7 **逐字节相同** → argv 未变，shim 直接可用 |
| `node-addon-system` 的入口契约 | 我们改的 `flock.js` 要跟得上上游 `loadBinding()` 的结构（打桩分支插在哪、`tryLock` 的签名） | 官方 `flock.js` 内容与 0.1.7 相同；**打桩实测通过**：`process.platform='openharmony'` 时 `tryLockExclusive(fd)` **立即 resolve（0 ms）**（懒加载 → 必须真调用才算验证）。自造平台包已不再需要 |
| `node-addon-require-builtin` 的 API 表面 | 我们的纯 JS 垫片要实现官方 addon 被用到的方法 | 官方内容未变；实测 `requireBuiltin('internal/modules/esm/loader')` 拿到 loader、`getBindingInfo()` 返回 `js-shim` |

> 0.2.0 新增的依赖（`got`/`http2-wrapper` 等纯 JS 包 + 5 个 `@deepseek-ai/*` 包、移除 `@aws-crypto`）
> 与 OHOS 适配**无关**：没有新增原生依赖，所以本次没有新增改造点。

### 2.5 上游「同名同版本重发」的 7 项仍在

第 1、6、8、9、10、11 项在 `manifest.json` 里额外带
`reason: 上游同名同版本重发后内容变了，用现役可跑的那份`。

> 第 2 项（`flock.js`）2026-09-30 改成"打桩"后，它的 `reason` 已换成打桩说明 ——
> 它仍然是**我们的改动**，但不属于"同名同版本重发"这一类了。
它们**同时也是我们的改造**（见 2.2），不能因为"上游已发布"就丢掉；
但也不能当"永远正确"照抄 —— **每次升级都要重新核对**，上游修好后就该去掉。
本次核对结论：这 7 项在新版的官方内容与 0.1.7 时相同，我们的版本仍适用。

## 三、产物与打包

产物 = 一个 zip（顶层目录 `dsh-ohos-0.2.0-rc.2/`，内含 `node_modules/`），由本仓库脚本产出：

```sh
node scripts/fetch-dsh.mjs 0.2.0-rc.2                 # 拉官方包（--ignore-scripts --node-linker=hoisted，按 pnpm-lock.yaml）
node scripts/build-dsh.mjs 0.2.0-rc.2 [--out <zip>]    # 校验 → 替换 → 资产 → bin → 打包 → 自检
node scripts/build-dsh.mjs 0.2.0-rc.2 --refresh-sha    # 改过 files/ 后刷新 manifest 的 sha256
node scripts/build-dsh.mjs 0.2.0-rc.2 --clean          # 清中间产物（work/ 约 1.2 GB，可随时删）
```

- **锁版本**：`pnpm-lock.yaml` 已随本目录入库，之后 `--frozen-lockfile` 精确复现。
- **校验**：manifest 存官方原文件与我们的**双份 sha256**（资产记整棵树的 `files`+`sha256`），不符即报错停下。
- **可反复跑**：build 在 `work/.build-<版本>/` 副本上做，`work/<版本>/` 永远官方原样。
- 壳侧：`sh scripts/build-hap.sh` 会自动调这里，产物写进壳的 `entry/src/main/resources/rawfile/pkg/`。

## 四、已知限制（dsh 侧）

- 「文件」侧边栏预览靠第 11 项绕过，代价是缺 `version` / `absolutePath`：外部改动不再自动重载（用刷新按钮）。
- rg shim 只覆盖 dsh 用到的 argv 子集；升级时按 2.4 复查 `dsh-tool-fs-search`。
- 0.1.5 及更早：`assertEntriesActivated` 会因原生模块缺失硬判整棵树死 —— **不要用**。

## 五、版本可用性记录（2026-09-30，真机实测）

| 项 | 结果 |
|---|---|
| 起临时实例（32101 + 干净 `DSH_HOME` + 独立包目录） | ✅ 进程存活，日志出现 `dsh web: http://127.0.0.1:32101/?token=…` |
| HTTP | ✅ 无 token **401** / 带 token **303**（发 cookie）/ 带 cookie **200**（34 KB 页面） |
| 最小任务 | ✅ `--profile headless "1+1 等于几？只回答数字"` → `2`（LLM + 会话 + 工具装载全通） |
| 能力抽查 | ✅ `require-builtin` 垫片拿到 `internal/modules/esm/loader`；rg shim（`--json --regexp` / `--files`）正常；jimp 闭包（core/js-png/js-jpeg/plugin-resize）可解析；`node-pty` 可加载。<br>（`flock` 原为「真加锁」，2026-09-30 起改为**打桩**：`tryLockExclusive(fd)` 在 `openharmony` 上立即 resolve，实测 0 ms） |
| `write` 工具写**共享盘**新文件 | ✅ 落地成功（无 `EPERM … link`） |
| 硬错误扫描 | ✅ 无 `plugin tree failed to load` / `Cannot find module` / `[execve 失败]` / `Error loading shared library` |
| 产物自检 | ✅ 65.1 MiB、25229 条目、13 个替换文件与图片后端 sha256 全中 |

对照：`0.1.7-rc.2` ✅ 起得来；`0.1.5-rc.3` ❌ `plugin tree failed to load`（原生模块缺失被硬判死）。

## 六、注意事项（踩过的坑）

- **同步到 VM 时，别让 `files/` 被当成依赖排掉**（2026-09-30 踩到，丢了一整轮提交）：
  `files/` 里是按**包内相对路径**存的改造文件（`files/node_modules/@deepseek-ai/…`），
  而 `dsh-sync.sh` 的默认排除清单里有 `--exclude=node_modules` —— 于是这些**源文件**被一起排掉，
  VM 上的 `files/` 一直是空的，几次提交全都缺了改造内容（因为构建都在鸿蒙侧做，一直没暴露）。
  已给 `node/dsh-harmony` 单独一套排除清单（只排 `work/`、`*.zip` 等构建产物）。
  **自查**：同步后到 VM 上 `find <版本>/files -type f | wc -l`，应等于 `manifest.json` 的 `replace` 项数。
- **重放改动时锚点要按「新版官方内容」对齐**：本次 `dsh-client-ui-settings-account` 那块 JSX 的缩进
  被上游整体多缩了一层（`AccountNoticeCard` 行由 4 个 tab → 5 个 tab），照抄旧缩进会匹配不上。
  做法：`diff -u work/<旧版本>/<文件> <旧版本>/files/<文件>` 得到我们的改动，再在新版里定位落点；
  新增代码块直接从旧版我们那份里**提取切片**，别手抄。
- `DSH_HOME` 必须在权限位能设成 600 的地方（见第一节）。
- node 及其依赖库、python 二进制都需要 `.codesign` 段（自签名），否则 `Error loading shared library`
  或 `symbol not found`。签名工具：`<SDK>/toolchains/lib/binary-sign-tool sign -selfSign 1 -inFile X -outFile Y -signAlg SHA256withECDSA`。
- 解压出来的文件默认没有执行位，需要补 `0755`（`execve` 失败 errno=13 就是它）。
- 装依赖必须 `--ignore-scripts`（沙箱里 `node-pty`/`koffi` 的 node-gyp 跑不了）
  + `--node-linker=hoisted`（布局对齐壳的解包方式）。
- 共享盘 `/storage/Users/...` **不支持硬链接**（`link(2)` 报 EPERM），但 `mv`/`cp`/追加写都可用；`/tmp` 只读。
- `koffi` 本次由 3.3.2 **降到 3.1.1**（上游依赖树变动）：它已改懒加载、非 Windows 路径不触碰，实测无影响。

## 七、变更沿革

- **0.2.0-rc.2 追加三（2026-09-30）**：把「目录选择器根限制」**从本仓库移到壳**（原第 9 项删除，改造数 14 → 13）。
  理由：那条限制的动机只来自"被应用托管" —— 避免用户一路选到沙箱内部那些看不见的路径；
  开源出去的包不需要它。现在**壳在打包时**用 `scripts/apply-dsh-patches.sh` 把补丁注入内置 zip
  （见壳仓库 `scripts/dsh-patches/`），本仓库的包跟随上游行为。

- **0.2.0-rc.2 追加二（2026-09-30）**：新增**第 14 项**改造 —— `credentials-local` 的 owner-only
  检查豁免 `openharmony`（共享盘固定 660、`chmod 600` 不生效，原来会直接卡住启动）。
  改造数 13 → 14。A/B 实测：打补丁的包正常起服务；把豁免改回 `if (false) return;` 则
  `startup failed: 1 required plugin did not activate / Failed plugins (1): credentials`。
- **本次（0.2.0-rc.2）**：13 项里 11 项官方未变直接复用，2 项按新版重放；4 类资产零改动
  （原生依赖版本全未变）；三处契约（rg argv / flock loader / require-builtin API）复查通过，无新增改造点。
- **0.2.0-rc.2 追加（2026-09-30 晚）**：`flock` 从「真加锁 + 自造平台包」**简化为打桩** ——
  参照 harmonybrew 的 dsh bottle（官方 npm 包 + 同一段打桩）。删掉 `native/` 里的
  `@deepseek-ai/node-addon-system-openharmony-arm64@0.1.2`（平台包 5 文件 → 2 文件，
  产物条目 25232 → 25229），省掉交叉编译 + 签名 + 跟版本维护；代价是放弃**跨进程**排他
  （同进程内第二个 writer 仍被拒，壳是单进程场景，用不到）。
- **0.1.7-rc.2**：必需补丁收敛到「`node-addon-require-builtin` 纯 JS 垫片 + `--expose-internals`」即可零禁用启动；
  flock 放行 + 自造平台包；目录选择器根限制；文档预览绕过。
- **更早**：从「补丁重放」改为「整文件替换」（只留 `files/` 整文件 + 每版独立脚本）。
