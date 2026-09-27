# native/ —— OHOS(openharmony-arm64) 平台专用包

这两个包在 `package.json` 里写着 `os:["openharmony"] cpu:["arm64"]`，**不在公共 npm registry 上**
（npmmirror/npm 都 404），但 dsh 在鸿蒙上跑**需要它们**：

| 包 | 作用 | 体积 |
|---|---|---|
| `@deepseek-ai/node-addon-system-openharmony-arm64@0.1.2` | `@deepseek-ai/node-addon-system` 的鸿蒙原生加载器 | 74 KB |
| `@vscode/ripgrep-openharmony-arm64@1.18.0` | `@vscode/ripgrep` 的鸿蒙原生二进制 | 6 KB |

所以它们作为**资产随版本目录入库**，由 `build-dsh.mjs` 拷到 `node_modules/` 下
（和 `image-backend/` 同一机制）。升级 dsh 版本时要确认这两个包的版本是否也要跟着换。
