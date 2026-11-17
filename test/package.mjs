#!/usr/bin/env node
/**
 * 打包自检测试（离线：不联网、不装包、不启动 DSH）。
 *
 * 覆盖 scripts/package.mjs 的每一条自检，外加几条「包能不能用」的前置断言：
 *   1. 必需文件齐全（index/client/cordis.patch.yml/package.json/README/CHANGELOG/lib 下全部模块/vendor）
 *   2. package.json 的 files 里显式列了 vendor/three.cjs（.gitignore 会排除它，靠 files 兜底）
 *   3. 打包产物里真的有 vendor/three.cjs，且字节数与源文件一致
 *   4. 产物里不含本机绝对路径（用户名 / 家目录 / 插件路径，由 scripts/package.mjs 运行时推导，不写死）
 *   5. 产物 package.json 的 dsh.bundle.patch 指向的文件存在
 *   6. 产物 package.json 的 dsh.client.platform 与 client.js 都在
 *   7. 打的 tgz 能解回来：条目名全部以 package/ 开头、包含 vendor/three.cjs
 *   8. 打包脚本自身不写死本机路径（scripts/package.mjs 里扫不到当前机器的用户名/家目录/插件路径）
 *   9. 自检函数 verifyStage 对「故意缺文件」的目录会说 FAIL（防止自检永远 PASS）
 *  10. npm pack 的文件清单也包含 vendor/three.cjs（用 package.json 的 files 字段做等价断言，不跑 npm）
 *
 * 运行：node test/package.mjs     退出码 0 = 全过。
 */
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.dirname(HERE);

