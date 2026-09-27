# dsh-harmony

**DeepSeek Harness（dsh）的 HarmonyOS / OpenHarmony 适配层**：改造过的文件 + 图片处理后端 + 新增插件 + 打包脚本。

- 上游：`@deepseek-ai/dsh` **0.1.7-rc.2**（MIT）
- 运行它的鸿蒙壳（HMDSH）：<https://gitcode.com/chen-qiongmeng/dsh-harmonyos-app>
- **本仓库不含 dsh 源码**：打包时用 pnpm 拉官方包，再按版本目录里的清单做替换/新增 —— 仓库只有几 MB，且"我们改了什么"一目了然。

## 目录

```
scripts/                    顶层：**共用件**
  fetch-dsh.mjs             薄转发入口 → <版本>/scripts/fetch-dsh.mjs
  build-dsh.mjs             薄转发入口 → <版本>/scripts/build-dsh.mjs
  verify-dsh.mjs            薄转发入口 → <版本>/scripts/verify-dsh.mjs
  trim-jimp.mjs             通用工具：裁剪 jimp 依赖闭包
<版本>/                     **每个 dsh 版本一套，互不影响**（如 0.1.7-rc.2/）
  scripts/                  ★ 这一版**独立**的脚本（权威实现；下个版本可能不一样）
  patches/                  ★ 这一版**独立**的补丁留档（+ jimp-deps.json）
  manifest.json             上游版本 + 替换/资产清单 + sha256 校验基线
  files/                    ★ 改造过的文件（保留包内相对路径，如 node_modules/@deepseek-ai/<包>/lib/x.js）
  image-backend/            ★ 图片后端（jimp 依赖闭包，替换掉 OHOS 上用不了的 sharp）
  native/                   ★ OHOS(openharmony-arm64) 平台专用包（公共 registry 上没有）
  bin/                      ★ 壳要用的顶层 bin/（bash shim）
  plugins/                  ★ 新增/替换的 dsh 插件（每插件一目录 + plugins.json）
  CHANGES.md                ★ 这个版本改了什么、为什么
```

约定：**每个版本自带独立脚本**；确实共用的东西放顶层 `scripts/`，其它版本要用就 **import 它的路径（引用，而不是复制）**。

## 用法

```sh
node scripts/fetch-dsh.mjs 0.1.7-rc.2      # 拉官方包到 work/0.1.7-rc.2/
node scripts/build-dsh.mjs 0.1.7-rc.2      # 出 dsh-ohos-0.1.7-rc.2.zip
node scripts/verify-dsh.mjs dsh-ohos-0.1.7-rc.2.zip
```

## 许可与免责

上游以 MIT 发布（见 `LICENSE`）；本仓库的改造与脚本同样以 MIT 提供，并保留上游版权与许可声明。
这是**非官方**移植，与 DeepSeek 官方及其关联公司无隶属或合作关系，未获其赞助或背书。

## 清理中间产物

打包会在 `work/` 下留缓存（`work/<版本>/` 官方树、`work/.build-<版本>/` 构建副本，合计约 900 MB），
它们**可以随时删**；下次 build 会发现官方树不在、**自动 fetch** 一次（按 `pnpm-lock.yaml`，约 10 秒）：

```sh
node scripts/build-dsh.mjs <版本> --clean     # 只清理，不构建
```
