#!/usr/bin/env node
/**
 * session-memory MCP server（沙箱侧，stdio）
 *
 * 给模型三个只读工具：`session_search` / `session_recall` / `session_list`，
 * 用来跨会话回查"我以前说过、做过、决定过什么"，而不是凭当前上下文猜。
 *
 * 架构（第二版：库从 VM 搬回沙箱本地）：
 *   · **库在沙箱本地**（`node:sqlite` + FTS5），查询是纯本地文件 IO —— 实测中文 2 字查询
 *     2.2–2.8ms、英文 0.4ms、recall 0.1ms；而库放 VM 时每次调用要付 450–600ms 的 ssh 往返。
 *   · **索引构建在独立进程**（`sync.sh` → `extract.mjs` → `ingest.mjs`），绝不进 dsh 的
 *     事件循环 —— 第一版把对账做在 dsh 进程里，主线程同步跑了 20 秒，界面冻住、会话列表
 *     都拉不出来。这条纪律是本设计唯一不可让步的部分。
 *   · **启动不依赖任何外部**：没有 ssh、没有远端；连库都推迟到第一次调用时才打开。
 *
 * 两条硬要求（照 mcp-service/vm/vm-mcp.mjs 的教训）：
 *   1. stdio 必须是**换行分隔的 JSON**，不能用 LSP 的 Content-Length 头 —— 帧格式不对会让
 *      dsh 判定 MCP 启动失败，连带 dsh 起不来；
 *   2. 启动不得依赖外部可达（现在已无外部依赖）。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { openDb, search, recall, listSessions, DEFAULT_DB } from './store.mjs'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const SYNC_SCRIPT = path.join(HERE, 'sync.sh')
/** 查询前若距上次同步超过这个时间就先增量同步（本地增量实测 ~1s） */
const SYNC_TTL_MS = Number(process.env.SESSION_MEMORY_SYNC_TTL_MS || 60_000)
const SYNC_TIMEOUT_MS = Number(process.env.SESSION_MEMORY_SYNC_TIMEOUT_MS || 300_000)

const log = (...a) => process.stderr.write('[session-memory] ' + a.join(' ') + '\n')

/** 库连接懒打开：MCP 进程起来时不碰磁盘，第一次工具调用才打开。 */
let db = null
const getDb = () => (db ??= openDb(DEFAULT_DB))

/* ── 增量同步（独立进程，不占 dsh 的事件循环） ─────────────────────────── */

let lastSyncAt = 0
let syncing = null

function syncNow(reason) {
  if (syncing) return syncing
  const t0 = Date.now()
  syncing = new Promise((resolve) => {
    const child = spawn('/bin/sh', [SYNC_SCRIPT], { cwd: HERE })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), SYNC_TIMEOUT_MS)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    const done = (code) => {
      clearTimeout(timer)
      lastSyncAt = Date.now()
      const ms = Date.now() - t0
      const ok = code === 0
      // sync.sh 抢不到跨进程锁时会跳过并输出 "skipped: another sync is running"：
      // 那不是失败，但也不能说成"已同步" —— 单独标出来。
      const skipped = ok && out.includes('skipped: another sync')
      const tail = (err.trim() || out.trim()).slice(-300)
      if (skipped) log(`同步（${reason}）跳过：另一个同步正在跑（${ms}ms）`)
      else if (ok) log(`同步（${reason}）完成，${ms}ms`)
      else log(`同步（${reason}）失败，exit=${code}，${ms}ms：${tail}`)
      resolve({ ok, code, ms, out, err, skipped })
    }
    child.on('error', (e) => {
      // 失败也记时间：出故障时不至于每次调用都白等一轮
      clearTimeout(timer)
      lastSyncAt = Date.now()
      resolve({ ok: false, code: -1, ms: Date.now() - t0, err: String(e.message) })
    })
    child.on('close', done)
  }).finally(() => { syncing = null })
  return syncing
}

