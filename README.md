# dsh-harmony

**把 DeepSeek Harness（dsh）适配到 HarmonyOS / OpenHarmony 的补丁与组装脚本。**

- 上游：`@deepseek-ai/dsh` **0.1.7-rc.2**（MIT）
- 本仓库产出：`dsh-ohos-<版本>.zip` —— 一个能被 HarmonyOS 壳解包直接跑、**不依赖 sharp** 的 dsh 包
- 本仓库**不是** dsh 的源码 fork，而是「上游 npm 包 + 少量可重放补丁 + 组装脚本」：
  我们消费的是**发布产物**（补丁打在编译后的 `lib/*.js` 上），好处是能精确跟随上游版本、逐条重放与回退。
- 运行它的 App（鸿蒙壳，含 Node/Python 运行时）：<https://gitcode.com/chen-qiongmeng/dsh-harmonyos-app>
- 详细改造记录与踩坑：[docs/dsh-改造记录.md](docs/dsh-改造记录.md)

## 补丁清单

| 补丁 | 作用 |
|---|---|
| `0001-…-no-sharp-jimp-backend` | 附件/图片：去掉 **sharp** 原生依赖，改用纯 JS 的 jimp 后端（OHOS 上装不了 sharp 的原生二进制） |
| `0002-…-prompt-cause` | `api-session-controller`：补 `prompt` 的 cause 字段 |
| `0003-…-image-media-type` | `ui-conversation`：图片 media type 兼容 |
| `0004-…-hand-login-url-to-shell` | `ui-settings-account`：登录授权链接交给宿主壳（先 `window.open` → 壳开系统浏览器；桥 `dshShell.openLogin` 兜底） |
| `0005-…-balance-row` | `ui-settings-account`：侧栏账号启动器上方显示「余额 / 赠金余额」+ ↻ 刷新（读插件自己的 `details.balance`） |

## 用法

```sh
# 1) 取上游包（得到 package/ 目录）
npm pack @deepseek-ai/dsh@0.1.7-rc.2
tar xzf deepseek-ai-dsh-0.1.7-rc.2.tgz

# 2) 打补丁 + 装纯 JS 图片后端 + 打包成 dsh-ohos-<版本>.zip
scripts/build-dsh-package.sh --src ./package --out dsh-ohos-0.1.7-rc.2.zip
```

- 补丁默认从 `patches/` 取（`--patches` 可指定别处）；脚本会按文件名顺序 `git apply -p1`，
  **已打过会自动跳过**（三态检测），冲突则报错退出，不会写坏源目录。
- 图片后端：只从 npm 装 `patches/jimp-deps.json` 里的种子包，再按依赖闭包裁剪（`scripts/trim-jimp.mjs`），
  塞到 `<src>/node_modules/@deepseek-ai/dsh-attachment-local/node_modules/`。
- 改完 dsh 源码后重跑脚本 + 重启 dsh 即可生效。

## 运行时不在本仓库

dsh 需要 **Node.js**。HarmonyOS 上的 Node 运行时、Python（可选）以及整个壳，
都在 App 仓库里随 hap 分发（`entry/src/main/resources/rawfile/runtime/`）。
npm 生态的原生二进制在 OHOS 上用不了，所以**运行时无法通过 npm 分发** —— 本仓库只负责"JS 侧的 dsh"。

## 许可与免责

- 上游 dsh 以 **MIT** 许可发布；本仓库的补丁与脚本同样以 MIT 提供，并保留上游的版权与许可声明（见 `LICENSE`）。
- 这是**非官方**移植，与 DeepSeek 官方及其关联公司**无隶属或合作关系**，未获其赞助或背书。
- DeepSeek、dsh (DeepSeek Harness)、Node.js、OpenHarmony 等名称与标识归各自权利人所有。
