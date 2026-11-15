#!/usr/bin/env node
/**
 * Host 半边离线测试（不启动 DSH、不装插件、不碰 SOLIDWORKS）。
 *
 *   1. S3DM 写→读往返（含非 4 字节对齐的 buffer）
 *   2. 锁盖.STEP 真跑 lib/step_mesh.py，校验面/边/三角形/bbox/边折线
 *   3. 锁盖.SLDPRT → resolveSource 找到同名 .STEP
 *   4. ASCII STL 与 binary STL 都能解析出正确三角形数
 *   5. node --check index.js / lib/mesh.js / lib/resolve.js
 *   6. 额外：用假 ctx 跑通 5 条路由（ping/resolve/mesh/three/annotation）
 *
 * 运行：node test/host.mjs      退出码 0 表示全部通过。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.dirname(HERE);
const SAMPLE_DIR = 'C:\\Users\\mota\\Desktop\\工程自动化';
const SAMPLE_STEP = path.join(SAMPLE_DIR, '锁盖.STEP');
const SAMPLE_SLDPRT = path.join(SAMPLE_DIR, '锁盖.SLDPRT');

// 把 LOCALAPPDATA 指到临时沙箱：缓存与标注写到那里，测试结束后整目录删掉。
// 真实值单独留一份：草图路由那组测试要**只读**真实的 %LOCALAPPDATA%\sw-mcp\projects。
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sw3d-host-test-'));
process.env.LOCALAPPDATA = sandbox;

const {
  S3DM_VERSION,
  cacheKeyFor,
  cachePathFor,
  handoffDir,
  parseObj,
  parseStl,
  probePython,
  readS3dm,
  readS3dmHeader,
  runStepMesh,
  sha1,
  writeS3dm,
} = await import('../lib/mesh.js');
const {
  DEFAULT_MAX_TRIANGLES,
  completeFilePath,
  findFallbackStep,
  nameSimilarity,
  normalizeMaxTriangles,
  resolveSource,
} = await import('../lib/resolve.js');
const { buildHandoffMarkdown, handoffPathFor } = await import('../lib/handoff.js');
const {
  findDesignIdForPath,
  findPathByBaseName,
  projectsDir,
  recentIndexPath,
  rememberResolvedPath,
} = await import('../lib/paths.js');

let failures = 0;
function pass(label, detail = '') {
  console.log(`✔ ${label}${detail ? `\n   ${detail}` : ''}`);
}
function skip(label, reason) {
  console.log(`… ${label}（跳过：${reason}）`);
}
function fail(label, error) {
  failures += 1;
  console.error(`✘ ${label}\n   ${error && error.stack ? error.stack : error}`);
}

// --------------------------------------------------------------------------- 测试 1：S3DM 往返

async function testRoundtrip() {
  const header = {
    version: S3DM_VERSION,
    units: 'mm',
    format: 'roundtrip',
    source: { path: 'C:\\临时 目录\\锁盖.STEP', bytes: 133942, mtimeMs: 1763000000000 },
    bbox: [-15.5, -29.25, -5, 15.5, 29.25, 0],
    vertexCount: 3,
    triangleCount: 1,
    faceCount: 1,
    edgeCount: 0,
    faceEdgeCount: 1,
    faces: [{ index: 0, kind: 'plane', areaMm2: 0.5, normal: [0, 0, 1], point: [0, 0, 0], radiusMm: null }],
    edges: [],
    warnings: [],
  };
  const buffers = {
    position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    index: new Uint32Array([0, 1, 2]),
    faceOfTriangle: new Uint32Array([0]),
    edgePosition: new Float32Array(0),
    edgeSegment: new Uint32Array(0),
    faceEdge: new Uint32Array([0, 0]),
    // 故意放一个长度 5 的 u8 buffer：验证非 4 对齐长度后的补零。
    extraBytes: { array: new Uint8Array([9, 8, 7, 6, 5]), type: 'u8', components: 1 },
  };

  const encoded = writeS3dm(header, buffers);
  const decoded = readS3dm(encoded);

  assert.equal(S3DM_VERSION, 2, 'S3DM 版本必须是 2');
  assert.equal(decoded.header.version, 2);
  assert.equal(decoded.header.units, 'mm');
  assert.equal(decoded.header.format, 'roundtrip');
  assert.equal(decoded.header.source.path, header.source.path, '中文路径 UTF-8 往返');
  assert.equal(decoded.header.source.mtimeMs, header.source.mtimeMs);
  assert.deepEqual(decoded.header.bbox, header.bbox);
  assert.deepEqual(decoded.header.faces, header.faces);
  assert.deepEqual(decoded.header.warnings, []);
  assert.equal(decoded.header.buffers.length, 8);
  assert.equal(encoded.toString('latin1', 0, 4), 'S3DM');
  assert.equal(encoded.readUInt32LE(4), decoded.jsonLength);
  assert.equal((8 + decoded.jsonLength) % 4, 0, 'header JSON 补齐后 8+len 必须 4 字节对齐');
  assert.equal(decoded.sectionStart, 8 + decoded.jsonLength, '数据区起点 = 8 + headerJsonLength（客户端就按这个算）');
  assert.equal(decoded.sectionStart % 4, 0, 'buffer 数据区起点 4 对齐');
  for (const descriptor of decoded.header.buffers) {
    assert.equal(descriptor.offset % 4, 0, `buffer ${descriptor.name} offset 4 对齐`);
    // 客户端 parseS3DM 的算法：base = 8 + headerJsonLength，start = base + offset，且 start % 4 === 0
    assert.equal((8 + decoded.jsonLength + descriptor.offset) % 4, 0, `客户端视角 ${descriptor.name} 绝对偏移对齐`);
    const raw = buffers[descriptor.name];
    const sourceArray = raw && raw.array ? raw.array : raw;
    const expected = Buffer.from(sourceArray.buffer, sourceArray.byteOffset, sourceArray.byteLength);
    const actualView = decoded.buffers[descriptor.name];
    const actual = Buffer.from(actualView.buffer, actualView.byteOffset, actualView.byteLength);
    assert.equal(actual.length, expected.length, `buffer ${descriptor.name} 字节数`);
    assert.equal(actual.toString('hex'), expected.toString('hex'), `buffer ${descriptor.name} 字节内容`);
    assert.equal(descriptor.count, sourceArray.length / descriptor.components, `buffer ${descriptor.name} count`);
  }

  const last = decoded.header.buffers[decoded.header.buffers.length - 1];
  assert.equal(last.name, 'extraBytes');
  assert.equal(last.count, 5);
  assert.equal(encoded.length, decoded.sectionStart + last.offset + 5 + 3, '末尾补零到 4 字节对齐');
  assert.deepEqual([...encoded.subarray(encoded.length - 3)], [0, 0, 0], '补的是 0x00');
  assert.deepEqual(readS3dmHeader(encoded).header.bbox, header.bbox, 'readS3dmHeader 只读头即可拿到 bbox');
  assert.equal(decoded.buffers.index.constructor, Uint32Array);
  assert.equal(decoded.buffers.position.constructor, Float32Array);

  pass('1. S3DM 写→读往返（header 字段 + 8 个 buffer 字节一致 + 非 4 对齐补零）');
  // 缓存键必须区分精度档（deflection / maxTriangles）
  const baseOptions = { path: SAMPLE_STEP, mtimeMs: 1000, bytes: 100, deflection: 0.2, maxTriangles: 300000 };
  const keyA = cacheKeyFor(baseOptions);
  const keyB = cacheKeyFor({ ...baseOptions, maxTriangles: 120000 });
  const keyC = cacheKeyFor({ ...baseOptions, deflection: 0.5 });
  assert.notEqual(keyA, keyB, 'maxTriangles 必须进缓存键');
  assert.notEqual(keyA, keyC, 'deflection 必须进缓存键');
  assert.equal(keyA, cacheKeyFor({ ...baseOptions }), '同样参数必须得到同样的键');
  assert.ok(cachePathFor(baseOptions).endsWith(`${keyA}.s3dm`));
  assert.equal(normalizeMaxTriangles('900000'), 900000);
  assert.equal(normalizeMaxTriangles('abc'), DEFAULT_MAX_TRIANGLES);
  assert.equal(normalizeMaxTriangles('0'), DEFAULT_MAX_TRIANGLES);
  assert.equal(normalizeMaxTriangles('10'), 2000, '低于下限夹到 2000');
  pass('1b. 缓存键含 deflection + maxTriangles，且键盘归一化正确', `key=${keyA.slice(0, 12)}… 默认上限=${DEFAULT_MAX_TRIANGLES}`);
}

// --------------------------------------------------------------------------- 测试 2：STEP 三角化

async function testStepMesh() {
  if (!fs.existsSync(SAMPLE_STEP)) {
    skip('2. 锁盖.STEP 三角化', `样例不存在：${SAMPLE_STEP}`);
    return;
  }
  const python = await probePython();
  console.log(
    `   python 探测：path=${python.path} ok=${python.ok} ocp=${python.ocp} version=${python.version} ocpVersion=${python.ocpVersion}`,
  );
  if (!python.ok) {
    skip('2. 锁盖.STEP 三角化', `没有可用的 python+OCP：${python.error}`);
    return;
  }
  const out = path.join(os.tmpdir(), `sw3d-step-${Date.now()}.s3dm`);
  try {
    const started = Date.now();
    const result = await runStepMesh({ python, input: SAMPLE_STEP, output: out, deflection: 0.2 });
    const elapsed = Date.now() - started;
    assert.equal(result.ok, true, `step_mesh.py 失败（${result.code}）：${result.stderrTail}`);
    const fileBytes = fs.readFileSync(out);
    const { header, buffers } = readS3dm(fileBytes);
    // 客户端 parseS3DM 的对齐假设：base = 8 + headerJsonLength（不额外 align4）
    const rawHeaderLength = fileBytes.readUInt32LE(4);
    assert.equal((8 + rawHeaderLength) % 4, 0, 'python 写的 header 也必须让 8+len 4 对齐');
    for (const descriptor of header.buffers) {
      assert.equal((8 + rawHeaderLength + descriptor.offset) % 4, 0, `${descriptor.name} 客户端视角绝对偏移对齐`);
    }
    const sizes = [header.bbox[3] - header.bbox[0], header.bbox[4] - header.bbox[1], header.bbox[5] - header.bbox[2]];

    assert.ok(header.triangleCount > 100, `triangleCount=${header.triangleCount} 应 > 100`);
    assert.ok(header.faceCount > 20, `faceCount=${header.faceCount} 应 > 20`);
    assert.ok(header.edgeCount > 50, `edgeCount=${header.edgeCount} 应 > 50`);
    // 锁盖是 30 × 58 × 5 mm 的薄盖：最长两轴落在 20..120 mm，薄轴（5 mm）不在这个区间，
    // 所以这里按「最长两轴 20..120、所有轴 <= 120 且 > 0.5」断言 —— 5 mm 正是没被当成米/英寸的证据。
    const sortedSizes = [...sizes].sort((a, b) => a - b);
    for (const size of [sortedSizes[1], sortedSizes[2]]) {
      assert.ok(size >= 20 && size <= 120, `bbox 最长两轴之一 ${size.toFixed(3)} mm 不在 20..120`);
    }
    for (const size of sizes) assert.ok(size > 0.5 && size <= 120, `bbox 某一轴 ${size.toFixed(3)} mm 超出 0.5..120`);
    assert.ok(buffers.edgePosition.length > 0, 'edgePosition 应有数据');
    for (const edge of header.edges) {
      assert.ok(edge.polylineCount >= 2, `边 ${edge.index} polylineCount=${edge.polylineCount} 应 >= 2`);
      assert.ok(edge.polylineStart >= 0);
      assert.ok(edge.polylineStart + edge.polylineCount <= buffers.edgePosition.length / 3);
    }
    for (const faceIndex of buffers.faceOfTriangle) {
      assert.ok(faceIndex < header.faceCount, `faceOfTriangle ${faceIndex} 应 < faceCount ${header.faceCount}`);
    }
    assert.equal(buffers.position.length, header.vertexCount * 3);
    assert.equal(buffers.normal.length, header.vertexCount * 3);
    assert.equal(buffers.index.length, header.triangleCount * 3);
    assert.equal(buffers.faceOfTriangle.length, header.triangleCount);
    assert.equal(buffers.edgeSegment.length % 2, 0, 'edgeSegment 应是成对的段索引');
    assert.equal(header.buffers.find((entry) => entry.name === 'edgeSegment').components, 2);
    assert.equal(header.source.path, SAMPLE_STEP, 'header.source.path 应保留中文原始路径');
    assert.ok(header.warnings.length === 0, `不应有 warnings：${header.warnings.join('; ')}`);

    // ---- S3DM v2：版本、faceEdge（面↔边）关联、精度字段
    assert.equal(header.version, 2, 'step_mesh.py 必须写 header.version = 2');
    assert.ok(header.faceEdgeCount > 0, `faceEdgeCount=${header.faceEdgeCount} 应 > 0`);
    const faceEdge = buffers.faceEdge;
    assert.ok(faceEdge && faceEdge.length >= 2, 'faceEdge buffer 应存在');
    assert.equal(faceEdge.length / 2, header.faceEdgeCount, 'faceEdgeCount 应等于 buffer 对数');
    for (let i = 0; i < faceEdge.length; i += 2) {
      assert.ok(faceEdge[i] < header.faceCount, `faceEdge.face=${faceEdge[i]} 应 < ${header.faceCount}`);
      assert.ok(faceEdge[i + 1] < header.edgeCount, `faceEdge.edge=${faceEdge[i + 1]} 应 < ${header.edgeCount}`);
    }
    assert.equal(header.maxTriangles, 300000);
    assert.deepEqual(header.precision, { deflectionMm: 0.2, maxTriangles: 300000 });
    assert.match(header.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    // 每个面至少能通过 faceEdge 找到一条边（锁盖是实体，没有孤立面）
    const facesWithEdges = new Set();
    for (let i = 0; i < faceEdge.length; i += 2) facesWithEdges.add(faceEdge[i]);
    assert.equal(facesWithEdges.size, header.faceCount, '每个面都应至少关联一条边');

    // ---- 精度参数真的传到了 python（缓存键 + --max-triangles）
    const cappedOut = path.join(os.tmpdir(), `sw3d-step-capped-${Date.now()}.s3dm`);
    try {
      const capped = await runStepMesh({
        python,
        input: SAMPLE_STEP,
        output: cappedOut,
        deflection: 0.2,
        maxTriangles: 2000,
      });
      assert.equal(capped.ok, true, `--max-triangles 2000 失败：${capped.stderrTail}`);
      const cappedHeader = readS3dm(fs.readFileSync(cappedOut)).header;
      assert.equal(cappedHeader.maxTriangles, 2000);
      assert.equal(cappedHeader.precision.maxTriangles, 2000);
      assert.ok(cappedHeader.triangleCount <= 2000, `triangleCount=${cappedHeader.triangleCount} 应 <= 2000`);
      pass(
        '2b. --max-triangles 生效',
        `deflection=0.2 maxTriangles=2000 → triangles=${cappedHeader.triangleCount} header.maxTriangles=${cappedHeader.maxTriangles}`,
      );
    } finally {
      fs.rmSync(cappedOut, { force: true });
    }

    pass(
      '2. 锁盖.STEP 三角化',
      `faces=${header.faceCount} edges=${header.edgeCount} triangles=${header.triangleCount} vertices=${header.vertexCount} ` +
        `edgePoints=${buffers.edgePosition.length / 3} bytes=${fileBytes.length} 耗时=${elapsed}ms（python 内部 ${result.summary.seconds}s）\n` +
        `   bbox=[${header.bbox.join(', ')}] 尺寸=${sizes.map((value) => value.toFixed(2)).join(' × ')} mm`,
    );
  } finally {
    fs.rmSync(out, { force: true });
  }
}

// --------------------------------------------------------------------------- 测试 3：SLDPRT → 同名 STEP

async function testSldprtResolve() {
  const detail = [];
  if (fs.existsSync(SAMPLE_SLDPRT) && fs.existsSync(SAMPLE_STEP)) {
    const resolved = await resolveSource(SAMPLE_SLDPRT);
    assert.equal(resolved.ok, true, JSON.stringify(resolved));
    assert.equal(resolved.format, 'sldprt');
    assert.equal(resolved.meshSource, 'sibling-step');
    assert.ok(resolved.sibling, '应给出 sibling 路径');
    assert.equal(path.basename(resolved.sibling).toLowerCase(), '锁盖.step');
    assert.equal(path.dirname(resolved.sibling).toLowerCase(), SAMPLE_DIR.toLowerCase());
    assert.ok(resolved.hints.length > 0, '应有 hints');
    assert.ok(resolved.bytes > 0 && resolved.mtimeMs > 0);
    detail.push(`样例 sibling-step=${path.basename(resolved.sibling)}`);
  } else {
    skip('3a. 真实样例 SLDPRT → 同名 STEP', '样例不存在');
  }

  // 反向用例：不支持的扩展名与不存在的文件
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw3d-bad-'));
  const projects = path.join(sandbox, 'sw-mcp', 'projects');
  fs.mkdirSync(projects, { recursive: true });
  try {
    const textFile = path.join(tempDir, 'a.txt');
    fs.writeFileSync(textFile, 'x');
    const unsupported = await resolveSource(textFile);
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.code, 'UNSUPPORTED');
    const missing = await resolveSource(path.join(tempDir, 'nope.STEP'));
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'NOT_FOUND');

    // ---- 3b. 第二级兜底：没有同名 STEP，但同目录有名字相近的 STEP
    const fallbackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw3d-fallback-'));
    let projectPath = '';
    try {
      const nativePath = path.join(fallbackDir, '轴承支架.SLDPRT');
      const nearStep = path.join(fallbackDir, '轴承支架-01.step');
      const farStep = path.join(fallbackDir, '完全不相关的零件.step');
      fs.writeFileSync(nativePath, 'fake sldprt');
      fs.writeFileSync(nearStep, 'ISO-10303-21;');
      fs.writeFileSync(farStep, 'ISO-10303-21;');
      const now = Date.now();
      fs.utimesSync(farStep, new Date(now - 600000), new Date(now - 600000));
      fs.utimesSync(nearStep, new Date(now - 300000), new Date(now - 300000));
      const fallback = await resolveSource(nativePath);
      assert.equal(fallback.ok, true, JSON.stringify(fallback));
      assert.equal(fallback.meshSource, 'fallback-step');
      assert.equal(path.basename(fallback.sibling), '轴承支架-01.step', '应挑文件名最相近的 STEP');
      assert.ok(fallback.hints.some((h) => h.includes('未找到同名 STEP')), fallback.hints.join(' | '));
      assert.ok(fallback.hints.some((h) => h.includes('最接近的')), fallback.hints.join(' | '));
      assert.ok(fallback.hints.some((h) => h.includes('相似度')), fallback.hints.join(' | '));
      // SLDPRT 比 STEP 新 5 分钟 → 必须提示「可能已过期」
      assert.ok(fallback.hints.some((h) => h.includes('可能已过期')), `缺少新鲜度警告：${fallback.hints.join(' | ')}`);
      detail.push('fallback-step=轴承支架-01.step(+过期警告)');

      // 完全不相似的 STEP 不应被选中
      const unrelatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw3d-unrelated-'));
      try {
        const native2 = path.join(unrelatedDir, 'abc.SLDPRT');
        fs.writeFileSync(native2, 'fake');
        fs.writeFileSync(path.join(unrelatedDir, 'zzz-qqq.step'), 'ISO-10303-21;');
        const unrelated = await resolveSource(native2);
        assert.equal(unrelated.ok, false, '不相似的 STEP 不该被当成同一个零件');
        assert.equal(unrelated.code, 'NO_MESH_SOURCE');
      } finally {
        fs.rmSync(unrelatedDir, { recursive: true, force: true });
      }

      // ---- 3c. 第四级：什么都没有 → 可直接复制的下一步 + 原生件时间/大小
      const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw3d-bare2-'));
      try {
        const bare = path.join(bareDir, 'bare.SLDPRT');
        fs.writeFileSync(bare, 'fake native');
        const noSource = await resolveSource(bare);
        assert.equal(noSource.code, 'NO_MESH_SOURCE');
        assert.match(noSource.hint, /deliver kind="step"/);
        assert.match(noSource.hint, /或把同名 \.step 放到/);
        assert.match(noSource.hint, /修改时间/);
        assert.match(noSource.hint, /大小/);
        assert.ok(noSource.native && noSource.native.bytes > 0, '错误体应带原生件大小');
        assert.ok(noSource.native.mtimeMs > 0, '错误体应带原生件修改时间');
        assert.equal(noSource.directory, bareDir);
        detail.push('NO_MESH_SOURCE=deliver命令+时间/大小');
      } finally {
        fs.rmSync(bareDir, { recursive: true, force: true });
      }

      // ---- 3d. 新鲜度阈值：差距 <= 60s 时不警告
      const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw3d-fresh-'));
      try {
        const native3 = path.join(freshDir, 'part.SLDPRT');
        const step3 = path.join(freshDir, 'part.step');
        fs.writeFileSync(native3, 'fake');
        fs.writeFileSync(step3, 'ISO-10303-21;');
        const t = Date.now();
        fs.utimesSync(step3, new Date(t), new Date(t));
        fs.utimesSync(native3, new Date(t + 20000), new Date(t + 20000)); // 只新 20 秒
        const fresh = await resolveSource(native3);
        assert.equal(fresh.meshSource, 'sibling-step');
        assert.ok(!fresh.hints.some((h) => h.includes('可能已过期')), '20 秒差距不该报警');
        detail.push('新鲜度阈值 60s 生效');
      } finally {
        fs.rmSync(freshDir, { recursive: true, force: true });
      }

      // ---- 3e. 相对路径补全：只有文件名时，按 sw-mcp project 记录补全成绝对路径
      projectPath = path.join(projects, 'bearing-seat-test.json');
      fs.writeFileSync(
        projectPath,
        JSON.stringify(
          {
            designId: 'bearing-seat-test',
            artifacts: [{ kind: 'sldprt', path: nativePath }, { kind: 'step', path: nearStep }],
          },
          null,
          2,
        ),
        'utf8',
      );
      assert.equal(await findDesignIdForPath(nativePath), 'bearing-seat-test');
      assert.equal(await findDesignIdForPath(nearStep), 'bearing-seat-test', '同目录同名异扩展名也应命中设计');
      const completed = await completeFilePath('轴承支架.SLDPRT');
      assert.equal(completed.ok, true, JSON.stringify(completed));
      assert.equal(completed.completed, true);
      assert.equal(completed.path.toLowerCase(), nativePath.toLowerCase());
      assert.equal(completed.designId, 'bearing-seat-test');
      assert.ok(completed.notes.some((n) => n.includes('project 记录')), completed.notes.join('|'));
      const resolvedRelative = await resolveSource('轴承支架.SLDPRT');
      assert.equal(resolvedRelative.ok, true, JSON.stringify(resolvedRelative));
      assert.equal(resolvedRelative.completed, true);
      assert.equal(resolvedRelative.path.toLowerCase(), nativePath.toLowerCase());
      assert.equal(resolvedRelative.designId, 'bearing-seat-test');
      detail.push('相对路径→project 记录补全+designId');

      // 补全不到时：错误体必须有原始字符串 + 期望形态
      const notFound = await resolveSource('绝对不存在的文件.SLDPRT');
      assert.equal(notFound.ok, false);
      assert.equal(notFound.code, 'NOT_FOUND');
      assert.match(notFound.message, /需要绝对路径，收到的是：绝对不存在的文件\.SLDPRT/);
      assert.match(notFound.hint, /期望形态/);
      assert.equal(notFound.received, '绝对不存在的文件.SLDPRT');
      detail.push('NOT_FOUND 带 received/expected');

      // ---- 3f. 最近索引：rememberResolvedPath 之后可以按 basename 找回
      await rememberResolvedPath(nativePath);
      assert.ok(fs.existsSync(recentIndexPath()), '最近索引应落盘');
      const byBase = await findPathByBaseName('轴承支架.SLDPRT');
      assert.ok(byBase, '最近索引应能按 basename 找回');
      assert.equal(byBase.absolutePath.toLowerCase(), nativePath.toLowerCase());

      // 名字相似度函数本身
      assert.ok(nameSimilarity('轴承支架.SLDPRT', '轴承支架-01.step') >= 0.25);
      assert.ok(nameSimilarity('abc.SLDPRT', 'zzz.step') < 0.25);
      const direct = await findFallbackStep(nativePath);
      assert.equal(path.basename(direct.path), '轴承支架-01.step');
    } finally {
      fs.rmSync(fallbackDir, { recursive: true, force: true });
      fs.rmSync(projectPath, { force: true });
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  pass('3. SLDPRT 多级兜底 / 新鲜度 / 相对路径补全 / designId', detail.join(' · '));
}

// --------------------------------------------------------------------------- 测试 4：STL 解析

function buildBinaryStl(triangleCount, { headerText = 'binary stl test' } = {}) {
  const buffer = Buffer.alloc(84 + triangleCount * 50);
  buffer.write(headerText, 0, 'latin1');
  buffer.writeUInt32LE(triangleCount, 80);
  for (let index = 0; index < triangleCount; index += 1) {
    const base = 84 + index * 50;
    buffer.writeFloatLE(0, base);
    buffer.writeFloatLE(0, base + 4);
    buffer.writeFloatLE(1, base + 8);
    for (let corner = 0; corner < 3; corner += 1) {
      const offset = base + 12 + corner * 12;
      const x = index * 10 + corner;
      buffer.writeFloatLE(x, offset);
      buffer.writeFloatLE(corner, offset + 4);
      buffer.writeFloatLE(0, offset + 8);
    }
  }
  return buffer;
}

async function testStl() {
  const ascii = [
    'solid test',
    '  facet normal 0 0 1',
    '    outer loop',
    '      vertex 0 0 0',
    '      vertex 1 0 0',
    '      vertex 0 1 0',
    '    endloop',
    '  endfacet',
    '  facet normal 0 0 1',
    '    outer loop',
    '      vertex 1 0 0',
    '      vertex 1 1 0',
    '      vertex 0 1 0',
    '    endloop',
    '  endfacet',
    'endsolid test',
    '',
  ].join('\r\n');

  const asciiParsed = parseStl(Buffer.from(ascii, 'utf8'));
  assert.equal(asciiParsed.indices.length / 3, 2, 'ASCII STL 2 个三角形');
  assert.equal(asciiParsed.vertices.length, 18);
  assert.equal(asciiParsed.normals.length, 18);
  assert.equal(asciiParsed.faces.length, 1, '同法向的两片归成一个面');
  assert.deepEqual([...asciiParsed.vertices.subarray(0, 3)], [0, 0, 0]);
  assert.deepEqual([...asciiParsed.normals.subarray(0, 3)], [0, 0, 1]);

  const binary = buildBinaryStl(3);
  const binaryParsed = parseStl(binary);
  assert.equal(binaryParsed.indices.length / 3, 3, 'binary STL 3 个三角形');
  assert.equal(binaryParsed.vertices.length, 27);

  // binary 头写成 "solid ..."（真实导出器常见），长度校验必须优先按 binary 解析
  const tricky = buildBinaryStl(2, { headerText: 'solid tricky but binary' });
  const trickyParsed = parseStl(tricky);
  assert.equal(trickyParsed.indices.length / 3, 2, '头部以 solid 开头的 binary STL 仍按 binary 解析');

  // OBJ 顺带验证：四边形扇形三角化 + 面序号
  const obj = ['v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'v 0 1 0', 'vn 0 0 1', 'f 1//1 2//1 3//1 4//1', ''].join('\n');
  const objParsed = parseObj(obj);
  assert.equal(objParsed.indices.length / 3, 2, 'OBJ 四边形拆 2 个三角形');
  assert.equal(objParsed.faces.length, 1);

  pass(
    '4. STL 解析',
    `ascii=${asciiParsed.indices.length / 3} 三角形 / binary=${binaryParsed.indices.length / 3} 三角形 / solid-头 binary=${trickyParsed.indices.length / 3} 三角形 / OBJ=${objParsed.indices.length / 3} 三角形`,
  );
}

// --------------------------------------------------------------------------- 测试 5：node --check

async function testSyntax() {
  for (const file of ['index.js', 'lib/mesh.js', 'lib/resolve.js', 'lib/paths.js', 'lib/handoff.js', 'lib/sketches.js']) {
    const target = path.join(PLUGIN_DIR, file);
    const result = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${file} node --check 失败：${result.stderr || result.stdout}`);
  }
  pass('5. node --check index.js / lib/mesh.js / lib/resolve.js / lib/paths.js / lib/handoff.js / lib/sketches.js');
}

// --------------------------------------------------------------------------- 测试 7：草图叠加层路由
//
// GET /sw3d/sketches?path=<模型绝对路径>
//   - 真实模型（D:\静静\临时文件\bracket-6.STEP → designId=bracket-6）→ ok:true + 草图折线
//   - 没有 designId 的模型（锁盖.STEP：任何 project 记录都没引用它）→ ok:false + code
//   - 缺 path → 400；非 GET → 405
// 只读：不写任何 project json（断言前后 size/mtime 不变）。
async function testSketchRoute() {
  const host = await import('../index.js');
  const routes = new Map();
  host.apply(createStubContext(routes));
  assert.equal(routes.has('/sw3d/sketches'), true, '必须注册 /sw3d/sketches');

  const REAL_STEP = 'D:\\静静\\临时文件\\bracket-6.STEP';
  const projectsReal = path.join(REAL_LOCALAPPDATA || '', 'sw-mcp', 'projects');
  if (!fs.existsSync(REAL_STEP) || !fs.existsSync(projectsReal)) {
    skip('7. /sw3d/sketches（真实 project 数据 · 只读）', `缺少 ${REAL_STEP} 或 ${projectsReal}`);
    return;
  }

  const projectFile = path.join(projectsReal, 'bracket-6.json');
  const before = fs.existsSync(projectFile) ? fs.statSync(projectFile) : null;

  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = REAL_LOCALAPPDATA; // 只读真实的 sw-mcp 记录
  let detail = '';
  try {
    // 缺 path → 400
    let response = await call(routes.get('/sw3d/sketches'), 'GET', '/sw3d/sketches');
    assert.equal(response.status, 400);
    assert.equal(JSON.parse(response.body.toString('utf8')).ok, false);

    // 非 GET → 405
    response = await call(routes.get('/sw3d/sketches'), 'POST', '/sw3d/sketches');
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, 'GET, HEAD');

    // 真实模型 → ok:true，草图数组与折线都齐全
    response = await call(routes.get('/sw3d/sketches'), 'GET', `/sw3d/sketches?path=${encodeURIComponent(REAL_STEP)}`);
    assert.equal(response.status, 200);
    assert.match(String(response.headers['content-type']), /application\/json/);
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(body.ok, true, JSON.stringify(body).slice(0, 400));
    assert.equal(body.designId, 'bracket-6');
    assert.equal(typeof body.designTitle, 'string');
    assert.equal(body.unit, 'mm');
    assert.ok(Array.isArray(body.sketches) && body.sketches.length > 0, `sketches 必须是数组：${JSON.stringify(body.sketches)}`);
    assert.ok(Array.isArray(body.warnings), 'warnings 必须是数组');

    let polylineCount = 0;
    let dimensionCount = 0;
    for (const sketch of body.sketches) {
      assert.match(String(sketch.id), /^sk-\d+$/, `草图 id 形如 sk-1：${sketch.id}`);
      assert.equal(typeof sketch.name, 'string');
      assert.ok(sketch.name.length > 0, '草图必须有 name');
      assert.equal(typeof sketch.feature, 'string');
      assert.ok(Array.isArray(sketch.polylines), '每条草图都要有 polylines 数组');
      assert.ok(Array.isArray(sketch.dimensions), '每条草图都要有 dimensions 数组');
      for (const polyline of sketch.polylines) {
        assert.ok(Array.isArray(polyline.points) && polyline.points.length >= 2,
          `${sketch.name} 的每条折线至少 2 个点：${JSON.stringify(polyline).slice(0, 120)}`);
        for (const point of polyline.points) {
          assert.equal(point.length, 3, '折线点必须是 [x,y,z]');
          assert.ok(point.every((v) => typeof v === 'number' && Number.isFinite(v)), '坐标必须是有限数');
        }
        polylineCount += 1;
      }
      for (const dimension of sketch.dimensions) {
        assert.equal(typeof dimension.name, 'string');
        assert.equal(typeof dimension.value, 'number');
        assert.equal(dimension.unit, 'mm');
        dimensionCount += 1;
      }
    }
    // 坐标系抽查：plate_band 的矩形是 225×90，画在「上视」基准面 → X=±112.5、Z=±45、Y=0
    const plateBand = body.sketches.find((s) => s.name === 'plate_band');
    assert.ok(plateBand, 'bracket-6 应有 plate_band 草图');
    assert.equal(plateBand.plane, '基准面-上视');
    assert.deepEqual(plateBand.bbox, [-112.5, 0, -45, 112.5, 0, 45],
      `上视基准面必须映射成 u→X、v→-Z：${JSON.stringify(plateBand.bbox)}`);
    detail = `designId=${body.designId} 草图 ${body.sketches.length} 条 / 折线 ${polylineCount} 条 / 尺寸 ${dimensionCount} 项 · warnings ${body.warnings.length} · plate_band bbox=${JSON.stringify(plateBand.bbox)}`;

    // 没有 designId 的模型 → ok:false + code（不是 500、不抛）
    if (fs.existsSync(SAMPLE_STEP)) {
      response = await call(routes.get('/sw3d/sketches'), 'GET', `/sw3d/sketches?path=${encodeURIComponent(SAMPLE_STEP)}`);
      assert.equal(response.status, 200, '失败也回 200，跟 /sw3d/resolve 的约定一致');
      const missing = JSON.parse(response.body.toString('utf8'));
      assert.equal(missing.ok, false);
      assert.equal(missing.code, 'NO_DESIGN');
      assert.equal(typeof missing.message, 'string');
      assert.equal(typeof missing.hint, 'string');
      assert.match(missing.hint, /build|designId/);
      detail += ` · 无 designId→${missing.code}`;
    }

    // 相对路径 → ok:false（BAD_PATH），不是 500
    response = await call(routes.get('/sw3d/sketches'), 'GET', `/sw3d/sketches?path=${encodeURIComponent('bracket-6.STEP')}`);
    assert.equal(response.status, 200);
    const badPath = JSON.parse(response.body.toString('utf8'));
    assert.equal(badPath.ok, false);
    assert.equal(badPath.code, 'BAD_PATH');
    detail += ` · 相对路径→${badPath.code}`;
  } finally {
    process.env.LOCALAPPDATA = previousLocalAppData;
  }

  // 只读断言：project json 一个字节都没动
  if (before) {
    const after = fs.statSync(projectFile);
    assert.equal(after.size, before.size, '不许改 sw-mcp 的 project json（大小）');
    assert.equal(after.mtimeMs, before.mtimeMs, '不许改 sw-mcp 的 project json（mtime）');
  }
  pass('7. /sw3d/sketches（真实 project 数据 · 只读）', detail);
}

// --------------------------------------------------------------------------- 测试 6：路由（假 ctx）

function fakeResponse() {
  const chunks = [];
  const headers = {};
  let status = 0;
  let headersSent = false;
  return {
    get statusCode() {
      return status;
    },
    set statusCode(value) {
      status = value;
    },
    get headersSent() {
      return headersSent;
    },
    writeHead(code, extra = {}) {
      status = code;
      Object.assign(headers, extra);
      headersSent = true;
      return this;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      headersSent = true;
      return this;
    },
    result() {
      return { status, headers, body: Buffer.concat(chunks) };
    },
  };
}

async function call(handler, method, url, { headers = {}, body = null, timeoutMs = 60000 } = {}) {
  const request = Readable.from(body === null ? [] : [Buffer.from(body)]);
  request.method = method;
  request.url = url;
  request.headers = headers;
  const response = fakeResponse();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${method} ${url} 超时 ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([Promise.resolve(handler(request, response)), timeout]);
  } finally {
    clearTimeout(timer);
  }
  return response.result();
}

function createStubContext(routes, { rejection = undefined } = {}) {
  return {
    webServer: {
      register: (route) => {
        assert.equal(route.kind, 'exact', '本插件只注册 exact 路由');
        assert.equal(routes.has(route.path), false, `重复注册 ${route.path}`);
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
    },
    connection: {
      requestRejection: () => rejection,
    },
    effect: (fn) => fn(),
  };
}

async function testRoutes() {
  const host = await import('../index.js');
  assert.equal(host.name, 'sw-3d-preview');
  assert.deepEqual([...host.inject], ['webServer', 'connection']);

  const routes = new Map();
  host.apply(createStubContext(routes));
  assert.deepEqual(
    [...routes.keys()].sort(),
    ['/sw3d/annotation', '/sw3d/handoff', '/sw3d/mesh', '/sw3d/ping', '/sw3d/resolve', '/sw3d/sketches', '/sw3d/snapshot', '/sw3d/three.js'],
  );

  // ping
  let response = await call(routes.get('/sw3d/ping'), 'GET', '/sw3d/ping');
  assert.equal(response.status, 200);
  assert.match(String(response.headers['content-type']), /application\/json/);
  const ping = JSON.parse(response.body.toString('utf8'));
  assert.equal(ping.ok, true);
  assert.equal(ping.name, '@local/dsh-sw-3d-preview');
  assert.equal(ping.version, '0.2.0');
  assert.ok(ping.cacheDir.startsWith(sandbox), `cacheDir 应在测试沙箱里：${ping.cacheDir}`);
  assert.equal(typeof ping.three, 'boolean');
  assert.equal(typeof ping.python.ok, 'boolean');

  // three.js：vendor 由客户端子代理提供，可能还不存在
  response = await call(routes.get('/sw3d/three.js'), 'GET', '/sw3d/three.js');
  const threeExists = fs.existsSync(path.join(PLUGIN_DIR, 'vendor', 'three.cjs'));
  assert.equal(response.status, threeExists ? 200 : 404);
  if (threeExists) assert.match(String(response.headers['content-type']), /text\/javascript/);
  const threeStatus = response.status;

  // 方法校验
  response = await call(routes.get('/sw3d/mesh'), 'POST', '/sw3d/mesh');
  assert.equal(response.status, 405);
  assert.equal(response.headers.allow, 'GET, HEAD');

  // 缺参数
  response = await call(routes.get('/sw3d/mesh'), 'GET', '/sw3d/mesh');
  assert.equal(response.status, 400);
  assert.equal(JSON.parse(response.body.toString('utf8')).ok, false);

  // 信任栅栏
  const rejected = new Map();
  host.apply(createStubContext(rejected, { rejection: 403 }));
  response = await call(rejected.get('/sw3d/ping'), 'GET', '/sw3d/ping');
  assert.equal(response.status, 403);
  assert.equal(rejected.get('/sw3d/mesh') !== undefined, true);

  // 没有同名 STEP 的 SLDPRT → 422 + NO_MESH_SOURCE
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw3d-bare-'));
  let meshDetail = '';
  let resolveDetail = '未测（样例缺失）';
  let snapshotDetail = '未测';
  try {
    const bareNative = path.join(bareDir, 'bare.SLDPRT');
    fs.writeFileSync(bareNative, 'fake');
    response = await call(routes.get('/sw3d/mesh'), 'GET', `/sw3d/mesh?path=${encodeURIComponent(bareNative)}`);
    assert.equal(response.status, 422);
    const bareBody = JSON.parse(response.body.toString('utf8'));
    assert.equal(bareBody.ok, false);
    assert.equal(bareBody.code, 'NO_MESH_SOURCE');
    assert.match(bareBody.hint, /deliver|同名/);

    // STL / OBJ 走 node 侧解析：200 + 正确的 x-sw3d-source + 空的边表
    const stlFile = path.join(bareDir, 'tri.stl');
    fs.writeFileSync(
      stlFile,
      ['solid t', '  facet normal 0 0 1', '    outer loop', '      vertex 0 0 0', '      vertex 10 0 0', '      vertex 0 10 0',
        '    endloop', '  endfacet', 'endsolid t', ''].join('\n'),
      'utf8',
    );
    response = await call(routes.get('/sw3d/mesh'), 'GET', `/sw3d/mesh?path=${encodeURIComponent(stlFile)}`);
    assert.equal(response.status, 200, response.body.toString('utf8').slice(0, 300));
    assert.equal(response.headers['x-sw3d-source'], 'stl');
    const stlHeader = readS3dm(response.body);
    assert.equal(stlHeader.header.triangleCount, 1);
    assert.equal(stlHeader.header.faceCount, 1);
    assert.equal(stlHeader.header.edgeCount, 0);
    assert.equal(stlHeader.buffers.edgePosition.length, 0);
    assert.equal(stlHeader.buffers.faceOfTriangle[0], 0);
    assert.deepEqual(stlHeader.header.bbox, [0, 0, 0, 10, 10, 0]);

    const objFile = path.join(bareDir, 'quad.obj');
    fs.writeFileSync(objFile, ['v 0 0 0', 'v 2 0 0', 'v 2 2 0', 'v 0 2 0', 'f 1//1 2//1 3//1 4//1', ''].join('\n'), 'utf8');
    response = await call(routes.get('/sw3d/mesh'), 'GET', `/sw3d/mesh?path=${encodeURIComponent(objFile)}`);
    assert.equal(response.status, 200, response.body.toString('utf8').slice(0, 300));
    assert.equal(response.headers['x-sw3d-source'], 'obj');
    assert.equal(readS3dm(response.body).header.triangleCount, 2);

    // 坏 STEP：python 侧失败要回 422 + detail（stderr 尾部，不能是堆栈直出）
    const badStep = path.join(bareDir, 'broken.STEP');
    fs.writeFileSync(badStep, 'this is not a step file\n', 'utf8');
    response = await call(routes.get('/sw3d/mesh'), 'GET', `/sw3d/mesh?path=${encodeURIComponent(badStep)}`);
    assert.equal(response.status, 422, response.body.toString('utf8').slice(0, 400));
    const brokenBody = JSON.parse(response.body.toString('utf8'));
    assert.equal(brokenBody.ok, false);
    assert.equal(typeof brokenBody.code, 'string');
    assert.equal(typeof brokenBody.message, 'string');
    assert.equal(typeof brokenBody.hint, 'string');
    assert.ok(!('stack' in brokenBody), '错误体里不能有 stack');
    meshDetail += `${meshDetail ? ' · ' : ''}STL/OBJ→200 · 坏 STEP→422(${brokenBody.code})`;

    if (fs.existsSync(SAMPLE_STEP)) {
      // resolve
      response = await call(routes.get('/sw3d/resolve'), 'GET', `/sw3d/resolve?path=${encodeURIComponent(SAMPLE_STEP)}`);
      assert.equal(response.status, 200);
      const resolved = JSON.parse(response.body.toString('utf8'));
      assert.equal(resolved.ok, true);
      assert.equal(resolved.format, 'step');
      assert.equal(resolved.meshSource, 'step');
      assert.equal(resolved.sibling, null);
      assert.equal(typeof resolved.cached.hit, 'boolean');
      assert.ok(resolved.cached.path.endsWith('.s3dm'));
      resolveDetail = `format=${resolved.format} cached.hit=${resolved.cached.hit}`;

      // mesh：第一次 miss，第二次 hit
      const meshUrl = `/sw3d/mesh?path=${encodeURIComponent(SAMPLE_STEP)}&deflection=0.2`;
      response = await call(routes.get('/sw3d/mesh'), 'GET', meshUrl);
      assert.equal(response.status, 200, response.body.toString('utf8').slice(0, 400));
      assert.equal(response.headers['content-type'], 'application/octet-stream');
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['x-sw3d-source'], 'step');
      assert.equal(Number(response.headers['content-length']), response.body.length);
      const header = readS3dmHeader(response.body).header;
      assert.ok(header.triangleCount > 100);
      assert.equal(response.headers['x-sw3d-bbox'], header.bbox.map((v) => String(Math.round(v * 1000) / 1000)).join(','));
      const firstCache = response.headers['x-sw3d-cache'];
      assert.ok(firstCache === 'hit' || firstCache === 'miss');

      response = await call(routes.get('/sw3d/mesh'), 'GET', meshUrl);
      assert.equal(response.headers['x-sw3d-cache'], 'hit');
      meshDetail = `source=${response.headers['x-sw3d-source']} bbox=${response.headers['x-sw3d-bbox']} 首次=${firstCache} 二次=hit${meshDetail ? ' · ' + meshDetail : ''}`;

      // .sldprt 走同名 STEP：x-sw3d-source 必须是 sibling-step，且命中同一份缓存
      if (fs.existsSync(SAMPLE_SLDPRT)) {
        response = await call(
          routes.get('/sw3d/mesh'),
          'GET',
          `/sw3d/mesh?path=${encodeURIComponent(SAMPLE_SLDPRT)}&deflection=0.2`,
        );
        assert.equal(response.status, 200, response.body.toString('utf8').slice(0, 300));
        assert.equal(response.headers['x-sw3d-source'], 'sibling-step');
        assert.equal(response.headers['x-sw3d-cache'], 'hit', 'SLDPRT 与同名 STEP 共用缓存键');
        assert.equal(readS3dmHeader(response.body).header.triangleCount, header.triangleCount);
        meshDetail += ' · SLDPRT→sibling-step(hit)';
      }

      // resolve 现在应显示缓存命中
      response = await call(routes.get('/sw3d/resolve'), 'GET', `/sw3d/resolve?path=${encodeURIComponent(SAMPLE_STEP)}`);
      assert.equal(JSON.parse(response.body.toString('utf8')).cached.hit, true);

      // ---- 精度档进缓存键：不同 maxTriangles 生成不同缓存文件、不同响应头
      const resolveLowUrl = `/sw3d/resolve?path=${encodeURIComponent(SAMPLE_STEP)}&precision=low`;
      response = await call(routes.get('/sw3d/resolve'), 'GET', resolveLowUrl);
      const lowResolve = JSON.parse(response.body.toString('utf8'));
      assert.equal(lowResolve.ok, true);
      assert.deepEqual(lowResolve.precision, { tier: 'low', deflectionMm: 0.5, maxTriangles: 120000 });
      const resolveMidUrl = `/sw3d/resolve?path=${encodeURIComponent(SAMPLE_STEP)}&precision=mid`;
      response = await call(routes.get('/sw3d/resolve'), 'GET', resolveMidUrl);
      const midResolve = JSON.parse(response.body.toString('utf8'));
      assert.equal(midResolve.precision.maxTriangles, 300000);
      assert.notEqual(lowResolve.cached.path, midResolve.cached.path, '精度档必须是缓存键的一部分');
      assert.notEqual(lowResolve.cached.key, midResolve.cached.key, 'cached.key 也应随精度变化');

      response = await call(routes.get('/sw3d/mesh'), 'GET', resolveLowUrl.replace('/resolve', '/mesh'));
      assert.equal(response.status, 200, response.body.toString('utf8').slice(0, 300));
      assert.equal(response.headers['x-sw3d-precision'], '0.5/120000');
      assert.equal(response.headers['x-sw3d-version'], '2');
      const lowHeader = readS3dmHeader(response.body).header;
      assert.equal(lowHeader.precision.maxTriangles, 120000);
      assert.ok(lowHeader.triangleCount > 0);

      // 显式 maxTriangles 也要透传
      response = await call(
        routes.get('/sw3d/mesh'),
        'GET',
        `/sw3d/mesh?path=${encodeURIComponent(SAMPLE_STEP)}&deflection=0.2&maxTriangles=5000`,
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers['x-sw3d-precision'], '0.2/5000');
      assert.equal(readS3dmHeader(response.body).header.maxTriangles, 5000);
      meshDetail += ' · precision=low/mid 缓存分离';

    }

    if (fs.existsSync(SAMPLE_STEP)) {
      // 标注：upsert → list（POST）→ list（GET）→ 超限 → 坏 JSON
      const upsertBody = JSON.stringify({ op: 'upsert', path: SAMPLE_STEP, annotation: { note: '测试标注', faceIndex: 3 } });
      response = await call(routes.get('/sw3d/annotation'), 'POST', '/sw3d/annotation', {
        headers: { 'content-type': 'application/json' },
        body: upsertBody,
      });
      assert.equal(response.status, 200, response.body.toString('utf8').slice(0, 300));
      const upsert = JSON.parse(response.body.toString('utf8'));
      assert.equal(upsert.ok, true);
      assert.match(upsert.id, /^ann_\d+_[0-9a-f]+$/);
      assert.equal(upsert.count, 1);

      response = await call(routes.get('/sw3d/annotation'), 'POST', '/sw3d/annotation', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'list', path: SAMPLE_STEP }),
      });
      const listed = JSON.parse(response.body.toString('utf8'));
      assert.equal(listed.ok, true);
      assert.equal(listed.items.length, 1);
      assert.equal(listed.items[0].annotation.note, '测试标注');
      assert.equal(listed.items[0].fileHash, sha1(SAMPLE_STEP.toLowerCase()));
      assert.equal(listed.items[0].file, SAMPLE_STEP);
      assert.match(listed.items[0].at, /^\d{4}-\d{2}-\d{2}T/);

      response = await call(routes.get('/sw3d/annotation'), 'GET', `/sw3d/annotation?path=${encodeURIComponent(SAMPLE_STEP)}`);
      assert.equal(JSON.parse(response.body.toString('utf8')).items.length, 1);

      const bigBody = JSON.stringify({ op: 'upsert', path: SAMPLE_STEP, annotation: { blob: 'x'.repeat(300 * 1024) } });
      response = await call(routes.get('/sw3d/annotation'), 'POST', '/sw3d/annotation', {
        headers: { 'content-type': 'application/json' },
        body: bigBody,
      });
      assert.equal(response.status, 413);

      response = await call(routes.get('/sw3d/annotation'), 'POST', '/sw3d/annotation', {
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      });
      assert.equal(response.status, 400);

      response = await call(routes.get('/sw3d/annotation'), 'POST', '/sw3d/annotation', {
        headers: { 'content-type': 'text/plain' },
        body: upsertBody,
      });
      assert.equal(response.status, 415);
    }

    // ---- 用户视角截图：POST /sw3d/snapshot（通道 B）落盘 + 魔数/体积/路径校验
    {
      const shotModel = path.join(sandbox, 'parts', '锁盖.STEP');
      const pngBytes = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(3072, 0x5a),
      ]);
      const snapBody = JSON.stringify({ path: shotModel, base64: pngBytes.toString('base64'), mediaType: 'image/png' });
      response = await call(routes.get('/sw3d/snapshot'), 'POST', '/sw3d/snapshot', {
        headers: { 'content-type': 'application/json' },
        body: snapBody,
      });
      assert.equal(response.status, 200, response.body.toString('utf8').slice(0, 300));
      const saved = JSON.parse(response.body.toString('utf8'));
      assert.equal(saved.ok, true);
      assert.equal(saved.mediaType, 'image/png');
      assert.equal(saved.bytes, pngBytes.length, '返回的字节数必须等于解码后长度');
      assert.ok(saved.shotPath.startsWith(path.join(sandbox, 'sw-3d-preview', 'shots')), `shotPath 应落在沙箱 shots：${saved.shotPath}`);
      assert.ok(saved.shotPath.endsWith('.png'));
      assert.ok(
        path.basename(saved.shotPath).startsWith(`${sha1(path.resolve(shotModel).toLowerCase())}-`),
        `文件名必须是 <sha1(小写模型路径)>-<时间戳>.png：${saved.shotPath}`,
      );
      assert.ok(fs.existsSync(saved.shotPath), '截图文件应真实存在');
      assert.equal(fs.statSync(saved.shotPath).size, pngBytes.length, '磁盘上的字节数必须对得上');
      assert.deepEqual(fs.readFileSync(saved.shotPath).subarray(0, 8), pngBytes.subarray(0, 8), '落盘内容必须是原图');

      // JPEG 魔数也要认，扩展名跟着魔数走（不跟声明的 mediaType）
      const jpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1024, 0x11)]);
      response = await call(routes.get('/sw3d/snapshot'), 'POST', '/sw3d/snapshot', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: shotModel, base64: jpegBytes.toString('base64'), mediaType: 'image/png' }),
      });
      assert.equal(response.status, 200, response.body.toString('utf8').slice(0, 300));
      const savedJpeg = JSON.parse(response.body.toString('utf8'));
      assert.equal(savedJpeg.mediaType, 'image/jpeg', 'mediaType 必须由魔数决定');
      assert.ok(savedJpeg.shotPath.endsWith('.jpg'));

      // 魔数不符 → 415（声明成 image/png 也没用）
      const badMagic = Buffer.from('not an image at all, just text', 'utf8');
      response = await call(routes.get('/sw3d/snapshot'), 'POST', '/sw3d/snapshot', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: shotModel, base64: badMagic.toString('base64'), mediaType: 'image/png' }),
      });
      assert.equal(response.status, 415, response.body.toString('utf8').slice(0, 300));

      // 解码后 >8 MB → 413（文本 10.8 MB，仍在 12 MB 文本上限内）
      const huge = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(8 * 1024 * 1024 + 1024, 0)]);
      response = await call(routes.get('/sw3d/snapshot'), 'POST', '/sw3d/snapshot', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: shotModel, base64: huge.toString('base64'), mediaType: 'image/png' }),
      });
      assert.equal(response.status, 413, response.body.toString('utf8').slice(0, 300));

      // 相对路径 → 400
      response = await call(routes.get('/sw3d/snapshot'), 'POST', '/sw3d/snapshot', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '锁盖.STEP', base64: pngBytes.toString('base64'), mediaType: 'image/png' }),
      });
      assert.equal(response.status, 400, response.body.toString('utf8').slice(0, 300));

      // 缺 path / 缺 base64 / 扩展名不支持 → 400
      response = await call(routes.get('/sw3d/snapshot'), 'POST', '/sw3d/snapshot', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ base64: pngBytes.toString('base64') }),
      });
      assert.equal(response.status, 400);
      response = await call(routes.get('/sw3d/snapshot'), 'POST', '/sw3d/snapshot', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: shotModel }),
      });
      assert.equal(response.status, 400);
      response = await call(routes.get('/sw3d/snapshot'), 'POST', '/sw3d/snapshot', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: path.join(sandbox, 'parts', 'a.txt'), base64: pngBytes.toString('base64') }),
      });
      assert.equal(response.status, 400);

      // 方法 / content-type
      response = await call(routes.get('/sw3d/snapshot'), 'GET', '/sw3d/snapshot');
      assert.equal(response.status, 405);
      assert.equal(response.headers.allow, 'POST');
      response = await call(routes.get('/sw3d/snapshot'), 'POST', '/sw3d/snapshot', {
        headers: { 'content-type': 'text/plain' },
        body: snapBody,
      });
      assert.equal(response.status, 415);
      snapshotDetail = `png ${saved.bytes}B→${path.basename(saved.shotPath)} · jpeg→.jpg · 415/413/400/405 全中`;
    }

    // ---- 交接单：POST 生成 → 落盘 → GET 返回 Markdown
    const projectFile = path.join(sandbox, 'sw-mcp', 'projects', 'lock-cover.json');
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    fs.writeFileSync(
      projectFile,
      JSON.stringify({ designId: 'lock-cover', artifacts: [{ kind: 'step', path: SAMPLE_STEP }] }, null, 2),
      'utf8',
    );
    if (fs.existsSync(SAMPLE_STEP)) {
      // 相对路径的标注也要能落地（宿主补全成绝对路径后再算 fileHash）
      response = await call(routes.get('/sw3d/annotation'), 'POST', '/sw3d/annotation', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'upsert', path: path.basename(SAMPLE_STEP), annotation: { text: '[3D标注] 相对路径用例' } }),
      });
      assert.equal(response.status, 200, response.body.toString('utf8').slice(0, 300));
      const relativeUpsert = JSON.parse(response.body.toString('utf8'));
      assert.equal(relativeUpsert.ok, true);
      response = await call(routes.get('/sw3d/annotation'), 'GET', `/sw3d/annotation?path=${encodeURIComponent(SAMPLE_STEP)}`);
      const listedRelative = JSON.parse(response.body.toString('utf8'));
      assert.ok(
        listedRelative.items.some((item) => item.annotation && item.annotation.text === '[3D标注] 相对路径用例'),
        '相对路径补全后的标注应与绝对路径的标注落在同一个文件哈希下',
      );

      response = await call(routes.get('/sw3d/handoff'), 'POST', '/sw3d/handoff', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: SAMPLE_STEP }),
      });
      assert.equal(response.status, 200, response.body.toString('utf8').slice(0, 400));
      const handoff = JSON.parse(response.body.toString('utf8'));
      assert.equal(handoff.ok, true);
      assert.ok(handoff.count >= 1, `count=${handoff.count}`);
      assert.ok(handoff.bytes > 0);
      assert.ok(handoff.mdPath.startsWith(sandbox), `mdPath 应落在沙箱：${handoff.mdPath}`);
      assert.ok(handoff.mdPath.endsWith('.md'));
      assert.equal(handoff.mdPath, handoffPathFor(SAMPLE_STEP));
      assert.equal(handoff.designId, 'lock-cover', '交接单应带 project 记录里的 designId');
      const markdown = fs.readFileSync(handoff.mdPath, 'utf8');
      assert.ok(markdown.startsWith('# 3D 标注交接单'), markdown.slice(0, 80));
      assert.ok(markdown.includes(SAMPLE_STEP), '交接单要含文件绝对路径');
      assert.ok(markdown.includes('lock-cover'), '交接单要含 designId');
      assert.ok(markdown.includes('测试标注'), '交接单要含每条标注的完整文本');
      assert.ok(markdown.includes('生成时间'));
      assert.match(markdown, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

      response = await call(routes.get('/sw3d/handoff'), 'GET', `/sw3d/handoff?path=${encodeURIComponent(SAMPLE_STEP)}`);
      assert.equal(response.status, 200);
      assert.match(String(response.headers['content-type']), /text\/markdown/);
      assert.equal(response.body.toString('utf8'), markdown, 'GET 与 POST 生成的 Markdown 必须一致');

      // 缺参数 → 400；方法不允许 → 405
      response = await call(routes.get('/sw3d/handoff'), 'GET', '/sw3d/handoff');
      assert.equal(response.status, 400);
      response = await call(routes.get('/sw3d/handoff'), 'DELETE', '/sw3d/handoff');
      assert.equal(response.status, 405);
      assert.equal(response.headers.allow, 'GET, POST');

      // 相对路径也能生成交接单（宿主按 project 记录补全）
      response = await call(routes.get('/sw3d/handoff'), 'POST', '/sw3d/handoff', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: path.basename(SAMPLE_STEP) }),
      });
      assert.equal(response.status, 200, response.body.toString('utf8').slice(0, 300));
      assert.equal(JSON.parse(response.body.toString('utf8')).mdPath, handoffPathFor(SAMPLE_STEP));

      // 交接单 Markdown 生成器：空标注也要有稳定结构
      const emptyMd = buildHandoffMarkdown({ filePath: SAMPLE_STEP, designId: '', annotations: [], generatedAt: '2026-01-02T03:04:05.000Z' });
      assert.ok(emptyMd.includes('（该文件还没有保存任何标注）'));
      assert.ok(emptyMd.includes('生成时间：2026-01-02T03:04:05.000Z'));
      assert.equal(emptyMd.split('\n')[1], '');
    } else {
      skip('7. 交接单路由', `样例不存在：${SAMPLE_STEP}`);
    }
  } finally {
    fs.rmSync(bareDir, { recursive: true, force: true });
  }

  pass(
    '6. 路由（假 ctx：信任栅栏/方法校验/ping/resolve/mesh/three/annotation/snapshot）',
    `three.js=${threeStatus} · ${resolveDetail} · ${meshDetail || '未测 STEP 路由（样例缺失）'} · NO_MESH_SOURCE→422 · 标注 upsert→list→413/400/415 · snapshot: ${snapshotDetail}`,
  );
  assert.ok(fs.existsSync(path.join(sandbox, 'sw-3d-preview', 'annotations', 'annotations.jsonl')), '标注应落在沙箱');
  assert.ok(fs.existsSync(path.join(sandbox, 'sw-3d-preview', 'cache')), '缓存目录应在沙箱里');
  assert.ok(fs.existsSync(path.join(sandbox, 'sw-3d-preview', 'shots')), '截图目录应在沙箱里');
}

// --------------------------------------------------------------------------- 测试 8：真实 http.Server 端到端

async function testLiveServer() {
  const http = await import('node:http');
  if (!fs.existsSync(SAMPLE_STEP)) {
    skip('8. 临时 http.Server 端到端', `样例不存在：${SAMPLE_STEP}`);
    return;
  }
  const host = await import('../index.js');
  const routes = new Map();
  host.apply(createStubContext(routes));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const handler = routes.get(url.pathname);
    if (!handler) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('no route');
      return;
    }
    Promise.resolve(handler(req, res)).catch((error) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(error && error.stack ? error.stack : error));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  try {
    const ping = await (await fetch(`${origin}/sw3d/ping`)).json();
    assert.equal(ping.ok, true);
    assert.equal(ping.three, true, 'vendor/three.cjs 应就位');

    const resolveStep = await (await fetch(`${origin}/sw3d/resolve?path=${encodeURIComponent(SAMPLE_STEP)}&precision=mid`)).json();
    assert.equal(resolveStep.ok, true, JSON.stringify(resolveStep));
    assert.equal(resolveStep.format, 'step');
    assert.equal(resolveStep.precision.maxTriangles, 300000);

    const meshStep = await fetch(`${origin}/sw3d/mesh?path=${encodeURIComponent(SAMPLE_STEP)}&precision=mid`);
    assert.equal(meshStep.status, 200);
    assert.equal(meshStep.headers.get('x-sw3d-version'), '2');
    assert.equal(meshStep.headers.get('x-sw3d-precision'), '0.2/300000');
    const stepBuffer = Buffer.from(await meshStep.arrayBuffer());
    const stepS3dm = readS3dm(stepBuffer);
    assert.equal(stepS3dm.header.version, 2);
    assert.ok(stepS3dm.header.triangleCount > 100);
    assert.ok(stepS3dm.header.faceCount > 20);
    assert.ok(stepS3dm.header.edgeCount > 50);
    assert.equal(stepS3dm.buffers.faceEdge.length / 2, stepS3dm.header.faceEdgeCount);
    assert.ok(stepS3dm.header.faces.length === stepS3dm.header.faceCount);
    assert.ok(stepS3dm.header.edges.length === stepS3dm.header.edgeCount);
    const bboxSizes = [0, 1, 2].map((i) => Number((stepS3dm.header.bbox[i + 3] - stepS3dm.header.bbox[i]).toFixed(2)));

    let sldprtDetail = '未测（样例缺失）';
    if (fs.existsSync(SAMPLE_SLDPRT)) {
      const meshSldprt = await fetch(`${origin}/sw3d/mesh?path=${encodeURIComponent(SAMPLE_SLDPRT)}&precision=mid`);
      assert.equal(meshSldprt.status, 200);
      assert.equal(meshSldprt.headers.get('x-sw3d-source'), 'sibling-step');
      assert.equal(meshSldprt.headers.get('x-sw3d-cache'), 'hit', 'SLDPRT 与同名 STEP 共用缓存');
      const sldprtHeader = readS3dmHeader(Buffer.from(await meshSldprt.arrayBuffer())).header;
      assert.equal(sldprtHeader.triangleCount, stepS3dm.header.triangleCount);

      // 相对路径 + base 参数（模拟面板只给出文件名 + 会话工作区根）
      const relative = await (await fetch(
        `${origin}/sw3d/resolve?path=${encodeURIComponent(path.basename(SAMPLE_SLDPRT))}&base=${encodeURIComponent(SAMPLE_DIR)}`,
      )).json();
      assert.equal(relative.ok, true, JSON.stringify(relative));
      assert.equal(relative.path.toLowerCase(), SAMPLE_SLDPRT.toLowerCase());
      assert.equal(relative.completed, true);
      assert.equal(relative.meshSource, 'sibling-step');
      sldprtDetail = `sibling-step(hit) triangles=${sldprtHeader.triangleCount} · 相对路径+base 补全 OK`;
    }

    const handoffResponse = await fetch(`${origin}/sw3d/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: SAMPLE_STEP }),
    });
    assert.equal(handoffResponse.status, 200);
    const handoff = await handoffResponse.json();
    assert.equal(handoff.ok, true);
    assert.ok(handoff.mdPath.startsWith(sandbox));
    assert.ok(fs.existsSync(handoff.mdPath), '交接单文件应真实存在');

    pass(
      '8. 临时 http.Server 端到端（真实 STEP/SLDPRT）',
      `faces=${stepS3dm.header.faceCount} edges=${stepS3dm.header.edgeCount} triangles=${stepS3dm.header.triangleCount} ` +
        `faceEdge=${stepS3dm.header.faceEdgeCount} bbox=${bboxSizes.join('×')}mm version=${stepS3dm.header.version}\n` +
        `   ${sldprtDetail} · handoff=${path.basename(handoff.mdPath)}`,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// --------------------------------------------------------------------------- 主流程

async function main() {
  console.log(`插件目录：${PLUGIN_DIR}`);
  console.log(`LOCALAPPDATA 沙箱：${sandbox}`);
  const tests = [testRoundtrip, testStepMesh, testSldprtResolve, testStl, testSyntax, testSketchRoute, testRoutes, testLiveServer];
  for (const test of tests) {
    try {
      await test();
    } catch (error) {
      fail(test.name, error);
    }
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`\n${failures} 个测试失败`);
    process.exitCode = 1;
    return;
  }
  console.log('\n全部通过（退出码 0）');
}

await main();