/** 需要新鲜数据时先同步；超出 TTL 才等，否则直接查（保证快的路径依然快）。 */
async function ensureFresh() {
  const age = Date.now() - lastSyncAt
  if (age < SYNC_TTL_MS) return { synced: false, ok: true, ageMs: age }
  const r = await syncNow('ttl')
  return { synced: true, ageMs: 0, ...r }
}

/* ── 输出格式化 ───────────────────────────────────────────────────────── */

/**
 * 同步状态的一句话说明。
 * 失败时必须说出来 —— 一律写"已先做增量同步"会让人误以为数据是新的。
 */
function freshNote(fresh) {
  if (fresh?.synced) {
    if (fresh.ok === false) {
      const tail = String(fresh.err || fresh.out || '').trim().split('\n').filter(Boolean).pop() || '未知原因'
      return `⚠ 同步失败（${tail.slice(0, 160)}），以下结果可能不是最新`
    }
    if (fresh.skipped) return '另一个同步正在进行，本次用现有数据（可能不是最新）'
    return '已先做增量同步'
  }
  return `数据新鲜度 ${Math.round((fresh?.ageMs ?? 0) / 1000)}s`
}

function fmtSearch(data, fresh, totalMs) {
  const items = data.items ?? []
  // 范围必须写明：不然调用方不知道"没命中"是因为真没有，还是因为只搜了当前工作区
  const local = data.scopeWorkspace || data.scopeCwd || '(未知)'
  const scopeNote = data.scope === 'cwd'
    ? `范围：当前工作区 ${local}（要跨项目检索加 scope=global）`
    : data.expanded
      ? `范围：当前工作区 ${local} 没命中，已自动扩大到全局`
      : '范围：全局'
  const head = [
    `命中 ${data.sessionsMatched ?? 0} 个会话（共 ${data.candidates ?? 0} 条匹配；` +
    `库内 ${data.ms}ms，总 ${totalMs}ms，${freshNote(fresh)}）`,
    scopeNote,
  ]
  // 放宽过就说出来：让调用方知道"这不是精确命中"，免得拿它当确定性结论用
  if (data.relaxed === 'or') head.push('⚠ 没有同时命中全部关键词，已放宽为「任一关键词匹配」')
  else if (data.relaxed === 'substring') head.push('⚠ 全文索引未命中，已退化为字面子串扫描')
  if (!items.length) {
    return [...head, '没有命中。可以换关键词、少给几个词，或先用 session_list 看最近有哪些会话。'].join('\n')
  }

  // 按会话分组：先看清"有哪些会话相关"，再决定深入哪一个
  const groups = new Map()
  for (const it of items) {
    if (!groups.has(it.sessionId)) groups.set(it.sessionId, [])
    groups.get(it.sessionId).push(it)
  }
  const blocks = []
  let n = 0
  for (const [sid, list] of groups) {
    const first = list[0]
    blocks.push(
      `${sid}${first.sessionCreated ? `（创建于 ${first.sessionCreated}）` : ''}\n` +
      `    工作区: ${first.workspace || '(未知)'}\n` +
      `    cwd: ${first.cwd || '(未知)'}`)
    for (const it of list) {
      n += 1
      const posNote = typeof it.matchPos === 'number' && it.textLen
        ? `    片段在第 ${it.matchPos}/${it.textLen} 字符`
        : ''
      blocks.push(
        `  [${n}] ${it.when || '(无时间)'}  ${it.type}  seq=${it.seq}\n` +
        (posNote ? `${posNote}\n` : '') +
        `      ${String(it.snippet || '').replace(/\s+/g, ' ').trim()}`)
    }
  }
  blocks.push('展开细节：session_recall(sessionId, seq) 读该条前后的原文（会附上它属于哪一轮对话）。')
  return [head.join('\n'), ...blocks].join('\n\n')
}

