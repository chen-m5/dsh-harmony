# plugins/ —— 新增 / 替换的 dsh 插件

放**要装进 dsh 的插件**（每个插件一个目录，目录名 = 插件名），由 `scripts/build-dsh.mjs` 打进包里。

`plugins.json`（可选，缺省时按目录名推断）：

```json
[
  { "name": "dsh-xxx", "mode": "add",      "target": "node_modules/@deepseek-ai/dsh-xxx" },
  { "name": "dsh-yyy", "mode": "replace",  "target": "node_modules/@deepseek-ai/dsh-yyy" }
]
```

- `mode: add` —— 新增（目标不存在时放入；已存在则报错，避免误覆盖）
- `mode: replace` —— 替换（目标必须存在，且 `manifest.json` 里要有它的 `sha256`）
- 插件若依赖其它包，把依赖一起放在插件目录的 `node_modules/` 下（同 `image-backend/` 的做法）

目前**还没有**新增/替换的插件（此目录为空）。
