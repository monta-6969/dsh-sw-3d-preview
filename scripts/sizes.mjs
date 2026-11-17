#!/usr/bin/env node
/**
 * README 字节数表自动生成 / 校验。
 *
 * 为什么需要它
 * ------------
 * 两张 README 的第 10 节里有一张「各文件字节数」表，14 行手抄的数字。
 * 只要有人改一行业务代码，表里那一行立刻变成假的；而「变成假的」永远没人发现，
 * 因为文档照样渲染。更糟的是原文还写着「版本 0.2.2、client.js 2,533,655 字节时测得」——
 * 这个句子把**测量那一刻的状态**钉进了文档，于是它除了是一次记录，也是一份会持续腐烂的债。
 *
 * 所以这里做两件事：
 *   1. 数字由机器从 `scripts/package.mjs` 的 `collectManifest()` 算出来（那是「包里有什么」的唯一真相）
 *   2. 只用 `<!-- sizes:begin -->` / `<!-- sizes:end -->` 包住**数字那一块**重写，
 *      表格的列宽、说明文字、行序全部保留 —— 人维护结构，机器维护数字
 *
 * 只替换数字，不重排表格
 * ----------------------
 * 现有表格是「文件名左对齐 + 数字右对齐到第 26 列 + 说明文字」的手工排版。
 * 本脚本**不重建**这张表，只把每一行里那个数字换成真值，并维持右对齐到位。
 * 说明文字一个字符都不动 —— 那是人写的，机器没资格改。
 *
 * 故意不写数字的行
 * ----------------
 * `README.md` / `CHANGELOG.md` 两行本来就不带数字：它们的字节数随文档编辑立刻变化，
 * 写进去必然过期。这两行在脚本里是**显式豁免**，而且反向断言：豁免清单之外的每个
 * 清单文件都必须在表里出现，否则说明有人加了文件却没更新表格 —— 那也是失效，只是更隐蔽。
 *
 * 用法
 * ----
 *   node scripts/sizes.mjs            # 重写两张 README 的数字
 *   node scripts/sizes.mjs --check    # 只比对不写；不一致时退出码 1
 *   node scripts/sizes.mjs --verbose  # 逐行列出比对结果
 *
 * 不联网、不重打包、不 spawn 任何外部命令。
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectManifest } from './package.mjs';

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 要维护的文档（相对插件根）。中英两版结构相同，说明文字不同。 */
export const DOC_FILES = ['README.md', 'README.en.md'];

export const BEGIN = '<!-- sizes:begin -->';
export const END = '<!-- sizes:end -->';

/**
 * 表里**故意不写数字**的文件 —— 它们的字节数会随文档编辑立刻变化，
 * 写进 README 只会变成假数据（这条规则是文档作者原先就写在正文里的，不是脚本自己发明的）。
 */
export const NO_NUMBER_FILES = ['README.md', 'CHANGELOG.md'];

/**
 * 表里**本来就不列**的文件 —— 与代码无关或极小，作者当初选择不放进这张「各文件字节数」表。
 *
 * 这份名单不是「豁免一切」：清单里出现一个既不在表里、也不在这份名单里的文件（比如新加的
 * `lib/xxx.js`）仍然是 problem —— 那说明有人往包里加了模块却没更新文档，属于同一类腐烂。
 */
export const NOT_IN_TABLE = ['LICENSE', 'icon.svg'];

/** 表格里「数字右对齐到第几列」（1-based，含该列）。取自现有手工排版。 */
const NUMBER_COLUMN = 26;

/**
 * 自我指涉的旧句式：`版本 0.2.2、client.js 2,533,655 字节时测得`。
 *
 * 这类句子是这张表持续腐烂的根因 —— 它把「测量时的那一刻」写死进文档。
 * 换成「本表由 `node scripts/sizes.mjs` 生成」之后，句子永远成立。
 * 脚本不自动改写散文，只负责**指出来**（人决定怎么措辞）。
 */
const SELF_REF_RE = /`?client\.js`?\s*[\d,]{4,}\s*字节时测得/;

// --------------------------------------------------------------------------- 数字格式化

