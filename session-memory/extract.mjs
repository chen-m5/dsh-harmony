#!/usr/bin/env node
/**
 * session-memory 提取器（沙箱侧，独立进程）
 *
 * 干什么：把 `$DSH_HOME/sessions/**` 里**新增**的会话事件提取成 NDJSON，交给同目录的
 *         `ingest.mjs` 写入**沙箱本地**的 SQLite FTS5 库（库不再放 VM）。
 *
 * 为什么不接 dsh 的接口：它不 import cordis、不订阅任何事件、不碰 `ctx.sessionQuery`，
 *         只读文件系统。上一版把索引做进 dsh 进程里，它的全量对账是主线程同步跑的，
 *         20 秒把界面冻住了 —— 这个进程即使慢，也只是它自己慢。
 *
 * 切片（增量）方式：会话日志是"往同一个文件里追加若干**独立** zstd 帧"，
 *         所以游标记的是**文件字节偏移**（最后一条完整帧的结束位置）。下一轮只读该偏移之后
 *         的新字节，开销只与新增量成正比。若最后一帧还没写完，解压会失败 —— 此时停在
 *         上一帧边界，下轮再来，绝不半条入库。
 *
 * 用法：
 *   node extract.mjs [--sessions-root DIR] [--out FILE] [--cursor FILE]
 *                    [--full] [--since-days N] [--max-sessions N]
 * 产物：
 *   <out>          NDJSON，一行一条事件
 *   <cursor>.next  下一轮的游标；调用方在入库成功后再覆盖正式游标（两阶段提交）
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const HOME = process.env.DSH_HOME || '/data/storage/el2/base/haps/entry/files/dsh-home'
const HERE = path.dirname(new URL(import.meta.url).pathname)

/**
 * 上限：单条入库文本不能无限大，但"截断"直接等于"以后搜不到"。
 * 2026-10-09 调高过一轮（2000/4000/4000 → 8000/12000/16000）：原来的上限会切掉长命令输出
 * 与长文件内容的结论部分，而那正是最值得回查的东西。库体积代价可接受（VM 上 458G 可用，
 * 实测平均原文才 600 字符，只有长尾受影响）。
 */
const CAP_MESSAGE_USER = 8000
const CAP_MESSAGE_ASSISTANT = 12000
const CAP_TOOL_CALL = 800
const CAP_TOOL_RESULT = 16000
/** 短于这个长度的工具结果没有检索价值（"ok"、空输出之类）。 */
const MIN_TOOL_RESULT = 24

