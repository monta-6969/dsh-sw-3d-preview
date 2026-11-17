#!/usr/bin/env node
/**
 * 打包 dsh-sw-3d-preview → 可交给别人的产物。
 *
 * 产物（默认写到插件目录下的 dist\）：
 *   1. 一个可分发目录  dist\dsh-sw-3d-preview-<version>\
 *   2. 一个压缩包      dist\dsh-sw-3d-preview-<version>.tgz（npm 风格，条目前缀 package/）
 *
 * 打包后自检（任一不过就退出码 1，不留半成品）：
 *   - 必需文件齐全：index.js client.js cordis.patch.yml package.json README.md CHANGELOG.md
 *                   LICENSE icon.svg lib\*.js lib\step_mesh.py vendor\three.cjs
 *   - vendor\three.cjs 真的在产物里（它随 git 分发，package.json 的 files 也显式列了它；
 *     npm pack 会带上它，这里不依赖 npm，自己复制一遍再断言字节数）
 *   - LICENSE 真的在产物里（MIT 要求分发时必须随附许可证全文，缺了就是许可不合规）
 *   - 产物里不含本机绝对路径（扫当前用户名 / 家目录 / 插件所在路径这类只有本机才有的字样）
 *   - package.json 的 dsh.bundle.patch 指向的文件真的存在
 *
 * 用法：
 *   node scripts/package.mjs                # 打到 <插件>\dist\
 *   node scripts/package.mjs --out D:\tmp\x # 换输出目录
 *   node scripts/package.mjs --dir-only     # 只出目录，不出 tgz
 *
 * 不联网、不执行 npm publish / pnpm publish、不 spawn 任何外部命令。
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8'));
const STAGE_NAME = `dsh-sw-3d-preview-${PKG.version}`;

/** 必需文件（相对插件根，正斜杠）。lib 目录按目录展开后逐个校验。 */
const REQUIRED_FILES = [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'icon.svg',
  'lib/step_mesh.py',
  'vendor/three.cjs',
];
/**
 * lib/ 下**必须**随包分发的模块（相对插件根，正斜杠，按字母序）。
 *
 * 这里是「少一个就装不起来」的硬清单：index.js 直接 import 了它们，
 * 缺任何一个安装后都会 ERR_MODULE_NOT_FOUND，插件整个加载失败。
 * collectManifest() 会扫 lib/ 自动收全，本清单则是**独立断言**：
 * 防止将来有人改了 collectManifest 的扫描规则（比如又退回非递归），
 * 把某个被 import 的模块静默漏掉。
 */
const REQUIRED_LIB_MODULES = [
  'lib/ext-token.js',
  'lib/handoff.js',
  'lib/mesh.js',
  'lib/paths.js',
  'lib/resolve.js',
  'lib/sketches.js',
];

/**
 * 「只有本机才会出现」的字样 —— **不写死任何一台机器的字符串**，全部由运行时事实推导：
 *   1. 当前用户名（os.userInfo().username）
 *   2. 完整家目录（%USERPROFILE%，正反斜杠两种写法）
 *   3. 插件目录及其每一级祖先的**完整路径**（正反斜杠两种写法）——
 *      只取整段路径，不取单个目录名，避免「临时文件」这种通用词把正常文案判成泄漏。
 * 这样脚本自己永远干净（不会把自己算成本机路径泄漏），换台机器自动适配新的用户名/目录。
 */
