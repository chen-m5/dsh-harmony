/**
 * hmdsh-kb-bridge —— host 侧的一元 RPC channel，给「壳的本地知识库」当回传口。
 *
 * 为什么要它：系统端侧知识库（DataAugmentationKit）只能在壳的 ArkTS 里跑，而 dsh 在 node 里。
 * 链路（见壳仓库 docs/知识库.md）：
 *
 *   ① dsh 侧命令打印一行标记 [[HMDSH-KB {"id","q","p"}]]  → 经 dsh 自己的 WS 流到页面
 *   ② 页面里壳注入的 KB_BRIDGE_JS 捕获 → window.dshShell.kbSearch(id,q,p) → 壳本地检索
 *   ③ 页面拿到结果 → fetch POST /hmdsh-kb/result {id,data}   ← 本插件接住
 *   ④ 本插件把结果写成 <HOME>/kb/response-<id>.json → ①的命令读到并打印
 *
 * 用 dsh 现成的 extension point（ctx.connection.rpc.handle），不碰 dsh 前端、不用重打 dsh 包。
 * 页面侧只是普通 fetch，无需任何 dsh 前端包。
 */

import fs from 'node:fs'
import path from 'node:path'

export const name = 'hmdsh-kb-bridge'

/** web profile 下 connection 一定在（HTTP carrier） */
export const inject = ['connection']

export function apply(ctx) {
  const HOME = process.env.HOME ?? '/data/storage/el2/base/haps/entry/files'
  const KB_DIR = path.join(HOME, 'kb')

  function writeResponse(id, data) {
    try {
      if (!fs.existsSync(KB_DIR)) fs.mkdirSync(KB_DIR, { recursive: true })
      fs.writeFileSync(path.join(KB_DIR, `response-${id}.json`),
        JSON.stringify({ ok: true, id, op: 'kbSearch', data }))
      return true
    } catch (error) {
      ctx.logger?.warn?.(`hmdsh-kb: 写回执失败 ${error}`)
      return false
    }
  }

  function listRequests() {
    try {
      return fs.readdirSync(KB_DIR).filter((n) => n.startsWith('request-') && n.endsWith('.json'))
    } catch {
      return []
    }
  }

  ctx.effect(() => ctx.connection.rpc.handle('/hmdsh-kb', async (endpoint, payload) => {
    if (endpoint === 'ping') {
      return { ok: true, value: { pong: true, kbDir: KB_DIR, pid: process.pid, at: Date.now() } }
    }
    if (endpoint === 'result') {
      const id = payload?.id
      const data = payload?.data
      if (typeof id !== 'string' || id.length === 0) {
        return { ok: false, error: { code: 'hmdsh-kb/bad-id', message: 'id 必填', details: {} } }
      }
      const wrote = writeResponse(id, typeof data === 'string' ? data : JSON.stringify(data ?? ''))
      return { ok: true, value: { wrote, id } }
    }
    if (endpoint === 'pending') {
      return { ok: true, value: { requests: listRequests() } }
    }
    return {
      ok: false,
      error: { code: 'hmdsh-kb/unknown-endpoint', message: `未知 endpoint: ${endpoint}`, details: {} }
    }
  }), 'hmdsh-kb: /hmdsh-kb rpc channel')
}