const packageTools = await import('../scripts/package.mjs');
const { collectManifest, collectLibFiles, packagePlugin, verifyStage, scanFileForLocalPaths } = packageTools;

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    const detail = fn();
    passed += 1;
    console.log(`✔ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`✘ ${name} — ${error && error.message ? error.message : error}`);
  }
}
function checkAsync(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => {
      passed += 1;
      console.log(`✔ ${name}${detail ? ` — ${detail}` : ''}`);
    })
    .catch((error) => {
      failures.push({ name, error });
      console.log(`✘ ${name} — ${error && error.message ? error.message : error}`);
    });
}

const manifest = collectManifest();

/** 把插件根下的 rel 拷到 dest（保持子目录结构）；源不存在就跳过，由断言去发现缺口。 */
function fsCopyIfExists(rel, dest) {
  const from = path.join(PLUGIN_DIR, rel);
  if (!existsSync(from)) return false;
  const to = path.join(dest, rel);
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
  return true;
}

// --------------------------------------------------------------------------- 1
check('1. 必需文件齐全', () => {
  const required = [
    'index.js',
    'client.js',
    'cordis.patch.yml',
    'package.json',
    'README.md',
    'CHANGELOG.md',
    'LICENSE',
    'icon.svg',
    // lib/ 下被 index.js import 的模块，少一个安装后就 ERR_MODULE_NOT_FOUND
    'lib/ext-token.js',
    'lib/handoff.js',
    'lib/mesh.js',
    'lib/paths.js',
    'lib/resolve.js',
    'lib/sketches.js',
    'lib/step_mesh.py',
    'vendor/three.cjs',
  ];
  for (const rel of required) assert.ok(existsSync(path.join(PLUGIN_DIR, rel)), `缺少 ${rel}`);
  return `${required.length} 个必需文件都在`;
});

// --------------------------------------------------------------------------- 1b
// 这条是本次修复的核心价值断言：以后任何人往 lib/ 加文件忘了登记清单，这里立刻红。
check('1b. manifest 里 lib/ 的文件数 == 磁盘上 lib/ 递归统计的 .js/.mjs/.py 文件数', () => {
  const { collectLibFiles } = packageTools;
  const onDisk = collectLibFiles(path.join(PLUGIN_DIR, 'lib'));
  const inManifest = manifest.filter((rel) => rel.startsWith('lib/'));
  const missing = onDisk.filter((rel) => !inManifest.includes(rel));
  const extra = inManifest.filter((rel) => !onDisk.includes(rel));
  assert.equal(
    missing.length,
    0,
    `磁盘上有但清单里没有（会静默不进包）：${missing.join(', ')}`,
  );
  assert.equal(extra.length, 0, `清单里有但磁盘上没有（打包会失败）：${extra.join(', ')}`);
  assert.equal(
    inManifest.length,
    onDisk.length,
    `数量不一致：清单 ${inManifest.length} / 磁盘 ${onDisk.length}`,
  );
  // 被 index.js import 的模块逐个点名，防止 collectLibFiles 的过滤规则被改坏
  for (const rel of ['lib/ext-token.js', 'lib/handoff.js', 'lib/mesh.js', 'lib/paths.js', 'lib/resolve.js', 'lib/sketches.js']) {
    assert.ok(inManifest.includes(rel), `清单漏了被 index.js import 的 ${rel}`);
  }
  return `${inManifest.length} 个 lib 文件，清单与磁盘一致`;
});

// --------------------------------------------------------------------------- 2
check('2. vendor/three.cjs 必须进 git，且 package.json 的 files 仍显式列出它', () => {
  const pkg = JSON.parse(readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8'));
  assert.ok(Array.isArray(pkg.files), 'files 必须是数组');
  // (a) 不能出现在 .gitignore 里：从 GitHub 源码安装（npm install github:…）时
  //     git 里有什么就装什么，files 字段完全不生效。一旦排除，/sw3d/three.js 会 404。
  const gitignore = readFileSync(path.join(PLUGIN_DIR, '.gitignore'), 'utf8');
  const ignoringLines = gitignore
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  assert.ok(
    !ignoringLines.some((line) => /^!?\/?vendor\/three\.cjs$/.test(line) || line === 'vendor' || line === 'vendor/' || line === '/vendor'),
    `.gitignore 不能排除 vendor/three.cjs（它必须随 git 分发）：${JSON.stringify(ignoringLines)}`,
  );
  // (b) files 仍要显式列出：npm 发布（npm pack / publish）只按 files 收文件。
  assert.ok(
    pkg.files.includes('vendor') || pkg.files.includes('vendor/three.cjs') || pkg.files.includes('vendor/**'),
    `files 里没有 vendor 条目：${JSON.stringify(pkg.files)}`,
  );
  return `files 显式列了 vendor/three.cjs；.gitignore 未排除它`;
});

// --------------------------------------------------------------------------- 3
check('3. 清单里的 vendor/three.cjs 与源文件字节数一致', () => {
  assert.ok(manifest.includes('vendor/three.cjs'), 'collectManifest 没把 vendor/three.cjs 收进来');
  const bytes = statSync(path.join(PLUGIN_DIR, 'vendor', 'three.cjs')).size;
  assert.ok(bytes > 2_000_000, `vendor/three.cjs 只有 ${bytes} 字节，像是残文件`);
  return `${bytes} 字节`;
});

// --------------------------------------------------------------------------- 4
check('4. 所有随包分发的文件都不含本机绝对路径', () => {
  const hits = [];
  for (const rel of manifest) {
    for (const hit of scanFileForLocalPaths(path.join(PLUGIN_DIR, rel))) hits.push(`${rel} 含「${hit.literal}」`);
  }
  assert.deepEqual(hits, [], `发现本机路径：${hits.join('；')}`);
  return `${manifest.length} 个文件全部干净`;
});

// --------------------------------------------------------------------------- 5
check('5. package.json 的 dsh 清单字段齐全（bundle.patch / client）', () => {
  const pkg = JSON.parse(readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8'));
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh?.client?.platform, 'web');
  assert.equal(pkg.dsh?.client?.immediately, true);
  assert.ok(Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0, 'inject 不能为空');
  assert.ok(existsSync(path.join(PLUGIN_DIR, 'cordis.patch.yml')), 'cordis.patch.yml 不存在');
  return `patch=${pkg.dsh.bundle.patch} platform=${pkg.dsh.client.platform} inject=${pkg.dsh.client.inject.join(',')}`;
});

// --------------------------------------------------------------------------- 6
check('6. package.json 有 scripts 与 license，engines 不写死本机版本', () => {
  const pkg = JSON.parse(readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8'));
  assert.equal(typeof pkg.scripts?.test, 'string', '缺 scripts.test');
  assert.equal(typeof pkg.scripts?.package, 'string', '缺 scripts.package');
  assert.equal(pkg.license, 'MIT', 'license 应为 MIT（开源发布）');
  assert.equal(typeof pkg.engines?.node, 'string');
  assert.equal(typeof pkg.engines?.dsh, 'string', 'engines.dsh 应声明（dshmarket 用 verify.js 判定安装门槛）');
  // 发布形态的硬要求：不再是私有包、包名不带 scope。这两条一起守住，防止有人手滑改回私有形态。
  assert.notEqual(pkg.private, true, 'private 必须删掉，否则 npm publish 会被拒绝');
  assert.ok(!String(pkg.name).startsWith('@'), `包名不应带 scope：${pkg.name}`);
  assert.equal(String(pkg.name), 'dsh-sw-3d-preview');
  return `name=${pkg.name} scripts=${Object.keys(pkg.scripts).join(',')} engines=${JSON.stringify(pkg.engines)}`;
});

// --------------------------------------------------------------------------- 7
check('7. 打包脚本自身不含本机绝对路径', () => {
  const hits = scanFileForLocalPaths(path.join(PLUGIN_DIR, 'scripts', 'package.mjs'));
  assert.deepEqual(hits, [], `scripts/package.mjs 含本机字样：${JSON.stringify(hits)}`);
  return '干净';
});

// --------------------------------------------------------------------------- 8-10（真跑一次打包到临时目录）
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'sw3d-pkg-test-'));
let report = null;
try {
  report = await packagePlugin({ outDir: sandbox, tgz: true });
} catch (error) {
  failures.push({ name: '8. packagePlugin 能跑通', error });
  console.log(`✘ 8. packagePlugin 能跑通 — ${error && error.message ? error.message : error}`);
}

if (report) {
  check('8. packagePlugin 自检全过', () => {
    const failed = report.checks.filter((c) => !c.ok);
    assert.deepEqual(failed, [], `自检失败项：${failed.map((c) => `${c.name}(${c.detail})`).join('；')}`);
    return `${report.fileCount} 个文件 / ${report.totalBytes} 字节`;
  });

  check('9. 产物里的 vendor/three.cjs 与源文件字节数一致', () => {
    const staged = statSync(path.join(report.stageRoot, 'vendor', 'three.cjs')).size;
    const source = statSync(path.join(PLUGIN_DIR, 'vendor', 'three.cjs')).size;
    assert.equal(staged, source);
    return `${staged} 字节`;
  });

  check('10. 产物里不含本机绝对路径（复扫一遍产物目录）', () => {
    const hits = [];
    for (const file of report.files) {
      for (const hit of scanFileForLocalPaths(path.join(report.stageRoot, file.path))) {
        hits.push(`${file.path} 含「${hit.literal}」`);
      }
    }
    assert.deepEqual(hits, [], hits.join('；'));
    return `${report.files.length} 个文件干净`;
  });

  check('11. tgz 产出且能解回来，条目以 package/ 开头并含每个被同步分发的文件', () => {
    assert.ok(report.tgzPath && existsSync(report.tgzPath), '没有生成 tgz');
    const raw = gunzipSync(readFileSync(report.tgzPath));
    assert.ok(raw.length > 2_000_000, `解压后只有 ${raw.length} 字节`);
    // 粗读 tar 头：每个条目 512 字节对齐，名字在头 100 字节里
    const names = [];
    const sizes = new Map();
    let offset = 0;
    while (offset + 512 <= raw.length) {
      const header = raw.subarray(offset, offset + 512);
      const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
      if (!name) break;
      const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
      const size = Number.parseInt(sizeField, 8) || 0;
      names.push(name);
      sizes.set(name, size);
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    assert.ok(names.length >= 10, `tar 里只有 ${names.length} 个条目`);
    for (const name of names) assert.ok(name.startsWith('package/'), `条目 ${name} 没有 package/ 前缀`);
    assert.ok(names.includes('package/vendor/three.cjs'), `tar 里没有 vendor/three.cjs：${names.join(', ')}`);
    // tgz 条目必须与清单**完全一致**：少一个 = 装到别人机器上会缺文件
    const expected = new Set(manifest.map((rel) => `package/${rel}`));
    const missing = [...expected].filter((name) => !names.includes(name));
    assert.deepEqual(missing, [], `tgz 缺这些清单文件：${missing.join(', ')}`);
    // 每个条目字节数与源文件一致（防止复制到一半/被截断）
    for (const rel of manifest) {
      const inTar = sizes.get(`package/${rel}`);
      const onDisk = statSync(path.join(PLUGIN_DIR, rel)).size;
      assert.equal(inTar, onDisk, `${rel} 在 tgz 里 ${inTar} 字节，源是 ${onDisk} 字节`);
    }
    return `${names.length} 个条目 / ${report.tgzBytes} 字节，与清单 ${manifest.length} 项逐字节一致`;
  });

  check('12. verifyStage 对缺文件的目录会说 FAIL（自检不是永真）', () => {
    const broken = mkdtempSync(path.join(os.tmpdir(), 'sw3d-broken-'));
    try {
      mkdirSync(path.join(broken, 'lib'), { recursive: true });
      writeFileSync(path.join(broken, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }), 'utf8');
      writeFileSync(path.join(broken, 'index.js'), '// stub', 'utf8');
      const result = verifyStage(broken);
      assert.equal(result.ok, false, '缺文件时 verifyStage 必须返回 ok:false');
      const failedNames = result.checks.filter((c) => !c.ok).map((c) => c.name);
      assert.ok(failedNames.length >= 3, `应该有多项失败，实际只有：${failedNames.join(', ')}`);
      return `正确识别 ${failedNames.length} 项失败`;
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  check('12b. 新增的 lib/ 完整性自检确实会 FAIL（漏一个 lib 文件就红）', () => {
    // 造一个「除 lib/mesh.js 之外都齐全」的产物目录，验证两条新断言不是永真
    const broken = mkdtempSync(path.join(os.tmpdir(), 'sw3d-libgap-'));
    try {
      mkdirSync(path.join(broken, 'lib'), { recursive: true });
      fsCopyIfExists('package.json', broken);
      fsCopyIfExists('index.js', broken);
      fsCopyIfExists('client.js', broken);
      fsCopyIfExists('cordis.patch.yml', broken);
      fsCopyIfExists('README.md', broken);
      fsCopyIfExists('CHANGELOG.md', broken);
      fsCopyIfExists('LICENSE', broken);
      fsCopyIfExists('icon.svg', broken);
      fsCopyIfExists('vendor/three.cjs', broken);
      // 只拷 lib 下除 mesh.js 以外的全部文件
      for (const rel of collectLibFiles(path.join(PLUGIN_DIR, 'lib'))) {
        if (rel === 'lib/mesh.js') continue;
        fsCopyIfExists(rel, broken);
      }
      const result = verifyStage(broken);
      assert.equal(result.ok, false, 'lib 少一个文件时 verifyStage 必须 ok:false');
      const byName = (name) => result.checks.find((c) => c.name === name);
      const libCheck = byName('lib/ 源码完整（无静默漏包）');
      assert.ok(libCheck, '新断言「lib/ 源码完整」必须存在于 checks 里');
      assert.equal(libCheck.ok, false, `lib/ 缺 mesh.js 时该断言必须 FAIL，实际 ok=${libCheck.ok}`);
      return `正确识别 lib 缺口：${libCheck.detail.slice(0, 80)}`;
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  check('12c. index.js 本地 import 缺失时自检会说 FAIL', () => {
    const broken = mkdtempSync(path.join(os.tmpdir(), 'sw3d-importgap-'));
    try {
      mkdirSync(path.join(broken, 'lib'), { recursive: true });
      // index.js 原样拷进来（它 import ./lib/ext-token.js 等），但 lib 一个都不放
      fsCopyIfExists('index.js', broken);
      fsCopyIfExists('package.json', broken);
      const result = verifyStage(broken);
      const importCheck = result.checks.find((c) => c.name === 'index.js 的本地 import 全部能在产物里找到');
      assert.ok(importCheck, '新断言「index.js 本地 import 全部能在产物里找到」必须存在');
      assert.equal(importCheck.ok, false, `一个 lib 文件都没有时该断言必须 FAIL，实际 ok=${importCheck.ok}`);
      assert.match(importCheck.detail, /ext-token/, `detail 应点名缺失的模块：${importCheck.detail}`);
      return importCheck.detail.slice(0, 90);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  check('13. 产物总大小在合理区间（>3 MB，说明大文件都带上了）', () => {
    assert.ok(report.totalBytes > 3_000_000, `只有 ${report.totalBytes} 字节，大文件可能没带上`);
    assert.ok(report.tgzBytes > 0 && report.tgzBytes < report.totalBytes, `tgz ${report.tgzBytes} 应小于原始 ${report.totalBytes}`);
    return `${report.fileCount} 文件 / ${report.totalBytes} 字节 → tgz ${report.tgzBytes} 字节`;
  });
}

rmSync(sandbox, { recursive: true, force: true });

// --------------------------------------------------------------------------- 14-15 文档防腐烂锁
// 这两条锁的是「文档里的数字会持续变假」这个结构性缺陷，不是某一次笔误。
// 详见 scripts/check-refs.mjs 与 scripts/sizes.mjs 顶部的说明。

const refsTools = await import('../scripts/check-refs.mjs');
const sizesTools = await import('../scripts/sizes.mjs');

check('14. 文档里的 文件:行号 引用能被扫描，且绝大多数指得对（默认模式：只报告不阻断）', () => {
  const report = refsTools.scanRefs({ root: PLUGIN_DIR });
  const { stats } = report;
  // 先证明它**不是空转**：一条都没扫到就等同于此锁不存在。
  // 这两条断言是这条 check 的真正价值所在 —— 没有它们，改成 `return []` 也能绿。
  assert.ok(report.docs.length >= 4, `只扫到 ${report.docs.length} 个文档，扫描范围可能被改坏了`);
  // 下限从 200 调到 150：0.2.2 把两张 README 从 532 行压到 ~190 行（用户要求「简化介绍」），
  // 引用数从 262 降到 169。下限仍然是**下限**，不是当前值 —— 正则一旦被改坏到扫不出东西，
  // 这里照样红。真正证明这条锁不空转的是 14b/14c 的内联夹具，它们不依赖文档规模。
  assert.ok(stats.total >= 150, `只扫到 ${stats.total} 处引用，正则可能被改坏了（应当 150+）`);
  assert.ok(stats.checkable >= 100, `只有 ${stats.checkable} 处可自校验，符号抽取可能退化成恒真/恒不可校验`);
  // 裸 @行号 是另一类写法，必须**实际扫到**才算这条锁也管住了它。
  // 注意：这条断言只用「至少 0 处」不够、写死 21 又会被文档改法绑死
  // （把裸写法改成显式的 `符号` @ `index.js:NNN` 之后，它们会被 REF_RE 接管、bareTotal 归零，
  //  那是**更好**的状态，不该因此让测试红）。所以真值校验交给下面的 14c 内联夹具，
  // 这里只断言「统计字段存在且是数字」，防止 stats 结构被改坏。
  assert.equal(
    typeof stats.bareTotal,
    'number',
    `stats.bareTotal 应当是数字，实际 ${typeof stats.bareTotal}；裸 @行号 的统计可能被删了`,
  );
  // 默认模式：失效只报告，不阻断（基线还没清干净，见 check-refs.mjs 顶部的两段式说明）。
  const rate = stats.checkable ? stats.pass / stats.checkable : 0;
  assert.ok(rate >= 0.5, `可校验引用的通过率只有 ${(rate * 100).toFixed(1)}%，说明文档大面积漂了`);
  const detail =
    `${stats.checkable} 可校验 / ${stats.pass} 通过（${(rate * 100).toFixed(1)}%）/ ` +
    `${stats.fail} 失效 / ${stats.skip} 不可自校验`;
  if (stats.fail > 0) {
    console.log(`    ℹ 另有 ${stats.fail} 处失效引用（默认模式不阻断；node scripts/check-refs.mjs 查看，加 --strict 可阻断）`);
  }
  return detail;
});

check('15. 两个 README 的字节数表与磁盘一致（node scripts/sizes.mjs --check）', () => {
  const report = sizesTools.run({ check: true });
  const drifted = report.results.flatMap((item) => item.changes.map((change) => `${item.doc}:${change.lineNo} ${change.name} ${change.from}→${change.to}`));
  const problems = report.results.flatMap((item) => item.problems.map((problem) => `${item.doc}: ${problem}`));
  assert.deepEqual(problems, [], `表格结构问题：${problems.join('；')}`);
  assert.deepEqual(drifted, [], `数字与磁盘不一致（跑 node scripts/sizes.mjs 更新）：${drifted.join('；')}`);
  // 反向：清单文件都得在表里有行，否则这条锁会随表格缩水而失效
  assert.ok(report.sizes.size >= 16, `随包清单只有 ${report.sizes.size} 个文件，打包清单可能被改坏了`);
  return `${report.results.length} 个 README、${report.sizes.size - sizesTools.NO_NUMBER_FILES.length} 行数字全部一致`;
});

// 14b/15b：证明上面两条锁**不是恒真**的。没有这两条，把 check-refs 改成 return []、
// 或把 sizes 的比对删掉，上面照样绿 —— 那就是又一次「看起来有锁、其实没有」。
check('14c. check-refs 能扫到裸 @行号 引用，且失效的会被判 fail（另一类写法不能是盲区）', () => {
  // 为什么单独一条：`REF_RE` 只认「文件名 + 扩展名 + `:` + 数字」。`` `handlePing` @492 ``
  // 里没有文件名，旧正则一个字都匹配不到 —— 既不 fail 也不 skip，直接不进统计。
  // 于是文档里成片的裸行号可以整体失效而闸门报绿。这条锁就是钉住「这类写法也被验」。
  //
  // ⚠️ **这条防的是 BARE_REF_RE 退化，不要因为文档改好了就删。**
  //   文档里的裸写法一旦统一改成 `符号 @ `文件:行号``，就会被 REF_RE 接管、bareTotal 归零，
  //   看起来「这类引用没了」——但**正则必须继续有效**，否则下一个人写出裸行号时闸门又聋了。
  //   本夹具不随文档变动，是这条正则唯一常驻的哨兵。已实测：把 BARE_REF_RE 改成 `/(?!)/`
  //   （永不匹配）后，这条会红在「应当扫到 3 处裸 @行号 引用，实际 0」。
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'sw3d-refs-bare-'));
  try {
    // 默认归属文件是 index.js（DEFAULT_BARE_FILE），所以夹具里放同名文件。
    // 20 行：handlePing 在 3。留够距离，好让「行号错位」落在文件范围内**且**超出 ±10 容差
    // （行号越界与「符号真不在那一带」是两条不同分支，后者才是这条锁要钉的）。
    const target = Array.from({ length: 20 }, (_, i) => `// ${i + 1}`);
    target[2] = 'function handlePing() {';
    target[3] = '}';
    target[16] = 'function otherFn() {';
    target[17] = '}';
    writeFileSync(path.join(fixture, 'index.js'), target.join('\n'), 'utf8');
    writeFileSync(
      path.join(fixture, 'README.md'),
      [
        '# fixture',
        // 1 通过：裸行号就在符号那一行
        `裸正确：\`handlePing\` @3`,
        // 1 失效：符号名对但行号错到 18（窗口 [8,28] 里没有 handlePing，它在 3）
        `裸失效：\`handlePing\` @18`,
        // 1 失效：换一个不存在的符号，证明判红靠的是符号而不是行号
        `裸符号错：\`totallyAbsentSymbol\` @3`,
        // 显式写了文件名的那种（`sym` @ `index.js:6`）**故意不放在这里**：
        // 它字面上就含 `index.js:6`，一定先被 REF_RE 抓走、随后被去重跳过，
        // 也就是说「显式归属」这条分支的净效果永远是 0 处裸引用。那条路径由 14d 覆盖。
        '',
      ].join('\n'),
      'utf8',
    );
    const report = refsTools.scanRefs({ root: fixture });
    assert.equal(report.stats.bareTotal, 3, `应当扫到 3 处裸 @行号 引用，实际 ${report.stats.bareTotal}（正则可能被改坏了）`);
    assert.equal(report.stats.bareFail, 2, `应当有 2 处裸引用失效，实际 ${report.stats.bareFail}`);
    assert.equal(report.stats.barePass, 1, `应当有 1 处裸引用通过，实际 ${report.stats.barePass}`);
    // 归属：没写文件名时落到默认主文件（fail-closed），而不是「无归属就跳过」
    const bare = report.results.filter((item) => item.bare);
    assert.equal(bare.length, 3, `裸引用识别数不对：${bare.length}`);
    assert.ok(
      bare.every((item) => item.file === 'index.js'),
      `裸引用应当归属到默认主文件 index.js，实际 ${bare.map((item) => `${item.symbol}→${item.file}`).join('/')}`,
    );
    // 判红理由必须能直接照着改：带上符号实际所在行
    const wrongLine = bare.find((item) => item.status === 'fail' && item.symbol === 'handlePing');
    assert.ok(wrongLine.reason.includes('handlePing 实际在'), `失效理由没给出正确行号：${wrongLine.reason}`);
    return `裸 @行号 引用纳入校验：${report.stats.bareTotal} 处（通过 ${report.stats.barePass} / 失效 ${report.stats.bareFail}）`;
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

check('14d. 裸 @行号 与 文件:行号 重叠时只计一次（去重不能失效）', () => {
  // 为什么单独一条：`` `logExternal` @ `index.js:159` `` 里同时含有
  // 「符号 @」 和 「index.js:159」两种形状。两条正则各抓一次就是**双计**，
  // --strict 会报出虚高的失效数；数字一旦虚高，就没人再信这个脚本了。
  // 这条锁钉住「同一处引用只算一次」。
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'sw3d-refs-dedup-'));
  try {
    writeFileSync(path.join(fixture, 'client.js'), ['// 1', '// 2', 'function handlePing() {', '}', ''].join('\n'), 'utf8');
    writeFileSync(
      path.join(fixture, 'README.md'),
      [
        '# fixture',
        // 这一行同时命中 REF_RE（client.js:900）与 BARE_REF_RE（`handlePing` @ client.js:900）
        `重叠：\`handlePing\` @ \`client.js:900\``,
        '',
      ].join('\n'),
      'utf8',
    );
    const report = refsTools.scanRefs({ root: fixture });
    assert.equal(report.stats.total, 1, `同一处引用被计了 ${report.stats.total} 次（应当只计 1 次；去重逻辑回归了）`);
    assert.equal(report.stats.fail, 1, `应当只有 1 处失效，实际 ${report.stats.fail}`);
    assert.equal(report.stats.bareTotal, 0, `被子引用 ({index.js:NNN}) 形式覆盖后不应再按裸引用计，实际 bareTotal=${report.stats.bareTotal}`);
    // 去重不能把「显式文件名」那条归属路径也一起吃掉：
    // 这里 `client.js:3` 已经被 REF_RE 接管，确认它归属到 client.js 而不是默认的 index.js。
    assert.equal(report.results[0].file, 'client.js', `去重后归属错了：${report.results[0].file}`);
    return '符号 @ 文件:行号 双写法只计一次，无重复';
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

check('14b. check-refs 对已知失效的引用确实会判 fail（锁不是恒真）', () => {  const fixture = mkdtempSync(path.join(os.tmpdir(), 'sw3d-refs-'));
  try {
    const lines = ['// 1', '// 2', 'function handlePing() {', '}', ''];
    writeFileSync(path.join(fixture, 'client.js'), lines.join('\n'), 'utf8');
    writeFileSync(
      path.join(fixture, 'README.md'),
      [
        '# fixture',
        `正确：\`client.js:3\` 的 \`handlePing()\``,
        `符号错：\`client.js:3\` 的 \`totallyAbsentSymbol\``,
        `越界：\`client.js:99999\` 的 \`handlePing\``,
        '',
      ].join('\n'),
      'utf8',
    );
    const report = refsTools.scanRefs({ root: fixture });
    assert.equal(report.stats.fail, 2, `应当有 2 处失效，实际 ${report.stats.fail}`);
    assert.equal(report.stats.pass, 1, `应当有 1 处通过，实际 ${report.stats.pass}`);
    const reasons = report.results.filter((item) => item.status === 'fail').map((item) => item.reason);
    assert.ok(reasons.some((r) => r.includes('超出')), `越界必须被识别：${reasons.join('；')}`);
    assert.ok(reasons.some((r) => r.includes('找不到')), `符号错位必须被识别：${reasons.join('；')}`);
    return `正确识别 2 处失效（符号错位 + 行号越界）`;
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

check('15b. sizes --check 对已知漂移的数字确实会判 fail（锁不是恒真）', () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'sw3d-sizes-'));
  try {
    // 造一个最小仓库：清单里每个文件都放一份桩（collectManifest 的固定清单不随 root 变），
    // 只有 index.js 的字节数是我们确切知道的。
    for (const rel of manifest) {
      const to = path.join(fixture, rel);
      mkdirSync(path.dirname(to), { recursive: true });
      writeFileSync(to, '// stub\n', 'utf8');
    }
    const stubBytes = statSync(path.join(fixture, 'index.js')).size;
    assert.notEqual(stubBytes, 999, '桩文件恰好 999 字节，这个变异构造不出来');
    const table = [
      '# fixture',
      '<!-- sizes:begin -->',
      '```',
      `index.js            999      假数字`,
      '```',
      '<!-- sizes:end -->',
      '',
    ].join('\n');
    writeFileSync(path.join(fixture, 'README.md'), table, 'utf8');
    const drifted = sizesTools.run({ check: true, root: fixture });
    const changes = drifted.results.flatMap((item) => item.changes);
    assert.ok(changes.length >= 1, '数字是假的（写着 999），必须报漂移');
    assert.equal(changes[0].to, String(String(stubBytes)), `重算后应为 ${stubBytes} 字节，实际 ${changes[0].to}`);
    assert.equal(drifted.ok, false, '有漂移时 run({check:true}).ok 必须为 false');
    // 反向：写模式必须真的把它改对，否则「只报不改」也会让上面这条锁看似有效
    sizesTools.run({ check: false, root: fixture });
    const fixed = readFileSync(path.join(fixture, 'README.md'), 'utf8');
    assert.ok(fixed.includes(String(stubBytes)), `写模式没有把 999 改成 ${stubBytes}：\n${fixed}`);
    assert.ok(!fixed.includes('999'), '写模式没有清掉假数字 999');
    return `假数字 999 被识别为漂移，真值 ${stubBytes}，写模式已修复`;
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------- 汇总
console.log('');
if (failures.length) {
  console.log(`失败 ${failures.length} 项 / 通过 ${passed} 项`);
  for (const failure of failures) console.log(`  ✘ ${failure.name}: ${failure.error && failure.error.message}`);
  process.exitCode = 1;
} else {
  console.log(`全部通过（${passed} 项）`);
  process.exitCode = 0;
}
