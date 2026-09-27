#!/bin/sh
#
# 一条命令打包：把本仓库里的 dsh 源码树打成 HarmonyOS 壳可直接用的 zip。
#
#   sh scripts/pack.sh [输出路径]
#
# 默认读取 ./dsh-<版本>/（源码树，含 node_modules），
# 产出 ./dsh-ohos-<版本>.zip（壳的「导入包目录」或内置 rawfile/pkg/ 都能用）。
#
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC=""
for d in "$ROOT"/dsh-*; do
  [ -f "$d/node_modules/@deepseek-ai/dsh/lib/bin.js" ] && { SRC="$d"; break; }
done
if [ -z "$SRC" ]; then
  echo "找不到 dsh 源码树：期望 ./dsh-<版本>/node_modules/@deepseek-ai/dsh/lib/bin.js" >&2
  exit 1
fi
VER="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
       "$SRC/node_modules/@deepseek-ai/dsh/package.json" | head -1)"
[ -n "$VER" ] || { echo "读不到 dsh 版本（$SRC/node_modules/@deepseek-ai/dsh/package.json）" >&2; exit 1; }
OUT="${1:-$ROOT/dsh-ohos-$VER.zip}"
echo "== 源码树：${SRC#"$ROOT"/}（版本 $VER）=="
echo "== 输出：$OUT =="
sh "$ROOT/scripts/build-dsh-package.sh" --src "$SRC" --patches "$ROOT/patches" --no-jimp --out "$OUT"
echo "== 完成：$OUT =="
