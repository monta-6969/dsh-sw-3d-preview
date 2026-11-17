#!/usr/bin/env node
/**
 * 文档行号引用校验：让「文档里的 `文件:行号` 已经指错地方」变成可机械判定的红/绿。
 *
 * 为什么需要它
 * ------------
 * README / CONTRIBUTING / SECURITY / docs 里有 200 多处 `client.js:9220` 这种引用。
 * 只要有人往被引用的源文件上方插几行，下面**所有**行号一起漂，而「漂了」永远不会有人发现：
 * 文档照样渲染，只是安静地指向了错误的行。这不是某一次笔误，是数字型文档的结构性缺陷，
 * 靠人肉每轮手算行号必然再次腐烂。所以这里只做一件事：把「漂没漂」交给机器判。
 *
 * 判定方法（对每一处引用）
 * -----------------------
 *   1. 行号超出源文件总行数                → 失效（fail-closed，一定错，没有容差）
 *   2. 从**同一 markdown 行**抽符号名候选：
 *        - 反引号 `…` 里的标识符
 *        - 反引号外的 SCREAMING_SNAKE / camelCase / PascalCase / `名字(` 调用式
 *      （纯小写的普通词不算，否则 `path`、`mesh` 这种高频词会让整篇断言恒真）
 *   3. 在 [行号-10, 行号+10] 窗口里找这些候选，找到即「通过」
 *   4. 同一行里一个符号名都抽不出来         → 不可自校验（warn，不判红）
 *
 * 两种写法都收
 * ------------
 *   `文件:行号`  —— `index.js:491`、`lib\mesh.js:451-456`。文件名自带，直接解析。
 *   `符号 @ 行号` —— `` `allowTrusted()` @492 ``、`` `logExternal` @ `index.js:159` ``。
 *     **第二种以前完全没收**（`REF_RE` 要求文件名 + 扩展名 + `:`，裸 `@NNN` 一个字都匹配不到），
 *     于是它既不 fail 也不 skip、直接不进统计：文档里 20 处裸 `@NNN` 全是失效的，闸门却一直报绿。
 *     裸行号没有文件名，归属按四级降级（详见 `scanRefs` 里的注释）：
 *       显式（`@` 后面自己写了 `文件:`）> 同行最近的可解析文件名 > 段落（标题重置）> 默认 `index.js`。
 *     默认值 fail-closed 是故意的：归属错会报一条**假红**，人看一眼就改成显式写法；
 *     而「没归属就跳过」等于留一个「写得含糊就能绕过闸门」的后门。
 *
 * 为什么 ±10 容差：上方增删几行会让下面整段平移，这种「小漂」不影响阅读，
 * 判红只会逼人做无意义的行号搬运；而真失效（符号根本不在那一带）仍然会红。
 *
 * 两种模式
 * --------
 *   默认       fail 降级为 warn，退出码 0 —— 先以这种方法接入 CI 拿基线，不阻断任何人
 *   --strict   fail 就是 fail，退出码 1 —— 基线清干净之后再开
 *
 * 用法
 * ----
 *   node scripts/check-refs.mjs                 # 报告，退出码 0
 *   node scripts/check-refs.mjs --strict        # 有失效就退出码 1
 *   node scripts/check-refs.mjs --verbose       # 连「不可自校验」的逐条列出
 *   node scripts/check-refs.mjs --root <目录>   # 换扫描根（自测/夹具用，不碰真文档）
 *
 * 不联网、不改任何文件、不执行被引用的代码（只读文本 + 数行）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 文档清单（相对扫描根，正斜杠）。docs/ 下的 *.md 递归收。 */
const DOC_FILES = ['README.md', 'README.en.md', 'CONTRIBUTING.md', 'SECURITY.md'];
const DOC_DIRS = ['docs'];

/** 行号容差：±10 行以内的漂移不判红。 */
export const TOLERANCE = 10;

/**
 * 引用形式：`client.js:1507`、`index.js:65-72`、`lib\mesh.js:451-456`、`test/host.mjs:26`，
 * 以及不带目录的 `step_mesh.py:167`（basename 在仓库里唯一时解析得出来）。
 *
 * 注意目录分隔符**正反斜杠都收**：Windows 上写出来的文档普遍是 `lib\mesh.js`，
 * 只认 `/` 会让绝大多数引用根本进不了统计 —— 那种「一条都没抓到、所以全绿」的脚本
 * 比没有脚本更糟。
 */
