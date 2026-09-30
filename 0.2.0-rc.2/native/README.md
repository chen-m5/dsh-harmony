# native/ —— OHOS(openharmony-arm64) 平台专用包

这个包在 `package.json` 里写着 `os:["openharmony"] cpu:["arm64"]`，**不在公共 npm registry 上**
（npmmirror/npm 都 404），但 dsh 在鸿蒙上跑**需要它**：

| 包 | 作用 | 体积 |
|---|---|---|
| `@vscode/ripgrep-openharmony-arm64@1.18.0` | `@vscode/ripgrep` 的鸿蒙原生二进制 | 6 KB |

所以它作为**资产随版本目录入库**，由 `build-dsh.mjs` 拷到 `node_modules/` 下
（和 `image-backend/` 同一机制）。升级 dsh 版本时要确认这个包的版本是否也要跟着换。

## 这里曾经还有一个包（2026-09-30 删除）

`@deepseek-ai/node-addon-system-openharmony-arm64@0.1.2`（74 KB，自编的 `musl/system.node`），
用来让 `flock` 在鸿蒙上**真加锁**。后来参照 harmonybrew 的 dsh bottle 改成**打桩**
（`platform === 'openharmony'` 时 `tryLock` 直接回调成功），这份平台包连同交叉编译 / 签名的
维护成本一起省掉了 —— 代价是放弃**跨进程**排他：同一进程里的第二个 writer 仍会被拒，
而壳是"一个进程一个 dsh"，本来也用不到跨进程锁。

改动落在 `files/node_modules/@deepseek-ai/node-addon-system/lib/flock.js`
（官方原版 + 12 行打桩，与上游差异极小，方便跟着升级）。

## 校验

`manifest.json` 的 `nativeAssets` 记着这棵树的 `files` 与 `sha256`，`build-dsh.mjs` 打包前校验。
内容为官方平台包的**原样**拷贝（未改动代码）。
