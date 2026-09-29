# dsh 改造记录（0.1.7-rc.2）

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
| 上游 | `@deepseek-ai/dsh` **0.1.7-rc.2**（MIT） |
| 改造形态 | **11 个文件整文件替换** + 3 类随包资产（不是 patch 重放） |
| 本仓库不含 | dsh 源码、dsh 包体 —— 打包时用 pnpm 拉官方包，再按本清单替换/新增 |
| 上次更新 | 2026-09-28（补全量比对实测） |

## 一、运行方式（dsh 自身）

| 项 | 值 |
|---|---|
| 启动命令 | `node --expose-internals <包目录>/node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open --port <端口>` |
| 入口为什么不用 `node_modules/.bin/dsh` | `node_modules/.bin/dsh` 内部 `import("./profile-boot.js")` 是**相对路径**，而鸿蒙沙箱里的 `.bin` 是**平铺**目录 → 解析失败。壳固定直接用 `.../@deepseek-ai/dsh/lib/bin.js` |
| `--expose-internals` | **不能少**：`require-builtin` 在鸿蒙上是纯 JS 适配，靠 `require('internal/*')` |
| `DSH_HOME` | 壳给。**必须在权限位可设成 600 的位置**（共享盘挂载固定 660，放那儿 dsh 的凭据插件起不来） |
| 权限模式 | `DSH_PERMISSION_MODE=danger-full-access`（鸿蒙无 bwrap/landlock；切回 `workspace-write` 会让共享盘整片不可写） |
| `TMPDIR` | 壳给。**必需**：spill / 子进程临时目录都走 `os.tmpdir()`，丢了会退回只读的 `/tmp`，`mkdtempSync` 直接 EROFS，**在插件装载期就抛错** |

## 二、改造清单

### 2.1 与官方包的差异（全量逐文件比对，2026-09-28 实测）

拿**壳里正在跑的那份包**与**按 `pnpm-lock.yaml` 现装的官方树**逐文件比（`node_modules/` 全量、比 sha256）：

| 项 | 数量 | 说明 |
|---|---|---|
| 现役文件 / 官方文件 | 25077 / 24790 | |
| **仅官方有** | **0** | 官方树里没有我们缺的东西 → 产物是官方的**超集**，差异全是「我们加上去的」 |
| 仅现役有 | 287 | = jimp 闭包 270 + OHOS 平台包 5 + `node_modules/bin/` 12 |
| 大小不同 | 23 | = **替换的 11 个文件** + 12 个 `.bin/*`（就是上面的 `bin/`） |
| 大小相同内容不同 | 1 | `node_modules/.modules.yaml`（pnpm 自己的元数据，无意义） |

→ **改造面就是这 11 个文件 + 3 类资产**，没有别的。`manifest.json` 里的 `replace` 列表与实测完全一致（不多不少）。

### 2.2 替换的 13 个文件（= `files/`，保留包内相对路径）

`manifest.json` 的 `replace[]` 逐项记着**官方原文件 sha256** 与**我们这份 sha256**；`build-dsh.mjs`
每次打包前校验「官方树确实是官方原样」，不符就**报错停下**（防止上游变了却静默覆盖）。

