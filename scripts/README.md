# scripts/ —— 共用件

**约定：每个 dsh 版本有自己独立的脚本**（放在 `<版本>/scripts/`），因为不同版本要改的东西可能不一样。

这个顶层目录只放两类东西：

| 文件 | 作用 |
|---|---|
| `fetch-dsh.mjs` / `build-dsh.mjs` / `verify-dsh.mjs` | **薄转发入口**：把 `node scripts/build-dsh.mjs <版本>` 转发到 `<版本>/scripts/build-dsh.mjs`（省得记版本路径） |
| `trim-jimp.mjs` | 通用工具：按种子包清单裁剪 jimp 依赖闭包（升级图片后端时用） |

要复用别的版本的实现，就 **import 它的路径（引用，而不是复制）**。

用法不变：
```sh
node scripts/fetch-dsh.mjs 0.1.7-rc.2
node scripts/build-dsh.mjs 0.1.7-rc.2 [--out <zip>]
node scripts/verify-dsh.mjs <zip> 0.1.7-rc.2
```
