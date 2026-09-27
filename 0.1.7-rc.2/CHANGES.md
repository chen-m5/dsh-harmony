# dsh 改造记录（dsh 侧）

> 只记 **dsh 本身**的适配改动，不涉及承载它的应用（壳）—— 壳侧内容见 [README](./README.md)。
> 这些补丁**本项目确实在改**：改完的包打成 `rawfile/pkg/dsh-ohos-<版本>.zip` 随 hap 分发。
> 仓库里只放这张清单（以及 `skills/dsh-upgrade/` 里的升级说明），**不放 dsh 源码，也不放包体**。
> 上游版本：`0.1.7-rc.2`（实测可用；`0.1.6` 及更早不可用）
> 更新：2026-09-26

## 一、运行方式（dsh 自身）

| 项 | 值 |
|---|---|
| 启动命令 | `node --expose-internals <包目录>/node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open --port <端口>` |
| 入口为什么不用 `node_modules/.bin/dsh` | `node_modules/.bin/dsh` 内部 `import("./profile-boot.js")` 是**相对路径**，而鸿蒙沙箱里的 `.bin` 是**平铺**目录 → 解析失败。壳固定直接用 `.../@deepseek-ai/dsh/lib/bin.js` |
| `DSH_HOME` | 自定。**必须在权限位可设成 600 的位置**（共享盘挂载固定 660，放那儿 dsh 的凭据插件起不来） |
| 权限模式 | `DSH_PERMISSION_MODE=danger-full-access` |
| `--expose-internals` | **不能少**：`require-builtin` 在鸿蒙上是纯 JS 适配，靠 `require('internal/*')` |

## 二、源码级适配补丁（18 处）

**改动在哪：**

- **已应用的结果**（要看某处到底改成什么样，直接看这个）：`entry/src/main/resources/rawfile/pkg/dsh-ohos-<版本>.zip`
  里对应的 `node_modules/@deepseek-ai/…` 文件 —— 下面表格「文件」列就是位置。
- **可重放的补丁原件**：不在仓库里了（仓库只留这份清单）。归档在仓库外的兄弟目录：
  仓库内的 **`dsh-build/`**（.gitignore 已排除，不会提交）：
  `dsh-build/dsh-patches.tar.gz`（归档）+ `dsh-build/patches/`（解开后的目录，`build-dsh-package.sh` 默认读这里）；
  上游 dsh 源放 `dsh-build/src/` 即成为 `--src` 的默认值。也可用 `--patches` / `DSH_PATCHES_DIR` 另指。
- Jimp 精简依赖清单在仓库内：`scripts/jimp-deps.json`。