function fmtRecall(data, fresh, totalMs) {
  const s = data.session
  const a = data.anchors ?? {}
  const lines = [
    `会话 ${s?.session_id ?? '(未知)'}  cwd=${s?.cwd ?? '(未知)'}` +
    `（共 ${s?.events ?? '?'} 条已索引事件；库内 ${data.ms}ms，总 ${totalMs}ms，${freshNote(fresh)}）`,
  ]
  // 锚点：光看 seq 附近的几条事件，常常看不出"当时在干什么"
  if (a.turnUser) lines.push(`这一轮的用户消息：seq=${a.turnUser.seq}  「${a.turnUser.head}」`)
  if (a.nextAssistant) lines.push(`其后的助手回复：seq=${a.nextAssistant.seq}  「${a.nextAssistant.head}」`)
  lines.push(`命中点 seq=${data.targetSeq}（下面用 >>> 标出）`, '')
  for (const it of data.items ?? []) {
    lines.push(`${it.seq === data.targetSeq ? '>>>' : '   '} [${it.seq}] ${it.type} ${it.when}`)
    lines.push(`    ${String(it.text || '').replace(/\n/g, ' ').slice(0, 1500)}`)
  }
  if (!(data.items ?? []).length) lines.push('（该 seq 附近没有已索引的事件）')
  lines.push('', '（库里只索引对话消息与工具活动：注入的上下文、提醒块、只读命令本身都不入库，所以 seq 可能不连续。）')
  return lines.join('\n')
}

function fmtList(data, fresh, totalMs) {
  const items = data.items ?? []
  const head = `最近 ${items.length} 个会话（库内 ${data.ms}ms，总 ${totalMs}ms，${freshNote(fresh)}）`
  if (!items.length) return `${head}\n库里还没有会话记录，先跑一次 sync.sh --full 建库。`
  const rows = items.map((it, i) =>
    `[${i + 1}] ${it.updatedAt || '(无时间)'}  ${it.events} 条  ${it.sessionId}\n` +
    `     ${it.workspace || '(未知工作区)'}  |  ${it.cwd || '(无 cwd)'}`)
  rows.push('用 session_search(query) 在这些会话里做全文检索。')
  return [head, ...rows].join('\n')
}

/* ── 工具定义 ─────────────────────────────────────────────────────────── */

const TOOLS = [
  {
    name: 'session_search',
    description:
      '跨会话检索历史会话记录：我自己在以往会话里说过、做过、决定过什么（数据来自所有历史会话的持久日志）。' +
      '当你需要回忆“这个项目之前怎么处理的”“上次那个结论/决定是什么”，或怀疑当前上下文里的记忆可能不准时使用。' +
      '**默认分层检索**：先搜当前工作区，命中就停；当前工作区没有命中时自动扩大到全局（结果里会标明用了哪个范围）。' +
      '想直接跨项目找（例如“别的项目里怎么解决的”）就传 scope=global。' +
      '结果按会话分组并给出 seq；确认细节请用 session_recall 读原文，不要凭片段下结论。' +
      '检索是字面匹配而非语义：命中就意味着原文里确实有这些字词。多个关键词用空格分隔（默认要求全部命中；' +
      '一条都没命中时自动放宽为「任一关键词」并在结果里标注）。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词（中文 1 个字也能查；多个词用空格分隔）' },
        scope: {
          type: 'string',
          enum: ['auto', 'cwd', 'global'],
          description: '检索范围：auto（默认，先当前工作区、无命中再扩大）/ cwd（只搜当前工作区）/ global（跨项目）',
        },
        limit: { type: 'number', description: '最多返回多少个会话，默认 8，上限 30' },
        perSession: { type: 'number', description: '每个会话最多几条，默认 2，上限 5' },
        cwd: { type: 'string', description: '可选：手动指定工作区（cwd 子串，例如某仓库名），会覆盖自动推断的当前工作区' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'session_recall',
    description:
      '读回某个历史会话里一段事件的原文（用 session_search 命中的 sessionId + seq）。' +
      '用来确认细节与上下文，而不是凭片段推测。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 id，来自 session_search 或 session_list' },
        seq: { type: 'number', description: '目标事件 seq' },
        before: { type: 'number', description: '向前多读几条事件，默认 3' },
        after: { type: 'number', description: '向后多读几条事件，默认 3' },
      },
      required: ['sessionId', 'seq'],
      additionalProperties: false,
    },
  },
  {
    name: 'session_list',
    description: '列出最近的会话（最新活动在前）及其工作目录、已索引事件数，用来定位“那件事是在哪个会话里做的”。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '列出多少个会话，默认 10，上限 50' },
        cwd: { type: 'string', description: '可选：只看某个工作目录下的会话（子串匹配）' },
      },
      additionalProperties: false,
    },
  },
]

