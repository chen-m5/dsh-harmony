# session-memory —— dsh 的跨会话检索（可选组件）

给 dsh 加一层「回查历史会话」的能力：三个 MCP 工具 + 一个使用纪律 skill。dsh 本身在会话结束就忘了
一切，这个组件让它能回答「这个项目上次是怎么处理的」「我之前定的规范是什么」，并且是**查出来的**、
不是猜出来的。

> **本目录不参与 dsh 包打包。** 它是独立组件：仓库只承担「开源存放源码」这件事，
> `<版本>/manifest.json`、`<版本>/CHANGES.md` 管的是 dsh 包本身，与这里无关。
> 想要就直接取用（见下面「安装」），不影响任何打包产物。

## 组成

```
session-memory/
├── mcp-server.mjs      stdio MCP server：暴露 session_search / session_recall / session_list
├── store.mjs           存储与查询层（node:sqlite + FTS5）：schema、入库、分层检索、重排、片段
├── extract.mjs         增量提取器：读 dsh 会话日志（追加式 zstd 帧），按文件字节偏移切片
├── ingest.mjs          NDJSON → 本地库（CLI，被 sync.sh 调用）
├── sync.sh             提取 → 入库 → 提交游标（两阶段；失败不留半截游标）
└── skills/session-memory/SKILL.md   使用纪律（什么时候必须查、怎么读结果才不被误导）
```

无第三方依赖：只用 Node 内置的 `node:sqlite`（含 FTS5）、`node:zlib`（zstd）、`node:child_process`。
实测环境 Node 24。

## 安装

1. **放脚本**：把本目录拷到任意位置（例如 `~/dsh-extras/session-memory/`）。
2. **挂 MCP**：在 profile 的 `cordis.patch.yml`（`$DSH_HOME/profiles/<面>/cordis.patch.yml`）里加一条：

   ```yaml
   - insert:
       - id: mcp-session-memory
         name: "@deepseek-ai/dsh-mcp-client"
         config:
           serverName: session_memory
           transport: stdio
           command: /absolute/path/to/node
           args: [ "/absolute/path/to/session-memory/mcp-server.mjs" ]
           toolCallTimeoutMs: 120000
   ```
   重启 dsh，工具名会变成 `mcp__session_memory__session_search` 等。
3. **装 skill**（可选但推荐）：把 `skills/session-memory/` 放进 `$DSH_HOME/skills/`
   （user-dsh 根，rank 400，**放进去实时生效、不必重启**）。
4. **建库**：`sh sync.sh --full`（首次；之后平时不用手动跑，工具调用会按 TTL 自动增量同步）。

环境变量（都有默认值）：`SESSION_MEMORY_DB`（库路径）、`SESSION_MEMORY_SYNC_TTL_MS`（默认 60000）、
`SESSION_MEMORY_TMP`（大临时文件目录）、`SESSION_MEMORY_NODE`（node 可执行文件）。

## 数据流

```
沙箱（都在 dsh 进程之外）               本机库
extract.mjs  ──► ingest.mjs  ──►  memory.db（SQLite FTS5）
   ↑ 只读 $DSH_HOME/sessions/**              ↑
mcp-server.mjs ──── 查询 ────────────────────┘   ← dsh 以 stdio 子进程方式启动它
```

三条刻意的设计约束：

- **重活不进 dsh 的事件循环**。索引（读全部会话日志、建 FTS）跑在 `sync.sh` 这个独立进程里；
  查询是纯 `SELECT`（毫秒级）。曾经有一版把索引做进 dsh 进程内（用 dsh 自带的
  `session-query-sqlite`），那个后端的对账是**主线程同步、不可中断**的，20 秒把界面冻住了。
- **启动不依赖任何外部**：MCP server 起来时只解析参数，连库都推迟到第一次调用才打开。
- **库是可丢弃的派生数据**：删掉 + 删 `cursor.json` + `sh sync.sh --full` 就重建。
  会话原始日志（`$DSH_HOME/sessions/`）永远只读，从不被改写。

## 检索设计

| 设计 | 为什么 |
|---|---|
| **分层检索**：先搜"当前工作区"，命中即停；没命中才自动扩大到全局，并**在结果里标明范围** | 多数问题是"这个项目之前怎么处理的"；但"别处怎么解决的"也不能漏。范围必须写出来，否则分不清"真没有"和"只搜了本区" |
| **当前工作区靠推断**：取最近一条事件所属的 cwd | dsh 不把会话 cwd 告诉 MCP（`tools/call` 只有 name/arguments），所以只能用"最近活跃"来推；可用 `cwd` 参数显式覆盖 |
| **入库时打工作区标记**（`events.workspace` + 索引） | cwd 是完整长路径，拿它做子串匹配既用不上索引、又会把 `a/b` 和 `a/b/c` 混成一个工作区。归一到项目粒度后可以精确匹配走索引 |
| **CJK 逐字拆开 + unicode61** | FTS5 自带的 `trigram` 分词器最短要 3 个字，中文常用词多是 2 字（"会话"、"插件"实测查不到）；`unicode61` 又完全不切中文 |
| **多词 AND 无命中 → 自动放宽为 OR**，并标注 `⚠ 已放宽` | 多词查询最容易"一个词没命中就全盘落空"；但放宽后必须说明，免得当成精确命中 |
| **相关度 70% + 时间近因 30%（半衰期 14 天）重排** | "上次那个结论"这类问题里，新近的事往往比"更相关但很老"的事有用 |
| **按会话分组**（每会话默认 2 条，`limit` = 会话数） | 先看"哪些会话相关"，再决定深入哪个；避免命中最多的会话刷满结果 |
| **片段给位置、recall 给对话锚点** | `片段在第 236/307 字符` 让人判断要不要读全文；recall 附带"这一轮的用户消息 + 其后助手回复"，才知道那句话是在什么语境下说的 |

## 已知边界

- 只索引 dsh 会话日志里的 4 类事件（用户消息、助手消息、工具调用、工具结果）；
  注入的运行时上下文、提醒块、只读命令本身、短于 24 字符的工具结果**不入库**。
- 单条截断：用户消息 8K / 助手消息 12K / 工具结果 16K 字符（超长输出的后半段查不到）。
- 检索是**字面匹配**（FTS5 短语 + AND/OR），不是语义检索 —— 命中就意味着原文确实有这些字词，
  这一点比向量召回更可核对，但也意味着同义改写查不到。
- 新鲜度：默认最多 60 秒延迟（TTL 到点才增量同步）。
