# hmdsh-kb-bridge（**当前未启用**，备选）

dsh **host 侧**的一个一元 RPC 频道（`/hmdsh-kb`），给「壳的本地知识库」当回传口。

## 它解决什么

系统端侧知识库（DataAugmentationKit）只能在壳的 ArkTS 里跑，dsh 在 node 里。链路：

```
① dsh 侧命令打印标记 [[HMDSH-KB {"id","q","p"}]] → 经 dsh 自己的 WS 流到页面
② 页面里壳注入的 KB_BRIDGE_JS 捕获 → window.dshShell.kbSearch(id,q,p) → 壳本地检索
③ 页面/壳把结果回传给 host        ← 本插件提供这条（fetch POST /hmdsh-kb/result）
④ host 侧写 <HOME>/kb/response-<id>.json → ①的命令读到并打印
```

## 为什么现在不启用

算过延迟：**壳检索完自己写文件**（`KbBridge.searchToFile`），而 dsh 侧命令**本来就在等那个文件**（40ms 轮询）——
标记路径约 70ms、纯轮询兜底约 200ms，已经够用。加这条 RPC 只省 ~30ms，却要动
`$DSH_HOME/profiles/web/cordis.patch.yml`、且「运行中新装包能否热生效」在 dsh 里**未实测**（可能要重启 dsh）。
**收益不抵风险**，所以留作备选；将来知识库变成高频调用（比如每次回答都查）再上。

## 要用的话（三行）

dsh 的现成扩展点，**不需要重打 dsh 包、不需要改 dsh 前端**：

```sh
# 1) 装进 profile（必须加 -w：profile 里有 pnpm-workspace.yaml）
node <dsh包>/node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile web add -w <本目录>
# 2) 在 $DSH_HOME/profiles/web/cordis.patch.yml 追加（不带 id 的 insert 才是新增）
#    - insert:
#        - id: hmdsh-kb-bridge
#          name: hmdsh-kb-bridge
# 3) 重启 dsh（或指望 hmr 热生效 —— 未确认）
```

页面侧调用（纯 fetch，不需要任何 dsh 前端包）：

```js
const rpcId = crypto.randomUUID()
const res = await fetch('/hmdsh-kb/result', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId, method: 'result', payload: { id, data } }),
})
// → { type: 'server-response', rpcId, result: { ok: true, value: { wrote, id } } }
```

## 依据

调研 dsh 上游（`/storage/Users/currentUser/Documents/aa/deepseek-harness-master`）：
`ctx.connection.rpc.handle(channel, handler)`（`packages/client/connection/src/rpc-host.ts:171-195`）、
信封（`packages/client/connection/src/rpc.ts:80-95`）、`/api` 前缀路由（`packages/client/connection/src/index.ts:139-159`）。
api-gateway 本身就是这套用法的样板。