/** 与现有表格一致：千分位逗号。 */
export function formatBytes(bytes) {
  return String(bytes).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 清单里的 `lib/mesh.js` 在表里写成 Windows 风格的 `lib\mesh.js`（与文档其余部分一致）。 */
function tableName(rel) {
  return rel.replace(/\//g, '\\');
}

/** 反向：表里的 `lib\mesh.js` → 清单里的 `lib/mesh.js`。 */
function manifestName(name) {
  return name.replace(/\\/g, '/');
}

/** 收集清单文件的真实字节数：`Map<清单相对路径, 字节数>`。 */
export function collectSizes(root = PLUGIN_DIR) {
  const sizes = new Map();
  for (const rel of collectManifest(root)) sizes.set(rel, statSync(path.join(root, rel)).size);
  return sizes;
}

// --------------------------------------------------------------------------- 表格行解析

/**
 * 拆一行表格。
 *
 * 形如 `index.js            49,775       Host 半边：8 条 /sw3d/* 路由`：
 *   文件名 / 数字（**可能没有**） / 数字之后的原文（含原有空格与说明文字，逐字节保留）
 *
 * 数字之后的原文**原样保留**，这样重写时只需重算「文件名与数字之间的空格」，
 * 说明文字与它的前导空格不会被机器碰到。
 *
 * `README.md` / `CHANGELOG.md` 两行本来就没有数字（见 NO_NUMBER_FILES），所以数字是可选的：
 * 只认「空白之后紧跟一串纯数字」为数字，其余一律当说明文字。
 */
function parseRow(line) {
  const head = /^(\s*)(\S+)(\s+)(.*)$/.exec(line);
  if (!head) return null;
  const [, indent, name, gap, rest] = head;
  // 数字必须是这一段里**唯一**的东西（后面接空白或行尾），否则当作说明文字的一部分
  const numeric = /^(\d[\d,]*)(\s.*|)$/.exec(rest);
  if (!numeric) return { indent, name, gap, number: '', trailing: rest, raw: line };
  const [, number, trailing] = numeric;
  return { indent, name, gap, number, trailing, raw: line };
}

/** 重排一行：数字右对齐到 NUMBER_COLUMN，数字之后的原文不动。无数字行原样返回。 */
function renderRow(row, bytes) {
  if (bytes === null) return row.raw;
  const number = formatBytes(bytes);
  const used = row.indent.length + row.name.length;
  const pad = Math.max(1, NUMBER_COLUMN - used - number.length);
  return `${row.indent}${row.name}${' '.repeat(pad)}${number}${row.trailing}`;
}

// --------------------------------------------------------------------------- 文档处理

/** 找到 marker 区间，返回 `{begin, end}`（行下标，指向 marker 行本身）。 */
export function findMarkers(lines) {
  const begin = lines.indexOf(BEGIN);
  const end = lines.indexOf(END);
  return { begin, end };
}

/** 定位围栏代码块（marker 区间内的第一对 ``` ）。 */
function findFence(lines, begin, end) {
  let open = -1;
  for (let i = begin + 1; i < end; i += 1) {
    if (lines[i].trim().startsWith('```')) {
      if (open < 0) open = i;
      else return { open, close: i };
    }
  }
  return open < 0 ? null : { open, close: -1 };
}

/**
 * 处理一份文档。
 * @param {string} root 插件根
 * @param {string} docRel 文档相对路径
 * @param {Map<string, number>} sizes 清单字节数
 * @param {boolean} write 是否真的写回
 * @returns {{doc: string, ok: boolean, changes: object[], problems: string[], notes: string[]}}
 */
export function processDoc(root, docRel, sizes, write) {
  const filePath = path.join(root, docRel);
  const result = { doc: docRel, ok: true, changes: [], problems: [], notes: [] };
  if (!existsSync(filePath)) {
    result.ok = false;
    result.problems.push(`文档不存在：${docRel}`);
    return result;
  }
  const text = readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const { begin, end } = findMarkers(lines);
  if (begin < 0) {
    result.ok = false;
    result.problems.push(`缺少起始 marker ${BEGIN}`);
    return result;
  }
  if (end < 0) {
    result.ok = false;
    result.problems.push(`缺少结束 marker ${END}`);
    return result;
  }
  if (end < begin) {
    result.ok = false;
    result.problems.push(`${END} 出现在 ${BEGIN} 之前`);
    return result;
  }
  const fence = findFence(lines, begin, end);
  if (!fence || fence.close < 0) {
    result.ok = false;
    result.problems.push('marker 区间内找不到成对的 ``` 代码块');
    return result;
  }

  const seen = new Set();
  for (let i = fence.open + 1; i < fence.close; i += 1) {
    const line = lines[i];
    const row = parseRow(line);
    if (!row) {
      if (line.trim()) result.problems.push(`第 ${i + 1} 行不是可识别的表格行：${JSON.stringify(line)}`);
      continue;
    }
    const rel = manifestName(row.name);
    seen.add(rel);
    if (NO_NUMBER_FILES.includes(rel)) {
      // 故意不写数字行：只断言它确实没数字，不参与重写
      if (row.number) result.problems.push(`第 ${i + 1} 行 ${row.name} 属于「故意不写数字」，却写着 ${row.number}`);
      continue;
    }
    if (!sizes.has(rel)) {
      result.problems.push(`第 ${i + 1} 行 ${row.name} 不在随包清单里（清单：${[...sizes.keys()].join(', ')}）`);
      continue;
    }
    const real = sizes.get(rel);
    const rendered = renderRow(row, real);
    if (rendered !== line) {
      result.changes.push({ lineNo: i + 1, name: row.name, from: row.number || '（空）', to: formatBytes(real) });
      lines[i] = rendered;
    }
  }

  // 反向完整性：清单里的每个文件都得在表里有一行（否则新加文件时表格静默漏项）
  for (const rel of sizes.keys()) {
    if (seen.has(rel)) continue;
    if (NOT_IN_TABLE.includes(rel)) continue;
    result.problems.push(`清单里的 ${rel} 在表格里没有对应行（${tableName(rel)}）`);
  }

  if (SELF_REF_RE.test(text)) {
    result.notes.push('正文里仍有自我指涉的旧句式（「… client.js N 字节时测得」），建议改成「本表由 node scripts/sizes.mjs 生成」');
  }

  if (result.changes.length && write) {
    writeFileSync(filePath, lines.join('\n'), 'utf8');
  }
  result.ok = result.problems.length === 0;
  return result;
}

// --------------------------------------------------------------------------- 主流程

export function run(options = {}) {
  const root = options.root ? path.resolve(options.root) : PLUGIN_DIR;
  const write = !options.check;
  const sizes = collectSizes(root);
  const results = DOC_FILES.map((doc) => processDoc(root, doc, sizes, write));
  const ok = results.every((item) => item.ok) && (options.check ? results.every((item) => item.changes.length === 0) : true);
  return { root, sizes, results, ok, check: Boolean(options.check) };
}

function print(report, options) {
  const { sizes, results, check } = report;
  console.log(`[sizes] 清单 ${sizes.size} 个文件，共 ${sizes.size - NO_NUMBER_FILES.length} 行需要数字`);
  console.log(`[sizes] 模式：${check ? '--check（只比对不写）' : '写入'}`);
  console.log('');
  let totalChanges = 0;
  let totalProblems = 0;
  for (const item of results) {
    const status = item.problems.length ? 'FAIL' : item.changes.length ? (check ? 'DRIFT' : 'UPDATED') : 'OK';
    console.log(`${item.doc.padEnd(14)} ${status}`);
    for (const change of item.changes) {
      totalChanges += 1;
      console.log(`  ${check ? '≠' : '~'} 第 ${change.lineNo} 行 ${change.name.padEnd(18)} ${change.from} → ${change.to}`);
    }
    for (const problem of item.problems) {
      totalProblems += 1;
      console.log(`  ✘ ${problem}`);
    }
    for (const note of item.notes) console.log(`  ! ${note}`);
    if (options.verbose && !item.changes.length && !item.problems.length) console.log('  全部数字与磁盘一致');
  }
  console.log('');
  if (check && totalChanges) {
    console.log(`[sizes] 结论：FAIL —— ${totalChanges} 处数字与磁盘不一致。跑 node scripts/sizes.mjs 更新。`);
    return 1;
  }
  if (totalProblems) {
    console.log(`[sizes] 结论：FAIL —— ${totalProblems} 处结构问题`);
    return 1;
  }
  console.log(check ? '[sizes] 结论：OK（数字与磁盘一致）' : `[sizes] 结论：OK（${totalChanges} 处已更新）`);
  return 0;
}

function parseArgs(argv) {
  const options = { check: false, verbose: false, root: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') options.check = true;
    else if (arg === '--verbose' || arg === '-v') options.verbose = true;
    else if (arg === '--root') {
      const value = argv[i + 1];
      if (!value) throw new Error('--root 需要一个目录参数');
      options.root = path.resolve(value);
      i += 1;
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`不认识的参数：${arg}（支持 --check / --verbose / --root <dir>）`);
  }
  return options;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[sizes] ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log('用法：node scripts/sizes.mjs [--check] [--verbose] [--root <dir>]');
    return;
  }
  try {
    process.exitCode = print(run(options), options);
  } catch (error) {
    console.error(`[sizes] 失败：${error && error.stack ? error.stack : error}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