const REF_RE = /(?<![\w$./\\-])((?:[\w$-]+[\\/])?[\w.-]+\.(?:js|mjs|py)):(\d+)(?:\s*[-–—]\s*(\d+))?/g;

/**
 * 裸行号引用：`` `handlePing` @492 ``、`` `allowTrusted()` @ `index.js:491` ``。
 *
 * 为什么必须单独一条正则
 * ----------------------
 * `REF_RE` 要求「文件名 + 扩展名 + `:` + 数字」。而 `` `handlePing` @492 `` 里没有文件名，
 * `REF_RE` **一个字都收不到**——既不 fail 也不 skip，直接不进统计。这类引用因此成了闸门的
 * 盲区：文档里 20 处裸 `@NNN` 全是失效的，而 `--strict` 一直报绿。这不是「少验几处」，
 * 是「有一整类引用根本没被验过」。
 *
 * 符号名必须在反引号里：正文里的 `` @ 2026 `` 这类不该被当成引用。
 * 行号部分允许 `@492` / `@ 492` / `` @ `492` `` / `@` 文件:492`` 四种写法。
 */
const BARE_REF_RE =
  /`([A-Za-z_$][\w$]*)`\s*@\s*(?:`((?:[\w$-]+[\\/])?[\w.-]+\.(?:js|mjs|py)):\s*)?`?\s*(\d+)(?:\s*[-–—]\s*(\d+))?\s*`?/g;

/**
 * 同一行里「可能被当成归属目标」的文件名。
 *
 * 结尾的 `(?![A-Za-z0-9_])` **不能省**：没有它，`package.json` 会被读成 `package.j` 之后
 * 再匹配到 `.js`，`recent.json` 变 `recent.js`、`annotations.jsonl` 变 `annotations.js`，
 * 于是一整行引用的归属被静默指到**不存在的文件**上。那种错不会报错，只会让行号校验
 * 失去意义，所以这里宁可严格。
 */
const FILE_IN_LINE_RE = /((?:[\w$-]+[\\/])?[\w.-]+\.(?:js|mjs|py))(?![A-Za-z0-9_])/g;

/**
 * 判定一条**裸行号**引用（`` `handlePing` @492 ``）。
 *
 * 与 `evaluate()` 的区别：符号名是**显式**给的（反引号里那个），不需要从整行去猜，
 * 所以这里不走 `collectSymbols` 那套归属切分，直接拿符号名去窗口里找。
 * 找不到就报 fail，并在 reason 里带上「符号实际在第几行」。
 */
function evaluateBare({ doc, lineNo, line, match, file, via, index, cache }) {
  const symbol = match[1];
  const start = Number(match[3]);
  const end = match[4] ? Number(match[4]) : start;
  const base = { doc, lineNo, ref: match[0].trim(), rawFile: file, start, end, symbol, bare: true, via };

  const rel = resolveRef(file, index);
  if (!rel) {
    return { ...base, file: null, status: 'fail', reason: `解析不到被引用的文件（${file}）` };
  }

  const lines = sourceLines(rel, cache);
  if (start < 1 || end < start || end > lines.length) {
    const shown = end === start ? `${start}` : `${start}-${end}`;
    return { ...base, file: rel, status: 'fail', reason: `行号 ${shown} 超出 ${rel} 的总行数 ${lines.length}` };
  }

  // 与 findHit 用同一套「大小写不敏感 + 长符号允许当前缀 + 短符号要词尾边界」的匹配，
  // 免得裸引用比 file:line 引用更严/更松，两套口径打架。
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tail = symbol.length >= 6 ? '' : '(?![\\w$])';
  const pattern = new RegExp(`(?<![\\w$])${escaped}${tail}`, 'i');

  const low = Math.max(1, start - TOLERANCE);
  const high = Math.min(lines.length, end + TOLERANCE);
  for (let n = low; n <= high; n += 1) {
    if (pattern.test(lines[n - 1])) {
      const lineOffset = n < start ? n - start : n > end ? n - end : 0;
      return { ...base, file: rel, status: 'pass', at: n, lineOffset, weak: Math.abs(lineOffset) > 5 };
    }
  }

  // 报错要能直接照着改：把符号**实际**所在的全部行号给出（最多 3 个）。
  const found = [];
  for (let n = 1; n <= lines.length && found.length < 3; n += 1) if (pattern.test(lines[n - 1])) found.push(n);
  const actual = lines[start - 1].trim().slice(0, 70);
  return {
    ...base,
    file: rel,
    status: 'fail',
    reason:
      `±${TOLERANCE} 行内找不到 ${symbol}；第 ${start} 行实际是「${actual}」；` +
      (found.length ? `${symbol} 实际在 ${found.join('/')}` : `${symbol} 全文都没有`),
  };
}

/** markdown 标题：裸引用的「段落归属」在这一行重置。 */
const HEADING_RE = /^#{1,6}\s/;

/**
 * 文档没写文件名时，裸 `@NNN` 默认归属哪个文件。
 *
 * fail-closed 是**故意的**：归属错了会报一条假红，人看一眼就能改成显式写法；
 * 而「没有归属就跳过」等于给自己留一个「写得含糊就绕过闸门」的后门——那正是
 * 这个脚本存在的理由。实测 README/CONTRIBUTING/SECURITY 里裸引用各 0 条，
 * 因此这条默认值目前不会误伤任何现有文档。
 */
const DEFAULT_BARE_FILE = 'index.js';

/**
 * 高频普通词黑名单（全部按小写比较）。
 *
 * 这些词在源文件里到处都是，一旦允许它们当「证据」，任何行号都能在 ±10 行内命中，
 * 断言就退化成恒真。宁可让这类引用落进「不可自校验」并如实统计，也不让它假装通过。
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'not', 'are', 'can', 'all', 'any', 'but', 'use', 'used', 'see',
  'this', 'that', 'from', 'into', 'than', 'then', 'when', 'what', 'which', 'will', 'have', 'has',
  'was', 'were', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'node', 'path', 'paths', 'json', 'jsonl', 'http', 'https', 'url', 'uri', 'api', 'ok', 'true',
  'false', 'null', 'undefined', 'text', 'body', 'code', 'name', 'names', 'type', 'types', 'item',
  'items', 'list', 'lists', 'line', 'lines', 'file', 'files', 'data', 'get', 'set', 'post', 'put',
  'head', 'delete', 'patch', 'option', 'options', 'python', 'npm', 'pnpm', 'git', 'dsh', 'md',
  'js', 'mjs', 'py', 'csv', 'ts', 'yaml', 'yml', 'appdata', 'localappdata', 'windows', 'linux',
  'macos', 'bash', 'powershell', 'curl', 'step', 'steps', 'stl', 'obj', 'sldprt', 'sldasm',
  'three', 'preview', 'plugin', 'mesh', 'resolve', 'sketch', 'sketches', 'annotation',
  'annotations', 'handoff', 'snapshot', 'snapshots', 'ping', 'cache', 'shots', 'recent', 'mm',
  'kb', 'mb', 'gb', 'byte', 'bytes', 'temp', 'dist', 'test', 'tests', 'scripts', 'lib', 'vendor',
  'docs', 'readme', 'license', 'icon', 'sha1', 'sha256', 'utf', 'base', 'dir', 'root', 'call',
  'true', 'false', 'none', 'self', 'user', 'down', 'back', 'end', 'start', 'left', 'right',
  // 这些在反引号里出现时多半是正文用词（「`content-type`」「`mode` 字段」），
  // 拿来当证据只会让断言变松，不能让它们冒充符号名。
  'only', 'source', 'method', 'count', 'content', 'mode', 'error', 'fence', 'persistence',
  'unavailable', 'string', 'number', 'object', 'array', 'value', 'values', 'index', 'result',
  'error', 'errors', 'status', 'size', 'length', 'offset', 'buffer', 'header', 'headers',
]);

/** 反引号内的标识符：单次扫描用。 */
const IDENT_RE = /[A-Za-z_$][\w$]*/g;
/** 反引号外、只认这几种「一看就是符号名」的形状。 */
const OUTSIDE_RES = [
  /[A-Za-z_$][\w$]*(?=\s*\()/g, // handlePing( / spawn(
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, // SCREAMING_SNAKE
  /\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g, // camelCase
  /\b(?:[A-Z][a-z0-9]+){2,}\b/g, // PascalCase
];

/**
 * 反引号片段是不是「文件路径 / 扩展名 / 环境变量」而不是符号名。
 *
 * `` `vendor\three.cjs` `` 按标识符切开会得到 vendor / three / cjs，其中 `cjs` 会被当成
 * 「这个引用该指向的符号」——纯噪声。`~/AppData/Local` 会切出 `Local` 同理。
 * 这类片段整段丢掉，一个标识符都不取。
 */
function isPathLikeSpan(body) {
  const inner = body.replace(/^`|`$/g, '').trim();
  if (!inner) return true;
  if (/[\\/]/.test(inner)) return true; // 含目录分隔符
  if (/^[\w.-]+\.(?:js|mjs|cjs|py|md|json|jsonl|yml|yaml|ts|txt|tgz|svg)$/i.test(inner)) return true; // 裸文件名
  if (/^%[A-Z_]+%$/.test(inner)) return true; // %LOCALAPPDATA%
  if (/^[~$][\w./\\-]*$/.test(inner)) return true; // ~/AppData/Local
  if (/^\d+$/.test(inner)) return true; // 纯数字
  return false;
}

// --------------------------------------------------------------------------- 文件索引

/**
 * 建「仓库里所有 .js/.mjs/.py」的索引，用于把文档里的引用解析成真实文件。
 *
 * 跳过 node_modules / dist / .git / __pycache__ / vendor：dist 里是**过期的产物副本**，
 * 拿它当真相会让校验在错误的地方通过。
 */
function buildFileIndex(root) {
  const byPath = new Map();
  const byBase = new Map();
  const skip = new Set(['node_modules', 'dist', '.git', '__pycache__', 'vendor']);
  const walk = (dir, prefix) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        walk(path.join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(js|mjs|py)$/i.test(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      byPath.set(rel, rel);
      const list = byBase.get(entry.name) || [];
      list.push(rel);
      byBase.set(entry.name, list);
    }
  };
  walk(root, '');
  return { root, byPath, byBase };
}

/** 文档里写的 `lib\mesh.js` → `lib/mesh.js`；解析不到就返回 null。 */
function resolveRef(raw, index) {
  const norm = raw.replace(/\\/g, '/');
  if (index.byPath.has(norm)) return norm;
  const base = path.posix.basename(norm);
  const hits = index.byBase.get(base) || [];
  // basename 在整个仓库里唯一时才敢猜；同名多个就宁可判「找不到」而不是猜错
  if (hits.length === 1) return hits[0];
  return null;
}

/** 按需读文件并按行缓存（client.js 有 9 万行、被引用上百次，不能重复读）。 */
function sourceLines(rel, cache) {
  if (cache.has(rel)) return cache.get(rel);
  const text = readFileSync(path.join(cache.root, rel), 'utf8');
  const lines = text.split(/\r?\n/);
  // 末尾换行会切出一个空元素，它不对应任何真实行
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  cache.set(rel, lines);
  return lines;
}

// --------------------------------------------------------------------------- 符号名抽取

function isCandidateBase(text) {
  if (text.length < 3) return false;
  if (!/^[A-Za-z_$][\w$]*$/.test(text)) return false;
  return !STOPWORDS.has(text.toLowerCase());
}

/** 反引号外只认「明显是符号名」的形状，避免把正文里的普通英文词当证据。 */
function isCandidateOutside(text) {
  if (!isCandidateBase(text)) return false;
  return text !== text.toLowerCase() || text.includes('_');
}

/**
 * 调用式候选（`JPEG(0.9)`、`render()`）必须带小写或下划线。
 *
 * 纯大写的 ``JPEG(0.9)`` 是**单位/格式名加括号**，不是函数名；把它当符号会让一条
 * 完全正确的引用（`client.js:1008` 那一行确实有 `SNAPSHOT_PNG_LIMIT_BYTES`）
 * 被判成失效。`getContext()`、`buildAnnotationPayload()` 这类才是真符号。
 */
function isCallLikeCandidate(text) {
  if (!isCandidateBase(text)) return false;
  return /[a-z_]/.test(text) || text.includes('_');
}

/** 找到包含 pos 的那对反引号的区间（找不到返回 null）。 */
function enclosingBacktickSpan(line, pos) {
  for (const match of line.matchAll(/`[^`]*`/g)) {
    if (pos >= match.index && pos < match.index + match[0].length) {
      return { start: match.index, end: match.index + match[0].length };
    }
  }
  return null;
}