| # | 文件（`node_modules/` 下） | 改了什么 | 必需性 |
|---|---|---|---|
| 1 | `node-addon-require-builtin/lib/index.js` | 换成**纯 JS 实现**（`createRequire` + `requireBuiltin`/`isAllowedInternalId`/`getBindingInfo`），替代预编译 addon；配合 `--expose-internals` 工作 | **必需**（不换起不来：host preparation 阶段直接失败） |
| 2 | `@deepseek-ai/node-addon-system/lib/flock.js` | 平台白名单加 `openharmony`，固定用 `musl` 子目录 | **必需**（headless 的硬前置；`web` 走到加锁路径同样需要） |
| 3 | `@deepseek-ai/dsh-attachment-local/lib/index.js` | 两处改动：**① fsync 边界** —— `ensureDurableHome()` 会从 `DSH_HOME` 逐级 fsync 到 `/`，而沙箱里 `/data/storage/el2`（及 `/data/storage`、`/data`）不可读 → `EACCES`，整次附件准入失败；改成遇到 `EACCES`/`EPERM` 就当持久边界（记日志后返回）。**② 无 sharp 时的图片后端** —— `sharp` 在 openharmony-arm64 上没有任何平台二进制（`@img/` 下只剩 `colour`），`require` 直接抛错；补两层（内部叫 `no-sharp-fallback` + `jimp-backend`）：先由 `sniffImage()` 嗅探头部（PNG 位深/alpha/tRNS/文本块、JPEG SOF/APPn、GIF 帧数、WebP VP8X/VP8L/VP8），WebP/GIF 直接用它并原样透传；PNG/JPEG 交给精简 Jimp（`createJimp` 只装 PNG/JPEG 格式 + resize/rotate/flip 插件）做真解码校验、EXIF 定向、按预算缩放与重编码（顺带剥掉 EXIF/ICC；alpha → PNG，否则 JPEG 85/75/60）。Jimp 只当**增强不当闸门**：解不开或归一化失败就退回头部事实 + 原样透传并写日志；声明 MIME 是别名/空/未知时以字节为准（不再误报 `IMAGE_TYPE_MISMATCH`）；sharp 可用时行为完全不变 | **必需**（不补：任何附件都存不下来；图片完全不可用） |
| 4 | `@deepseek-ai/dsh-api-session-controller/lib/index.js` | **别吞真因**：`prompt()` 的兜底 catch 把任何非 `RemoteError`/`AttachmentError` 都转成 `session/agent-busy, "prompt rejected"`，真因只塞在 `details.reason`（前端不显示）→ 于是「图片解码器加载失败」被误报成「忙」。改成 `console.error` 记日志（进 `dsh.log`）并把原文带进消息：`prompt rejected (cause: …)`；`AttachmentError` 也记 `[session] attachment rejected (CODE)` | **必需**（否则准入类故障没法定位） |
| 5 | `@deepseek-ai/dsh-client-ui-conversation/lib/client.js` | **图片类型判定只信浏览器**：`isImageMediaType()`/`imageMediaType()` 只认 `image/png`、`image/jpeg`、`image/webp`、`image/gif` 四个精确串，而 ArkWeb 与系统选择器给的 `file.type` 可能是空、`application/octet-stream` 或旧别名（`image/jpg`、`image/x-png`）→ 轻则把图片当普通文件上传，重则直接弹「仅支持 PNG、JPG、WebP、GIF 格式的图片」。补丁：① 别名归一；② 声明不可信时按**文件头魔数**识别，识别成功就按图片处理 | **必需**（容器适配） |
| 6 | `@deepseek-ai/dsh-client-connection/lib/client.js` | **loopback 页面不跟随浏览器联网状态**：`stopNetworkWatch: handle.isLoopback ? () => {} : watchBrowserNetwork(controller)`。鸿蒙 ArkWeb 的 `navigator.onLine`/`offline` 事件不可靠，一旦报离线，`ConnectionController.loop()` 就 `emitState("disconnected")` 后 `await waitForAbort()` **无限期停住** —— 界面卡在「连接异常，点击立即重连」，而页面本身就是 `127.0.0.1` 的本机服务、一直可达。改完断线按 0.5s→10s 退避重试 | **必需**（容器适配；不补就要用户手点重连） |
| 7 | `@deepseek-ai/dsh-client-ui-settings-account/lib/client.js` | 两处改动：**① 登录授权链接交给宿主壳** —— web 表面自己不会开浏览器（桌面端靠 Electron 的 `shell.openExternal`）；位置**必须在状态流循环里**（`for await (const frame of stream)`，编译后约 4200 行），拿到新 URL 就调 `globalThis.dshShell.openLogin(url)` —— JS→native 调用不需要用户手势；`window.open` 只作兜底（`await` 之后的异步上下文会被弹窗策略拦）。放在 `startSignIn` 返回之后**无效**：那一刻 `attempt.authorizeUrl` 还不存在，URL 是随后经**状态流**推来的。**② 余额条** —— 账号启动器（头像那行）上方显示「充值余额 / 赠金余额」+ ↻ 刷新；挂载时拉一次（原来只在打开设置时拉） | 体验（不补则登录要用户手动复制链接、余额要进设置才看得到） |
| 8 | `@deepseek-ai/dsh-fs-local/lib/index.js` | no-clobber 发布用 `link(2)`，**共享盘（hmdfs）不支持硬链接** → `write` 工具报 `EPERM … link '…tmp' -> '…'`（`edit` 走 rename 才没事）。命中 `EPERM`/`EOPNOTSUPP`/`ENOSYS`/`EXDEV` 时降级 `rename`；目标已存在时仍按原语义报错 | **能力**（不补则 `write` 写不进共享盘） |
| 9 | `@deepseek-ai/dsh-host-directory-picker-browse/lib/index.js` | 目录选择器**根限制**：起点/边界钳在指定根下，越界钳回；`DSH_PICKER_ROOT` 可改根（鸿蒙上 directory-picker 一定走 `browse` 后端，上游 browse 可浏览整个文件系统） | 产品定制 |
| 10 | `@deepseek-ai/dsh-client-ui-directory-picker-browse/lib/client.js` | 摘除面包屑行尾的「编辑路径」铅笔按钮（路径只能逐级点选） | 产品定制 |
| 11 | `@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.js` | 预览不再被 `meta.status="none"` 拦（`canRead=true`）、加载态加刷新按钮 | 产品定制（见第四节限制） |