| # | 文件 | 改了什么 | 必需性 |
|---|---|---|---|
| 1 | `node-addon-require-builtin/lib/index.js` | 换成**纯 JS 实现**（`createRequire` + `requireBuiltin`/`isAllowedInternalId`/`getBindingInfo`），替代预编译 addon | **必需**（不换就起不来） |
| 2 | `@deepseek-ai/node-addon-system/lib/flock.js` | 平台白名单加 `openharmony`，固定用 `musl` 子目录 | 按需（flock） |
| 3 | `@deepseek-ai/node-addon-system-openharmony-arm64/`（自造平台包） | 交叉编译并自签名的 `bin/musl/system.node`（flock）+ `prebuilds.json` | 按需（flock） |
| 4 | `@deepseek-ai/dsh-app-boot/lib/index.js` | 启动引导适配 | 按需 |
| 5 | `@deepseek-ai/dsh-subprocess-local/lib/runner-launch-*.js` | 子进程启动适配 | 按需 |
| 6 | `@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js` | 会话持久化适配 | 按需 |
| 7 | `@deepseek-ai/dsh-ptc-runtime-node/lib/index.js` | PTC 运行时适配 | 按需（用到 PTC 才需要） |
| 8 | `@deepseek-ai/dsh-host-directory-picker-browse/lib/index.js` | 目录选择器根限制：起点/边界钳在指定根下，越界钳回；`DSH_PICKER_ROOT` 可改根 | 产品定制 |
| 9 | `@deepseek-ai/dsh-client-ui-directory-picker-browse/lib/client.js` | 摘除面包屑行尾的「编辑路径」铅笔按钮（路径只能逐级点选） | 产品定制 |
| 10 | `@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.js` | 预览不再被 `meta.status="none"` 拦（`canRead=true`）、加载态加刷新按钮 | 产品定制 |
| 11 | `@deepseek-ai/dsh-fs-local/lib/index.js` | 硬链接不可用（共享盘报 EPERM）时降级 `rename`，否则 `write` 工具写不进共享盘 | **能力**（P0） |
| 12 | `@vscode/ripgrep-openharmony-arm64/`（自造平台包）或 rg shim | `@vscode/ripgrep` 拼平台包 `…-openharmony-arm64`，鸿蒙没有 → `grep`/`glob` 工具报 `ripgrep launch failed` | **能力**（P0） |
| 13 | `@deepseek-ai/dsh-client-connection/lib/client.js` | **loopback 页面不跟随浏览器联网状态**：`stopNetworkWatch: handle.isLoopback ? () => {} : watchBrowserNetwork(controller)`。鸿蒙 ArkWeb 的 `navigator.onLine` / `offline` 事件不可靠，一旦报离线，`ConnectionController.loop()` 就 `emitState("disconnected")` 后 `await waitForAbort()` **无限期停住** —— 界面卡在「连接异常，点击立即重连」，而页面本身就是 `127.0.0.1` 的本机服务、一直可达 | **必需**（容器适配；不补就要用户手点重连） |
| 14 | `@deepseek-ai/dsh-attachment-local/lib/index.js` | **无 sharp 时的图片后端**：`sharp` 在 openharmony-arm64 上没有任何平台二进制（`@img/` 下只剩 `colour`），`require` 直接抛错 —— 图片准入必失败，而且这个错还会被 session-controller 兜成 `session/agent-busy / prompt rejected`（看着像「忙」）。补丁加两层：① **Jimp 纯 JS 后端**（只当增强、不当闸门：解不开或归一化失败就退回头部事实 + 原样透传，并写 `console.error` 进 `dsh.log`；声明 MIME 是别名/空/未知时以字节为准，不再误报 `IMAGE_TYPE_MISMATCH`）（`createJimp` 只装 PNG/JPEG 格式 + resize/rotate/flip 插件）——PNG/JPEG 真解码校验、EXIF 定向、按预算缩放、重编码（顺带剥掉 EXIF/ICC；带 alpha 出 PNG，否则走 JPEG 质量阶梯 85/75/60）；② **头解析 + 原样透传**兜底（`sniffImage()`：PNG/JPEG/GIF/WebP 的格式、宽高、alpha、动画、元数据、位深），WebP 与 GIF 走这条。Jimp 只装 6 个种子包并按依赖闭包裁剪（27 个包 / 266 个文件 / 1.6 MiB，zip 只增 ~0.5 MiB；配方见 `scripts/jimp-deps.json` + `scripts/trim-jimp.mjs`），放在 `dsh-attachment-local/node_modules/` 下，避免与 dsh 顶层依赖撞版本；sharp 能加载时仍走原逻辑 | **必需**（不补则图片附件完全不可用） |
| 15 | `@deepseek-ai/dsh-api-session-controller/lib/index.js` | **别吞真因**：`prompt()` 的兜底 catch 把任何非 `RemoteError`/`AttachmentError` 都转成 `session/agent-busy, "prompt rejected"`，真因只塞在 `details.reason` 里而前端不显示 —— 于是「图片解码器加载失败」被误报成「忙」。改成 `console.error` 记日志（进 `dsh.log`）并把原文带进消息：`prompt rejected (cause: …)`；`AttachmentError` 也记一条 `[session] attachment rejected (CODE)` | **必需**（否则准入类故障没法定位） |
| 16 | `@deepseek-ai/dsh-client-ui-conversation/lib/client.js` | **图片类型判定只信浏览器**：`isImageMediaType()` / `imageMediaType()` 只认 `image/png|jpeg|webp|gif` 这四个精确串。ArkWeb 与系统选择器给的 `file.type` 可能是空、`application/octet-stream` 或旧别名（`image/jpg`、`image/x-png`）—— 轻则把图片当普通文件上传（「发送就保存」），重则直接弹「仅支持 PNG、JPG、WebP、GIF 格式的图片」。补丁：① 别名归一；② 声明不可信时按**文件头魔数**识别，识别成功就按图片处理 | **必需**（容器适配） |
| 18 | `@deepseek-ai/dsh-client-ui-settings-account/lib/client.js` | **登录授权链接交给宿主壳**：web 表面自己不会开浏览器（桌面端靠 Electron 外壳 `shell.openExternal`），如果把这个钩子放在 `startSignIn` 返回之后是**无效的** —— 那一刻 `attempt.authorizeUrl` 还不存在（`auth_init` 稍后才回来，URL 是随后经**状态流**推来的）；正确位置是该插件的**状态流循环**里（`for await (const frame of stream)`，编译后 `lib/client.js` 约 4203 行）：拿到新 URL 就调 `globalThis.dshShell.openLogin(url)` —— JS→native 调用**不需要用户手势**（`window.open` 在 `await` 之后的异步上下文里会被弹窗策略拦掉，只作兜底）。对应归档补丁 `0004-…-hand-login-url-to-shell.patch`。壳侧另有兜底：注入脚本拦 `navigator.clipboard.writeText`，用户点 dsh 弹窗里的「复制链接」时也会把授权页打开（实测可用）。 |
| 17 | `@deepseek-ai/dsh-attachment-local/lib/index.js`（与 14 同文件，diff 合并在归档的 `0001-…-no-sharp-jimp-backend.patch`） | **沙箱里 fsync 不到祖先目录，导致附件根本写不进去**：`ensureDurableHome()` 为了「崩溃后仍持久」会从 `DSH_HOME` **逐级 fsync 到 `/`**；鸿蒙沙箱里 `/data/storage/el2`（以及 `/data/storage`、`/data`）**不可读** → `EACCES: permission denied, open '/data/storage/el2'` → 整次准入失败。补丁：遇到 `EACCES`/`EPERM` 就把它当作持久边界（写一条日志后返回），不让附件写失败 | **必需**（不补则任何附件都存不下来，与图片格式无关） |