/**
 * 抽「同一 markdown 行」里的符号名候选，并给出证据强度分档（数字越小越强）。
 *
 *   0 = 和引用在**同一个反引号片段**里（`` `client.js:4318 SKETCH_ONLY_DISABLED` ``）
 *   1 = 紧邻引用（距离 ≤60 字符）—— 这也是最常见的写法：
 *       （`lib/mesh.js:258` `pythonCandidates()`）、`` @492 `handlePing` ``
 *   2 = 只是同一行里远处出现过（最弱：那句话可能根本不是在说这一处引用）
 *
 * **符号只归给离它最近的那个引用。** 一行里常有两个引用各说各的，例如
 * 「文本上限 12 MB（`index.js:61`）；只认魔数，扩展名与 `mediaType` 不算数（`index.js:237` `sniffImageType`）」——
 * 若把 `sniffImageType` 也算成 `index.js:61` 的证据，第 61 行永远不可能命中，
 * 就会报出一个**假失效**。按归属切分之后，没有符号的那一处老实落进「不可自校验」。
 *
 * 先把引用替换成等长空格再抽符号：这样 `lib\mesh.js:451` 里的 `mesh` 不会冒充符号，
 * 而且后续所有下标仍然对齐原始行。
 *
 * @param {string} line 原始 markdown 行
 * @param {number} refPos 本引用的起始下标
 * @param {Array<{pos:number, end:number}>} allRefs 本行**所有**引用的区间
 */
