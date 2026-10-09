# HMDSH 使用说明

**HMDSH** = 承载 dsh 的 HarmonyOS 壳。本仓库（dsh-harmony）是它的 **dsh 侧适配**，壳本身在
[dsh-harmonyos-app](https://gitcode.com/chen-qiongmeng/dsh-harmonyos-app)。

这份说明回答一件事：**在一台装了 HMDSH 的设备上，怎么把 dsh 用顺手** —— 装与起、该装哪几个 skill、
以及为什么这些 skill 刻意不随包。

## 一、装与起

1. **壳（hap）** 从 dsh-harmonyos-app 构建安装；它内置一份**已适配 openharmony-arm64 的 dsh 包**
   （`rawfile/pkg/dsh-ohos.zip`，由本仓库 `node scripts/build-dsh.mjs <版本>` 产出）。
2. **起 dsh**：在壳的「设置 → dsh 控制」里启停；Web UI 端口 **32100**（正式实例只能由用户启停）。
3. **要验证 dsh 侧改动**：别重启正式实例 —— 另起临时进程，用独立的 `DSH_HOME` + 空闲端口（如 32101），
   确认无报错后停掉并释放端口，再由用户重启正式实例。

## 二、建议装的三个 skill（**不随包**，从本仓库取）

壳里 dsh 的 skill 有两个根：

| 根 | rank | 谁维护 |
|---|---|---|
| `<沙箱>/files/skills/` | 600 | 壳按 hap 内 `rawfile/skills/**` 镜像（即"随包注入"） |
| `<沙箱>/files/dsh-home/skills/`（`$DSH_HOME/skills`） | 400 | 用户目录，**放进去就生效**（热加载，不用重打 hap） |

下面三个 skill 刻意**不随包**，源码就放在本仓库 `skills/` 下：

| skill | 干什么 |
|---|---|
| [`dsh-shell`](skills/dsh-shell/SKILL.md) | 这个沙箱长什么样：目录布局、壳提供了什么、能力边界（哪些命令有 / 没有）、`DSH_*` 变量的传递规则 |
| [`harmonybrew`](skills/harmonybrew/SKILL.md) | 缺工具怎么装：Homebrew 的鸿蒙移植、`brew install`，以及**装完必须补 `files/bin/<工具>` 包装脚本**（bottle 的 rpath 写死在上游 prefix，裸跑会报缺共享库）、已装工具清单 |
| [`dsh-plugin-install`](skills/dsh-plugin-install/SKILL.md) | 给 dsh 装 / 更新 skill 或插件的流程：先导出用户目录留退路 → 装 → 重启验证 → 失败用归档回滚 |

**安装**（在设备/沙箱里执行，一条命令）：

```sh
REPO=/storage/Users/currentUser/Documents/git/ohos/dsh-harmony   # 本仓库在设备上的路径
SK=/data/storage/el2/base/haps/entry/files/dsh-home/skills       # 用户目录（= dsh 里的 $DSH_HOME/skills）
mkdir -p "$SK"
cp -r "$REPO"/skills/dsh-shell "$REPO"/skills/harmonybrew "$REPO"/skills/dsh-plugin-install "$SK/"
```

> 在 dsh 自己的 `bash` 工具里，`$DSH_HOME` 就是上面那个 `.../files/dsh-home`，可以直接用；
> 在设备终端里手敲时请用绝对路径 —— `$DSH_HOME` 只在 dsh 起的进程里有，空展开会写到 `/skills`。
> `harmonybrew` 的安装脚本随 skill 一起放（`$SK/harmonybrew/install-harmonybrew.mjs`），别漏。

放进去就生效（rank 400 是实时扫描的），**不必重启 dsh，更不必重新打 hap**。
验证：看 dsh 的技能清单里出现这三个名字，或 `ls "$DSH_HOME/skills/"`。

更新版本同理（覆盖后即时生效）；`harmonybrew` 的安装脚本随 skill 一起放：
`$DSH_HOME/skills/harmonybrew/install-harmonybrew.mjs`。

## 三、其他可选组件

| 组件 | 位置 | 说明 |
|---|---|---|
| `session-memory` | 本仓库 [`session-memory/`](session-memory/README.md) | 跨会话检索（MCP 工具 + skill）：让 dsh 能回查"以前说过/做过什么"。索引在 dsh 进程外，库在沙箱本地 |

## 四、为什么这些不随包

随包（打进 hap）的代价是**每改一次就要重新 build + 装 hap**；而这几份 skill 的内容是**跟着实测环境走的**
——装了新工具、发现某条说明过时，就要马上改。把它们放进 hap，等于每次修一句话都要走一遍打包。

所以这里的约定是：

- **要跟着 hap 分发的**留在壳/版本目录里：dsh 包本身、OHOS 原生后端、启动时必须存在的资产；
- **"给 agent 看的知识"** 放本仓库 `skills/`，用户侧一条 `cp` 就能更新。

> 注：本仓库只管 dsh 侧。壳侧另有一份 `rawfile/skills/`（镜像给 `files/skills/`，rank 600）用于
> **必须随包**的 skill；本仓库这三个走上面的用户目录路径（rank 400），两者互不冲突。
