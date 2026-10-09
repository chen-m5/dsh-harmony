#!/bin/sh
# session-memory 同步：沙箱提取 → **本地**入库（node:sqlite）→ 提交游标（两阶段）
#
# 用法:
#   sh sync.sh                    # 增量（默认；只处理变了的部分）
#   sh sync.sh --full             # 全量重建（忽略游标）
#   sh sync.sh --since-days 30    # 只处理最近 30 天动过的会话
#   sh sync.sh --max-sessions 20  # 分批限速：本次最多处理 20 个会话，其余下轮继续
#   sh sync.sh --no-ingest        # 只提取，不入库（排查用）
#
# 位置约定（2026-10-09 第二版：库从 VM 搬回沙箱本地）：
#   · 服务本体（本脚本 / mcp-server.mjs / store.mjs / ingest.mjs / extract.mjs / cursor.json）
#     在共享盘 `Documents/mcp-service/session-memory/`，与 vm、deveco、agent-server 并列；
#   · **库在沙箱本地**：$SESSION_MEMORY_DB（默认 files/session-memory/memory.db）。
#     实测本地查询 0.1–2.8ms；库放 VM 时每次调用要付 450–600ms 的 ssh 往返。
#     库是可丢弃的派生数据，删掉重跑 `sh sync.sh --full` 即可重建。
#   · 大临时文件（out.ndjson）落沙箱 TMP_DIR，不占共享盘。
#
# 纪律：本脚本只读会话日志、只写自己的库，且是**独立进程** —— 绝不进 dsh 的事件循环。
# （第一版把索引做进 dsh 进程，主线程同步对账 20 秒，界面冻住、会话列表都拉不出来。）
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NODE="${SESSION_MEMORY_NODE:-/data/storage/el2/base/haps/entry/files/node/node}"
TMP_DIR="${SESSION_MEMORY_TMP:-/data/storage/el2/base/haps/entry/files/.session-memory-tmp}"

mkdir -p "$TMP_DIR"
OUT="$TMP_DIR/out.ndjson"

# 跨进程互斥：MCP 触发的同步与你手工跑的 sync.sh 可能撞在一起。
# 抢不到锁就直接跳过 —— 免得白跑一次提取（84 MB 要 6 秒），也免得两个写者互相等。
# 用 mkdir 做原子锁（POSIX 语义），锁目录里记 pid，持有者已死则视为陈旧锁清掉。
LOCK="${SESSION_MEMORY_LOCK:-$TMP_DIR/.sync-lock}"
acquire_lock() {
  if mkdir "$LOCK" 2>/dev/null; then echo $$ > "$LOCK/pid"; return 0; fi
  holder=$(cat "$LOCK/pid" 2>/dev/null || echo "")
  if [ -n "$holder" ] && [ -d "/proc/$holder" ]; then return 1; fi
  rm -rf "$LOCK" 2>/dev/null || true
  if mkdir "$LOCK" 2>/dev/null; then echo $$ > "$LOCK/pid"; return 0; fi
  return 1
}
if ! acquire_lock; then
  echo "[sync] skipped: another sync is running (pid $(cat "$LOCK/pid" 2>/dev/null || echo '?'))"
  exit 0
fi
trap 'rm -rf "$LOCK"' EXIT INT TERM

# 除 --no-ingest 外，其余参数原样透传给 extract.mjs（它认识 --full / --since-days / --max-sessions）
DO_INGEST=1
PASS_ARGS=""
for arg in "$@"; do
  case "$arg" in
    --no-ingest) DO_INGEST=0 ;;
    *) PASS_ARGS="$PASS_ARGS $arg" ;;
  esac
done

echo "[sync] 提取中（沙箱独立进程）…"
EXTRACT_OUT=$(cd "$HERE" && $NODE extract.mjs --out "$OUT" --cursor "$HERE/cursor.json" $PASS_ARGS)
echo "$EXTRACT_OUT"

ENTRIES=$(printf '%s' "$EXTRACT_OUT" | sed -n 's/.*"entries": *\([0-9]*\).*/\1/p')

if [ ! -f "$HERE/cursor.json.next" ]; then
  echo "[sync] 没有产出游标，终止" >&2
  exit 1
fi

if [ "${ENTRIES:-0}" -gt 0 ] && [ "$DO_INGEST" = "1" ]; then
  echo "[sync] 入库（$ENTRIES 条，本地 node:sqlite）…"
  T0=$(date +%s)
  INGEST_OUT=$($NODE "$HERE/ingest.mjs" "$OUT")
  echo "[sync] 入库结果: $INGEST_OUT"
  # 注意：沙箱的 sh 是 toybox，别写 $(($(date +%s)-T0)) 那种嵌套算术（会被解析坏）
  T1=$(date +%s)
  echo "[sync] 入库耗时: $((T1 - T0))s"
else
  echo "[sync] 无新内容，跳过入库"
fi

# 两阶段提交：入库成功后才认这个游标
mv "$HERE/cursor.json.next" "$HERE/cursor.json"
rm -f "$OUT"
echo "[sync] 游标已提交: $HERE/cursor.json"
