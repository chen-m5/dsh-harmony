#!/bin/sh
#
# 从上游 dsh 包目录产出「dsh-ohos-<版本>.zip」—— 本仓库的 dsh 侧组装链路。
#
# 做的三件事：
#   1. 应用补丁（对上游 0.1.7-rc.2 原件，git apply -p1，按文件名顺序）
#      补丁**不入库**：放在仓库内的 dsh-build/（已被 .gitignore 排除），
#      归档 dsh-build/dsh-patches.tar.gz 可解开到 dsh-build/patches/（默认就取这里）
#   2. 装纯 JS 图片后端：npm 只装 scripts/jimp-deps.json 里的种子包，
#      再按依赖闭包裁剪（scripts/trim-jimp.mjs），放到
#      <src>/node_modules/@deepseek-ai/dsh-attachment-local/node_modules/ 下
#   3. 打包成 zip（顶层目录 = <src> 的目录名）
#
# 用法：
#   scripts/build-dsh-package.sh --src /path/to/dsh-0.1.7-rc.2 [--out dsh-ohos-0.1.7-rc.2.zip] [--no-jimp]
#                                [--patches /path/to/dsh-patches]
#
# 前提：node / npm / zip 可用；<src> 是**未打补丁**的上游包（已打过会自动跳过）。
#
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# dsh 打包素材目录（在仓库内但被 .gitignore 排除）：
#   dsh-build/src/      上游 dsh 源目录（--src 的默认值，自备）
#   dsh-build/patches/  可重放的适配补丁（dsh-patches.tar.gz 解开的目录）
DSH_BUILD="$ROOT/dsh-build"
PATCHES_DIR="${DSH_PATCHES_DIR:-$DSH_BUILD/patches}"
# 默认源目录：dsh-build/src（不存在就留空，仍走 --src 必填校验）
#   ⚠ 别写成 SRC="$( [ -d … ] && echo … )" —— set -e 下目录不存在时那个赋值返回 1，脚本会直接退出
SRC=""
if [ -d "$DSH_BUILD/src" ]; then SRC="$DSH_BUILD/src"; fi
OUT=""
WITH_JIMP=1
TMP=""

while [ $# -gt 0 ]; do
  case "$1" in
    --src) SRC="$2"; shift ;;
    --out) OUT="$2"; shift ;;
    --no-jimp) WITH_JIMP=0 ;;
    --patches) PATCHES_DIR="$2"; shift ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
  shift
done

[ -n "$SRC" ] || { echo "--src 必填（dsh-<版本> 目录）" >&2; exit 2; }
SRC="$(cd "$SRC" && pwd)"
TOP="$(basename "$SRC")"
[ -d "$SRC/node_modules/@deepseek-ai/dsh" ] || { echo "$SRC 看起来不是 dsh 包目录（缺 node_modules/@deepseek-ai/dsh）" >&2; exit 1; }
[ -n "$OUT" ] || OUT="$ROOT/$TOP.zip"

# 注意用 if 而不是 `[ -n "$TMP" ] && …` —— 后者在 TMP 为空时返回 1，会把脚本的退出码盖成 1
cleanup() { if [ -n "$TMP" ]; then rm -rf "$TMP"; fi; }
trap cleanup EXIT INT TERM

echo "== 1/3 应用补丁 =="
if ! ls "$PATCHES_DIR"/*.patch >/dev/null 2>&1; then
  echo "找不到补丁：$PATCHES_DIR/*.patch" >&2
  echo "  · 补丁归档在仓库内的 dsh-build/dsh-patches.tar.gz（.gitignore 已排除）" >&2
  echo "  · 解开后用 --patches <目录> 指定，或设 DSH_PATCHES_DIR" >&2
  echo "  · 没有补丁就别继续：那会产出一个「没改造过」的包" >&2
  exit 2
fi
for p in "$PATCHES_DIR"/*.patch; do
  [ -e "$p" ] || continue
  name="$(basename "$p")"
  # 判定三态：能正着应用=新打；只能反着应用=已经打过（幂等）；都不行=真冲突（不要让构建悄悄过）
  if ( cd "$SRC" && git apply -p1 --check "$p" ) 2>/dev/null; then
    ( cd "$SRC" && git apply -p1 "$p" ) && echo "  · 已应用：$name"
  elif ( cd "$SRC" && git apply -p1 -R --check "$p" ) 2>/dev/null; then
    echo "  · 已经是打过补丁的状态，跳过：$name"
  else
    echo "  ✗ 补丁无法应用（既不是未打、也不是已打）：$name" >&2
    exit 3
  fi
done

echo "== 2/3 组装纯 JS 图片后端（精简 Jimp）=="
if [ "$WITH_JIMP" = 0 ]; then
  echo "  · --no-jimp：跳过"
else
  SEEDS="$(node -e 'const d=require(process.argv[1]);console.log(Object.entries(d.seeds).map(([k,v])=>k+"@"+v).join(" "))' "$ROOT/scripts/jimp-deps.json")"
  TMP="$(mktemp -d)"
  echo "  · npm install：$SEEDS"
  ( cd "$TMP" && npm install --no-audit --no-fund --no-save --no-package-lock --loglevel=error $SEEDS >/dev/null )
  node "$ROOT/scripts/trim-jimp.mjs" \
    --in "$TMP/node_modules" \
    --out "$SRC/node_modules/@deepseek-ai/dsh-attachment-local/node_modules"
fi

echo "== 3/3 打包 =="
rm -f "$OUT"
( cd "$(dirname "$SRC")" && zip -qr "$OUT" "$TOP" )
echo "  产物：$OUT（$(du -m "$OUT" | cut -f1) MiB，$(unzip -l "$OUT" | tail -1 | awk '{print $2}') 个条目）"
