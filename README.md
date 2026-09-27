# dsh-harmony

**DeepSeek Harness（dsh）的 HarmonyOS / OpenHarmony 适配层**：改造过的文件 + 图片处理后端 + 新增插件 + 打包脚本。

- 上游：`@deepseek-ai/dsh` **0.1.7-rc.2**（MIT）
- 运行它的鸿蒙壳（HMDSH）：<https://gitcode.com/chen-qiongmeng/dsh-harmonyos-app>
- **本仓库不含 dsh 源码**：打包时用 pnpm 拉官方包，再按版本目录里的清单做替换/新增 —— 仓库只有几 MB，且"我们改了什么"一目了然。

## 目录

```
scripts/
  fetch-dsh.mjs      拉取并安装指定版本的官方 dsh（含 OHOS 原生包；--ignore-scripts --node-linker=hoisted）
  build-dsh.mjs      校验 manifest → 替换 files/ → 装图片后端 → 放插件 → 生成 bin/ → 打包 zip → 自检
  verify-dsh.mjs     产物自检（zip 顶层 dsh-<版本>/、文件集合、关键文件 sha256、补丁标记）
<版本>/               每个 dsh 版本一套（如 0.1.7-rc.2/）
  manifest.json      上游版本 + 要替换/新增的东西 + sha256 校验清单
  files/             ★ 改造过的文件（保留包内相对路径，如 node_modules/@deepseek-ai/<包>/lib/x.js）
  image-backend/     ★ 图片处理后端（jimp 依赖闭包，替换 sharp）
  plugins/           ★ 新增/替换的 dsh 插件（每插件一目录 + plugins.json）
  CHANGES.md         ★ 这个版本改了什么、为什么
patches/             历史补丁原件（留档；现在由 files/ 整文件替换取代）
```

## 用法

```sh
node scripts/fetch-dsh.mjs 0.1.7-rc.2      # 拉官方包到 work/0.1.7-rc.2/
node scripts/build-dsh.mjs 0.1.7-rc.2      # 出 dsh-ohos-0.1.7-rc.2.zip
node scripts/verify-dsh.mjs dsh-ohos-0.1.7-rc.2.zip
```

## 许可与免责

上游以 MIT 发布（见 `LICENSE`）；本仓库的改造与脚本同样以 MIT 提供，并保留上游版权与许可声明。
这是**非官方**移植，与 DeepSeek 官方及其关联公司无隶属或合作关系，未获其赞助或背书。
