# bin/ —— 壳要用的顶层可执行入口

dsh 官方 npm 包里**没有**顶层的 `bin/`，但鸿蒙壳里执行 shell 命令时会用到它。
这里放的 `bash` 是个 28 字节的 shim（把 `bash` 转成 `/bin/sh`）：

```sh
#!/bin/sh
exec /bin/sh "$@"
```

由 `build-dsh.mjs` 拷进包顶层（`dsh-ohos-<版本>/bin/`）。

## 说明

本目录里只有 `bash` 会被打进包（本 README 不进包）。`manifest.json` 的 `binAssets`
记着它的 `files` 与 `sha256`，`build-dsh.mjs` 打包前校验。
