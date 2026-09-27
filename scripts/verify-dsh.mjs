#!/usr/bin/env node
/**
 * 薄入口：转发到 <版本>/scripts/verify-dsh.mjs —— 让你不用记版本路径。
 *
 *   node scripts/verify-dsh.mjs <版本> [其它参数...]
 *
 * 为什么这样：**每个 dsh 版本有自己独立的脚本**（下个版本可能不一样），
 * 版本目录里的那份才是权威实现；这里只是共用的转发器。
 * 想复用别的版本的实现，就 import 它的路径（引用，而不是复制）。
 */
const version = process.argv.slice(2).find(a => !a.startsWith('--'))
if (!version) { console.error('用法: node scripts/verify-dsh.mjs <版本> [其它参数...]'); process.exit(1) }
const target = new URL(`../${version}/scripts/verify-dsh.mjs`, import.meta.url)
try {
  await import(target)
} catch (error) {
  if (String(error?.code) === 'ERR_MODULE_NOT_FOUND') {
    console.error(`找不到 ${version}/scripts/verify-dsh.mjs —— 该版本还没有自己的脚本`)
    process.exit(1)
  }
  throw error
}
