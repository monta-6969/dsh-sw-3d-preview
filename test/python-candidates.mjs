#!/usr/bin/env node
/**
 * python 候选推导的离线测试（不启动 DSH、不碰 SOLIDWORKS、不装任何包）。
 *
 * 背景（真机缺陷）：`swMcpRepoRoots()` 以前**只**从 `process.env.DSH_PROFILE_DIR` 找 profile 目录，
 * 而 DSH_PROFILE_DIR 只注入给 shell 工具子进程，DSH **宿主进程自己没有** —— 宿主里于是只剩
 * `py -3` / `python` / `python3` 三条候选，明明装了 sw-mcp venv 也报 PYTHON_MISSING。
 * 修复把 profile 目录改成有序回退链：
 *   ① DSH_PROFILE_DIR → ② DSH_HOME/profiles/<DSH_PROFILE> → ③ ~/.dsh/profiles/<DSH_PROFILE>
 *   → ④ 枚举 ~/.dsh/profiles/*（全部遍历，不找到第一个就停）
 *
 * 本测试全部用临时目录造假 profile / 假 repo，**不依赖本机的 profile 布局**，可在任何机器上跑。
 * 关键的一条是 case B/C：**不设 DSH_PROFILE_DIR**，只靠 homedir 回退 —— 修复前必红。
 *
 * 运行：node test/python-candidates.mjs      退出码 0 = 全过。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { pythonCandidates, pythonCandidateDiagnostics, PYTHON_MISSING_HINT } = await import('../lib/mesh.js');

const execName = process.platform === 'win32' ? 'python.exe' : 'python';
const venvPython = (...parts) => path.join(...parts, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', execName);

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

/** 只看真实路径 + 大小写（Windows 的 %TEMP% 可能是 8.3 短名，字面比较会假红）。 */
function samePath(a, b) {
  const norm = (value) => {
    const resolved = path.resolve(String(value));
    let real = resolved;
    try {
      real = fs.realpathSync(resolved);
    } catch {
      /* 不存在就用 resolve 结果 */
    }
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  return norm(a) === norm(b);
}

/** 造一个假 profile 目录：package.json 里写 link:/file: 依赖。 */
function makeProfile(profilesRoot, name, deps) {
  const dir = path.join(profilesRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `fake-${name}`, dependencies: deps }, null, 2), 'utf8');
  return dir;
}