> 这 11 个都是**我们的改动**（不是官方内容）：拿改动特征逐个在官方树里查过 ——
> 例如 `flock.js` 的 `'openharmony'` 白名单官方 0 处、`DSH_PICKER_ROOT` 官方 0 处、
> `dshShell.openLogin` 官方 0 处、jimp 后端官方 0 处，而「编辑路径」官方 6 处 / 我们 4 处（摘掉了两处）。

### 2.3 为什么有 7 项带 `reason: 上游同名同版本重发`

`manifest.json` 的 `replace[]` 里，第 1、2、6、8、9、10、11 项（共 7 个）额外带一句
`reason: 上游同名同版本重发后内容变了，用现役可跑的那份`。

原因：上游**用同一个版本号重新发布**过一批包，内容却变了。其中
`node-addon-require-builtin@0.1.6` 的新版会 `require('node-addon-require-builtin-openharmony-arm64')`
—— 该包在公共 registry 上**不存在** → **dsh 直接起不来**（实测：`Cannot find module …`）。

要点（升级时最容易踩）：

- 这 7 个文件**同时也是我们的改造**（就是上表第 1/2/6/8/9/10/11 项）——
  它们存的是「**我们改过的版本**」，不能因为"上游已发布"就丢掉；
- 但它们基于的又是**当时的**上游内容，所以也不能当成"永远正确"照抄 ——
  **升级时这 7 项要重新核对**：上游修好之后就该去掉（改回用官方内容）。
- 也就是说：**用当前官方内容直接覆盖会丢掉我们的改动；照抄这份覆盖会带回旧版上游内容** —— 两头都要看。

### 2.4 随包资产（官方树里没有，必须随版本目录自带）

> **2026-09-29 新增 `pty-backend/`**：`node-pty` 自带 prebuilds 只有 darwin/linux/win32，
> **没有 openharmony** → 侧栏终端与常驻 shell 都起不来（`Failed to load native module: pty.node`）。
> 官方也没发鸿蒙版（`@deepseek-ai/node-pty-openharmony-arm64` 之类在 registry 上 404），所以
> **自己交叉编译并自签名**，作为资产入库（`manifest.ptyAssets` → 解到 `node_modules/node-pty/prebuilds`）。
> 编译要点见 `scripts/build-pty.mjs` 与第六节。

| 资产 | 内容 | 体积 | 去处 |
|---|---|---|---|
| `image-backend/` | jimp 依赖闭包：**270 个文件 / 约 2 MB**（`@jimp/core`、`js-png`、`js-jpeg`、`plugin-resize/rotate/flip` + 依赖闭包）；**代码与官方 npm 包逐字节一致**，只是裁掉了 `*.d.ts`/`*.map` 之类 | 约 2 MB | `node_modules/@deepseek-ai/dsh-attachment-local/node_modules/`（放包内避免与 dsh 顶层依赖撞版本：`zod` 3 vs 4、`debug` 4 vs 2…） |
| `native/` | OHOS 平台专用包 **5 个文件**：`@deepseek-ai/node-addon-system-openharmony-arm64@0.1.2`（flock 原生加载器）、`@vscode/ripgrep-openharmony-arm64@1.18.0`（ripgrep 二进制）—— **公共 registry 上 404**，只能随仓库走 | 约 110 KB | `node_modules/` |
| `bin/` | 壳要用的顶层 `bin/bash`（28 字节 shim：`exec /bin/sh "$@"`）—— 官方 npm 包里**没有**顶层 `bin/` | 约 4 KB | 包顶层 `bin/` |