/** harness 自己注入的东西：检索历史时是纯噪音，且会与真实对话重复。 */
const HARNESS_INJECTED = [
  /^<[a-z-]+-reminder>/i,
  /^<command-(?:name|message|args)>/i,
  /^\[SYSTEM NOTIFICATION/i,
  /^<task-notification>/i,
  /^Caveat: The messages below were generated/i,
]
/** 只读命令不产生"做过什么"的信号，跳过调用记录（结果仍然保留）。 */
const READ_ONLY_SHELL = [
  'cd', 'ls', 'pwd', 'echo', 'cat', 'head', 'tail', 'which', 'type', 'grep', 'rg', 'find', 'fd',
  'wc', 'sed', 'awk', 'less', 'more', 'stat', 'file', 'tree', 'du', 'df', 'env', 'printf', 'sort',
  'uniq', 'cut', 'jq', 'true', 'sleep', 'date', 'git status', 'git log', 'git diff', 'git show',
]
const SHELL_TOOLS = new Set(['bash', 'shell', 'pwsh', 'exec', 'run_code'])

function parseArgs(argv) {
  const out = {
    sessionsRoot: path.join(HOME, 'sessions'),
    out: path.join(HERE, 'out.ndjson'),
    cursor: path.join(HERE, 'cursor.json'),
    full: false,
    sinceDays: 0,
    maxSessions: 0,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--sessions-root') out.sessionsRoot = argv[++i]
    else if (a === '--out') out.out = argv[++i]
    else if (a === '--cursor') out.cursor = argv[++i]
    else if (a === '--full') out.full = true
    else if (a === '--since-days') out.sinceDays = Number(argv[++i]) || 0
    else if (a === '--max-sessions') out.maxSessions = Number(argv[++i]) || 0
  }
  return out
}

/** 会话日志可能是 zstd 的（v4）也可能是明文的（早期版本），两种都要认。 */
function scanSessions(root) {
  const found = []
  if (!fs.existsSync(root)) return found
  for (const group of fs.readdirSync(root)) {
    const groupDir = path.join(root, group)
    let entries = []
    try {
      entries = fs.readdirSync(groupDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(groupDir, entry.name)
      let files = []
      try {
        files = fs.readdirSync(dir)
      } catch {
        continue
      }
      for (const file of files) {
        if (!/^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(file)) continue
        const full = path.join(dir, file)
        try {
          const st = fs.statSync(full)
          found.push({ file: full, size: st.size, mtimeMs: st.mtimeMs })
        } catch {
          /* 读不到就跳过 */
        }
      }
    }
  }
  return found
}

function loadCursor(file, full) {
  if (full) return { version: 1, sessions: {} }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (parsed && typeof parsed === 'object' && parsed.sessions) return parsed
  } catch {
    /* 没有或坏了都当首次 */
  }
  return { version: 1, sessions: {} }
}

function extractText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

function clip(text, max) {
  const s = String(text ?? '')
  return s.length > max ? s.slice(0, max) : s
}

function isHarnessInjected(text) {
  const t = String(text ?? '').trim()
  return HARNESS_INJECTED.some((p) => p.test(t))
}

function summarizeToolCall(data) {
  const name = String(data?.name ?? '')
  if (!name || name.startsWith('honcho_') || name.startsWith('session_')) return ''
  let args = {}
  try {
    const parsed = JSON.parse(data?.arguments ?? '{}')
    if (parsed && typeof parsed === 'object') args = parsed
  } catch {
    /* 参数不是 JSON 也照样记个名字 */
  }
  if (SHELL_TOOLS.has(name.toLowerCase())) {
    const raw = args.command ?? args.cmd ?? args.code
    const command = (Array.isArray(raw) ? raw.join(' ') : typeof raw === 'string' ? raw : '').trim()
    if (!command) return ''
    if (READ_ONLY_SHELL.some((t) => command === t || command.startsWith(`${t} `))) return ''
    return `ran: ${clip(command, CAP_TOOL_CALL)}`
  }
  const filePath = args.path ?? args.file_path ?? args.filePath
  if (typeof filePath === 'string' && filePath) {
    return /write|edit|create/i.test(name) ? `edited: ${filePath}` : ''
  }
  return `used ${name} ${clip(JSON.stringify(args), 300)}`
}

/**
 * 一条事件 → 可检索文本，或 '' 表示不值得入库。
 * 四类保留：用户消息、助手消息、有信号的工具调用、工具结果。
 */
function eventText(event) {
  const data = event?.data ?? {}
  switch (event?.type) {
    case 'user/message': {
      if (data.source?.kind && data.source.kind !== 'user') return '' // 注入的上下文，重复噪音
      const text = extractText((data.message ?? data)?.content)
      if (!text.trim() || isHarnessInjected(text)) return ''
      return clip(text, CAP_MESSAGE_USER)
    }
    case 'assistant/message': {
      const text = extractText((data.message ?? data)?.content)
      if (!text.trim()) return ''
      return clip(text, CAP_MESSAGE_ASSISTANT)
    }
    case 'tool/call':
      return summarizeToolCall(data)
    case 'tool/result': {
      const text = extractText(data.message?.content) || extractText(data.content) || extractText(data.result)
      if (text.trim().length < MIN_TOOL_RESULT) return ''
      return clip(text, CAP_TOOL_RESULT)
    }
    default:
      return ''
  }
}

function frameOffsets(buf) {
  const positions = []
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) positions.push(i)
  }
  positions.push(buf.length)
  return positions
}

/**
 * 处理一个会话文件从 `offset` 开始的新增字节。
 * 返回 { entries, nextOffset, header, lastSeq, complete }：
 *   nextOffset 只推进到"最后一条完整解压成功的帧结束"，撕裂的尾巴留给下一轮。
 */
