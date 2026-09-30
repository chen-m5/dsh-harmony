// 按依赖闭包裁剪出一棵最小 Jimp 子树（dsh-ohos 补丁 14 用）。
//
// 用法：
//   node scripts/trim-jimp.mjs --in <npm 装好的 node_modules> --out <输出 node_modules>
//
// 做的事：
//   1. 从 seeds（见 <版本>/patches/jimp-deps.json（如 0.2.0-rc.2/patches/jimp-deps.json））出发，按 package.json 的 dependencies 递归收集闭包
//   2. 只复制这些包（扁平布局，与 npm 装出来的一致）
//   3. 去杂物：dist/esm（保留 dist/commonjs）、src、test*、example*、*.d.ts/*.map/*.md 等
//   4. zod 只留 v3/（它的 index.cjs 转发到 v3；v4/v4-mini/src 用不到）
//
// 产物约 7 MiB 展开（压缩后 ~1.2 MiB），装到
//   node_modules/@deepseek-ai/dsh-attachment-local/node_modules/
// 下，避免与 dsh 顶层同名依赖（zod / debug / ms / pako 大版本不同）冲突。
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const SEEDS = [
  "@jimp/core",
  "@jimp/js-png",
  "@jimp/js-jpeg",
  "@jimp/plugin-resize",
  "@jimp/plugin-rotate",
  "@jimp/plugin-flip"
];
const JUNK_DIRS = new Set(["src", "test", "tests", "__tests__", "example", "examples", "benchmark", "benchmarks", ".github", "docs"]);
const JUNK_FILE = /(\.d\.ts|\.d\.mts|\.d\.cts|\.map|\.md)$|^README|^CHANGELOG/;

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, "")] = argv[i + 1];
  return out;
}

async function pkgJson(dir) {
  try {
    return JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

async function collect(src) {
  const need = new Set();
  const queue = [...SEEDS];
  const missing = [];
  while (queue.length) {
    const name = queue.shift();
    if (need.has(name)) continue;
    const json = await pkgJson(join(src, name));
    if (json === null) {
      missing.push(name);
      continue;
    }
    need.add(name);
    for (const dep of Object.keys(json.dependencies ?? {})) if (!need.has(dep)) queue.push(dep);
  }
  return { need, missing };
}

/** 收集包入口（main/module/browser + exports 的运行时条件；types 条件不算），返回相对路径集合 */
function entryPaths(pkg) {
  const out = [];
  const push = (value) => {
    if (typeof value !== "string") return;
    out.push(value.replace(/^\.\//, ""));
  };
  for (const key of ["main", "module", "browser"]) push(pkg[key]);
  const walk = (node, isTypes) => {
    if (typeof node === "string") {
      if (!isTypes) push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, isTypes);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) walk(value, isTypes || key === "types");
  };
  walk(pkg.exports, false);
  walk(pkg.imports, false);
  return out;
}

/** 包入口是否落在该目录里（落在里面就不能当杂物删掉：如 debug 的入口就是 src/index.js） */
function dirHoldsEntry(dirName, entries) {
  return entries.some((e) => e === dirName || e.startsWith(dirName + "/"));
}

async function strip(dir, hasCjs, entries) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (JUNK_DIRS.has(entry.name) && !dirHoldsEntry(entry.name, entries)) {
        await rm(full, { recursive: true, force: true });
        continue;
      }
      if (entry.name === "esm" && hasCjs && dir.endsWith("dist")) {
        await rm(full, { recursive: true, force: true });
        continue;
      }
      await strip(full, hasCjs, entries);
      continue;
    }
    if (JUNK_FILE.test(entry.name)) await rm(full, { force: true });
  }
}

const { in: srcDir, out: outDir } = args();
if (!srcDir || !outDir) {
  console.error("用法: node scripts/trim-jimp.mjs --in <node_modules> --out <node_modules>");
  process.exit(2);
}

const { need, missing } = await collect(srcDir);
if (missing.length > 0) {
  console.error("缺包（先在 --in 里 npm install 种子包）:", missing.join(", "));
  process.exit(1);
}
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
for (const name of [...need].sort()) {
  const pkgDir = join(outDir, name);
  await cp(join(srcDir, name), pkgDir, { recursive: true });
  const pkg = await pkgJson(pkgDir);
  await strip(pkgDir, existsSync(join(pkgDir, "dist", "commonjs")), entryPaths(pkg ?? {}));
}
for (const extra of ["zod/v4", "zod/v4-mini", "zod/src"]) {
  await rm(join(outDir, extra), { recursive: true, force: true });
}

let files = 0;
let bytes = 0;
async function measure(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await measure(full);
    else {
      files++;
      bytes += (await stat(full)).size;
    }
  }
}
await measure(outDir);
console.log(`裁剪完成：${need.size} 个包，${files} 个文件，${(bytes / 1048576).toFixed(1)} MiB -> ${outDir}`);