/** 造假 repo：只有一个空的 .venv 解释器占位文件（不需要真 python）。 */
function makeRepo(repoRoot) {
  const python = venvPython(repoRoot);
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(python, '', 'utf8');
  return repoRoot;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sw3d-pycand-'));
const venvRepoCandidates = (candidates) => candidates.filter((candidate) => candidate.origin === 'venv-repo');
const hasRepo = (candidates, repo) =>
  venvRepoCandidates(candidates).some((candidate) => samePath(candidate.command, venvPython(repo)));

try {
  // ------------------------------------------------------------------------- 0
  check('0. 默认调用（不传参数）与传空对象一致：可测试性注入口不改变默认行为', () => {
    const real = pythonCandidates();
    const empty = pythonCandidates({});
    assert.deepEqual(empty, real, 'pythonCandidates({}) 必须等价于 pythonCandidates()');
    assert.ok(Array.isArray(real) && real.length >= 3, '至少应有启动器/PATH 三条保底候选');
    const origins = real.map((candidate) => candidate.origin);
    assert.equal(origins.at(-1), 'path', `最后一条应是 python3（path），实际 ${JSON.stringify(origins)}`);
    return `默认 ${real.length} 条候选：${origins.join(' → ')}`;
  });

  // ------------------------------------------------------------------------- A
  check('A. 正向：DSH_PROFILE_DIR 直接指向假 profile，能推导出 link 的 repo venv', () => {
    const home = path.join(tmpRoot, 'home-a');
    fs.mkdirSync(home, { recursive: true }); // 空家目录：排除 ③④ 干扰，只测 ①
    const repo = makeRepo(path.join(tmpRoot, 'repo-a'));
    const profileDir = makeProfile(path.join(tmpRoot, 'profiles-a'), 'from-env', {
      '@local/dsh-sw-preset': `link:${repo}`,
    });
    const candidates = pythonCandidates({ env: { DSH_PROFILE_DIR: profileDir }, homedir: home });
    assert.ok(hasRepo(candidates, repo), `候选里没有 ${venvPython(repo)}：${JSON.stringify(candidates.map((c) => c.command))}`);
    return venvPython(repo);
  });

  // ------------------------------------------------------------------------- B
  check('B. 反向（关键）：删掉 DSH_PROFILE_DIR，只靠 ~/.dsh/profiles/<DSH_PROFILE> 回退也能找到', () => {
    const home = path.join(tmpRoot, 'home-b');
    const profilesRoot = path.join(home, '.dsh', 'profiles');
    const repo = makeRepo(path.join(tmpRoot, 'repo-b'));
    makeProfile(profilesRoot, 'workdesk', { '@local/dsh-sw-preset': `link:${repo}` });
    // 环境里**故意没有** DSH_PROFILE_DIR —— 这正是 DSH 宿主进程的真实处境
    const env = { DSH_PROFILE: 'workdesk' };
    assert.equal(Object.hasOwn(env, 'DSH_PROFILE_DIR'), false);
    const candidates = pythonCandidates({ env, homedir: home });
    assert.ok(
      hasRepo(candidates, repo),
      `只靠 homedir 回退没推导出 ${venvPython(repo)}：${JSON.stringify(candidates.map((c) => c.origin))}`,
    );
    return `env=${JSON.stringify(env)} → venv-repo 命中`;
  });

  // ------------------------------------------------------------------------- C
  check('C. 反向（关键）：连 DSH_PROFILE 都没有时枚举 ~/.dsh/profiles/*，且不找到第一个就停', () => {
    const home = path.join(tmpRoot, 'home-c');
    const profilesRoot = path.join(home, '.dsh', 'profiles');
    // 按名字排序，含 sw-mcp 的那个排在**最后**：如果实现「找到第一个就停」，这条必红
    makeProfile(profilesRoot, 'aaa-no-mcp', { '@local/dsh-other': `link:${path.join(tmpRoot, 'nope-aaa')}` });
    makeProfile(profilesRoot, 'mmm-no-deps', {});
    makeRepo(path.join(tmpRoot, 'nope-aaa')); // 有 .venv 但这个 profile 已经不指向它了
    const repo = makeRepo(path.join(tmpRoot, 'repo-c'));
    makeProfile(profilesRoot, 'zzz-has-mcp', { '@local/dsh-sw-preset': `link:${repo}` });
    fs.mkdirSync(path.join(profilesRoot, 'no-package-json'), { recursive: true }); // 无 package.json → 跳过
    fs.writeFileSync(path.join(profilesRoot, 'stray-file.txt'), 'x', 'utf8'); // 非目录 → 跳过
    const candidates = pythonCandidates({ env: {}, homedir: home });
    assert.ok(hasRepo(candidates, repo), `枚举没有遍历全部 profile，漏了 ${venvPython(repo)}`);
    const diagnostics = pythonCandidateDiagnostics({ env: {}, homedir: home });
    assert.equal(diagnostics.profiles, 3, `应读到 3 个带 package.json 的 profile，实际 ${diagnostics.profiles}`);
    assert.deepEqual(diagnostics.errors, [], `不该有读取错误：${JSON.stringify(diagnostics.errors)}`);
    return `3 个 profile 全部扫过，zzz-has-mcp 命中`;
  });

  // ------------------------------------------------------------------------- D
  check('D. 去重：两个 profile link 同一个 repo，只产生一条 venv-repo 候选', () => {
    const home = path.join(tmpRoot, 'home-d');
    const profilesRoot = path.join(home, '.dsh', 'profiles');
    const repo = makeRepo(path.join(tmpRoot, 'repo-d'));
    makeProfile(profilesRoot, 'desktop', { '@local/dsh-sw-preset': `link:${repo}` });
    makeProfile(profilesRoot, 'bridge', { '@local/dsh-sw-preset': `link:${repo}` });
    const candidates = pythonCandidates({ env: {}, homedir: home });
    const hits = venvRepoCandidates(candidates).filter((candidate) => samePath(candidate.command, venvPython(repo)));
    assert.equal(hits.length, 1, `重复候选没去重：${hits.length} 条`);
    const commands = candidates.map((candidate) => candidate.command.toLowerCase());
    assert.equal(new Set(commands).size, commands.length, '候选命令整体有重复');
    return `1 条 venv-repo（去重前 2 个 profile 指向同一 repo）`;
  });

  // ------------------------------------------------------------------------- E
  check('E. 顺序：env → venv-data → venv-repo → launcher/path 的相对次序不变', () => {
    const home = path.join(tmpRoot, 'home-e');
    const repo = makeRepo(path.join(tmpRoot, 'repo-e'));
    makeProfile(path.join(home, '.dsh', 'profiles'), 'desktop', { '@local/dsh-sw-preset': `link:${repo}` });
    const dataRoot = path.join(tmpRoot, 'dataroot-e');
    makeRepo(dataRoot);
    const env = {
      SW_3D_PREVIEW_PYTHON: path.join(tmpRoot, 'explicit-python.exe'),
      SW_MCP_DATA: dataRoot,
    };
    const origins = pythonCandidates({ env, homedir: home }).map((candidate) => candidate.origin);
    assert.equal(origins[0], 'env', `第一条应是 SW_3D_PREVIEW_PYTHON，实际 ${JSON.stringify(origins)}`);
    assert.equal(origins[1], 'venv-data', `第二条应是数据根 venv，实际 ${JSON.stringify(origins)}`);
    assert.ok(origins.includes('venv-repo'), `应含 venv-repo，实际 ${JSON.stringify(origins)}`);
    const index = (origin) => origins.indexOf(origin);
    assert.ok(index('venv-data') < index('venv-repo'), '数据根 venv 必须在 repo venv 之前');
    assert.ok(index('venv-repo') < index('launcher'), 'repo venv 必须在 py -3 之前');
    assert.ok(index('launcher') < index('path'), 'py -3 必须在 python/python3 之前');
    return origins.join(' → ');
  });

  // ------------------------------------------------------------------------- F
  check('F. 诊断区分 (a)：profile 读得到但没有 .venv → errors 为空、profiles > 0', () => {
    const home = path.join(tmpRoot, 'home-f');
    makeProfile(path.join(home, '.dsh', 'profiles'), 'desktop', { '@local/dsh-other': `link:${path.join(tmpRoot, 'nope-f')}` });
    const diagnostics = pythonCandidateDiagnostics({ env: {}, homedir: home });
    assert.ok(diagnostics.profiles > 0, 'profiles 计数应 > 0');
    assert.deepEqual(diagnostics.errors, [], '读得到就不该报错');
    return `profiles=${diagnostics.profiles} errors=[]`;
  });

  // ------------------------------------------------------------------------- G
  check('G. 诊断区分 (b)：读 profile 抛错时 errors 有内容（不是「没有 venv」）', () => {
    const home = path.join(tmpRoot, 'home-g');
    const dsh = path.join(home, '.dsh');
    fs.mkdirSync(dsh, { recursive: true });
    // profiles 是个普通文件 → readdirSync 抛 ENOTDIR，模拟「profile 读不到/没权限」
    fs.writeFileSync(path.join(dsh, 'profiles'), 'not a directory', 'utf8');
    const diagnostics = pythonCandidateDiagnostics({ env: {}, homedir: home });
    assert.equal(diagnostics.roots.length, 0, '读不到就不该有 repo 根');
    assert.ok(diagnostics.errors.length > 0, '读失败必须留下原因，否则提示无法区分两种情况');
    return diagnostics.errors[0];
  });

  // ------------------------------------------------------------------------- H
  check('H. 提示文案仍可诊断且不带本机绝对路径', () => {
    assert.equal(typeof PYTHON_MISSING_HINT, 'string');
    assert.ok(PYTHON_MISSING_HINT.includes('SW_3D_PREVIEW_PYTHON'), '提示应引导设置 SW_3D_PREVIEW_PYTHON');
    assert.ok(PYTHON_MISSING_HINT.includes('候选顺序'), '提示应说明候选顺序');
    assert.doesNotMatch(PYTHON_MISSING_HINT, /[A-Za-z]:\\{1,2}Users\\{1,2}[^\\]+/i, '提示里不该出现具体用户名路径');
    assert.doesNotMatch(PYTHON_MISSING_HINT, /:\/Users\//i, '提示里不该出现具体用户名路径');
    return PYTHON_MISSING_HINT.slice(-60);
  });
  // ------------------------------------------------------------------------- I
  //
  // 这条补的是排序/穿透的覆盖缺口（审查用变异发现）：
  // 把 lib/mesh.js 的 `for (const [, spec] of entries)` 改成 `entries.slice(0, 1)` 后，
  // 原来的 9 条 case 全绿 —— 因为每个 profile 只放了**一个** link: 依赖，
  // `entries.sort()` 那段「名字像 sw-mcp 的排前面」的逻辑从来没被真正跑到。
  // 而本机 desktop profile 有 9 个 link 依赖、sw-mcp 排第 7，正是排序在救命。
  //
  // 实现语义（见 lib/mesh.js:147、212）：**所有** link/file 依赖里「有 .venv」的都会被收进来，
  // 排序只决定候选先后。所以这里断言的是**顺序**（sw-mcp 那个必须排在最前），
  // 而不是「只有它一条」——后者会把既有设计当成 bug。
  check('I. 同一 profile 多个 link 依赖：非 sw-mcp 的带 .venv 排前面，sw-mcp 仍排在候选最前', () => {
    const home = path.join(tmpRoot, 'home-i');
    const profilesRoot = path.join(home, '.dsh', 'profiles');

    const decoyRepo = makeRepo(path.join(tmpRoot, 'repo-i-decoy'));
    const realRepo = makeRepo(path.join(tmpRoot, 'repo-i-real'));

    // entries.sort 的 rank：匹配 /sw-mcp|sw-preset|sw_3d|sw3d/ 的排前（rank=0），其余排后（rank=1）。
    // 这里放 3 个不匹配名（都带 .venv，是诱饵）+ 1 个匹配名（真目标）。
    const deps = {
      'aaa-other-plugin': `link:${decoyRepo}`,
      'mmm-third-plugin': `link:${makeRepo(path.join(tmpRoot, 'repo-i-decoy3'))}`,
      'zzz-another-plugin': `link:${makeRepo(path.join(tmpRoot, 'repo-i-decoy2'))}`,
      '@local/dsh-sw-preset': `link:${realRepo}`,
    };
    // 故意让 sw-mcp 在**对象字面量顺序**里排最后，确保排序真的按 rank 而不是按插入顺序
    makeProfile(profilesRoot, 'multi', deps);

    const candidates = pythonCandidates({ env: {}, homedir: home });
    assert.ok(
      hasRepo(candidates, realRepo),
      `没命中真正的 sw-mcp repo ${venvPython(realRepo)}；候选=${JSON.stringify(candidates.filter((c) => c.origin === 'venv-repo').map((c) => c.command))}`,
    );

    const repoCandidates = venvRepoCandidates(candidates);
    // 核心断言：sw-mcp 那个必须排在所有 venv-repo 候选的**第一位**（排序生效）。
    // 若排序被删掉或变成 slice(0,1)，这里会拿到 aaa-other-plugin 的诱饵 → 必红。
    assert.ok(repoCandidates.length >= 1, '应至少有 1 条 venv-repo 候选');
    assert.ok(
      samePath(repoCandidates[0].command, venvPython(realRepo)),
      `venv-repo 第一条必须是 sw-mcp 那个，实际是 ${repoCandidates[0].command}（诱饵排前面说明排序失效）`,
    );
    // 诱饵仍然在候选里（既有设计：所有带 .venv 的 link 依赖都收），但必须排在 sw-mcp 之后
    const decoyIndex = repoCandidates.findIndex((c) => samePath(c.command, venvPython(decoyRepo)));
    assert.ok(decoyIndex > 0, `诱饵应排在 sw-mcp 之后（index>0），实际 index=${decoyIndex}`);
    return `4 个带 .venv 的依赖 → sw-mcp 排第 1，诱饵排第 ${decoyIndex + 1}`;
  });

  // ------------------------------------------------------------------------- J
  check('J. 同一 profile 里 sw-mcp 排第 7（9 个依赖的 desktop 形态）也排在候选最前', () => {
    const home = path.join(tmpRoot, 'home-j');
    const profilesRoot = path.join(home, '.dsh', 'profiles');
    const realRepo = makeRepo(path.join(tmpRoot, 'repo-j-real'));
    // 仿本机 desktop：9 个 link 依赖，sw-mcp 排第 7（前面 6 个都不匹配 rank）
    const deps = {};
    for (let i = 1; i <= 6; i += 1) {
      deps[`plugin-${i}`] = `link:${makeRepo(path.join(tmpRoot, `repo-j-${i}`))}`;
    }
    deps['@local/dsh-sw-preset'] = `link:${realRepo}`; // 第 7
    deps['plugin-8'] = `link:${makeRepo(path.join(tmpRoot, 'repo-j-8'))}`;
    deps['plugin-9'] = `link:${makeRepo(path.join(tmpRoot, 'repo-j-9'))}`;
    makeProfile(profilesRoot, 'desktop-like', deps);

    const candidates = pythonCandidates({ env: {}, homedir: home });
    assert.ok(hasRepo(candidates, realRepo), `9 个依赖里没找到 sw-mcp：${venvPython(realRepo)}`);
    const repoCandidates = venvRepoCandidates(candidates);
    assert.ok(
      samePath(repoCandidates[0].command, venvPython(realRepo)),
      `sw-mcp 必须排第一（它在 package.json 里是第 7 个），实际第一是 ${repoCandidates[0].command}`,
    );
    return `9 个依赖、sw-mcp 字面第 7 → 候选里排第 1`;
  });

} finally {
  // 清场：只删自己 mkdtempSync 出来的这一个目录
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log(`临时目录已清理：${tmpRoot}`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} 个测试失败`);
  process.exitCode = 1;
} else {
  console.log(`\n全部通过（${passed}/${passed}，退出码 0）`);
}
