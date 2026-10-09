---
name: dsh-plugin-install
description: 给 dsh（HarmonyOS 壳）装/更新 skill 或插件时要走的流程：先导出用户目录（留退路）→ 装 → 重启 dsh 验证 → 失败则用导出归档导入回滚并做失败现场包。判断「这是 skill 还是插件」、安装路径（仓库分发 / 随包注入 / 打进 dsh 包）、校验清单与常见坑，以及起不来时怎么把现场交给 AI 分析。当用户说「装个 skill / 装个插件 / 加个能力」或装完 dsh 起不来时阅读。
---

> **职责边界**：dsh 侧的改造与打包在 [dsh-harmony](https://gitcode.com/chen-qiongmeng/dsh-harmony) 仓库（每版独立的 `scripts/`）；
> 本技能只管**壳侧**的适配、装入与验证。

# 装 skill / 插件（HarmonyOS 壳）

> **这个 skill 自己装在用户目录**（不是随包注入）：`<沙箱>/files/dsh-home/skills/dsh-plugin-install/`
> —— 也就是 dsh 的 **user-dsh 根**（`$DSH_HOME/skills`，rank 400）。
> **2026-10-10 起 HMDSH 内不再保留 `skills/` 副本** —— 这份 `$DSH_HOME/skills/dsh-plugin-install/` 就是权威源本身。
>
> ```sh
> 要在别的机器上复现：直接把本目录拷进新机器的 `$DSH_HOME/skills/` 即可（放进去就生效，不用重启）。
> ```
>
> 下面讲的"随包注入"是给**别的** skill 用的路径（进 hap、由壳镜像到 `<沙箱>/files/skills/`）。

这个壳里「装东西」有两类，**先判断是哪一类，再动手**：

| 类型 | 是什么 | 装到哪 | 生效方式 |
|---|---|---|---|
| **skill** | 一个目录，含 `SKILL.md`（+ 任意资源） | `<沙箱>/files/skills/<名字>/` | 重启 dsh |
| **插件 / 依赖包** | 改 dsh 自己的代码或给它加 npm 依赖 | **dsh 包**（`files/dsh-pkg/node_modules/…`） | 改包 → 重打 zip → 重启 |

判别：目录里有 `SKILL.md` → skill；有 `package.json` / 要改 dsh 的 JS → 插件。

---

## 一、skill 的注入机制（`DSH_BUNDLED_SKILL_DIR`）

- 壳把 **`rawfile/skills/**`** 逐字节镜像到 **`<沙箱>/files/skills/**`**，并在启动 dsh 时注入
  `DSH_BUNDLED_SKILL_DIR=<沙箱>/files/skills`；dsh 的 `skill-filesystem` 按 **rank 600** 扫它。
- 清单由构建脚本生成（`rawfile/skills/manifest.txt`），壳按「清单 ∪ 递归发现」同步；
  只增改 + **只删自己放过的文件**（记账在 `files/skills/.dsh-mirrored`），手工塞进去的不碰。
- 两种落地方式：
  - **仓库分发（推荐）**：放 dsh-harmony 仓库的 `skills/`，用户侧 `cp` 到 `$DSH_HOME/skills/` —— 改 skill 不必重打 hap（见该仓库 `HMDSH.md`）
  - **随包注入（仅"必须跟 hap 分发"的 skill）**：放进 HMDSH 应用的 `entry/src/main/resources/rawfile/skills/<名字>/`（改它要重打 HMDSH），由壳镜像到 `<沙箱>/files/skills/`
    → `scripts/build-hap.sh` → 装 hap → 重启。
  - **只在本机试**：直接写到 `<沙箱>/files/skills/<名字>/`（持久目录）→ 重启 dsh 即可；
    但它不在包里，换机/清数据就没了，也不会被 `.dsh-mirrored` 记账。
- ⚠ 点文件（如 `.manifest`）**不会被打进 hap** —— 需要进包的辅助文件别用 `.` 开头。

## 二、安装流程（双重保险，照这个顺序做）

1. **先导出用户目录**（坏 skill 会让 dsh 起不来，这是退路）：
   设置 → 用户目录 →「导出」→ 选一个文档目录下的位置 → 得到 `dsh-home-<时间戳>.tar.gz`。

   命令行等价写法：

   ```sh
   S=/data/storage/el2/base/haps/entry/files
   DEST=/storage/Users/currentUser/Documents          # 导到共享盘：看得见、拿得走、换机还在
   cd "$S" && tar czf "$DEST/dsh-home-$(date +%Y%m%d-%H%M%S).tar.gz" dsh-home
   ```

   - 归档落在**共享盘**（`/storage/Users/...`），不在沙箱内部 —— 清数据/换机都还在，也能直接发给 AI 或别人。
   - ⚠ **沙箱内的「备份目录」与设置里的备份下拉已移除**（2026-09-30）：别再 `cp` 到
     `files/backups/`，那个目录不会再被任何界面管理（列不出、恢复不了），纯粹白占沙箱空间。
   - 回滚时用这个归档**导入**（见第 6 步）。
2. **装 skill**（仓库侧）：`scripts/install-skill.sh --from <目录|tar.gz|.tgz|.zip> [--name <名字>]`
   —— 它校验 `SKILL.md`、备份同名 skill 到 `.skill-backup/`、并刷新 `manifest.txt`。
   （直接手放 `rawfile/skills/<名字>/` 也行，但记得**自己更新清单**：跑一次 `build-hap.sh` 即可。）
3. **出包 + 安装**：`scripts/build-hap.sh`（全内置；配了签名会同时产出 `-signed.hap`，可直接装，
   否则只有 `-unsigned.hap`，要自己签一遍）→ 装到设备。
4. **启动验证**（"启动一个服务验证"就是这一步）：重启 dsh，然后
   - 沙箱里看日志：`tail -n 40 <沙箱>/logs/dsh.log`；
   - 端口探活：`curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:32100/`（应得 200/302）。
5. **成功**：核对 skill 已被扫到（见第四节校验清单）。
6. **失败（装不上 / 起来不）→ 回滚**：
   - skill：`scripts/install-skill.sh --restore <名字>`；
   - **用户目录：用第 1 步导出的归档** —— 设置 → 用户目录 →「导入」→ 选中那个 `.tar.gz`
     （会覆盖当前用户信息，需二次确认）；
   - 重启 dsh 确认恢复。

## 三、失败现场包（交给 AI 分析用）

起不来时，**在沙箱里**打一个现场包放进 dsh 工作区（工作区就是 dsh 的 cwd，`<沙箱>/files/workspace`），
然后让用户说一句「分析 `dsh-install-failed/` 这个目录」，AI 就能直接读：

```sh
set -e
S=<沙箱>/files            # /data/storage/el2/base/haps/entry/files
D=$S/workspace/dsh-install-failed
rm -rf "$D"; mkdir -p "$D"
[ -d "$S/skills" ] && (cd "$S" && tar czf "$D/skills-now.tar.gz" skills)   # 当前（坏的）skill 目录
[ -f "$S/logs/dsh.log" ] && cp "$S/logs/dsh.log" "$D/"                     # 失败日志
cp -f /path/to/被安装的包 "$D/" 2>/dev/null || true
{
  echo "# dsh 安装失败现场"
  echo "时间: $(date)"
  echo "装了什么: <包名/来源>"
  echo "现象: <没起来 / 报错原文>"
  echo
  echo "## 先看"
  echo "1. dsh.log 里的报错（尤其启动阶段的 stack）"
  echo "2. skills-now.tar.gz 里那个新 skill 的 SKILL.md front-matter 是否合法"
  echo "3. 若是插件：dsh 包里 node_modules 是否缺依赖 / 版本冲突"
} > "$D/README.md"
ls -la "$D"
```

常见原因（先按这个顺序怀疑）：

- `SKILL.md` 的 front-matter 不合法（缺 `name`/`description`、`---` 不配对、YAML 里冒号没引号）；
- skill 名字与已有 skill 冲突，或含非法字符（只允许字母数字 `.` `_` `-`）；
- 包里没有 `SKILL.md`（放错层级），或引用了不存在的资源文件；
- 把**插件**当 skill 装（`package.json` 那类要打进 dsh 包，见第五节）；
- 清单陈旧：手工加了文件但没重新构建，壳读的还是旧清单；
- 插件路径的坑：给 dsh 包加依赖时**别删上游目录里的 `src/`**（有些包的入口就在 `src/index.js`，例如 `debug@4`），
  否则会连累 `file-type` 这类依赖在运行期崩掉。
- **`dsh plugin … add` 必须加 `-w`**：包里带 `pnpm-workspace.yaml`，不加会报 `ERR_PNPM_ADDING_TO_ROOT`
  （`-w` 会被透传给 pnpm 作 `--workspace-root`）。

## 四、校验清单（装完逐条核）

```sh
S=<沙箱>/files
ls -l  "$S/skills/<名字>/SKILL.md"        # 1) 文件到位
cat    "$S/skills/.dsh-mirrored" | grep <名字>   # 2) 壳记账里有它（说明是镜像过来的）
# 3) 与源逐字节一致（仓库侧执行）
sha256sum rawfile/skills/<名字>/SKILL.md "$S/skills/<名字>/SKILL.md"
tail -n 40 "$S/logs/dsh.log"              # 4) 启动无报错
```

## 五、插件（改 dsh 自己）怎么装

不能只改沙箱里 `files/dsh-pkg/...` 的解压副本（换包/重装会被覆盖）。正确做法：

> 走 `dsh plugin` 装 npm 包时**一定加 `-w`**：
> `dsh plugin --profile <面> add -w <包>[@<版本>]`
> 包目录里有 `pnpm-workspace.yaml`，不加 `-w` 会直接报 `ERR_PNPM_ADDING_TO_ROOT`（`-w` 透传给 pnpm 作
> `--workspace-root`）。

1. 改**改过的那个文件**：dsh 侧的改造在 [dsh-harmony](https://gitcode.com/chen-qiongmeng/dsh-harmony)
   的 `<版本>/files/`（整文件替换，保留包内相对路径）；新文件就放进去，并同步
   `<版本>/manifest.json` 的 `replace`（含官方原文件与改造版的 sha256）——
   该改哪个文件、为什么，看 `<版本>/CHANGES.md`；
2. 在 dsh-harmony 里重打 zip：`node scripts/build-dsh.mjs <版本> [--out <zip>]`
   （校验 → 替换 → 资产 → bin → 打包 → 自检）；
3. 把 zip 放到 Release（`PKG_URL` 指的位置）或内置 `rawfile/pkg/`；
4. 重启 dsh 让它换包（内置 zip 大小变了壳会自动重解压）。
