/**
 * session-memory 存储与查询层（沙箱本地版，node:sqlite + FTS5）
 *
 * 为什么不是 python + ssh 了：库放在本机时，查询是"打开文件 + FTS 匹配"，实测毫秒级
 * （中文 2 字查询 2.2–2.8ms、英文 0.4ms、recall 0.1ms），比走 ssh 到 VM 快 10–20 倍，
 * 而且不依赖网络与私钥、会话文本不出设备。
 *
 * 这个 schema 是本项目**唯一**的定义（`workspace` 列就是在这里加的）；
 * 第一版放在 VM 的 `ingest.py` / `query.py` 已随那份库一起删除，不再需要保持同步。
 * 检索语义沿用第一版的决策（AND→OR 放宽、按会话分组、相关度+时间近因重排、对话锚点），
 * 并新增了**工作区标记**与**分层检索**。
 *
 * 一个必须守住的纪律：本模块只做"本地文件读写"，绝不碰 dsh 的任何服务或事件循环。
 * 它被独立进程调用（sync 时是 ingest.mjs，查询时是 mcp-server.mjs），所以再慢也只是
 * 那一次调用慢 —— 上一版把索引做进 dsh 进程里，主线程同步对账 20 秒把界面冻住了。
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_DB = process.env.SESSION_MEMORY_DB
  || '/data/storage/el2/base/haps/entry/files/session-memory/memory.db'

/**
 * 库的 schema（本项目唯一定义）。
 * 老库若缺 `workspace` 列，由 migrateWorkspace() 自动补列回填；想彻底重来就删库+删游标再 `sh sync.sh --full`。
 */