裁剪/重装 jimp 的配方：`patches/jimp-deps.json` + 顶层 `scripts/trim-jimp.mjs`。
不做 `native/`、`image-backend/` 的后果：**前者起不来，后者图片功能全废**（且都是懒加载，症状很晚才暴露）。

### 2.5 `node_modules/.bin` → `node_modules/bin`

pnpm（hoisted）生成的是 `node_modules/.bin/`，而壳里用的是 **`node_modules/bin/`（无点）**。
`build-dsh.mjs` 打包时改名/复制（12 个入口：`dsh`、`cordis`、`pi-ai`…）。
这与上面的「大小不同 23 项」里的 12 个 `.bin/*` 是同一件事。

### 2.6 旧编号（1–18）→ 现在的位置

早期这份清单按「**18 处**适配点」编号，编号还留在归档补丁与部分文档里。对应关系：

| 旧编号 | 现在 |
|---|---|
| 1、2、8、9、10、11、13、14、15、16、17、18 | 即上表 11 个文件（14 与 17 是同一个文件 `dsh-attachment-local/lib/index.js`） |
| 3、12 | 平台包 → `native/` |
| **4、5、6、7** | **已不需要**（`dsh-app-boot`、`dsh-subprocess-local`、`dsh-session-persistence-jsonl`、`dsh-ptc-runtime-node`）：全量比对实测这 4 个文件**与官方内容一致**，当前版本无需改 |

> 所以「18 处」是**历史计数**；当前实际是 **11 个文件替换 + 3 类资产**。

## 三、产物与打包

产物 = `dsh-ohos-<版本>.zip`（顶层目录 `dsh-<版本>/`，内含 `node_modules/`），由本仓库脚本产出：

```sh
node scripts/fetch-dsh.mjs 0.1.7-rc.2                 # 拉官方包（--ignore-scripts --node-linker=hoisted，按 pnpm-lock.yaml）
node scripts/build-dsh.mjs 0.1.7-rc.2 [--out <zip>]    # 校验 → 替换 → 资产 → bin → 打包 → 自检
node scripts/verify-dsh.mjs <zip> 0.1.7-rc.2           # 产物自检
node scripts/build-dsh.mjs 0.1.7-rc.2 --clean          # 清中间产物（work/ 约 900 MB，可随时删）
```

- **锁版本**：首次 fetch 生成 `pnpm-lock.yaml` 存进版本目录，之后 `--frozen-lockfile` 精确复现
  （两次 fetch 出的官方原文件 sha256 完全一致，已实测）。
- **校验**：`manifest.json` 存官方原文件与我们的**双份 sha256**（资产也校验），不符即**报错停下**。
- **可反复跑**：build 在 `work/.build-<版本>/` 副本上做，`work/<版本>/` 永远官方原样。
- 壳侧：`sh scripts/build-hap.sh` 会**自动调这里**（输入没变就跳过），产物直接写进壳的
  `entry/src/main/resources/rawfile/pkg/`，随 hap 分发。

## 四、已知限制（dsh 侧）

- 「文件」侧边栏预览靠第 11 项绕过，代价是缺 `version` / `absolutePath`：外部改动不再自动重载（用刷新按钮手动刷）。根因（file 协议 provider 未激活）未修。
- 0.1.5 及更早：`assertEntriesActivated` 会因原生模块缺失硬判整棵树死 —— **不要用**。

## 五、版本可用性记录

同一份 node 分别实测：

| 包 | 结果 |
|---|---|
| `0.1.7-rc.2` | ✅ 起得来 |
| `0.1.5-rc.3` | ❌ `plugin tree failed to load` |

原因：`dsh-attachment-local`(sharp) / `dsh-subprocess-local`(koffi) / `dsh-sandbox-local`(koffi)
依赖的原生模块在鸿蒙上没有二进制。差别在**加载器**：0.1.5 有硬检查 `assertEntriesActivated`，
只要有 entry 没激活就抛错、整棵树判死；0.1.7 系不这样，同样的缺失只是那几个功能不可用。

试过并放弃的绕过（记下来免得重走）：

