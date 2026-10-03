/**
 * hmdsh-kb-bridge —— 让「壳的本地知识库」与 dsh 之间**全双工、零轮询**。
 *
 * 为什么需要它：系统端侧知识库（DataAugmentationKit）只能在壳的 ArkTS 里跑，dsh 在 node 里。
 * 原来靠两条轮询（壳 150ms 扫文件、命令 25ms 扫回执）。这里改成三条直连：
 *
 *   ① 我的命令 → host：POST /hmdsh-kb/ask     （**请求挂起等结果**，不是轮询）
 *   ② host → 页面：    SSE  /hmdsh-kb-events  （服务器主动推 {id,q,p}）
 *   ③ 页面 → host：    POST /hmdsh-kb/result  （页面调完 dshShell.kbSearch 后回传）
 *
 * 实现取舍（踩过的坑，别再改回去）：
 *   · 三个路由都走 `ctx.webServer.register({kind:'prefix', …})`，**不用** `ctx.connection.rpc.handle`：
 *     后者要求 owner ctx 同时具 inject connection 与 webServer，注册失败时**不报错也不生效**，很难查；
 *     而 webServer.register 实测直接可用（SSE 那条一次就通）。
 *   · inject 必须写成「顶层 connection + 嵌套 webServer」：顶层若写 webServer，整个插件会卡在
 *     pending（cb 根本不执行）；只 inject connection 则子 ctx 拿不到 webServer。
 */

import fs from 'node:fs'
import path from 'node:path'

export const name = 'hmdsh-kb-bridge'

/** 顶层只 inject connection（保证插件激活）；webServer 在下面嵌套 inject */
export const inject = ['connection']

export function apply(ctx) {
  const HOME = process.env.HOME ?? '/data/storage/el2/base/haps/entry/files'
  const KB_DIR = path.join(HOME, 'kb')
  const DEFAULT_TIMEOUT = 20000

  /** id → { resolve }：等待页面回传的请求 */
  const pending = new Map()
  /** 已连上的页面（SSE res） */
  const streams = new Set()

  function log(msg) {
    try {
      console.log(`[hmdsh-kb] ${msg}`)
    } catch { /* ignore */ }
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => resolve(body))
      req.on('error', () => resolve(''))
    })
  }

  function json(res, code, obj) {
    try {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(obj))
    } catch { /* ignore */ }
  }

  function writeResponse(id, data) {
    try {
      if (!fs.existsSync(KB_DIR)) fs.mkdirSync(KB_DIR, { recursive: true })
      fs.writeFileSync(path.join(KB_DIR, `response-${id}.json`),
        JSON.stringify({ ok: true, id, op: 'kbSearch', data }))
    } catch { /* ignore */ }
  }

  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.inject(['webServer'], (webCtx) => {
      log('注入完成，注册 /hmdsh-kb')

      // 鉴权（可选）：有 requestRejection 就用，loopback 默认可信
      const reject = (req) => {
        try {
          const r = connectionCtx.connection?.requestRejection?.(req)
          return r === undefined || r === null ? undefined : r
        } catch {
          return undefined
        }
      }

      webCtx.webServer.register({
        kind: 'prefix',
        path: '/hmdsh-kb',
        handler: (req, res) => {
          void (async () => {
            const url = req.url ?? ''
            const code = reject(req)
            if (code !== undefined) {
              res.writeHead(code, { 'content-type': 'text/plain' })
              res.end(code === 401 ? 'unauthorized' : 'forbidden')
              return
            }
            if (req.method !== 'POST') {
              json(res, 405, { ok: false, error: '只接受 POST' })
              return
            }
            const raw = await readBody(req)
            let body = {}
            try {
              body = raw.length > 0 ? JSON.parse(raw) : {}
            } catch {
              json(res, 400, { ok: false, error: 'body 不是合法 JSON' })
              return
            }
            const payload = body.payload ?? body

            if (url.endsWith('/ask')) {
              const q = payload.q
              if (typeof q !== 'string' || q.length === 0) {
                json(res, 400, { ok: false, error: 'q 必填' })
                return
              }
              if (streams.size === 0) {
                json(res, 200, {
                  ok: true,
                  value: {
                    delivered: false, reason: 'no-page',
                    message: '页面没开（HMDSH 的 Web UI 不在），无法调用壳的本地知识库',
                  },
                })
                return
              }
              const id = `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
              const project = typeof payload.p === 'string' ? payload.p : ''
              const timeoutMs = Number(payload.timeoutMs) > 0 ? Number(payload.timeoutMs) : DEFAULT_TIMEOUT
              log(`ask ${id} q=${q} p=${project} → 推给 ${streams.size} 个页面`)
              const wait = new Promise((resolve) => {
                const timer = setTimeout(() => {
                  pending.delete(id)
                  resolve(null)
                }, timeoutMs)
                pending.set(id, {
                  resolve: (data) => {
                    clearTimeout(timer)
                    pending.delete(id)
                    resolve(data)
                  },
                })
              })
              for (const s of streams) {
                try {
                  s.write(`event: ask\ndata: ${JSON.stringify({ id, q, p: project })}\n\n`)
                } catch { /* ignore */ }
              }
              const data = await wait
              if (data === null) {
                json(res, 200, {
                  ok: true,
                  value: { delivered: false, reason: 'timeout', id, message: `等页面回传超时（${timeoutMs}ms）` },
                })
              } else {
                json(res, 200, { ok: true, value: { delivered: true, id, data } })
              }
              return
            }

            if (url.endsWith('/result')) {
              const id = payload.id
              if (typeof id !== 'string' || id.length === 0) {
                json(res, 400, { ok: false, error: 'id 必填' })
                return
              }
              const data = typeof payload.data === 'string' ? payload.data : JSON.stringify(payload.data ?? '')
              const entry = pending.get(id)
              if (entry !== undefined) entry.resolve(data)
              writeResponse(id, data)
              json(res, 200, { ok: true, value: { delivered: entry !== undefined, id } })
              return
            }

            if (url.endsWith('/ping')) {
              json(res, 200, {
                ok: true,
                value: { pong: true, clients: streams.size, pending: pending.size, kbDir: KB_DIR },
              })
              return
            }

            json(res, 404, { ok: false, error: `未知 endpoint: ${url}` })
          })().catch((error) => {
            try {
              json(res, 500, { ok: false, error: String(error) })
            } catch { /* ignore */ }
          })
        },
      })

      // host → 页面：SSE
      webCtx.webServer.register({
        kind: 'prefix',
        path: '/hmdsh-kb-events',
        handler: (req, res) => {
          const code = reject(req)
          if (code !== undefined) {
            res.writeHead(code, { 'content-type': 'text/plain' })
            res.end()
            return
          }
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          })
          res.write(': hmdsh-kb connected\n\n')
          streams.add(res)
          log(`SSE 客户端接入（当前 ${streams.size}）`)
          const keepAlive = setInterval(() => {
            try { res.write(': ka\n\n') } catch { /* ignore */ }
          }, 25000)
          req.on('close', () => {
            clearInterval(keepAlive)
            streams.delete(res)
            log(`SSE 客户端断开（当前 ${streams.size}）`)
          })
        },
      })
    })
  })
}
