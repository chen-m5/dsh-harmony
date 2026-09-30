# image-backend/ —— 图片处理后端（纯 JS 的 jimp）

**为什么有它**：dsh 用 `sharp` 处理图片，而 `sharp` 是原生模块，在 HarmonyOS / OpenHarmony 上装不了、
也用不了。所以 `dsh-attachment-local` 的补丁把后端换成**纯 JS 的 jimp**，它的依赖闭包就放在这里。

内容：`node_modules/`（jimp 及裁剪后的依赖，270 个文件 / 约 4 MB），由 `build-dsh.mjs` 整体拷到
`node_modules/@deepseek-ai/dsh-attachment-local/node_modules/`。

裁剪规则见 `scripts/trim-jimp.mjs` + `patches/jimp-deps.json`（要升级 jimp 时按它重装再裁）。

## 这份内容的性质（已核对）

- **代码未被改动**：与官方 npm 包**逐字节一致**（拿 `@jimp/core@1.6.1` 与官方对比过：
  同名文件内容不同 **0** 个；我们这份 15 个文件 / 官方 67 个文件）
- **被裁剪过**：只删掉运行时不需要的 `*.d.ts`（类型）、`*.map`（sourcemap）、`CHANGELOG.md` 之类；
  少量没用的开发配置（`eslint.config.mjs`、`tsconfig.json`）还留着（无害）
- **不是源码**：是 npm 的 `dist/`（commonjs + esm 编译产物）；jimp 的 TS 源码在它的上游仓库里，与本项目无关
- **有校验**：`manifest.json` 里记着这棵树的 `files` 与 `sha256`，`build-dsh.mjs` 每次打包前校验
