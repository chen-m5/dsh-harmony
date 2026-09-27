# patches/ —— dsh 侧补丁（对着上游 `0.1.7-rc.2` 原件）

本目录是「dsh 改造」的**可重放形式**：补丁从 dsh 包目录（即含 `node_modules/@deepseek-ai/…`
的那层）用 `git apply -p1` 应用，内容说明见 [dsh-改造记录.md](../docs/dsh-改造记录.md) 与
[reference.md](../skills/dsh-upgrade/reference.md)。

| 补丁 | 对应 | 改了什么 |
|---|---|---|
| `0001-dsh-attachment-local-no-sharp-jimp-backend.patch` | 补丁 14 | 无 sharp 时的图片后端：① 头解析兜底（PNG/JPEG/GIF/WebP，WebP/GIF 原样透传）；② 精简 Jimp 做 PNG/JPEG 的解码校验、EXIF 定向、按预算缩放与重编码 |
| `0002-dsh-api-session-controller-prompt-cause.patch` | 补丁 15 | prompt 准入失败不再把真因吞成 `session/agent-busy`：写日志 + 原文进消息（`AttachmentError` 也记 code） |
| `0004-dsh-client-ui-settings-account-hand-login-url-to-shell.patch` | 补丁 18 | 登录授权链接交给宿主壳：`start()` 里接住 `startSignIn` 的返回值，先 `window.open`（壳接管外部开窗 → 系统浏览器），被拦时退回 `window.dshShell.openLogin` |
| `0003-dsh-client-ui-conversation-image-media-type.patch` | 补丁 16 | 图片类型判定不再只信 `file.type`：别名归一 + 按文件头魔数识别 |

> 这两个补丁只覆盖**需要改 JS 的部分**；其余补丁（自造平台包、`flock` 白名单、`dsh-fs-local`
> 的硬链接降级、ripgrep 平台包等）见改造记录里的表格 —— 那几条是新增/替换包或单行开关，
> 未单独出 diff。

## `jimp-deps.json`

补丁 14 需要的 Jimp 种子包与版本、裁剪规则、以及裁剪结果：

- 只装 6 个种子包（`@jimp/core`、`js-png`、`js-jpeg`、`plugin-resize/rotate/flip`），
  再按 `dependencies` 闭包裁剪（`scripts/trim-jimp.mjs`）
- 结果：27 个包 / 270 个文件 / 1.7 MiB（压缩后约 0.6 MiB）
- 裁剪是**入口感知**的：入口（main/module/browser + exports 运行时条件）所在目录不当杂物删——`debug@4` 的入口就是 `src/index.js`
- 装到 `node_modules/@deepseek-ai/dsh-attachment-local/node_modules/`：与 dsh 顶层同名包
  （`zod` 3.x vs 4.x、`debug` 4.x vs 2.x、`ms`、`pako`）大版本不同，放这里互不影响

## 一键组装

```sh
scripts/build-dsh-package.sh --src /path/to/dsh-0.1.7-rc.2 --out dsh-ohos-0.1.7-rc.2.zip
```

脚本依次：应用本目录的补丁 → `npm install` 种子包 → 裁剪装回包内 → 打成 zip
（zip 顶层目录名 = `--src` 的目录名，也就是 dsh 版本目录名）。`--no-jimp` 可只打补丁不装 Jimp。