function collectSymbols(line, refPos, allRefs) {
  const stripped = line.replace(REF_RE, (matched) => ' '.repeat(matched.length));
  const refSpan = enclosingBacktickSpan(stripped, refPos);
  const refStart = refSpan ? refSpan.start : refPos;
  const refEnd = refSpan ? refSpan.end : refPos;
  const distanceToRef = (start, end) => Math.max(0, start - refEnd, refStart - end);

  /** 该区间离本引用是不是比离本行其它任何引用都近（等距时归左边那个，避免重复计入）。 */
  const ownedByThisRef = (start, end) => {
    const mine = distanceToRef(start, end);
    for (const other of allRefs) {
      if (other.pos === refPos) continue;
      const otherDistance = Math.max(0, start - other.end, other.pos - end);
      if (otherDistance < mine) return false;
      if (otherDistance === mine && other.pos < refPos) return false;
    }
    return true;
  };

  const found = new Map(); // text -> tier
  const add = (text, tier) => {
    const prev = found.get(text);
    if (prev === undefined || tier < prev) found.set(text, tier);
  };

  // (a) 反引号内的标识符：全部收（`spawn`、`withAnnotationLock` 这种纯小写也可能是真符号）
  for (const match of stripped.matchAll(/`[^`]*`/g)) {
    if (isPathLikeSpan(match[0])) continue; // 路径/扩展名/环境变量不是符号证据
    const start = match.index;
    const end = start + match[0].length;
    if (!ownedByThisRef(start, end)) continue;
    const sameSpan = refSpan !== null && refSpan.start === start;
    const tier = sameSpan ? 0 : distanceToRef(start, end) <= 60 ? 1 : 2;
    for (const token of match[0].matchAll(IDENT_RE)) {
      if (!isCandidateBase(token[0])) continue;
      add(token[0], tier);
    }
  }

  // (b) 反引号外：只认 SCREAMING_SNAKE / camelCase / PascalCase / 调用式
  for (const pattern of OUTSIDE_RES) {
    pattern.lastIndex = 0;
    const isCallPattern = pattern.source.includes('(?=\\s*\\()');
    for (const match of stripped.matchAll(pattern)) {
      const text = match[0];
      if (isCallPattern ? !isCallLikeCandidate(text) : !isCandidateOutside(text)) continue;
      const end = match.index + text.length;
      if (!ownedByThisRef(match.index, end)) continue;
      add(text, distanceToRef(match.index, end) <= 60 ? 1 : 2);
    }
  }

  return [...found.entries()]
    .map(([text, tier]) => ({ text, tier }))
    .sort((a, b) => a.tier - b.tier || b.text.length - a.text.length);
}

/**
 * 在 [start-tol, end+tol] 窗口里找候选符号，**任一档命中即算通过**。
 *
 * 为什么不在「最强档」里找就收手：一行里常有几个并列的反引号片段，例如
 * 「确认 profile 的 `bundles` 里真有这一项 | `client.js:4369`、`index.js:361`」——
 * `bundles` 在这行里其实指不到任何一处引用（它说的是 profile 配置，不在源文件里），
 * 若只认它就会把一条**完全正确**的 `client.js:4369`（那行确实有 `PING_NOT_OK`）判成失效。
 *
 * 噪声由 collectSymbols 的归属切分 + 黑名单 + 路径过滤负责，不靠这里再砍一刀；
 * 命中档位仍然写进结果（tier/weak），让「靠整行级符号兜下来的」在统计里可见。
 */
function findHit(symbols, lines, start, end) {
  const low = Math.max(1, start - TOLERANCE);
  const high = Math.min(lines.length, end + TOLERANCE);
  let best = null;
  for (const symbol of symbols) {
    // 大小写不敏感 + 长符号允许当前缀：文档常写 JSON 字段名 `precision`，源文件里是
    // `PRECISION_TIERS`；按「严格大小写 + 严格词边界」比会把一条**正确**引用判成失效。
    // 短符号（<6 字符）仍然要求严格词尾边界，否则 `apply` 会命中 `applied` 这类无关词。
    const escaped = symbol.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tail = symbol.text.length >= 6 ? '' : '(?![\\w$])';
    const pattern = new RegExp(`(?<![\\w$])${escaped}${tail}`, 'i');
    for (let n = low; n <= high; n += 1) {
      if (!pattern.test(lines[n - 1])) continue;
      const lineOffset = n < start ? n - start : n > end ? n - end : 0;
      const strength = symbol.tier * 1000 + Math.abs(lineOffset) * 10 - Math.min(symbol.text.length, 9);
      if (best === null || strength < best.strength) best = { strength, symbol: symbol.text, tier: symbol.tier, at: n, lineOffset };
      break; // 同一符号只取最近的一次命中就够
    }
  }
  return best;
}

// --------------------------------------------------------------------------- 判定

const TIER_NAME = ['同片段', '近邻', '整行'];

function evaluate({ doc, lineNo, line, match, allRefs, index, cache }) {
  const rawFile = match[1];
  const start = Number(match[2]);
  const end = match[3] ? Number(match[3]) : start;
  const base = { doc, lineNo, ref: match[0], rawFile, start, end };

  const rel = resolveRef(rawFile, index);
  if (!rel) {
    return { ...base, file: null, status: 'fail', reason: `解析不到被引用的文件（${rawFile}）` };
  }

  const lines = sourceLines(rel, cache);
  if (start < 1 || end < start || end > lines.length) {
    const shown = end === start ? `${start}` : `${start}-${end}`;
    return {
      ...base,
      file: rel,
      status: 'fail',
      reason: `行号 ${shown} 超出 ${rel} 的总行数 ${lines.length}`,
    };
  }

  const symbols = collectSymbols(line, match.index, allRefs);
  if (symbols.length === 0) {
    return { ...base, file: rel, status: 'skip', reason: '同一行里没有可识别的符号名，无法自校验' };
  }

  const hit = findHit(symbols, lines, start, end);
  if (!hit) {
    const actual = lines[start - 1].trim().slice(0, 70);
    // 顺手给出「这个符号其实在第几行」：报错里带**正确行号**，人才能直接照着改，
    // 否则每次都得自己 grep 一遍（那就等于这脚本没帮上忙）。
    const suggestions = [];
    for (const symbol of symbols.slice(0, 3)) {
      const pattern = new RegExp(`(?<![\\w$])${symbol.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`);
      const found = [];
      for (let n = 1; n <= lines.length && found.length < 3; n += 1) if (pattern.test(lines[n - 1])) found.push(n);
      suggestions.push(found.length ? `${symbol.text} 实际在 ${found.join('/')}` : `${symbol.text} 全文都没有`);
    }
    return {
      ...base,
      file: rel,
      status: 'fail',
      candidates: symbols.map((symbol) => symbol.text),
      reason:
        `±${TOLERANCE} 行内找不到该行提到的符号（${symbols.slice(0, 3).map((s) => s.text).join(' / ')}）；` +
        `第 ${start} 行实际是「${actual}」；${suggestions.join('；')}`,
    };
  }

  // 弱匹配：只靠「整行级」符号，或命中的行离引用 ±5 行以外 —— 通过，但要标出来，
  // 免得整张表看起来全绿、实际一半是超宽容差兜下来的。
  const weak = hit.tier === 2 || Math.abs(hit.lineOffset) > 5;
  return {
    ...base,
    file: rel,
    status: 'pass',
    symbol: hit.symbol,
    tier: TIER_NAME[hit.tier],
    at: hit.at,
    lineOffset: hit.lineOffset,
    weak,
  };
}

/** 收要扫描的文档（相对 root，正斜杠）。 */
function docList(root) {
  const out = [];
  for (const rel of DOC_FILES) if (existsSync(path.join(root, rel))) out.push(rel);
  const walk = (dir, prefix) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), `${prefix}/${entry.name}`);
        continue;
      }
      if (entry.isFile() && /\.md$/i.test(entry.name)) out.push(`${prefix}/${entry.name}`);
    }
  };
  for (const dir of DOC_DIRS) walk(path.join(root, dir), dir);
  return out.sort();
}

/**
 * 扫一遍文档里的全部 `文件:行号` 引用**与**裸 `@行号` 引用。
 * @param {{root?: string}} [options]
 * @returns {{root: string, docs: string[], results: object[], stats: object}}
 */
export function scanRefs(options = {}) {
  const root = options.root ? path.resolve(options.root) : PLUGIN_DIR;
  const docs = docList(root);
  const index = buildFileIndex(root);
  // 行缓存本身是 Map（sourceLines 用 has/get/set），额外挂一个 root 供它定位文件
  const cache = new Map();
  cache.root = root;
  const results = [];
  for (const doc of docs) {
    const text = readFileSync(path.join(root, doc), 'utf8');
    const lines = text.split(/\r?\n/);
    // 段落级归属：最近一个标题之后「被点名的、真能解析到源文件的」文件名。
    // 跨行继承是因为文档常在表格/列表里只写一次文件名，后面全是 `符号` @NNN。
    let sectionFile = null;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line) continue;
      if (HEADING_RE.test(line)) {
        sectionFile = null;
        continue;
      }
      if (!line.includes(':')) {
        // 没有冒号的行不可能有 `文件:行号`，但仍可能是裸 `@NNN`（`符号` @492），
        // 所以这里只跳过 REF_RE 那一段，不能整行 continue。
        if (!line.includes('@')) continue;
      }

      const refs = [...line.matchAll(REF_RE)];
      if (refs.length) {
        // 本行所有引用的区间：抽符号时用来判定「这个符号归哪一处引用」
        const allRefs = refs.map((item) => ({ pos: item.index, end: item.index + item[0].length }));
        for (const match of refs) {
          results.push(evaluate({ doc, lineNo: i + 1, line, match, allRefs, index, cache }));
        }
      }

      // ---- 裸行号引用 ----
      // 本行里能解析成真实源文件的文件名词（按出现位置排序）；
      // 段落归属无论本行有没有裸引用都要更新，否则「先点名文件名、再写 @NNN」的段落会丢归属。
      const fileHits = [...line.matchAll(FILE_IN_LINE_RE)]
        .map((item) => ({ raw: item[1], at: item.index, rel: resolveRef(item[1], index) }))
        .filter((item) => item.rel);
      const lastHit = fileHits.length ? fileHits[fileHits.length - 1] : null;

      const bareRefs = [...line.matchAll(BARE_REF_RE)];
      if (bareRefs.length) {
        for (const match of bareRefs) {
          // 去重：`` `logExternal` @ `index.js:159` `` 的行号部分已经被上面的 REF_RE 抓到并判过了，
          // 再算一次就是双计。判红要准，数字虚高会让人不再信这个脚本。
          if (overlapsAny(match.index, match.index + match[0].length, refs)) continue;

          const explicit = match[2] ? resolveRef(match[2], index) : null;
          const inline = fileHits.filter((item) => item.at < match.index).pop();
          const file = explicit || inline?.rel || sectionFile || DEFAULT_BARE_FILE;
          const via = explicit ? '显式' : inline ? '同行' : sectionFile ? '段落' : '默认';
          results.push(evaluateBare({ doc, lineNo: i + 1, line, match, file, via, index, cache }));
        }
      }

      if (lastHit) sectionFile = lastHit.rel;
    }
  }
  return { root, docs, results, stats: summarize(results) };
}

/** 某个区间是否与已匹配的 `REF_RE` 结果重叠（用于裸引用去重）。 */
function overlapsAny(start, end, matches) {
  return matches.some((item) => start < item.index + item[0].length && item.index < end);
}

function summarize(results) {
  const stats = {
    total: results.length,
    checkable: 0, // X：抽得出符号名、能自校验的
    pass: 0, // Y
    fail: 0, // Z
    skip: 0, // W：不可自校验
    weak: 0,
    byDoc: {},
    // 裸 `@行号` 引用单独计数：它们是另一套写法，混在 total 里看不出「这一类被验了没有」
    bareTotal: 0,
    barePass: 0,
    bareFail: 0,
  };
  for (const item of results) {
    const bucket = stats.byDoc[item.doc] || (stats.byDoc[item.doc] = { total: 0, pass: 0, fail: 0, skip: 0 });
    bucket.total += 1;
    const isBare = item.bare === true;
    if (isBare) stats.bareTotal += 1;
    if (item.status === 'skip') {
      stats.skip += 1;
      bucket.skip += 1;
      continue;
    }
    stats.checkable += 1;
    if (item.status === 'pass') {
      stats.pass += 1;
      bucket.pass += 1;
      if (item.weak) stats.weak += 1;
      if (isBare) stats.barePass += 1;
    } else {
      stats.fail += 1;
      bucket.fail += 1;
      if (isBare) stats.bareFail += 1;
    }
  }
  return stats;
}

// --------------------------------------------------------------------------- 输出

function formatFail(item, strict) {
  const tag = strict ? 'FAIL' : 'WARN';
  const kind = item.bare ? '裸@' : '   ';
  return `  [${tag}] ${item.doc}:${item.lineNo}  ${kind} ${item.ref}  → ${item.reason}`;
}

function report({ root, docs, results, stats }, options) {
  const strict = options.strict;
  const failures = results.filter((item) => item.status === 'fail');
  const skips = results.filter((item) => item.status === 'skip');

  console.log(`[check-refs] 扫描 ${docs.length} 个文档，共 ${stats.total} 处 文件:行号 引用`);
  console.log(`[check-refs] 容差 ±${TOLERANCE} 行；模式=${strict ? 'strict（失效即失败）' : '默认（失效降级为 warn）'}`);
  console.log('');

  if (failures.length === 0) {
    console.log('失效引用：无');
  } else {
    console.log(`失效引用 ${failures.length} 处${strict ? '' : '（默认模式不阻断）'}：`);
    for (const item of failures) console.log(formatFail(item, strict));
  }

  if (skips.length) {
    console.log('');
    const shown = options.verbose ? skips : skips.slice(0, 5);
    console.log(`不可自校验 ${skips.length} 处（同一行没有可识别符号名，仅提示）${options.verbose ? '' : '，只列前 5 条'}`);
    for (const item of shown) console.log(`  [INFO] ${item.doc}:${item.lineNo}  ${item.ref}`);
    if (!options.verbose && skips.length > shown.length) console.log(`  …另有 ${skips.length - shown.length} 处（--verbose 看全）`);
  }

  console.log('');
  console.log('按文档：');
  for (const doc of docs) {
    const bucket = stats.byDoc[doc];
    if (!bucket) continue;
    console.log(
      `  ${doc.padEnd(30)} 引用 ${String(bucket.total).padStart(3)} · 通过 ${String(bucket.pass).padStart(3)}` +
        ` · 失效 ${String(bucket.fail).padStart(2)} · 不可自校验 ${String(bucket.skip).padStart(2)}`,
    );
  }

  console.log('');
  console.log(
    `[check-refs] 统计：${stats.checkable} 处可校验、${stats.pass} 处通过、${stats.fail} 处失效、${stats.skip} 处不可自校验` +
      `（共 ${stats.total} 处；其中 ${stats.weak} 处通过属弱匹配：仅整行级符号或偏离引用 >5 行）`,
  );
  console.log(
    `[check-refs] 其中裸 @行号 引用 ${stats.bareTotal} 处（通过 ${stats.barePass} / 失效 ${stats.bareFail}）；` +
      `其余 ${stats.total - stats.bareTotal} 处是 文件:行号 引用`,
  );

  if (strict && failures.length) {
    console.log(`[check-refs] 结论：FAIL（${failures.length} 处失效）`);
    return 1;
  }
  if (failures.length) {
    console.log(`[check-refs] 结论：WARN（${failures.length} 处失效，默认模式退出码 0；基线清干净后可加 --strict）`);
    return 0;
  }
  console.log('[check-refs] 结论：OK');
  return 0;
}

function parseArgs(argv) {
  const options = { strict: false, verbose: false, root: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--strict') options.strict = true;
    else if (arg === '--verbose' || arg === '-v') options.verbose = true;
    else if (arg === '--root') {
      const value = argv[i + 1];
      if (!value) throw new Error('--root 需要一个目录参数');
      options.root = path.resolve(value);
      i += 1;
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`不认识的参数：${arg}（支持 --strict / --verbose / --root <dir>）`);
  }
  return options;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[check-refs] ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log('用法：node scripts/check-refs.mjs [--strict] [--verbose] [--root <dir>]');
    return;
  }
  try {
    process.exitCode = report(scanRefs({ root: options.root || PLUGIN_DIR }), options);
  } catch (error) {
    console.error(`[check-refs] 失败：${error && error.stack ? error.stack : error}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