const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS sessions(
  session_id TEXT PRIMARY KEY,
  cwd        TEXT,
  workspace  TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  events     INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events(
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  type       TEXT,
  time       INTEGER,
  cwd        TEXT,
  workspace  TEXT,
  text       TEXT,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS events_time ON events(time);
-- events_workspace 的索引不写在这里：老库需要先 ALTER 补列，统一交给 migrateWorkspace()
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(text_idx, tokenize='unicode61');
CREATE TABLE IF NOT EXISTS state(k TEXT PRIMARY KEY, v TEXT);
`

const CJK = /([\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af])/g
const SPLIT = /[\s,，、;；]+/
const FTS_NOISE = /["'()*:^-]/g

// 重排权重：相关度为主、新鲜度为辅（半衰期 14 天）
const RELEVANCE_WEIGHT = 0.7
const RECENCY_WEIGHT = 0.3
const RECENCY_HALFLIFE_MS = 14 * 86400_000
const CANDIDATE_POOL = 400

/** CJK 逐字拆开加空格 —— 必须与 extract/入库时的处理一致，也决定"中文 1 个字也能查"。 */
export function toIdx(text) {
  return String(text ?? '').replace(CJK, ' $1 ')
}

function splitTerms(query) {
  return String(query ?? '').trim().split(SPLIT).filter(Boolean)
}

/** 查询串 → FTS5 MATCH 表达式；词内短语、词间 AND/OR。无法构造时返回 null。 */
export function toMatch(query, mode = 'and') {
  const terms = []
  for (const part of splitTerms(query)) {
    const cleaned = part.replace(FTS_NOISE, ' ').trim()
    if (!cleaned) continue
    const t = toIdx(cleaned).split(/\s+/).filter(Boolean)
    if (!t.length) continue
    terms.push(t.length > 1 ? `"${t.join(' ')}"` : t[0])
  }
  if (!terms.length) return null
  return terms.join(mode === 'and' ? ' AND ' : ' OR ')
}

/** LIKE 子串模式（故意不转义 % 和 _：路径/查询里几乎不会出现，宽松一点反而召回更好）。 */
export function likePattern(value) {
  return `%${String(value ?? '')}%`
}

/**
 * 工作区标记：把长路径归一成"项目"粒度 —— `ohos/<应用>`、`java/<服务>`、`python`。
 * 本机会话的 cwd 都形如 `.../Documents/git/<相对路径>`，所以取 `git/` 之后的部分。
 *
 * 为什么要归一而不是直接用整条 cwd：
 *   · 精确匹配（`workspace = ?`）能走索引，子串 `LIKE '%…%'` 走不了；
 *   · 语义上 `git/java` 与 `git/java/jincai-ui` 是两个工作区，子串匹配会把它们混在一起。
 * 显式传 `cwd` 参数时仍走子串匹配（调用方可能只记得仓库名片段）。
 */
export function workspaceOf(cwd) {
  const p = String(cwd ?? '').trim()
  if (!p) return ''
  const m = p.match(/(?:^|\/)git\/(.+)$/)
  if (m) return m[1].replace(/\/+$/, '')
  const parts = p.split('/').filter(Boolean)
  return parts.slice(-2).join('/') || p
}

/**
 * 老库补 workspace 列 + 回填 + 建索引（幂等）。
 * schema 变更就是"入库时打标记"的落地：新库由 SCHEMA 直接带列，老库在这里补齐，
 * 两边结果一致，所以不需要重建库。
 */
function migrateWorkspace(db) {
  const eventCols = db.prepare('PRAGMA table_info(events)').all().map((c) => c.name)
  if (!eventCols.includes('workspace')) {
    db.exec('ALTER TABLE events ADD COLUMN workspace TEXT')
    const rows = db.prepare('SELECT rowid AS rid, cwd FROM events').all()
    db.exec('BEGIN IMMEDIATE')
    try {
      const upd = db.prepare('UPDATE events SET workspace=? WHERE rowid=?')
      for (const r of rows) upd.run(workspaceOf(r.cwd), r.rid)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
  const sessionCols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name)
  if (!sessionCols.includes('workspace')) {
    db.exec('ALTER TABLE sessions ADD COLUMN workspace TEXT')
    for (const r of db.prepare('SELECT session_id, cwd FROM sessions').all()) {
      db.prepare('UPDATE sessions SET workspace=? WHERE session_id=?').run(workspaceOf(r.cwd), r.session_id)
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS events_workspace ON events(workspace)')
}

export function openDb(file = DEFAULT_DB) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // timeout：并发写时**等待**而不是立刻抛 "database is locked"。
  // 手工跑 sync.sh 与 MCP 触发的同步撞在一起是真会发生的（实测两个 ingest 并发时第二个失败）。
  const db = new DatabaseSync(file, { timeout: 30_000 })
  db.exec(SCHEMA)
  migrateWorkspace(db)
  return db
}

/* ── 入库 ─────────────────────────────────────────────────────────────── */

/**
 * 写入一批事件（幂等：同一 (session_id, seq) 先删后插，FTS 的 rowid 一起同步）。
 * rows: [{ sessionId, cwd, createdAt, seq, type, time, text }]
 * 返回写入条数。
 */
export function ingest(db, rows, { batch = 500 } = {}) {
  let written = 0
  const sessions = new Map()
  const flush = (buf) => {
    if (!buf.length) return
    // 必须是 IMMEDIATE：WAL 下 deferred 事务"先读后升级写"会撞成 SQLITE_BUSY（读快照已过期，
    // 等锁也救不了）；一开始就取写锁，第二个写者才会老老实实按 timeout 排队。
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const r of buf) {
        const old = db.prepare('SELECT rowid AS rid FROM events WHERE session_id=? AND seq=?')
          .get(r.sessionId, r.seq)
        if (old) {
          db.prepare('DELETE FROM events_fts WHERE rowid=?').run(old.rid)
          db.prepare('DELETE FROM events WHERE rowid=?').run(old.rid)
        }
        const info = db.prepare(
          'INSERT INTO events(session_id,seq,type,time,cwd,workspace,text) VALUES(?,?,?,?,?,?,?)')
          .run(r.sessionId, r.seq, r.type ?? '', Number(r.time ?? 0), r.cwd ?? '',
            workspaceOf(r.cwd), r.text ?? '')
        db.prepare('INSERT INTO events_fts(rowid,text_idx) VALUES(?,?)')
          .run(info.lastInsertRowid, toIdx(r.text))
        written += 1
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }

  let buf = []
  for (const r of rows) {
    buf.push(r)
    const prev = sessions.get(r.sessionId)
    if (prev) prev.n += 1
    else sessions.set(r.sessionId, {
      cwd: r.cwd ?? '', workspace: workspaceOf(r.cwd), createdAt: Number(r.createdAt ?? 0), n: 1,
    })
    if (buf.length >= batch) { flush(buf); buf = [] }
  }
  flush(buf)

  const now = Date.now()
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const [sid, meta] of sessions) {
      db.prepare(`INSERT INTO sessions(session_id,cwd,workspace,created_at,updated_at,events)
                  VALUES(?,?,?,?,?,?)
                  ON CONFLICT(session_id) DO UPDATE SET
                    cwd=excluded.cwd,
                    workspace=excluded.workspace,
                    updated_at=excluded.updated_at,
                    events=(SELECT COUNT(*) FROM events WHERE session_id=excluded.session_id)`)
        .run(sid, meta.cwd, meta.workspace, meta.createdAt, now, meta.n)
    }
    db.prepare("INSERT INTO state(k,v) VALUES('last_ingest',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
      .run(String(now))
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return written
}

/* ── 查询 ─────────────────────────────────────────────────────────────── */

/** 把工作区过滤条件拼进 SQL：优先精确匹配 workspace（走索引），显式 cwd 才用子串匹配。 */
function applyFilter(sql, params, filter, col) {
  const p = col ? `${col}.` : ''
  if (filter?.workspace) {
    sql += ` AND ${p}workspace = ?`
    params.push(filter.workspace)
  } else if (filter?.cwdLike) {
    sql += ` AND ${p}cwd LIKE ?`
    params.push(likePattern(filter.cwdLike))
  }
  return sql
}

function ftsRows(db, match, filter, session, pool = CANDIDATE_POOL) {
  if (!match) return []
  let sql = `SELECT e.rowid AS rid, e.session_id, e.seq, e.type, e.time, e.cwd, e.workspace, e.text,
                    s.created_at AS created_at, rank AS r
             FROM events_fts f
             JOIN events e ON e.rowid = f.rowid
             LEFT JOIN sessions s ON s.session_id = e.session_id
             WHERE events_fts MATCH ?`
  const params = [match]
  sql = applyFilter(sql, params, filter, 'e')
  if (session) { sql += ' AND e.session_id = ?'; params.push(session) }
  sql += ' ORDER BY rank LIMIT ?'
  params.push(pool)
  try {
    return db.prepare(sql).all(...params)
  } catch {
    return []
  }
}

function likeRows(db, query, filter, session, pool = CANDIDATE_POOL) {
  let sql = `SELECT rowid AS rid, session_id, seq, type, time, cwd, workspace, text,
                    NULL AS created_at, 0.0 AS r
             FROM events WHERE text LIKE ?`
  const params = [likePattern(String(query).trim())]
  sql = applyFilter(sql, params, filter, '')
  if (session) { sql += ' AND session_id = ?'; params.push(session) }
  sql += ' ORDER BY time DESC LIMIT ?'
  params.push(pool)
  return db.prepare(sql).all(...params)
}

/** 相关度 + 时间近因的综合分（越大越靠前）；FTS 的 rank 越小越相关。 */
function rescore(rows, nowMs) {
  return rows
    .map((r) => {
      const relevance = -Number(r.r ?? 0)
      const relNorm = relevance > 0 ? relevance / (relevance + 1) : 0
      const age = Math.max(0, nowMs - Number(r.time ?? nowMs))
      const recency = Math.exp(-age / RECENCY_HALFLIFE_MS)
      return { score: RELEVANCE_WEIGHT * relNorm + RECENCY_WEIGHT * recency, row: r }
    })
    .sort((a, b) => b.score - a.score)
}

/** 每个会话最多 perSession 条，组间按组内最高分排序。 */
function groupBySession(scored, perSession, limitSessions) {
  const groups = new Map()
  for (const item of scored) {
    const sid = item.row.session_id
    const list = groups.get(sid) ?? []
    if (list.length < perSession) list.push(item)
    groups.set(sid, list)
  }
  const ordered = [...groups.values()].sort((a, b) => b[0].score - a[0].score)
  return { picked: ordered.slice(0, limitSessions).flat(), sessionsMatched: groups.size }
}

/** 片段：优先围绕命中词取窗口，并回报命中位置（调用方据此判断要不要读全文）。 */
function snippetOf(text, query, width = 320) {
  const src = String(text ?? '')
  if (!src) return { snippet: '', matchPos: null }
  const words = splitTerms(query).filter((w) => w.length >= 2).sort((a, b) => b.length - a.length)
  const low = src.toLowerCase()
  for (const w of words) {
    const pos = low.indexOf(w.toLowerCase())
    if (pos >= 0) {
      const start = Math.max(0, pos - Math.floor(width / 3))
      return {
        snippet: (start ? '…' : '') + src.slice(start, start + width).replace(/\s+/g, ' '),
        matchPos: pos,
      }
    }
  }
  return { snippet: src.slice(0, width).replace(/\s+/g, ' '), matchPos: 0 }
}

const fmtTime = (ms) => {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return ''
  const d = new Date(n)
  const p = (v) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 推断"当前工作区"：取最近一条已索引事件所属的 cwd。
 *
 * 为什么能这么推：正在对话的那个会话，它的日志一直在增长，事件时间自然最新；
 * 而同一条 cwd 下的其它（历史）会话不会比它更新。dsh 不会把会话的 cwd 告诉 MCP
 * （tools/call 里只有 name/arguments，spawn 时的 cwd 又是静态的），所以只能这样推。
 * 拿不到就返回 null，调用方退化为全局检索。
 */
export function inferActiveWorkspace(db) {
  try {
    const row = db.prepare(
      "SELECT cwd, workspace FROM events WHERE cwd IS NOT NULL AND cwd <> '' ORDER BY time DESC LIMIT 1").get()
    if (!row) return null
    return { cwd: row.cwd, workspace: row.workspace || workspaceOf(row.cwd) }
  } catch {
    return null
  }
}

/** 一轮检索（AND → OR 放宽 → 字面子串兜底）。filter 为空表示不限工作区。 */
function runQuery(db, query, filter, session) {
  let rows = ftsRows(db, toMatch(query, 'and'), filter, session)
  let relaxed = 'none'
  if (!rows.length) {
    const orMatch = toMatch(query, 'or')
    if (orMatch && splitTerms(query).length > 1) {
      rows = ftsRows(db, orMatch, filter, session)
      if (rows.length) relaxed = 'or'
    }
  }
  if (!rows.length && String(query).trim().length >= 2) {
    rows = likeRows(db, query, filter, session)
    if (rows.length) relaxed = 'substring'
  }
  return { rows, relaxed }
}

/**
 * 分层检索：**先当前工作区，没命中再扩大到全局**。
 *
 * scope：
 *   `auto`（默认）—— 先按当前工作区搜；命中就到此为止（并在结果里标明范围）；无命中自动扩大
 *   `cwd`         —— 只搜当前工作区（等价于"我就想找这个项目里的东西"）
 *   `global`      —— 跨项目搜（找"别处怎么解决的"时用）
 * 显式传 `cwd` 会覆盖推断出的当前工作区。
 */
export function search(db, { query, limit = 8, perSession = 2, cwd, session, scope = 'auto' } = {}) {
  const t0 = Date.now()
  const nowMs = Date.now()
  // 显式 cwd（调用方可能只记得仓库名片段）→ 子串匹配；
  // 否则用推断出的工作区 → 精确匹配 workspace，走 events_workspace 索引。
  const explicitCwd = cwd ? String(cwd) : null
  const inferred = explicitCwd ? null : inferActiveWorkspace(db)
  const localFilter = explicitCwd
    ? { cwdLike: explicitCwd }
    : (inferred ? { workspace: inferred.workspace } : null)
  const scopeCwd = explicitCwd ?? inferred?.cwd ?? null
  const scopeWorkspace = explicitCwd ? null : (inferred?.workspace ?? null)

  let scopeUsed
  let expanded = false
  let result
  if (scope === 'global' || !localFilter) {
    scopeUsed = 'global'
    result = runQuery(db, query, null, session)
  } else if (scope === 'cwd') {
    scopeUsed = 'cwd'
    result = runQuery(db, query, localFilter, session)
  } else {
    result = runQuery(db, query, localFilter, session)
    if (result.rows.length) {
      scopeUsed = 'cwd'
    } else {
      result = runQuery(db, query, null, session)
      scopeUsed = 'global'
      expanded = true
    }
  }

  const { picked, sessionsMatched } = groupBySession(rescore(result.rows, nowMs), perSession, limit)
  const items = picked.map(({ score, row }) => {
    const { snippet, matchPos } = snippetOf(row.text, query)
    return {
      sessionId: row.session_id,
      seq: row.seq,
      type: row.type,
      time: row.time,
      when: fmtTime(row.time),
      sessionCreated: row.created_at ? fmtTime(row.created_at) : '',
      cwd: row.cwd,
      workspace: row.workspace || workspaceOf(row.cwd),
      snippet,
      matchPos,
      textLen: String(row.text ?? '').length,
      score: Number(score.toFixed(4)),
    }
  })
  return {
    mode: 'search', query, ms: Date.now() - t0, relaxed: result.relaxed,
    scope: scopeUsed, scopeCwd, scopeWorkspace, expanded,
    candidates: result.rows.length, sessionsMatched, items,
  }
}

export function recall(db, { session, seq, before = 3, after = 3 } = {}) {
  const t0 = Date.now()
  const lo = Math.max(0, seq - Math.max(0, before))
  const hi = seq + Math.max(0, after)
  const items = db.prepare(
    `SELECT seq, type, time, text FROM events
     WHERE session_id=? AND seq BETWEEN ? AND ? ORDER BY seq`).all(session, lo, hi)
  const meta = db.prepare('SELECT * FROM sessions WHERE session_id=?').get(session)

  const anchor = (sql, ...params) => {
    const row = db.prepare(sql).get(...params)
    if (!row) return null
    return { seq: row.seq, type: row.type, when: fmtTime(row.time), head: String(row.text ?? '').replace(/\s+/g, ' ').slice(0, 200) }
  }
  return {
    mode: 'recall', ms: Date.now() - t0,
    session: meta ?? null, targetSeq: seq,
    anchors: {
      turnUser: anchor(`SELECT seq,type,time,text FROM events
                        WHERE session_id=? AND seq<=? AND type='user/message'
                        ORDER BY seq DESC LIMIT 1`, session, seq),
      nextAssistant: anchor(`SELECT seq,type,time,text FROM events
                             WHERE session_id=? AND seq>? AND type='assistant/message'
                             ORDER BY seq ASC LIMIT 1`, session, seq),
    },
    items: items.map((r) => ({ seq: r.seq, type: r.type, when: fmtTime(r.time), text: r.text })),
  }
}

export function listSessions(db, { limit = 10, cwd } = {}) {
  const t0 = Date.now()
  let sql = 'SELECT * FROM sessions'
  const params = []
  if (cwd) { sql += ' WHERE cwd LIKE ?'; params.push(likePattern(cwd)) }
  sql += ' ORDER BY updated_at DESC LIMIT ?'
  params.push(limit)
  const rows = db.prepare(sql).all(...params)
  return {
    mode: 'list', ms: Date.now() - t0,
    items: rows.map((r) => ({
      sessionId: r.session_id, cwd: r.cwd, workspace: r.workspace,
      createdAt: fmtTime(r.created_at), updatedAt: fmtTime(r.updated_at), events: r.events,
    })),
  }
}

export function stats(db) {
  const events = db.prepare('SELECT COUNT(*) AS n FROM events').get().n
  const sessions = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n
  const lastIngest = db.prepare("SELECT v FROM state WHERE k='last_ingest'").get()?.v ?? null
  return { events, sessions, lastIngest }
}
