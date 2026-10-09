# dsh 改造说明（0.1.7-rc.2）

> **这是什么**：升级 dsh 版本时用的**自包含**改造清单（离线也能照着做）。
> **权威来源**：dsh-harmony 仓库的 `0.1.7-rc.2/CHANGES.md`
> （<https://gitcode.com/chen-qiongmeng/dsh-harmony>）—— 两边必须一致，
> **改一边就同步另一边**；一致性检查：`sh scripts/check-dsh-docs.sh`。
>
> ⚠ **只对标题里这个版本（`0.1.7-rc.2`）成立**：**每个版本的改造都可能不一致**
> （上游会改、改动可能失效或需要换做法），升级时逐版本重新核对、重放、重写。
> 它列的是「已知改动」，**不代表适配一定成功** —— 改完必须另起一个独立进程实测
> （见同级 [`SKILL.md`](./SKILL.md) 的「验收」）。
>
> 本文件只讲 **dsh 本身**的改动，不涉及承载它的应用（壳）。

## 一、目标版本与运行方式

| 项 | 值 |
|---|---|
| dsh 版本 | `0.1.7-rc.2`（`0.1.6` 及更早在本壳上起不来） |
| 启动命令 | `node --expose-internals <包目录>/node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open --port <端口>` |
| 入口为什么不用 `node_modules/.bin/dsh` | 它内部 `import("./profile-boot.js")` 是**相对路径**，而鸿蒙沙箱里的 `.bin` 是**平铺**目录 → 解析失败。壳固定直接用 `.../@deepseek-ai/dsh/lib/bin.js` |
| `--expose-internals` | **不能少**：`require-builtin` 在鸿蒙上是纯 JS 适配，靠 `require('internal/*')` |
| `DSH_HOME` | 壳给（`<沙箱>/files/dsh-home`）。**必须在权限位可设成 600 的位置**：共享盘挂载固定 `660`，放那儿 dsh 的凭据插件起不来 |
| 权限模式 | `DSH_PERMISSION_MODE=danger-full-access`（鸿蒙无 bwrap/landlock；切回 `workspace-write` 会让共享盘整片不可写） |
| `TMPDIR` | 壳给。**必需**：spill / 子进程临时目录都走 `os.tmpdir()`（`dsh-subprocess-local/lib/output.js`、`dsh-spill-local/lib/index.js`）。丢了会退回只读的 `/tmp`，`mkdtempSync` 直接 EROFS，**在插件装载期就抛错**（比"降级成内存尾"严重） |

## 二、改造清单：11 个文件替换 + 3 类资产

**形态**：对官方包做**整文件替换**（不再重放 patch）。官方包由 pnpm 拉取 + `pnpm-lock.yaml` 锁版本，
替换文件与官方原文件的 sha256 都记在 dsh-harmony 的 `0.1.7-rc.2/manifest.json` 里，打包前校验。

> **全量实测（2026-09-28）**：拿壳里正在跑的包与按 lock 现装的官方树逐文件比 ——
> 仅官方有 **0** 个；仅现役有 **287** 个（= jimp 270 + OHOS 平台包 5 + `node_modules/bin/` 12）；
> 大小不同 **23** 个（= 下面 11 个替换文件 + 12 个 `.bin/*`）；另有 1 个 `.modules.yaml`（pnpm 元数据，无意义）。
> **改造面就是这 11 个文件 + 3 类资产，没有别的。**

### 2.1 替换的 11 个文件（包内相对路径在 `node_modules/` 下）