1. `cordis.patch.yml` 里禁掉那三个插件 —— **entry id 不是包名后缀**，要从日志的
   `loader entry <id> (@scope/pkg)` 里读（实际是 `attachment-local` / `subprocess` / `sandbox`）。
   禁掉后又出现连锁：依赖它们的 6 个插件等不到服务。
2. 把 `dsh-app-boot` 的 `assertEntriesActivated` 从硬抛改成警告 —— 能起来了，但连带 6 个不激活，功能残。

**结论：用 0.1.7 系。**

## 六、注意事项（踩过的坑）

- `DSH_HOME` 必须在权限位能设成 600 的地方（见第一节）。
- node 及其依赖库、python 二进制都需要 `.codesign` 段（自签名），否则 `Error loading shared library`
  或 `symbol not found`。签名工具：`<SDK>/toolchains/lib/binary-sign-tool sign -selfSign 1 -inFile X -outFile Y -signAlg SHA256withECDSA`。
- 解压出来的文件默认没有执行位，需要补 `0755`（`execve` 失败时 errno=13 就是它）。
- `koffi`：0.1.7 已改**懒加载**，非 Windows 路径不触碰，可不动；`node-pty` 只影响交互式终端；
  `sharp` 可直接加载。
- 共享盘 `/storage/Users/...` **不支持硬链接**（`link(2)` 报 EPERM），但 `mv`/`cp`/追加写都可用；`/tmp` 只读。
- 装依赖必须 `--ignore-scripts`（沙箱里 `node-pty`/`koffi` 的 node-gyp 跑不了）+ `--node-linker=hoisted`（布局对齐壳的解包方式）。

## 七、账号登录：dsh 侧只改一个文件

DeepSeek 账号登录**不需要**给 dsh 打一堆补丁：dsh 内置的
`deepseek-account` / `credentials` / `authorization` / `llm-deepseek-account`（来自 `dsh-base`）与
`ui-settings-account` / `account-controller`（来自 `dsh-web-app`）已经把这套功能挂全了。

dsh 侧唯一的改动是上表第 7 项**①**：把**授权页 URL**交给宿主壳去开浏览器。

三条实测硬约束（回调只认 http loopback、授权页 `frame-ancestors 'none'` 禁 iframe、无自定义 scheme）
决定了「授权页必须在 App 内顶层打开」—— 那是**壳**的职责。壳侧：`pages/Index.ets` 的登录覆盖层 + 回调兜底
（另有兜底注入脚本：拦 `navigator.clipboard.writeText`，用户点 dsh 弹窗里的「复制链接」时也会打开授权页）。
详见壳仓库 `docs/账号登录.md`。

## 八、余额条

第一版是「整条灰底 + 11px 灰字」，在深色主题下发闷、整条显得空。现改为：

- **去掉整条底色**，改用留白与层次：「余额」小字用 `--dsw-alias-label-tertiary`，
  数字用 `--dsw-alias-label-primary` 且 13px/500 更醒目
- 数字用 `font-variant-numeric: tabular-nums`，刷新时宽度不跳
- 颜色全部改用主题变量（原先是硬编码 `#94a3b8`，明暗主题都不贴）
- ↻ 按钮无底色、14px，与数字同一基线
- **赠金为 0 也显示**（`赠金 ¥0.00`）：只要钱包数据在就展示，别让「有没有赠金」看不出来
- **点 ↻ 有明确反馈**：刷新期间图标转圈（注入 `@keyframes hmdsh-spin`）+ 变淡 + 不可重复点，
  数据回来（`account.details.balance` 变化）或 8 秒超时后自动停 —— 之前"点了跟没点一样"，
  是因为余额没变、界面毫无变化
- 挂载时先拉一次（`useEffect([])`），不用等打开设置才看得到

> 权威实现在 `files/` 里的整文件（`dsh-client-ui-settings-account/lib/client.js`）；
> `patches/0005` 是第一版的历史留档，**样式与交互以 `files/` 为准**。

## 九、运行时验证（2026-09-28，真机实际运行）

用本流程产出的包在鸿蒙壳里**重新启动并实测通过**：

