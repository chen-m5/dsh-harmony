#!/usr/bin/env node
/**
 * ingest.mjs —— 把 extract.mjs 产出的 NDJSON 写进**沙箱本地**的库（node:sqlite）。
 *
 * 相比 VM 版（ingest.py）少了两跳：不再 gzip、不再 ssh、不再远端 python；
 * 库就在本地文件系统上，写入是纯本地 IO。schema 与 VM 版一致，库文件可互换。
 *
 * 用法：node ingest.mjs <ndjson 文件>
 * 输出：一行 JSON 统计（调用方据此判断成败）
 */
import fs from 'node:fs'
import readline from 'node:readline'
import { openDb, ingest, stats, DEFAULT_DB } from './store.mjs'

const file = process.argv[2]
if (!file) {
  console.error('用法: node ingest.mjs <ndjson 文件>')
  process.exit(2)
}
if (!fs.existsSync(file)) {
  console.error(`找不到输入文件: ${file}`)
  process.exit(2)
}

const db = openDb()
const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })

const FLUSH = 1000
let lines = 0
let badLines = 0
let written = 0
let batch = []

for await (const line of rl) {
  if (!line.trim()) continue
  lines += 1
  let row
  try {
    row = JSON.parse(line)
  } catch {
    badLines += 1
    continue
  }
  if (!row?.sessionId || !Number.isInteger(row.seq)) {
    badLines += 1
    continue
  }
  batch.push(row)
  if (batch.length >= FLUSH) {
    written += ingest(db, batch)
    batch = []
  }
}
if (batch.length) written += ingest(db, batch)

const s = stats(db)
console.log(JSON.stringify({
  lines, badLines, written, events: s.events, sessions: s.sessions,
  db: DEFAULT_DB, dbBytes: fs.statSync(DEFAULT_DB).size,
}))
db.close()