> `flock` 是 **headless 的硬前置**；`web` 走到加锁路径时同样需要。
> 逐版本的完整说明（给升级用）在 [`skills/dsh-upgrade/reference.md`](./skills/dsh-upgrade/reference.md)。

## 三、已知限制（dsh 侧）

- 「文件」侧边栏预览靠补丁 #10 绕过，代价是缺 `version` / `absolutePath`：外部改动不再自动重载（用刷新按钮手动刷）。根因（file 协议 provider 未激活）未修。
- 0.1.5 及更早：`assertEntriesActivated` 会因原生模块缺失硬判整棵树死 —— **不要用**。

## 四、版本可用性记录

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

## 五、注意事项

- `DSH_HOME` 必须在权限位能设成 600 的地方（见第一节）。
- node 及其依赖库、python 二进制都需要 `.codesign` 段（自签名），否则 `Error loading shared library`
  或 `symbol not found`。签名工具：`<SDK>/toolchains/lib/binary-sign-tool sign -selfSign 1 -inFile X -outFile Y -signAlg SHA256withECDSA`。
- 解压出来的文件默认没有执行位，需要补 `0755`（`execve` 失败时 errno=13 就是它）。
- `koffi`：0.1.7 已改**懒加载**，非 Windows 路径不触碰，可不动；`node-pty` 只影响交互式终端；
  `sharp` 可直接加载。

## 五之二、账号登录：壳侧实现（dsh 零改动）

DeepSeek 账号登录**不需要**给 dsh 打任何补丁：

- dsh 内置的 `deepseek-account` / `credentials` / `authorization` / `llm-deepseek-account`
  （来自 `dsh-base`）与 `ui-settings-account` / `account-controller`（来自 `dsh-web-app`）已经把这套功能挂全了；
- 三条实测硬约束（回调只认 http loopback、授权页 `frame-ancestors 'none'` 禁 iframe、无自定义 scheme）
  决定了"授权页必须在 App 内顶层打开"—— 那是壳的职责，不是 dsh 的；
- 因此登录实现在壳里（`pages/Index.ets` 的登录覆盖层 + 回调兜底），dsh 侧补丁数量**不变**。

详见 [账号登录](账号登录.md)。

## 六、变更沿革

