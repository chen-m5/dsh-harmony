> ⚠ **留档用途**：这些补丁是针对**构建产物**（`lib/*.js`）写的**历史记录**。
> 现行流程用 `files/` 里的**整文件替换**，且 `files/` 里的版本已比补丁更新（例如余额条样式）。
> 要改 dsh 就直接改 `files/` 下对应文件，不要再改补丁。

# patches/ —— dsh 侧补丁留档（对着上游 `0.1.7-rc.2` 原件）

补丁从 dsh 包目录（即含 `node_modules/@deepseek-ai/…` 的那层）用 `git apply -p1` 应用。
**现行打包流程不重放它们** —— 用的是 [`../files/`](../files) 里的整文件替换；
本目录只留「当初是怎么改的」这个视角，内容说明以 [`../CHANGES.md`](../CHANGES.md)（权威）为准，
升级用的自包含副本在本仓库
[`docs/dsh-upgrade/reference.md`](../../docs/dsh-upgrade/reference.md)。

| 补丁 | 改造项（CHANGES 2.2） | 改了什么 | 状态 |
|---|---|---|---|
| `0001-dsh-attachment-local-no-sharp-jimp-backend.patch` | #3 | 无 sharp 时的图片后端：① 头解析兜底（PNG/JPEG/GIF/WebP，WebP/GIF 原样透传）；② 精简 Jimp 做 PNG/JPEG 的解码校验、EXIF 定向、按预算缩放与重编码。**同一个文件里还含 fsync 边界**（`EACCES`/`EPERM` 当持久边界）那一处 | 现行（细节以 `files/` 为准） |
| `0002-dsh-api-session-controller-prompt-cause.patch` | #4 | prompt 准入失败不再把真因吞成 `session/agent-busy`：写日志 + 原文进消息（`AttachmentError` 也记 code） | 现行 |
| `0003-dsh-client-ui-conversation-image-media-type.patch` | #5 | 图片类型判定不再只信 `file.type`：别名归一 + 按文件头魔数识别 | 现行 |
| `0004-dsh-client-ui-settings-account-hand-login-url-to-shell.patch` | #7 ① | 登录授权链接交给宿主壳：钩在插件的**状态流循环**里（`for await (const frame of stream)`，约 4202 行），拿到新 `authorizeUrl` 就调 `globalThis.dshShell.openLogin(url)`；无桥时 `window.open` 兜底 | 现行（位置就是要紧处：`startSignIn` 返回时还没有 URL） |
| `0005-dsh-client-ui-settings-account-balance-row.patch` | #7 ② | 余额条：挂载时拉一次余额 + 在账号启动器上方渲染「充值余额 / 赠金余额」+ ↻ | **历史（第一版样式）** —— 现行样式见 `files/`（去灰底、主题变量、赠金为 0 不渲染） |

> 这几个补丁只覆盖**需要改 JS 的部分**；其余改造项（自造平台包、`flock` 白名单、
> `dsh-fs-local` 的硬链接降级、ripgrep 平台包、目录选择器与预览定制等）见
> [`../CHANGES.md`](../CHANGES.md) 的表格 —— 那几条是新增/替换包或单行开关，未单独出 diff。

## `jimp-deps.json`

Jimp 种子包与版本、裁剪规则、以及裁剪结果：

- 只装 6 个种子包（`@jimp/core`、`js-png`、`js-jpeg`、`plugin-resize/rotate/flip`），
  再按 `dependencies` 闭包裁剪（顶层 `scripts/trim-jimp.mjs`）
- 结果：**270 个文件 / 约 2 MB**（入库在 [`../image-backend/`](../image-backend)）
- 裁剪是**入口感知**的：入口（main/module/browser + exports 运行时条件）所在目录不当杂物删——`debug@4` 的入口就是 `src/index.js`
- 装到 `node_modules/@deepseek-ai/dsh-attachment-local/node_modules/`：与 dsh 顶层同名包
  （`zod` 3.x vs 4.x、`debug` 4.x vs 2.x、`ms`、`pako`）大版本不同，放这里互不影响

## 现行打包（不再用补丁）

```sh
node scripts/fetch-dsh.mjs 0.1.7-rc.2                  # 拉官方包（按 pnpm-lock.yaml）
node scripts/build-dsh.mjs 0.1.7-rc.2 [--out <zip>]     # 校验 → 替换(files/) → 资产 → bin → 打包 → 自检
```

替换清单与官方原文件 sha256 都在 [`../manifest.json`](../manifest.json)；
要「重放补丁」这套老流程已经删掉了（`build-dsh-package.sh` 不在本仓库）。