| 项 | 结果 |
|---|---|
| 启动 | 跑的就是新包（`files/pkg/dsh-ohos-0.1.7-rc.2`）✓，服务 `:32100` 返回 401（要 token = 正常）✓ |
| 与壳下 zip 关键文件 | 4/4 sha256 一致 ✓（`dsh/lib/bin.js`、`settings-account/client.js`、`node-addon-require-builtin/lib/index.js`、`attachment-local/lib/index.js`） |
| 余额条新样式 | `label-tertiary` 命中 ✓、旧灰底 0 处 ✓ |
| 登录桥 | `dshShell.openLogin` ✓ |
| compat 覆盖 | `node-addon-require-builtin` 可加载 ✓（不覆盖就起不来） |
| 图片后端 | jimp 模块按 dsh 真实 require 方式 **4/4 解析成功** ✓；真跑 `2x2 → resize 8x8 → rotate → flip → PNG/JPEG 编码` 全通 ✓ |
| 全量比对 | 见 2.1：与官方树差异 = 11 个文件 + 3 类资产，且「仅官方有」为 **0** ✓ |

一键自检脚本：壳仓库 `scripts/check-dsh-runtime.sh`（只读，不重启 dsh）。

## 十、变更沿革

- **必需补丁收敛到一条**：早期是「禁插件」方案（不可行，见第五节）；0.1.7 起只需把
  `node-addon-require-builtin` 换成纯 JS 垫片 + 启动带 `--expose-internals` 即可零禁用启动。
- **flock（第 2 项 + `native/`）**：headless 被 `flock is not supported on openharmony-arm64` 硬前置阻塞，
  故给 `node-addon-system` 放行 `openharmony` 并自造平台包（C 源码只依赖 `node_api.h` 与 `sys/file.h`，交叉编译干净）。
- **目录选择器（第 9、10 项）**：鸿蒙上 directory-picker 一定走 `browse` 后端（`auto` 只在 darwin/win32/linux 上选 native），
  上游 browse 可浏览整个文件系统；遂把「创建工作区」的起点/边界钳到指定根、并摘掉手输路径的铅笔。
- **文档预览（第 11 项）**：见第四节。
- **从「补丁重放」改为「整文件替换」**（2026-09）：仓库里只留 `files/` 整文件 + 每版独立脚本，
  不再对构建产物打 patch —— 上游挪几行也不会冲突，且「我们改了什么」一眼可见。

- **进程检查器的平台白名单（2026-09-29）**：`dsh-subprocess-local` 的 `createProcessInspector()`
  只认 `linux/darwin/win32`，鸿蒙上 `process.platform === 'openharmony'` → 直接抛
  `terminal inspection is unsupported on platform openharmony`（dsh 侧栏终端一打开就报错）。
  改为**把 openharmony 与 linux 同等对待**（鸿蒙内核是 Linux 系、`/proc` 可读，该 inspector 正是读 `/proc`）。
  核查：全包 64 处 `process.platform` 判断，其余 63 处都是 `=== 'win32'`（openharmony 自然走 posix 分支），
  只有这一处是**枚举白名单 + throw** —— 换 dsh 版本时要复查同类写法。
- **自编译 node-pty 原生模块（2026-09-29）**：见 2.4。关键是三层：
  ① 交叉编译（用 VM 的 clang-17 + OHOS SDK 的 sysroot/libcxx；SDK 自带的编译器是 x64，沙箱/VM 都是 aarch64 跑不了）；
  ② `.codesign` 段（鸿蒙 dlopen 前校验代码签名；**占位段无效**，要用 `ohos-bst-light` 真自签名，
     且 SDK 的 clang/lld 自动插的那个也是无效的）；
  ③ 入库方式用**资产**而非 `replace`（`replace` 要求上游文件存在，而这是新增文件）。
  脚本：`scripts/build-pty.mjs`（前提探测 → 自动下 node 头文件 → 编译 → 自签名 → 落 `pty-backend/`）。
- **侧栏终端的复制/粘贴（2026-09-29）**：HTML 终端（xterm.js）里没有自定义快捷键，Ctrl+C 是 SIGINT、
  Ctrl+V 受 Web 剪贴板限制。给 `dsh-client-ui-sidebar-terminal/lib/client.terminal.js` 打了补丁：
  **选中后单击右键=复制、双击右键=粘贴、Ctrl+V=粘贴**（走 Web 剪贴板 API，不占系统权限），
  并在面板底部显示一行操作提示。（初版用 Ctrl+Shift+C，与浏览器 DevTools 冲突，已弃用。）
  注：客户端插件是运行时从 `/plugin/...` 加载的，WebView 会缓存 —— 改动要重装 hap 才生效。