function extractFile(file, offset, isZstd) {
  const size = fs.statSync(file).size
  const out = { entries: [], nextOffset: offset, header: null, lastSeq: null, torn: false }
  if (size <= offset) return out

  const fd = fs.openSync(file, 'r')
  let buf
  try {
    buf = Buffer.allocUnsafe(size - offset)
    fs.readSync(fd, buf, 0, buf.length, offset)
  } finally {
    fs.closeSync(fd)
  }

  const rows = []
  if (!isZstd) {
    // 明文 JSONL：按行切，只吃完整的行
    let cursor = 0
    while (true) {
      const nl = buf.indexOf(0x0a, cursor)
      if (nl < 0) break
      const line = buf.toString('utf8', cursor, nl)
      cursor = nl + 1
      if (line.trim()) rows.push(line)
      out.nextOffset = offset + cursor
    }
  } else {
    const bounds = frameOffsets(buf)
    for (let i = 0; i < bounds.length - 1; i++) {
      const start = bounds[i]
      const end = bounds[i + 1]
      let text
      try {
        text = zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
      } catch {
        // 帧不全（写入中或边界没对齐）：停在上一帧，下轮重试
        out.torn = true
        break
      }
      for (const line of text.split('\n')) {
        if (line.trim()) rows.push(line)
      }
      out.nextOffset = offset + end
    }
  }

  for (const line of rows) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event?.type === 'session') {
      out.header = {
        sessionId: String(event.id ?? ''),
        cwd: String(event.cwd ?? ''),
        createdAt: Number(event.createdAt ?? 0),
      }
      continue
    }
    if (typeof event?.seq !== 'number') continue
    out.lastSeq = event.seq
    const text = eventText(event)
    if (!text) continue
    out.entries.push({
      seq: event.seq,
      type: event.type,
      time: Number(event.time ?? 0),
      text,
    })
  }
  return out
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const t0 = Date.now()
  const cursor = loadCursor(args.cursor, args.full)
  const next = { version: 1, sessions: { ...cursor.sessions } }

  let files = scanSessions(args.sessionsRoot)
  if (args.sinceDays > 0) {
    const cutoff = Date.now() - args.sinceDays * 86400_000
    files = files.filter((f) => f.mtimeMs >= cutoff)
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (args.maxSessions > 0) files = files.slice(0, args.maxSessions)

  const stream = fs.createWriteStream(args.out, { encoding: 'utf8' })
  const stat = { files: files.length, touched: 0, entries: 0, newBytes: 0, torn: 0 }

  for (const f of files) {
    const prev = next.sessions[f.file] ?? { offset: 0, sessionId: '', cwd: '', createdAt: 0, lastSeq: -1 }
    if (f.size <= prev.offset) {
      next.sessions[f.file] = prev
      continue
    }
    const isZstd = f.file.endsWith('.zstd')
    const res = extractFile(f.file, prev.offset, isZstd)
    const header = res.header ?? { sessionId: prev.sessionId, cwd: prev.cwd, createdAt: prev.createdAt }
    next.sessions[f.file] = {
      offset: res.nextOffset,
      sessionId: header.sessionId || prev.sessionId,
      cwd: header.cwd || prev.cwd,
      createdAt: header.createdAt || prev.createdAt,
      lastSeq: res.lastSeq ?? prev.lastSeq,
      processedAt: Date.now(),
    }
    stat.touched += 1
    stat.newBytes += res.nextOffset - prev.offset
    stat.entries += res.entries.length
    if (res.torn) stat.torn += 1
    for (const e of res.entries) {
      stream.write(JSON.stringify({
        sessionId: next.sessions[f.file].sessionId,
        cwd: next.sessions[f.file].cwd,
        createdAt: next.sessions[f.file].createdAt,
        seq: e.seq,
        type: e.type,
        time: e.time,
        text: e.text,
      }) + '\n')
    }
  }

  stream.end(() => {
    fs.writeFileSync(`${args.cursor}.next`, JSON.stringify(next, null, 1))
    stat.elapsedMs = Date.now() - t0
    stat.out = args.out
    stat.outBytes = fs.existsSync(args.out) ? fs.statSync(args.out).size : 0
    stat.cursorNext = `${args.cursor}.next`
    console.log(JSON.stringify(stat, null, 1))
  })
}

main()