export function localPathLiterals() {
  const literals = new Set();
  let username = '';
  try {
    username = String(os.userInfo().username || '');
  } catch {
    username = '';
  }
  // 用户名太短（1–2 个字符）会到处误命中，跳过；正常用户名长度足够当指纹
  if (username.length >= 3) literals.add(username);
  const home = String(os.homedir() || '');
  if (home.length >= 4) {
    literals.add(home);
    literals.add(home.replace(/\\/g, '/'));
  }
  let dir = PLUGIN_DIR;
  for (let depth = 0; depth < 6; depth += 1) {
    literals.add(dir);
    literals.add(dir.replace(/\\/g, '/'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [...literals].filter((value) => value.length >= 4);
}

/** 超过这个大小的文件不扫内容（当前最大的 three.cjs 2.1 MB，仍会扫）。 */
const SCAN_SIZE_LIMIT = 16 * 1024 * 1024;

// --------------------------------------------------------------------------- 参数

function parseArgs(argv) {
  const options = { outDir: path.join(PLUGIN_DIR, 'dist'), tgz: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      const value = argv[i + 1];
      if (!value) throw new Error('--out 需要一个目录参数');
      options.outDir = path.resolve(value);
      i += 1;
    } else if (arg === '--dir-only') {
      options.tgz = false;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`不认识的参数：${arg}（支持 --out <dir> / --dir-only）`);
    }
  }
  return options;
}

// --------------------------------------------------------------------------- 文件清单

/**
 * 递归收集 `lib/` 下所有 `.js` / `.mjs` / `.py`（相对插件根，正斜杠）。
 *
 * 为什么必须递归：早先这里用的是非递归 `readdirSync` + `entry.isFile()`，
 * 一旦 `lib/` 出现子目录（如 `lib/util/xxx.js`），里面的文件会**静默不进包**，
 * 而打包自检照样通过 —— 装到别人机器上运行时才 500/ERR_MODULE_NOT_FOUND。
 * 这是「打包成功但运行时坏掉」的经典陷阱，所以这里递归扫全，
 * 并由 test/package.mjs 的「清单数 == 磁盘数」断言兜底。
 *
 * @param {string} libDir 绝对路径
 * @param {string} [prefix] 递归时的相对前缀（正斜杠）
 * @returns {string[]} 形如 `lib/util/xxx.js`
 */
export function collectLibFiles(libDir, prefix = 'lib') {
  const out = [];
  if (!existsSync(libDir)) return out;
  for (const entry of readdirSync(libDir, { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      // 跳过 Python 缓存等非分发目录
      if (entry.name === '__pycache__') continue;
      out.push(...collectLibFiles(path.join(libDir, entry.name), rel));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(js|mjs|py)$/i.test(entry.name)) continue;
    out.push(rel);
  }
  return out;
}

/** 要随包分发的文件（相对路径，正斜杠）。这就是「产物里应该有什么」的唯一真相。 */
export function collectManifest(root = PLUGIN_DIR) {
  const files = [];
  for (const rel of REQUIRED_FILES) {
    if (rel.startsWith('lib/') || rel.startsWith('vendor/')) continue;
    files.push(rel);
  }
  // lib/ 递归收集：子目录里的模块也必须进包
  files.push(...collectLibFiles(path.join(root, 'lib')));
  files.push('vendor/three.cjs');
  return [...new Set(files)].sort();
}

function copyInto(stageRoot, rel) {
  const from = path.join(PLUGIN_DIR, rel);
  const to = path.join(stageRoot, rel);
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
  return statSync(to).size;
}

// --------------------------------------------------------------------------- tar.gz（离线、无依赖）

function tarHeader({ name, size, mode, mtime }) {
  const header = Buffer.alloc(512, 0);
  const write = (value, offset, length) => header.write(value, offset, length, 'utf8');
  write(name, 0, 100);
  write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8);
  write('0000000\0', 108, 8); // uid
  write('0000000\0', 116, 8); // gid
  write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12);
  write(`${Math.floor(mtime / 1000).toString(8).padStart(11, '0')}\0`, 136, 12);
  write('        ', 148, 8); // checksum 占位（8 个空格）
  write('0', 156, 1); // typeflag: 普通文件
  write('ustar\0', 257, 6);
  write('00', 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return header;
}

/** 把 {relPath, bytes} 列表打成 USTAR + gzip。条目名统一加 package/ 前缀（npm 习惯）。 */
export function buildTgz(entries, { mtime = Date.now() } = {}) {
  const chunks = [];
  for (const entry of entries) {
    const name = `package/${entry.relPath}`;
    if (Buffer.byteLength(name, 'utf8') > 100) throw new Error(`tar 条目名过长（>100 字节）：${name}`);
    chunks.push(tarHeader({ name, size: entry.bytes.length, mode: 0o644, mtime }));
    chunks.push(entry.bytes);
    const pad = (512 - (entry.bytes.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(1024, 0)); // 两个全零块 = 归档结束
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

// --------------------------------------------------------------------------- 自检

/** 扫一个文件里有没有本机字样。返回 [{literal, offset}]。 */
export function scanFileForLocalPaths(filePath, literals = localPathLiterals()) {
  if (!existsSync(filePath)) return [];
  const stat = statSync(filePath);
  if (!stat.isFile() || stat.size > SCAN_SIZE_LIMIT) return [];
  const text = readFileSync(filePath).toString('utf8');
  const hits = [];
  for (const literal of literals) {
    const index = text.indexOf(literal);
    if (index >= 0) hits.push({ literal, offset: index });
  }
  return hits;
}

/**
 * 对产物目录做全套自检。
 * @returns {{ok:boolean, checks:Array<{name:string, ok:boolean, detail:string}>}}
 */
export function verifyStage(stageRoot) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  const required = [...REQUIRED_FILES, ...REQUIRED_LIB_MODULES];
  const missing = required.filter((rel) => !existsSync(path.join(stageRoot, rel)));
  add('必需文件齐全', missing.length === 0, missing.length ? `缺少：${missing.join(', ')}` : `${required.length} 个必需文件都在`);

  const threePath = path.join(stageRoot, 'vendor', 'three.cjs');
  const threeBytes = existsSync(threePath) ? statSync(threePath).size : 0;
  add(
    'vendor/three.cjs 在包里',
    threeBytes > 2_000_000,
    threeBytes ? `${threeBytes} 字节` : '不在产物里（会被 /sw3d/three.js 与 ping.three 依赖）',
  );

  // MIT 要求「许可证全文随所有副本或实质性部分一起分发」：漏了 LICENSE 就不是合规的 MIT 分发包。
  const licensePath = path.join(stageRoot, 'LICENSE');
  const licenseText = existsSync(licensePath) ? readFileSync(licensePath, 'utf8') : '';
  add(
    'LICENSE 在包里且是 MIT 全文',
    licenseText.includes('MIT License') && licenseText.includes('WITHOUT WARRANTY OF ANY KIND'),
    licenseText ? `${statSync(licensePath).size} 字节` : '不在产物里（MIT 要求随附许可证全文）',
  );

  const manifest = collectManifest();
  const missingManifest = manifest.filter((rel) => !existsSync(path.join(stageRoot, rel)));
  add(
    '清单内文件全部复制到',
    missingManifest.length === 0,
    missingManifest.length ? `缺少：${missingManifest.join(', ')}` : `${manifest.length} 个文件`,
  );

  // lib/ 源码完整性：产物里 lib/ 下递归的 .js/.mjs/.py 必须与源目录**一一对应**。
  // 这条专门防「清单漏登记 → 文件静默不进包 → 安装后 ERR_MODULE_NOT_FOUND」。
  const stageLib = collectLibFiles(path.join(stageRoot, 'lib'));
  const sourceLib = collectLibFiles(path.join(PLUGIN_DIR, 'lib'));
  const libMissing = sourceLib.filter((rel) => !stageLib.includes(rel));
  const libExtra = stageLib.filter((rel) => !sourceLib.includes(rel));
  add(
    'lib/ 源码完整（无静默漏包）',
    libMissing.length === 0 && libExtra.length === 0,
    libMissing.length || libExtra.length
      ? `漏包：${libMissing.join(', ') || '无'}；多出：${libExtra.join(', ') || '无'}`
      : `${stageLib.length} 个 lib 文件与源一致`,
  );

  // 被 index.js 直接 import 的本地模块必须真的在产物里（静态解析，不执行代码）。
  const entryPath = path.join(stageRoot, 'index.js');
  const entryText = existsSync(entryPath) ? readFileSync(entryPath, 'utf8') : '';
  const localImports = [...entryText.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)].map((match) => match[1]);
  const unresolved = [];
  for (const spec of localImports) {
    const target = path.join(stageRoot, spec.replace(/^\.\//, ''));
    if (!existsSync(target)) unresolved.push(spec);
  }
  add(
    'index.js 的本地 import 全部能在产物里找到',
    localImports.length > 0 && unresolved.length === 0,
    unresolved.length ? `解析不到：${unresolved.join(', ')}` : `${localImports.length} 个本地 import 全部就位`,
  );

  const stagePkgPath = path.join(stageRoot, 'package.json');
  let stagePkg = null;
  try {
    stagePkg = JSON.parse(readFileSync(stagePkgPath, 'utf8'));
  } catch (error) {
    stagePkg = null;
  }
  add('产物 package.json 可解析', Boolean(stagePkg), stagePkg ? `${stagePkg.name}@${stagePkg.version}` : '读不到或不是合法 JSON');
  const patchRel = stagePkg?.dsh?.bundle?.patch;
  add(
    'dsh.bundle.patch 指向的文件存在',
    Boolean(patchRel) && existsSync(path.join(stageRoot, String(patchRel).replace(/^\.\//, ''))),
    patchRel ? `${patchRel}` : 'package.json 缺 dsh.bundle.patch',
  );
  add(
    'dsh.client 声明齐全',
    Boolean(stagePkg?.dsh?.client?.platform) && existsSync(path.join(stageRoot, 'client.js')),
    stagePkg?.dsh?.client?.platform ? `platform=${stagePkg.dsh.client.platform}` : '缺 dsh.client.platform',
  );

  const localPathHits = [];
  const literals = localPathLiterals();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      for (const hit of scanFileForLocalPaths(full, literals)) {
        localPathHits.push(`${path.relative(stageRoot, full).replace(/\\/g, '/')} 含「${hit.literal}」`);
      }
    }
  };
  walk(stageRoot);
  add(
    '产物不含本机绝对路径',
    localPathHits.length === 0,
    localPathHits.length ? localPathHits.join('；') : `扫描了 ${literals.length} 个本机字样（用户名/家目录/插件路径里的非 ASCII 段），0 命中`,
  );

  const files = [];
  const collect = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collect(full);
        continue;
      }
      files.push({ relPath: path.relative(stageRoot, full).replace(/\\/g, '/'), bytes: readFileSync(full), size: statSync(full).size });
    }
  };
  collect(stageRoot);
  add('产物非空', files.length > 0 && files.some((file) => file.size > 1_000_000), `${files.length} 个文件，最大 ${Math.max(0, ...files.map((f) => f.size))} 字节`);

  return { ok: checks.every((check) => check.ok), checks, files };
}

// --------------------------------------------------------------------------- 主流程

export async function packagePlugin(options = {}) {
  const outDir = options.outDir || path.join(PLUGIN_DIR, 'dist');
  const wantTgz = options.tgz !== false;
  const stageRoot = path.join(outDir, STAGE_NAME);

  // 先清掉同版本的旧产物：宁可没有，也不留半新半旧的包
  rmSync(stageRoot, { recursive: true, force: true });
  mkdirSync(stageRoot, { recursive: true });

  const manifest = collectManifest();
  const sizes = new Map();
  for (const rel of manifest) sizes.set(rel, copyInto(stageRoot, rel));

  const verified = verifyStage(stageRoot);

  const report = {
    version: PKG.version,
    name: PKG.name,
    outDir,
    stageRoot,
    tgzPath: null,
    tgzBytes: 0,
    files: verified.files.map((file) => ({ path: file.relPath, bytes: file.size })),
    fileCount: verified.files.length,
    totalBytes: verified.files.reduce((sum, file) => sum + file.size, 0),
    checks: verified.checks,
    ok: verified.ok,
    sha256: createHash('sha256')
      .update(verified.files.map((file) => `${file.relPath}:${file.size}`).join('|'))
      .digest('hex'),
  };

  if (!verified.ok) {
    rmSync(stageRoot, { recursive: true, force: true });
    return report;
  }

  if (wantTgz) {
    const tgzPath = path.join(outDir, `${STAGE_NAME}.tgz`);
    const bytes = buildTgz(verified.files.map((file) => ({ relPath: file.relPath, bytes: file.bytes })));
    writeFileSync(tgzPath, bytes);
    report.tgzPath = tgzPath;
    report.tgzBytes = bytes.length;
  }

  return report;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('用法：node scripts/package.mjs [--out <dir>] [--dir-only]');
    return;
  }
  packagePlugin(options)
    .then((report) => {
      console.log(`[package] ${report.name}@${report.version}`);
      console.log(`[package] 目录产物：${report.stageRoot}`);
      if (report.tgzPath) console.log(`[package] 压缩包  ：${report.tgzPath}（${report.tgzBytes} 字节）`);
      console.log(`[package] 文件数  ：${report.fileCount} · 总字节数：${report.totalBytes}`);
      console.log('[package] 清单：');
      for (const file of report.files) console.log(`  - ${file.path}  ${file.bytes}`);
      console.log('[package] 自检：');
      for (const check of report.checks) console.log(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name}：${check.detail}`);
      console.log(`[package] 结论：${report.ok ? 'OK' : 'FAILED'}`);
      if (!report.ok) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(`[package] 失败：${error && error.stack ? error.stack : error}`);
      process.exitCode = 1;
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