| # | 文件 | 改了什么 | 必需性 |
|---|---|---|---|
| 1 | `node-addon-require-builtin/lib/index.js` | 换成**纯 JS 实现**（`createRequire` + `requireBuiltin`/`isAllowedInternalId`/`getBindingInfo`），替代预编译 addon；配合 `--expose-internals` | **必需**（不换起不来：host preparation 阶段直接失败） |
| 2 | `@deepseek-ai/node-addon-system/lib/flock.js` | 平台白名单加 `openharmony`，固定用 `musl` 子目录 | **必需**（headless 硬前置；`web` 走到加锁路径同样需要） |
| 3 | `@deepseek-ai/dsh-attachment-local/lib/index.js` | **① fsync 边界**：`ensureDurableHome()` 会从 `DSH_HOME` 逐级 fsync 到 `/`，沙箱里 `/data/storage/el2`（及 `/data/storage`、`/data`）不可读 → `EACCES` → 附件准入全失败；改成遇 `EACCES`/`EPERM` 就当持久边界（记日志后返回）。**② 无 sharp 的图片后端**：`sharp` 在 openharmony-arm64 上没有任何平台二进制（`@img/` 只剩 `colour`），`require` 直接抛错；补两层（`no-sharp-fallback` 头解析嗅探 + `jimp-backend` 精简 Jimp）：PNG/JPEG 真解码校验、EXIF 定向、按预算缩放重编码（剥 EXIF/ICC；alpha → PNG，否则 JPEG 85/75/60），WebP/GIF 走头解析并原样透传。Jimp 只当**增强不当闸门**，解不开就退回头部事实 + 原样透传并写日志；sharp 可用时行为完全不变 | **必需**（不补：任何附件都存不下来；图片完全不可用） |
| 4 | `@deepseek-ai/dsh-api-session-controller/lib/index.js` | **别吞真因**：`prompt()` 的兜底 catch 把任何非 `RemoteError`/`AttachmentError` 都转成 `session/agent-busy, "prompt rejected"`，真因只进 `details.reason`（前端不显示）→「图片解码器加载失败」被误报成「忙」。改成 `console.error` 记日志（进 `dsh.log`）并把原文带进消息：`prompt rejected (cause: …)`；`AttachmentError` 也记 `[session] attachment rejected (CODE)` | **必需**（否则准入类故障没法定位） |
| 5 | `@deepseek-ai/dsh-client-ui-conversation/lib/client.js` | **图片类型判定只信浏览器**：`isImageMediaType()`/`imageMediaType()` 只认 `image/png`、`image/jpeg`、`image/webp`、`image/gif` 四个精确串，而 ArkWeb 与系统选择器给的 `file.type` 可能是空、`application/octet-stream` 或旧别名（`image/jpg`、`image/x-png`）→ 轻则把图片当普通文件上传，重则弹「仅支持 PNG、JPG、WebP、GIF 格式的图片」。改为：① 别名归一；② 声明不可信时按**文件头魔数**识别 | **必需**（容器适配） |
| 6 | `@deepseek-ai/dsh-client-connection/lib/client.js` | **loopback 页面不跟随浏览器联网状态**：`stopNetworkWatch: handle.isLoopback ? () => {} : watchBrowserNetwork(controller)`。ArkWeb 的 `navigator.onLine`/`offline` 不可靠，一旦报离线，`ConnectionController.loop()` 就 `emitState("disconnected")` 后 `await waitForAbort()` **无限期停住** —— 界面卡在「连接异常，点击立即重连」，而页面本身就是 `127.0.0.1` 的本机服务。改完按 0.5s→10s 退避重试 | **必需**（容器适配；不补要用户手点重连） |
| 7 | `@deepseek-ai/dsh-client-ui-settings-account/lib/client.js` | **① 登录授权链接交给宿主壳**：钩在插件的**状态流循环**里（`for await (const frame of stream)`，编译后约 4202 行），拿到新 `authorizeUrl` 就调 `globalThis.dshShell.openLogin(url)`（JS→native 不需要用户手势）；`window.open` 仅兜底。**放在 `startSignIn` 返回之后无效** —— 那一刻 `attempt.authorizeUrl` 还不存在，URL 是随后经状态流推来的。**② 余额条**：账号启动器上方显示「充值余额 / 赠金余额」+ ↻，挂载时拉一次；样式用主题变量（`--dsw-alias-label-tertiary`/`primary`）、赠金为 0 不渲染 | 体验 |
| 8 | `@deepseek-ai/dsh-fs-local/lib/index.js` | no-clobber 发布用 `link(2)`，而**共享盘（hmdfs）不支持硬链接** → `write` 工具报 `EPERM … link '…tmp' -> '…'`（`edit` 走 rename 才没事）。命中 `EPERM`/`EOPNOTSUPP`/`ENOSYS`/`EXDEV` 时降级 `rename`；目标已存在仍按原语义报错 | **能力**（不补则 `write` 写不进共享盘） |
| 9 | `@deepseek-ai/dsh-host-directory-picker-browse/lib/index.js` | 目录选择器**根限制**：起点/边界钳在指定根下、越界钳回；`DSH_PICKER_ROOT` 可改根（鸿蒙上 directory-picker 一定走 `browse` 后端，上游 browse 可浏览整个文件系统） | 产品定制 |
| 10 | `@deepseek-ai/dsh-client-ui-directory-picker-browse/lib/client.js` | 摘除面包屑行尾的「编辑路径」铅笔按钮（路径只能逐级点选） | 产品定制 |
| 11 | `@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.js` | 预览不再被 `meta.status="none"` 拦（`canRead=true`）、加载态加刷新按钮 | 产品定制（代价：缺 `version`/`absolutePath`，外部改动不再自动重载） |

> 这 11 个都是**我们的改动**（不是官方内容）—— 升级时可用改动特征自查，例如：
> `flock.js` 里的 `'openharmony'`、`DSH_PICKER_ROOT`、`dshShell.openLogin`、`@jimp/core` 的懒加载
> 在**官方原文件里都应该是 0 处**。

### 2.2 随包资产（官方树里没有，必须自带）

| 资产 | 内容 | 去处 |
|---|---|---|
| jimp 闭包 | **270 个文件 / 约 2 MB**（`@jimp/core`、`js-png`、`js-jpeg`、`plugin-resize/rotate/flip` + 依赖闭包；代码与官方 npm 包逐字节一致，只裁掉了 `*.d.ts`/`*.map`） | `node_modules/@deepseek-ai/dsh-attachment-local/node_modules/` |
| OHOS 平台包 | **5 个文件**：`@deepseek-ai/node-addon-system-openharmony-arm64@0.1.2`、`@vscode/ripgrep-openharmony-arm64@1.18.0` —— **公共 registry 上 404** | `node_modules/` |
| 顶层 `bin/` | `bash`（28 字节 shim：`exec /bin/sh "$@"`）—— 官方 npm 包**没有**顶层 `bin/` | 包顶层 `bin/` |