const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, Math.trunc(n)))
}

async function callTool(name, args) {
  const t0 = Date.now()
  const fresh = await ensureFresh()
  const total = () => Date.now() - t0
  const store = getDb()

  if (name === 'session_search') {
    const query = String(args?.query ?? '').trim()
    if (!query) return text('检索词为空。')
    const data = search(store, {
      query,
      limit: clampInt(args?.limit, 1, 30, 8),
      perSession: clampInt(args?.perSession, 1, 5, 2),
      scope: ['auto', 'cwd', 'global'].includes(args?.scope) ? args.scope : 'auto',
      cwd: args?.cwd ? String(args.cwd) : undefined,
    })
    return text(fmtSearch(data, fresh, total()))
  }

  if (name === 'session_recall') {
    const sessionId = String(args?.sessionId ?? '').trim()
    const seq = Number(args?.seq)
    if (!sessionId) return text('sessionId 为空。')
    if (!Number.isInteger(seq) || seq < 0) return text(`seq 需要非负整数，收到 ${JSON.stringify(args?.seq)}。`)
    const data = recall(store, {
      session: sessionId,
      seq,
      before: clampInt(args?.before, 0, 50, 3),
      after: clampInt(args?.after, 0, 50, 3),
    })
    return text(fmtRecall(data, fresh, total()))
  }

  if (name === 'session_list') {
    const data = listSessions(store, {
      limit: clampInt(args?.limit, 1, 50, 10),
      cwd: args?.cwd ? String(args.cwd) : undefined,
    })
    return text(fmtList(data, fresh, total()))
  }

  throw new Error(`未知工具：${name}`)
}

const text = (t) => ({ content: [{ type: 'text', text: t }] })

/* ── JSON-RPC over stdio（换行分隔，别改成 Content-Length） ────────────── */

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

async function handle(msg) {
  const { id, method, params } = msg || {}
  const isNotification = id === undefined || id === null
  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: (params && params.protocolVersion) || '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'session-memory', version: '0.2.0' },
        },
      })
      return
    case 'notifications/initialized':
      return
    case 'ping':
      if (!isNotification) send({ jsonrpc: '2.0', id, result: {} })
      return
    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
      return
    case 'tools/call': {
      const name = (params && params.name) || ''
      const args = (params && params.arguments) || {}
      try {
        const result = await callTool(name, args)
        if (!isNotification) send({ jsonrpc: '2.0', id, result })
      } catch (e) {
        const message = String((e && e.message) || e)
        if (!isNotification) {
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `查询失败：${message}` }], isError: true } })
        }
      }
      return
    }
    default:
      if (!isNotification) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
  }
}

let buffer = ''
let pending = 0
let ended = false
const maybeExit = () => { if (ended && pending === 0) process.exit(0) }

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    pending += 1
    handle(msg).catch((e) => log(`handler error: ${e && e.message}`)).finally(() => { pending -= 1; maybeExit() })
  }
})
process.stdin.on('end', () => { ended = true; maybeExit() })

log(`ready — 库在沙箱本地 ${DEFAULT_DB}，同步 TTL ${SYNC_TTL_MS}ms`)
// 启动后做一次后台增量同步：把新鲜数据准备好，但**不阻塞** stdio 握手
setTimeout(() => { syncNow('startup').catch(() => {}) }, 5_000)