- **必需补丁收敛到一条**：早期是「禁插件」方案（不可行，见第四节）；0.1.7 起只需把
  `node-addon-require-builtin` 换成纯 JS 垫片 + 启动带 `--expose-internals` 即可零禁用启动。
- **flock 补丁（#2/#3）**：headless 被 `flock is not supported on openharmony-arm64` 硬前置阻塞，
  故给 `node-addon-system` 放行 `openharmony` 并自造平台包（C 源码只依赖 `node_api.h` 与 `sys/file.h`，交叉编译干净）。
- **目录选择器补丁（#8/#9）**：鸿蒙上 directory-picker 一定走 `browse` 后端（`auto` 只在 darwin/win32/linux 上选 native），
  上游 browse 可浏览整个文件系统；遂把「创建工作区」的起点/边界钳到指定根、并摘掉手输路径的铅笔。
- **文档预览补丁（#10）**：见第三节。

## 余额条样式（2026-09 优化）

第一版是"整条灰底 + 11px 灰字"，在深色主题下发闷、整条显得空。现改为：

- **去掉整条底色**，改用留白与层次：「余额」小字用 `--dsw-alias-label-tertiary`，
  数字用 `--dsw-alias-label-primary` 且 13px/500 更醒目
- 赠金为 0 时**整块不渲染**（原来会显示 `赠金 ¥0.00`）
- 数字用 `font-variant-numeric: tabular-nums`，刷新时宽度不跳
- 颜色全部改用主题变量（原先是硬编码 `#94a3b8`，明暗主题都不贴）
- ↻ 按钮无底色、14px，与数字同一基线

> 权威实现在 `files/`（整文件替换）；`patches/0005` 是第一版的历史留档，样式以 `files/` 为准。

## 为什么有 7 个"非我们所改"的覆盖文件（compat）

上游**用同一个版本号重新发布**过若干包，内容却变了。其中
`node-addon-require-builtin@0.1.6` 的新版会 `require('node-addon-require-builtin-openharmony-arm64')`
（该包在公共 registry 上不存在）→ **dsh 直接起不来**（实测：`Cannot find module …`）。

所以这 7 个文件按**现役可跑的那份**覆盖（与我们的改造同一机制，都放在 `files/`）：

```
@deepseek-ai/dsh-client-connection/lib/client.js
@deepseek-ai/dsh-client-ui-directory-picker-browse/lib/client.js
@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.js
@deepseek-ai/dsh-fs-local/lib/index.js
@deepseek-ai/dsh-host-directory-picker-browse/lib/index.js
@deepseek-ai/node-addon-system/lib/flock.js
node-addon-require-builtin/lib/index.js        ← 关键就是这个
```

manifest 里每项都带 `reason` 与 `upstreamSha256`。**升级 dsh 版本时要重新核对这 7 项**
（上游修好之后就该去掉）。

验证（2026-09 实测）：用本流程产出的包起实例 → `dsh web: http://127.0.0.1:32199/?token=…`，
端口返回 HTTP 401（要 token = 服务正常）。

## 运行时验证（2026-09-28，真机实际运行）

新包在鸿蒙壳里**重新启动并实测通过**：

| 项 | 结果 |
|---|---|
| 启动 | pid 用的就是新包（`files/pkg/dsh-ohos-0.1.7-rc.2`）✓，服务 `:32100` 返回 401（要 token = 正常）✓ |
| 与壳下 zip 关键文件 | 4/4 sha256 一致 ✓（`dsh/lib/bin.js`、`settings-account/client.js`、`node-addon-require-builtin/lib/index.js`、`attachment-local/lib/index.js`）|
| 余额条新样式 | `label-tertiary` 6 处 ✓、旧灰底 0 处 ✓ |
| 登录桥 | `dshShell.openLogin` 2 处 ✓ |
| compat 覆盖 | `node-addon-require-builtin` 可加载 ✓（不覆盖就起不来）|
| 图片后端 | jimp 模块按 dsh 真实 require 方式 **4/4 解析成功** ✓；真跑 `2x2 → resize 8x8 → rotate → flip → PNG/JPEG 编码` 全通 ✓ |

一键自检脚本：壳仓库 `scripts/check-dsh-runtime.sh`（只读，不重启 dsh）。