另有一处**改名**：pnpm（hoisted）给的是 `node_modules/.bin/`，而壳里用的是 `node_modules/bin/`（无点），
打包时要改名/复制（12 个入口：`dsh`、`cordis`、`pi-ai`…）。

**升级要点**：`native/` 缺了**起不来**，jimp 闭包缺了**图片功能全废** —— 两者都是懒加载，症状出现得很晚。
平台包与 jimp 的版本要不要跟着上游换，逐版本核对。

### 2.3 有 7 项还要留意「上游同名同版本重发」

第 1、2、6、8、9、10、11 项在 dsh-harmony 的 `manifest.json` 里额外带一句
`reason: 上游同名同版本重发后内容变了`。因为上游**用同一个版本号重新发布**过一批包、内容却变了；
其中 `node-addon-require-builtin@0.1.6` 的新版会 `require('node-addon-require-builtin-openharmony-arm64')`
—— 该包公共 registry 上**不存在** → **dsh 直接起不来**（`Cannot find module …`）。

- 这 7 项**本身也是我们的改造**，别因为"上游已发布"就丢掉；
- 但它们基于的是**当时的**上游内容，也不能当"永远正确"照抄 —— **升级时重新核对**，上游修好后就该去掉。

### 2.4 旧编号（1–18）→ 现在的位置

早期清单按「**18 处**适配点」编号，归档补丁与部分文档里还在用。对应：

| 旧编号 | 现在 |
|---|---|
| 1、2、8、9、10、11、13、14、15、16、17、18 | 上面 11 个文件（14 与 17 是同一个文件 `dsh-attachment-local/lib/index.js`） |
| 3、12 | 平台包 → `native/` |
| **4、5、6、7** | **已不需要**（`dsh-app-boot`、`dsh-subprocess-local`、`dsh-session-persistence-jsonl`、`dsh-ptc-runtime-node`）：全量比对实测这 4 个文件与官方**一致** |

> 「18 处」是**历史计数**；当前实际是 **11 个文件 + 3 类资产**。

## 三、产出物约定

```
dsh-ohos-0.1.7-rc.2.zip        # 顶层目录 dsh-0.1.7-rc.2/，内含 node_modules/
```

由 dsh-harmony 的脚本产出（`node scripts/build-dsh.mjs 0.1.7-rc.2 [--out <zip>]`）；
壳侧 `sh scripts/build-hap.sh` 会自动调用它，产物落到
`entry/src/main/resources/rawfile/pkg/` 后随 hap 分发。换版本还要同步
`entry/src/main/ets/common/PkgVersion.ets` 的 `DSH_VERSION` 一行 —— 包名/zip 名/顶层目录名全由它派生
（`sh scripts/check-dsh-docs.sh` 会核对三方一致）。

## 四、注意事项（踩过的坑）

- `--expose-internals` 不能少：dsh 的 `require-builtin` 在鸿蒙上是 JS 适配，靠 `require('internal/*')`。
- `DSH_HOME` 必须在权限位可设成 600 的位置：共享盘（Documents）挂载固定 `660`，凭据插件起不来。
- node 及其依赖库、python 二进制都需要 `.codesign` 段（自签名），否则 `Error loading shared library`
  或 `symbol not found`。签名工具：`<SDK>/toolchains/lib/binary-sign-tool sign -selfSign 1 -inFile X -outFile Y -signAlg SHA256withECDSA`。
- 解压出来的文件默认没有执行位，需要补 `0755`（`execve` 失败 errno=13 就是它）。
- 装依赖必须 `--ignore-scripts`（沙箱里 `node-pty`/`koffi` 的 node-gyp 跑不了）
  + `--node-linker=hoisted`（布局对齐壳的解包方式）。
- `koffi`：0.1.7 已改懒加载，非 Windows 路径不触碰，可不动；`node-pty` 只影响交互式终端；
  `sharp` 可直接加载。
- **`TMPDIR` 是必需的环境注入**（见第一节）—— 丢了会在**插件装载期**就抛错。
- **权限模式保持 `danger-full-access`**：`dsh-sandbox` 的 `writableRoots()` 在 `workspace-write` 下
  只给「会话 cwd + `/tmp`（鸿蒙只读）+ `tmpdir()`」，且**没有加白名单的配置项**。
- 共享盘 `/storage/Users/...` **不支持硬链接**（`link(2)` 报 EPERM），但 `mv`/`cp`/追加写都可用；`/tmp` 只读。

## 五、验收

见同级 [`SKILL.md`](./SKILL.md) 的「验收（必做）」7 步 —— 文件改对了、包装好了都**不算**适配成功，
必须另起独立进程实测。壳侧事后自检：`sh scripts/check-dsh-runtime.sh`（只读，不重启 dsh）。
