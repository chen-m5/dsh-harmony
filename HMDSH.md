# HMDSH 使用说明

**HMDSH** 是承载 [dsh](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek Harness）的 HarmonyOS 壳。
本仓库（dsh-harmony）是它的 **dsh 侧适配** —— 把上游 dsh 包改成能在 `openharmony-arm64` 上跑，并产出随壳分发的包体；
壳本身（ArkTS 应用）在 [dsh-harmonyos-app](https://gitcode.com/chen-qiongmeng/dsh-harmonyos-app)。

这份说明面向**使用 HMDSH 的人**：怎么装起来、该装哪几个 skill，以及为什么这几个 skill 刻意不随包。

## 一、装与起

1. **壳（hap）**：从 dsh-harmonyos-app 构建安装。它内置一份已适配 `openharmony-arm64` 的 dsh 包
   （壳内的 `rawfile/pkg/dsh-ohos.zip`，由本仓库 `node scripts/build-dsh.mjs <版本>` 产出）。
2. **起 dsh**：在壳的「设置 → dsh 控制」里启停（Web UI 端口默认 `32100`，以你的配置为准）。
3. **要验证 dsh 侧的改动**：别重启正在用的实例 —— 另起一个临时进程，用**独立的 `DSH_HOME`** 和空闲端口，
   确认无报错后停掉并释放端口，再让正式实例重启。

## 二、建议装的三个 skill（**不随包**，从本仓库取）

dsh 的 skill 有两个根：

| 根 | rank | 谁维护 |
|---|---|---|
| `<沙箱>/files/skills/` | 600 | 壳按 hap 内的 `rawfile/skills/**` 镜像（即"随包注入"） |
| `<沙箱>/files/dsh-home/skills/` | 400 | 用户目录（dsh 里的 `$DSH_HOME/skills`），**放进去就生效**（热加载） |

下面三个 skill 刻意**不随包**，源码就在本仓库 `skills/` 下：

| skill | 干什么 |
|---|---|
| [`dsh-shell`](skills/dsh-shell/SKILL.md) | 这个沙箱长什么样：目录布局、壳提供了什么、能力边界（哪些命令有 / 没有）、`DSH_*` 变量的传递规则 |
| [`harmonybrew`](skills/harmonybrew/SKILL.md) | 缺工具怎么装：Homebrew 的鸿蒙移植、`brew install`，以及装完**必须补一个 `files/bin/<工具>` 包装脚本**（bottle 的 rpath 写死在上游 prefix，裸跑会报缺共享库）、已装工具清单 |
| [`dsh-plugin-install`](skills/dsh-plugin-install/SKILL.md) | 给 dsh 装 / 更新 skill 或插件的流程：先导出用户目录留退路 → 装 → 重启验证 → 失败用归档回滚 |

**安装**：把本仓库 `skills/` 下这三个目录拷进用户目录即可。

```sh
REPO=<你克隆本仓库的位置>
SK="$DSH_HOME/skills"        # dsh 里可直接用；等价于 <沙箱>/files/dsh-home/skills
mkdir -p "$SK"
cp -r "$REPO"/skills/dsh-shell "$REPO"/skills/harmonybrew "$REPO"/skills/dsh-plugin-install "$SK/"
```

rank 400 那个根是**实时扫描**的：放进去就生效，**不必重启 dsh，更不必重新打 hap**。
验证：看 dsh 的技能清单里出现这三个名字。

更新版本同理（覆盖后即时生效）。注意 `harmonybrew` 的安装脚本跟 skill 放在一起
（`$SK/harmonybrew/install-harmonybrew.mjs`），拷贝时别漏。

## 三、其他可选组件

| 组件 | 位置 | 说明 |
|---|---|---|
| `session-memory` | 本仓库 [`session-memory/`](session-memory/README.md) | 跨会话检索（MCP 工具 + skill）：让 dsh 能回查"以前说过 / 做过什么"。索引跑在 dsh 进程之外，库在沙箱本地 |

## 四、为什么这几个不随包

随包（打进 hap）的代价是**每改一次都要重新 build + 装 hap**；而这几份 skill 的内容是跟着**实测环境**走的
—— 装了新工具、发现某条说明过时，就要马上改。放进 hap，等于每修一句话都走一遍打包。

所以这里的约定是：

- **要跟 hap 分发的**留在壳 / 版本目录里：dsh 包本身、OHOS 原生后端、启动时必须存在的资产；
- **"给 agent 看的知识"** 放本仓库 `skills/`，用户侧一条 `cp` 就能更新。

> 壳侧另有 `rawfile/skills/`（镜像到 `<沙箱>/files/skills/`，rank 600），留给**必须**跟 hap 一起走的 skill；
> 本仓库这三个走用户目录（rank 400），两者互不冲突。
