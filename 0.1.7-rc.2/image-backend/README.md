# image-backend/ —— 图片处理后端（纯 JS 的 jimp）

**为什么有它**：dsh 用 `sharp` 处理图片，而 `sharp` 是原生模块，在 HarmonyOS / OpenHarmony 上装不了、
也用不了。所以 `dsh-attachment-local` 的补丁把后端换成**纯 JS 的 jimp**，它的依赖闭包就放在这里。

内容：`node_modules/`（jimp 及裁剪后的依赖，270 个文件 / 约 4 MB），由 `build-dsh.mjs` 整体拷到
`node_modules/@deepseek-ai/dsh-attachment-local/node_modules/`。

裁剪规则见 `scripts/trim-jimp.mjs` + `patches/jimp-deps.json`（要升级 jimp 时按它重装再裁）。
