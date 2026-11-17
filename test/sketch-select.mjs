// Offline test for sketch line / sketch point picking + Ctrl multi-select
//   node test/sketch-select.mjs
//
// 全部用真实数据结构（fracture_profile：10 条折线、172 个点，来自
// test/sketch-parse.mjs 内联的真实 fixture），不连任何服务。
//
// 覆盖：
//   1. 段下标 → 折线下标的映射（首段/末段/中间抽样）
//   2. 端点拾取优先于折线拾取（光标同时靠近端点与折线时返回点）
//   3. Ctrl toggle（A → Ctrl+B → {A,B} → Ctrl+A → {B}）
//   4. 不按 Ctrl 点 C → 只剩 {C}
//   5. 多选汇总文本逐字符（N 条线、M 个点、合计长度一位小数）
//   6. Esc 清空后集合为空
//   7. 折线长度 / 端点 / 右键菜单 / 「把所选填进对话框」指令文本
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = process.env.SW3D_CLIENT
  ? path.resolve(process.env.SW3D_CLIENT)
  : path.join(here, '..', 'client.js');
const source = fs.readFileSync(clientPath, 'utf8');
console.log('# client.js: ' + clientPath + ' (' + source.length + ' bytes)');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log('ok   ' + name);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log('FAIL ' + name + '\n     ' + (err && err.stack ? err.stack : err));
  }
}

/* ------------------------------------------------------------------ */
/* fakes: window.__ModuleLoader__ + minimal react (same shape as the   */
/* smoke test's harness — no network, no DOM)                          */
/* ------------------------------------------------------------------ */

let loadedSpec = null;
const fakeWindow = {
  devicePixelRatio: 1,
  __ModuleLoader__: {
    load(spec) {
      assert.ok(!loadedSpec, 'client.js must call __ModuleLoader__.load exactly once');
      loadedSpec = spec;
    },
  },
  __listeners: {},
  addEventListener(type, fn) { (this.__listeners[type] = this.__listeners[type] || []).push(fn); },
  removeEventListener(type, fn) {
    if (this.__listeners[type]) this.__listeners[type] = this.__listeners[type].filter((f) => f !== fn);
  },
};

const fakeDocument = {
  createElementNS() {
    return {
      style: {},
      getContext() { return null; },
      setAttribute() {},
      addEventListener() {},
      removeEventListener() {},
    };
  },
  createElement() { return this.createElementNS(); },
  addEventListener() {},
  removeEventListener() {},
  defaultView: fakeWindow,
};

const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children };
  },
  useState(initial) {
    let value = initial;
    return [value, (next) => { value = typeof next === 'function' ? next(value) : next; }];
  },
  useRef(v) { return { current: v }; },
  useEffect() { return undefined; },
  useMemo(fn) { return fn(); },
  useCallback(fn) { return fn; },
};

const fakeRequire = (id) => {
  if (id === 'react') return fakeReact;
  throw new Error('unexpected require: ' + id);
};

const fakeFetch = () => { throw new Error('sketch-select test must not perform network requests'); };

const factory = new Function(
  'window', 'document', 'navigator', 'self', 'fetch', 'console', 'TextEncoder', 'setTimeout', 'clearTimeout',
  source + '\n//# sourceURL=dsh-sw-3d-preview/client.js'
);
factory(
  fakeWindow,
  fakeDocument,
  { clipboard: { writeText: async () => {} }, userAgent: 'node' },
  fakeWindow,
  fakeFetch,
  console,
  TextEncoder,
  setTimeout,
  clearTimeout
);
assert.ok(loadedSpec, '__ModuleLoader__.load was not called');
const api = loadedSpec.factory(fakeRequire);
const T = api.__test;
assert.ok(T && typeof T === 'object', '__test surface missing');

/* ------------------------------------------------------------------ */
/* 真实数据：fracture_profile（10 条折线 / 172 个点）                    */
/* ------------------------------------------------------------------ */

const { FRACTURE_PROJECT } = await import('./sketch-parse.mjs');
const { tessellateSketch } = await import('../lib/sketches.js');

const FEATURE = FRACTURE_PROJECT.definition.features[0];
assert.equal(FEATURE.id, 'fracture_profile', 'fixture 必须是真实的 fracture_profile 特征');
const POLYLINES = tessellateSketch(FEATURE, {}).polylines;
assert.equal(POLYLINES.length, 10, '真实形状：10 条折线');
assert.equal(POLYLINES.reduce((sum, p) => sum + p.points.length, 0), 172, '真实形状：172 个点');
assert.equal(POLYLINES[8].closed, true, '第 9 条（下标 8）是闭合圆');
assert.equal(POLYLINES[9].closed, true, '第 10 条（下标 9）是闭合圆');

// 真实的世界坐标（草图 → 世界：lib/sketches.js 按 plane 把 2D 投到 3D）
const L0 = POLYLINES[0].points[0].slice();
const L9 = POLYLINES[9].points[0].slice();

/* ------------------------------------------------------------------ */
/* 1. 段下标 → 折线下标映射                                              */
/* ------------------------------------------------------------------ */

check('段下标 → 折线下标：首段属于折线 0、末段属于折线 9、中间抽样正确', () => {
  const index = T.buildSketchSegmentIndex(POLYLINES);
  const expectedSegments = POLYLINES.reduce((sum, p) => sum + T.sketchPolylineSegmentCount(p), 0);
  assert.equal(index.segmentCount, expectedSegments, '段数必须等于各折线段数之和');
  // 与 buildSketchSegmentPositions 的顶点数严格一致：段数 × 2 = 顶点数
  const positions = T.buildSketchSegmentPositions(POLYLINES);
  assert.equal(index.segmentCount * 2, positions.length / 3,
    '段数×2 必须等于 LineSegments 的顶点数（否则反查会错位）');
  assert.equal(index.polylineOfSegment.length, index.segmentCount);

  // 首段 / 末段
  assert.equal(index.polylineOfSegment[0], 0, '首段属于折线 0');
  assert.equal(index.polylineOfSegment[index.segmentCount - 1], 9, '末段属于折线 9');
  // 每条折线的段区间自洽（start / count 与 segmentCount 对得上）
  let cursor = 0;
  for (let p = 0; p < POLYLINES.length; p += 1) {
    const count = T.sketchPolylineSegmentCount(POLYLINES[p]);
    assert.equal(index.startOfPolyline[p], cursor, '折线 ' + p + ' 的段起点');
    assert.equal(index.countOfPolyline[p], count, '折线 ' + p + ' 的段数');
    for (let s = cursor; s < cursor + count; s += 1) {
      assert.equal(index.polylineOfSegment[s], p, '段 ' + s + ' 必须属于折线 ' + p);
    }
    cursor += count;
  }
  // 中间抽样：落在每条折线区间里的段都反查回它自己。
  // 真实形状的段划分（每条折线的段数 = 点数，闭合补一段）：
  //   折线 0: 17 点 → 16 段 (0..15)     折线 1: 17 点 → 16 段 (16..31)
  //   折线 2: 2 点  → 1 段  (32)        折线 3: 2 点  → 1 段  (33)
  //   折线 4: 17 点 → 16 段 (34..49)    折线 5: 2 点  → 1 段  (50)
  //   折线 6: 2 点  → 1 段  (51)        折线 7: 17 点 → 16 段 (52..67)
  //   折线 8: 48 点 → 48 段 (68..115)   折线 9: 48 点 → 48 段 (116..163)
  for (const [segment, polyline] of [
    [0, 0], [15, 0], [16, 1], [31, 1], [32, 2], [33, 3], [34, 4], [49, 4],
    [50, 5], [51, 6], [52, 7], [67, 7], [68, 8], [115, 8], [116, 9], [163, 9],
  ]) {
    assert.equal(index.polylineOfSegment[segment], polyline,
      '段 ' + segment + ' 应属于折线 ' + polyline + '（实际 ' + index.polylineOfSegment[segment] + '）');
  }
});

check('段下标映射：退化输入（空 / 单点 / null）不炸，且与顶点数仍一致', () => {
  assert.equal(T.buildSketchSegmentIndex(null).segmentCount, 0);
  assert.equal(T.buildSketchSegmentIndex([]).segmentCount, 0);
  const one = T.buildSketchSegmentIndex([{ points: [[0, 0, 0]] }, null, { points: [[0, 0, 0], [1, 0, 0]] }]);
  assert.equal(one.segmentCount, 1);
  assert.deepEqual(one.polylineOfSegment, [2], '单点折线贡献 0 段，段下标 0 属于折线 2');
  assert.equal(T.buildSketchSegmentPositions([{ points: [[0, 0, 0]] }]).length, 0);
});

check('段拾取（射线 → 折线）：命中段的折线下标由映射表反查，不靠猜', () => {
  const index = T.buildSketchSegmentIndex(POLYLINES);
  const positions = T.buildSketchSegmentPositions(POLYLINES);
  const ends = T.sketchPolylineEndpoints(POLYLINES[5]);
  // 从折线 5 的中点正上方打一条射线下来（世界 z 是「上」的话不一定；用射线-段距离的通用构造：
  // 起点 = 段中点 + 法向偏移，方向指向段中点）
  const mid = [(ends.start[0] + ends.end[0]) / 2, (ends.start[1] + ends.end[1]) / 2, (ends.start[2] + ends.end[2]) / 2];
  // 找一个跟该段不平行的方向：用段的法向（叉乘一个任意轴，退化就换轴）
  const dx = ends.end[0] - ends.start[0], dy = ends.end[1] - ends.start[1], dz = ends.end[2] - ends.start[2];
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  const dirs = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  let dir = null;
  for (const cand of dirs) {
    const cross = [dy * cand[2] - dz * cand[1], dz * cand[0] - dx * cand[2], dx * cand[1] - dy * cand[0]];
    const cl = Math.sqrt(cross[0] ** 2 + cross[1] ** 2 + cross[2] ** 2);
    if (cl > len * 1e-6) { dir = [cross[0] / cl, cross[1] / cl, cross[2] / cl]; break; }
  }
  const origin = [mid[0] + dir[0] * 5, mid[1] + dir[1] * 5, mid[2] + dir[2] * 5];
  const direction = [-dir[0], -dir[1], -dir[2]];
  const hit = T.pickSketchSegmentInPositions(positions, index, origin, direction, 0.05);
  assert.ok(hit, '射线必须命中折线 5 的某一段');
  assert.equal(hit.polylineIndex, 5, '命中的折线下标必须是 5（实际 ' + hit.polylineIndex + '）');
  assert.equal(index.polylineOfSegment[hit.segmentIndex], 5, '段下标与映射表一致');
  assert.ok(hit.distance <= 0.05, 'distance 在阈值内：' + hit.distance);
  // 阈值 0 = 什么都不命中（不会因为阈值退化而全选）
  assert.equal(T.pickSketchSegmentInPositions(positions, index, origin, direction, 0), null);
});

/* ------------------------------------------------------------------ */
/* 1b. 与真 THREE 的 LineSegments 射线结果对齐（不是纯数学自证）          */
/* ------------------------------------------------------------------ */

check('真 THREE LineSegments 的 intersection.index 经映射表反查 = 我的段拾取结果', () => {
  const THREE = T.loadTHREE();
  const index = T.buildSketchSegmentIndex(POLYLINES);
  const positions = T.buildSketchSegmentPositions(POLYLINES);

  // 完全按 buildSketchEntry 的方式建一条合并的 LineSegments
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({ depthTest: false });
  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;

  // 相机放在模型外，朝折线 5（一条 2 点直边）的中点看
  const ends = T.sketchPolylineEndpoints(POLYLINES[5]);
  const mid = [(ends.start[0] + ends.end[0]) / 2, (ends.start[1] + ends.end[1]) / 2, (ends.start[2] + ends.end[2]) / 2];
  const diagonal = Math.hypot(
    Math.max(...POLYLINES.flatMap((p) => p.points.map((q) => q[0]))) - Math.min(...POLYLINES.flatMap((p) => p.points.map((q) => q[0]))),
    Math.max(...POLYLINES.flatMap((p) => p.points.map((q) => q[1]))) - Math.min(...POLYLINES.flatMap((p) => p.points.map((q) => q[1]))),
    Math.max(...POLYLINES.flatMap((p) => p.points.map((q) => q[2]))) - Math.min(...POLYLINES.flatMap((p) => p.points.map((q) => q[2])))
  );
  const camera = new THREE.PerspectiveCamera(45, 1, diagonal * 0.001, diagonal * 60);
  // 让相机沿「段中点 + N 倍对角线」的斜方向看回去，保证射线穿过该段
  camera.position.set(mid[0] + diagonal, mid[1] + diagonal, mid[2] + diagonal);
  camera.lookAt(new THREE.Vector3(mid[0], mid[1], mid[2]));
  camera.updateMatrixWorld();

  const raycaster = new THREE.Raycaster();
  raycaster.params.Line = raycaster.params.Line || {};
  raycaster.params.Line.threshold = diagonal * T.SKETCH_PICK_RATIO;
  // 屏幕上指向段中点的那根射线
  const projected = new THREE.Vector3(mid[0], mid[1], mid[2]).project(camera);
  raycaster.setFromCamera(new THREE.Vector2(projected.x, projected.y), camera);

  const hits = raycaster.intersectObject(lines, false);
  assert.ok(hits.length > 0, '真 THREE 必须命中（阈值 = 对角线 × SKETCH_PICK_RATIO）');
  assert.equal(typeof hits[0].index, 'number', 'LineSegments 的命中必须带顶点下标');
  const segmentFromThree = hits[0].index / 2;
  assert.equal(Number.isInteger(segmentFromThree), true, '顶点下标必须是偶数（第 s 段 = 2s、2s+1）');
  assert.equal(index.polylineOfSegment[segmentFromThree], 5,
    '真 THREE 的 intersection.index 经映射表必须反查出折线 5（实际 ' +
    index.polylineOfSegment[segmentFromThree] + '）');

  // 我的纯数学段拾取在同一根射线上给出同一个折线
  const origin = [raycaster.ray.origin.x, raycaster.ray.origin.y, raycaster.ray.origin.z];
  const direction = [raycaster.ray.direction.x, raycaster.ray.direction.y, raycaster.ray.direction.z];
  const mine = T.pickSketchSegmentInPositions(positions, index, origin, direction, diagonal * T.SKETCH_PICK_RATIO);
  assert.ok(mine, '我的段拾取也必须命中');
  assert.equal(mine.polylineIndex, 5, '两条路径必须得出同一条折线');
  assert.equal(mine.segmentIndex, segmentFromThree, '两条路径命中的段下标应一致（' +
    mine.segmentIndex + ' vs ' + segmentFromThree + '）');

  geometry.dispose();
  material.dispose();
});

/* ------------------------------------------------------------------ */
/* 2. 端点 > 折线 的优先级                                             */
/* ------------------------------------------------------------------ */

check('拾取优先级：同一根射线同时靠近端点和折线时，返回的是「点」', () => {
  const index = T.buildSketchSegmentIndex(POLYLINES);
  const positions = T.buildSketchSegmentPositions(POLYLINES);
  // 挑一个**不与前面的折线共点**的端点（真实轮廓里相邻边会共享端点；共点时最近点可能落在
  // 前一条折线上，那是正确行为，不适合拿来断言「第几条折线」）。
  const samePoint = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-6;
  let target = null;
  for (let p = 0; p < POLYLINES.length && !target; p += 1) {
    for (let k = 0; k < POLYLINES[p].points.length && !target; k += 1) {
      const cand = POLYLINES[p].points[k];
      let unique = true;
      for (let q = 0; q < p && unique; q += 1) {
        for (const other of POLYLINES[q].points) if (samePoint(cand, other)) { unique = false; break; }
      }
      if (unique) target = { polylineIndex: p, pointIndex: k, point: cand.slice() };
    }
  }
  assert.ok(target, '真实轮廓里必须存在一个独占端点（否则测试前提不成立）');
  const p0 = target.point;
  // 找一个与「该端点所在段」垂直的方向，从近处朝端点打射线
  const owner = POLYLINES[target.polylineIndex];
  const neighbour = owner.points[(target.pointIndex + 1) % owner.points.length];
  const dx = neighbour[0] - p0[0], dy = neighbour[1] - p0[1], dz = neighbour[2] - p0[2];
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  let normal = null;
  for (const cand of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
    const cross = [dy * cand[2] - dz * cand[1], dz * cand[0] - dx * cand[2], dx * cand[1] - dy * cand[0]];
    const cl = Math.sqrt(cross[0] ** 2 + cross[1] ** 2 + cross[2] ** 2);
    if (cl > len * 1e-6) { normal = [cross[0] / cl, cross[1] / cl, cross[2] / cl]; break; }
  }
  const gap = 0.002;                       // 离端点 0.002 mm：画在屏幕上是同一个像素
  const origin = [p0[0] + normal[0] * gap, p0[1] + normal[1] * gap, p0[2] + normal[2] * gap];
  const direction = [-normal[0], -normal[1], -normal[2]];
  const pointHit = T.pickSketchPointInPolylines(POLYLINES, origin, direction, 0.05);
  const lineHit = T.pickSketchSegmentInPositions(positions, index, origin, direction, 0.05);
  assert.ok(pointHit, '端点必须被命中（同一个射线）');
  assert.ok(lineHit, '折线也必须被命中（同一个射线）——否则这条测试没意义');
  assert.equal(pointHit.polylineIndex, target.polylineIndex, '命中的折线下标');
  assert.equal(pointHit.pointIndex, target.pointIndex, '命中的点下标');
  // 优先级函数：两者都在时返回 sketchPoint
  assert.equal(T.pickSubjectByPriority({ sketchPoint: pointHit, sketchLine: lineHit, sketch: {} }), 'sketchPoint');
  assert.equal(T.pickSubjectByPriority({ sketchLine: lineHit, sketch: {} }), 'sketchLine');
  assert.equal(T.pickSubjectByPriority({ sketch: {} }), 'sketch');
  // 实体仍然压住草图：面/边/顶点命中时草图候选一律不算
  assert.equal(T.pickSubjectByPriority({ face: {}, sketchPoint: pointHit, sketchLine: lineHit }), 'face');
  assert.equal(T.pickSubjectByPriority({ edge: {}, sketchPoint: pointHit }), 'edge');
  assert.equal(T.pickSubjectByPriority({ vertex: {}, face: {}, sketchPoint: pointHit }), 'vertex');
});

check('端点容差比折线容差宽（0.018 vs 0.012），且各自的拾取半径按预期生效', () => {
  // 只断言「关系」而不断言常量等于它自己的定义（那种断言恒真，改 client.js 里的实现也不会红）
  assert.ok(T.SKETCH_POINT_PICK_RATIO > T.SKETCH_PICK_RATIO, '端点容差必须比折线宽，否则「点 > 线」永远轮不到');
  assert.ok(Math.abs(T.SKETCH_POINT_PICK_RATIO / T.SKETCH_PICK_RATIO - 1.5) < 1e-9,
    '端点容差是折线的 1.5 倍（浮点：' + (T.SKETCH_POINT_PICK_RATIO / T.SKETCH_PICK_RATIO) + '）');
  // 用一个**独占**端点（不与其它折线共点），否则邻线的重合点会以 distance 0 抢走命中
  const samePoint = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-6;
  let unique = null;
  for (let p = 0; p < POLYLINES.length && !unique; p += 1) {
    for (let k = 0; k < POLYLINES[p].points.length && !unique; k += 1) {
      const cand = POLYLINES[p].points[k];
      let isolated = true;
      for (let q = 0; q < POLYLINES.length && isolated; q += 1) {
        if (q === p) continue;
        for (const other of POLYLINES[q].points) if (samePoint(cand, other)) { isolated = false; break; }
      }
      if (isolated) unique = { polylineIndex: p, pointIndex: k, point: cand.slice() };
    }
  }
  assert.ok(unique, '真实轮廓里必须存在一个独占端点');
  const p0 = unique.point;
  const owner = POLYLINES[unique.polylineIndex];
  // 沿「该点所在段」的方向打射线，并把射线整体侧向平移 0.004mm：
  // 此时 p0 到射线的垂距恰为 0.004（p0 在射线起点「背后」，t 夹到 0 → 距离 = |p0-origin|）。
  const neighbour = owner.points[Math.min(unique.pointIndex + 1, owner.points.length - 1)];
  const dx = neighbour[0] - p0[0], dy = neighbour[1] - p0[1], dz = neighbour[2] - p0[2];
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  const direction = [dx / len, dy / len, dz / len];
  let normal = null;
  for (const cand of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
    const cross = [
      direction[1] * cand[2] - direction[2] * cand[1],
      direction[2] * cand[0] - direction[0] * cand[2],
      direction[0] * cand[1] - direction[1] * cand[0],
    ];
    const cl = Math.sqrt(cross[0] ** 2 + cross[1] ** 2 + cross[2] ** 2);
    if (cl > 1e-6) { normal = [cross[0] / cl, cross[1] / cl, cross[2] / cl]; break; }
  }
  assert.ok(normal, '必须能构造出与该段垂直的方向');
  const offset = 0.004;
  const origin = [p0[0] + normal[0] * offset, p0[1] + normal[1] * offset, p0[2] + normal[2] * offset];
  const hit = T.pickSketchPointInPolylines(POLYLINES, origin, direction, 0.005);
  assert.ok(hit, '0.005 阈值内命中端点（垂距 0.004）');
  assert.equal(hit.pointIndex, unique.pointIndex);
  assert.ok(Math.abs(hit.distance - offset) < 1e-9, '垂距应恰为 0.004，实际 ' + hit.distance);
  assert.equal(T.pickSketchPointInPolylines(POLYLINES, origin, direction, 0.001), null, '阈值收紧到 0.001 后不命中');
});

/* ------------------------------------------------------------------ */
/* 3 / 4 / 6. Ctrl 多选状态机                                          */
/* ------------------------------------------------------------------ */

const KEY_A = T.sketchLineKey(0, 0);          // 'sk:0:0'
const KEY_B = T.sketchLineKey(0, 1);          // 'sk:0:1'
const KEY_C = T.sketchLineKey(0, 2);          // 'sk:0:2'
const PICK_A = { subject: 'sketchLine', sketchIndex: 0, polylineIndex: 0 };
const PICK_B = { subject: 'sketchLine', sketchIndex: 0, polylineIndex: 1 };
const PICK_C = { subject: 'sketchLine', sketchIndex: 0, polylineIndex: 2 };

check('键设计：线键 / 点键 / 反解（点键带 :pt:，线键不带）', () => {
  assert.equal(KEY_A, 'sk:0:0');
  assert.equal(T.sketchPointKey(0, 3, 7), 'sk:0:3:pt:7');
  assert.deepEqual(T.parseSketchSelectionKey('sk:0:3:pt:7'), { sketchIndex: 0, polylineIndex: 3, pointIndex: 7 });
  assert.deepEqual(T.parseSketchSelectionKey('sk:2:9'), { sketchIndex: 2, polylineIndex: 9, pointIndex: -1 });
  assert.equal(T.parseSketchSelectionKey('sk:x'), null);
  assert.equal(T.parseSketchSelectionKey(null), null);
  // 键里带草图下标：不同草图的同号折线不会串味
  assert.notEqual(T.sketchLineKey(0, 0), T.sketchLineKey(1, 0));
});

check('Ctrl toggle：选 A → Ctrl 点 B → {A,B} → Ctrl 点 A → {B}', () => {
  let state = { lines: new Set(), points: new Set() };
  state = T.updateSketchSelection(state, PICK_A, false);        // 不按 Ctrl 点 A
  assert.deepEqual(Array.from(state.lines), [KEY_A]);
  state = T.updateSketchSelection(state, PICK_B, true);         // Ctrl 点 B
  assert.deepEqual(Array.from(state.lines), [KEY_A, KEY_B]);
  state = T.updateSketchSelection(state, PICK_A, true);         // Ctrl 点已选的 A → 取消
  assert.deepEqual(Array.from(state.lines), [KEY_B]);
  // 再 Ctrl 点一次 A：重新加回，且顺序是「先 B 后 A」
  state = T.updateSketchSelection(state, PICK_A, true);
  assert.deepEqual(Array.from(state.lines), [KEY_B, KEY_A]);
});

check('不按 Ctrl 点 C → 集合只剩 {C}（替换而非累积）', () => {
  let state = T.updateSketchSelection({ lines: new Set(), points: new Set() }, PICK_A, false);
  state = T.updateSketchSelection(state, PICK_B, true);
  state = T.updateSketchSelection(state, PICK_C, false);
  assert.deepEqual(Array.from(state.lines), [KEY_C]);
  assert.equal(state.points.size, 0);
});

check('跨类型多选：线 + 点同时存在；Ctrl 点空白不清空、不按 Ctrl 点空白清空', () => {
  let state = T.updateSketchSelection({ lines: new Set(), points: new Set() }, PICK_A, false);
  state = T.updateSketchSelection(state, { subject: 'sketchPoint', sketchIndex: 0, polylineIndex: 3, pointIndex: 5 }, true);
  assert.deepEqual(Array.from(state.lines), [KEY_A]);
  assert.deepEqual(Array.from(state.points), ['sk:0:3:pt:5']);
  assert.deepEqual(T.sketchSelectionCounts(state), { lines: 1, points: 1 });
  // Ctrl + 空白：保持不动
  const keep = T.updateSketchSelection(state, null, true);
  assert.deepEqual(Array.from(keep.lines), [KEY_A]);
  assert.deepEqual(Array.from(keep.points), ['sk:0:3:pt:5']);
  // 不按 Ctrl 点空白：全清
  const wiped = T.updateSketchSelection(state, null, false);
  assert.equal(wiped.lines.size, 0);
  assert.equal(wiped.points.size, 0);
  // 输入 state 不被就地修改（纯函数）
  assert.equal(state.lines.size, 1, '输入集合不能被就地改掉');
});

check('Esc 清空：清空后集合为空（updateSketchSelection(…, null, false) = Esc 走的同一条路）', () => {
  let state = T.updateSketchSelection({ lines: new Set(), points: new Set() }, PICK_A, false);
  state = T.updateSketchSelection(state, PICK_B, true);
  state = T.updateSketchSelection(state, { subject: 'sketchPoint', sketchIndex: 0, polylineIndex: 1, pointIndex: 0 }, true);
  assert.equal(T.sketchSelectionCounts(state).lines, 2);
  const cleared = T.updateSketchSelection(state, null, false);
  assert.deepEqual(T.sketchSelectionCounts(cleared), { lines: 0, points: 0 });
  // 清空后的汇总文本：拿清空后**真实**的集合去算（不是恒真的空数组常量）
  assert.equal(cleared.lines.size, 0);
  assert.equal(cleared.points.size, 0);
  assert.equal(T.sketchSelectionSummaryText(Array.from(cleared.lines), Array.from(cleared.points)),
    '未选中草图折线/点', '清空后汇总文本必须回到「未选中」');
});

/* ------------------------------------------------------------------ */
/* 5. 多选汇总文本：逐字符                                             */
/* ------------------------------------------------------------------ */

check('多选汇总文本：逐字符（N 条线、M 个点、合计长度固定一位小数）', () => {
  // 用真实折线的长度（折线 2/3/5 是 2 点直边，折线 0 是 17 点的圆弧）
  const lengthOf = (i) => T.sketchPolylineLengthMm(POLYLINES[i]);
  const l0 = lengthOf(0);
  const l2 = lengthOf(2);
  const l3 = lengthOf(3);
  assert.ok(l0 > 0 && l2 > 0 && l3 > 0);

  // 0 条线 0 个点
  assert.equal(T.sketchSelectionSummaryText([], []), '未选中草图折线/点');
  // 1 条线
  assert.equal(T.sketchSelectionSummaryText([{ lengthMm: 12 }], []), '已选 1 条线、0 个点（合计 12.0 mm）');
  // 2 条线（合计按一位小数）
  assert.equal(T.sketchSelectionSummaryText([{ lengthMm: 12 }, { lengthMm: 46.6 }], []),
    '已选 2 条线、0 个点（合计 58.6 mm）');
  // 线 + 点（点不贡献长度）
  assert.equal(T.sketchSelectionSummaryText([{ lengthMm: 12 }], [{}, {}]),
    '已选 1 条线、2 个点（合计 12.0 mm）');
  // 只有点
  assert.equal(T.sketchSelectionSummaryText([], [{}]), '已选 0 条线、1 个点（合计 0.0 mm）');
  // 真实长度也按一位小数
  const realTotal = l0 + l2 + l3;
  assert.equal(T.sketchSelectionSummaryText(
    [{ lengthMm: l0 }, { lengthMm: l2 }, { lengthMm: l3 }], []),
    '已选 3 条线、0 个点（合计 ' + realTotal.toFixed(1) + ' mm）');

  // 卡片文本：第 1 行汇总，随后每条线一行、每个点一行
  const lines = [
    { polylineIndex: 2, kind: 'line', lengthMm: 12, closed: false },
    { polylineIndex: 8, kind: 'circle', lengthMm: 31.416, closed: true },
  ];
  const points = [{ polylineIndex: 2, pointIndex: 1, position: [1.5, 0, 2.25] }];
  assert.equal(T.buildSketchSelectionText(lines, points), [
    '已选 2 条线、1 个点（合计 43.4 mm）',
    '线 #2（直线，长 12.0 mm）',
    '线 #8（圆，长 31.4 mm，闭合）',
    '点 折线#2 点#1 @ [1.50,0.00,2.25]',
  ].join('\n'));
  assert.equal(T.buildSketchSelectionText([], []), '未选中草图折线/点');
});

check('折线长度 / 端点 / 锚点：按点序列累加（mm），闭合补末→首段', () => {
  // 3-4-5 直角三角形：3mm + 4mm + 5mm = 12mm（三点，不重复首点）
  const right = { points: [[0, 0, 0], [3, 0, 0], [3, 4, 0]], closed: false, kind: 'line' };
  assert.equal(T.sketchPolylineLengthMm(right), 7, '开放三点：3 + 4 = 7');
  // 闭合：补「末点 → 首点」那一段 = 5mm，于是 7 + 5 = 12
  assert.equal(T.sketchPolylineLengthMm(Object.assign({}, right, { closed: true })), 12);
  // 显式重复首点的闭合写法不会重复计长度（重复段长度 0）
  const looped = { points: [[0, 0, 0], [3, 0, 0], [3, 4, 0], [0, 0, 0]], closed: true, kind: 'line' };
  assert.equal(T.sketchPolylineLengthMm(looped), 12);
  // 正方形 4 点闭合 = 4 段 × 10 = 40
  const square = { points: [[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]], closed: true, kind: 'line' };
  assert.equal(T.sketchPolylineLengthMm(square), 40);
  assert.equal(T.sketchPolylineLengthMm({ points: [[0, 0, 0]], closed: true }), 0);
  assert.equal(T.sketchPolylineLengthMm(null), 0);
  // 端点：闭合折线的 end 回到 start
  assert.deepEqual(T.sketchPolylineEndpoints(square), { start: [0, 0, 0], end: [0, 0, 0] });
  assert.deepEqual(T.sketchPolylineEndpoints({ points: [[1, 2, 3], [4, 5, 6]], closed: false }),
    { start: [1, 2, 3], end: [4, 5, 6] });
  assert.deepEqual(T.sketchPolylineEndpoints({ points: [] }), { start: null, end: null });
  // 锚点取中间那个点
  assert.deepEqual(T.sketchPolylineAnchor({ points: [[0, 0, 0], [1, 0, 0], [2, 0, 0]] }), [1, 0, 0]);
  assert.equal(T.sketchPolylineAnchor({ points: [] }), null);
  // 真实闭合圆：长度 = 弦长和，略小于真实周长 2πr（多边形逼近的必然结果）
  const circle = POLYLINES[8];
  const radiusFromBbox = (() => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of circle.points) {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
    }
    return Math.max(maxX - minX, maxY - minY) / 2;
  })();
  const chordTotal = T.sketchPolylineLengthMm(circle);
  const circumference = 2 * Math.PI * radiusFromBbox;
  assert.ok(chordTotal > 0, '闭合圆长度必须为正');
  assert.ok(chordTotal < circumference, '弦长和必须小于真实周长：' + chordTotal + ' < ' + circumference);
  assert.ok(chordTotal > circumference * 0.97, '48 边形逼近误差应小于 3%：' + (chordTotal / circumference));
});

/* ------------------------------------------------------------------ */
/* 7. 右键菜单 + 「把所选填进对话框」指令                                */
/* ------------------------------------------------------------------ */

check('右键菜单：草图折线/端点各 4 项（含「编辑这条草图」/「全选本草图」/「把所选填进对话框」）', () => {
  const line = T.contextMenuItemsFor({ subject: 'sketchLine', sketchIndex: 0, polylineIndex: 3 });
  assert.deepEqual(line.map((i) => i.id), ['mark', 'select-all', 'edit-sketch', 'sketch-fill']);
  assert.deepEqual(line.map((i) => i.label), ['标记此处', '全选本草图', '编辑这条草图', '把所选填进对话框']);
  assert.deepEqual(line.map((i) => i.behavior), ['mark', 'action', 'draft', 'draft']);
  const point = T.contextMenuItemsFor({ subject: 'sketchPoint', sketchIndex: 0, polylineIndex: 3, pointIndex: 1 });
  assert.deepEqual(point.map((i) => i.id), ['mark', 'select-all', 'edit-sketch', 'sketch-fill']);
  assert.deepEqual(point.map((i) => i.label), ['标记此处', '全选本草图', '编辑这条草图', '把所选填进对话框']);
  const whole = T.contextMenuItemsFor({ subject: 'sketch', sketchIndex: 0 });
  assert.deepEqual(whole.map((i) => i.id), ['select-all', 'edit-sketch']);
  // subject 归并：sketchLine / sketchPoint / sketch 各自成菜单，不再被吞进 'none'
  assert.equal(T.contextMenuSubjectOf({ subject: 'sketchLine' }), 'sketchLine');
  assert.equal(T.contextMenuSubjectOf({ subject: 'sketchPoint' }), 'sketchPoint');
  assert.equal(T.contextMenuSubjectOf({ subject: 'sketch' }), 'sketch');
  // 旧行为逐字节不变：不管草图时面对/边对/点对/空白对还是原来的 2–3 项
  assert.deepEqual(T.contextMenuItemsFor({ subject: 'face', faceIndex: 1 }).map((i) => i.id), ['mark', 'new-sketch', 'edit-sketch']);
  assert.deepEqual(T.contextMenuItemsFor(null).map((i) => i.id), ['fit', 'reset-view', 'copy-shot']);
  // 多选非空 → 空白菜单也补一项「把所选填进对话框」（已有就不重复加）
  const withSel = T.contextMenuItemsFor(null, { selectedLines: 2, selectedPoints: 1 });
  assert.deepEqual(withSel.map((i) => i.id), ['fit', 'reset-view', 'copy-shot', 'sketch-fill']);
  const noDup = T.contextMenuItemsFor({ subject: 'sketchLine' }, { selectedLines: 2, selectedPoints: 0 });
  assert.deepEqual(noDup.map((i) => i.id), ['mark', 'select-all', 'edit-sketch', 'sketch-fill']);
});

check('「把所选填进对话框」指令：逐字符（含序号/类型/长度/端点/坐标/合计）', () => {
  const sketch = {
    id: 'fracture_profile', name: 'fracture_profile', feature: '凸台-拉伸1', plane: '基准面-上视',
  };
  const text = T.buildSketchSelectionInstruction({
    file: 'D:\\work\\fracture-section-01.SLDPRT',
    designId: 'fracture-section-01',
    sketch: sketch,
    lines: [
      { polylineIndex: 2, kind: 'line', lengthMm: 12, start: [0, 0, 0], end: [12, 0, 0] },
      { polylineIndex: 8, kind: 'circle', lengthMm: 31.416, start: [5, 0, 5], end: [5, 0, 5] },
    ],
    points: [{ polylineIndex: 2, pointIndex: 1, position: [12, 0, 0] }],
    note: '把这两条改成 15 mm',
  });
  // 契约变更（旧格式 → ①–⑤ 分段格式）后仍然**整篇逐字符**断言：
  // 段落标题、编号 [1]…[3]、每条的序号/类型/长度/起终点、合计 mm、设计ID 一个都不放过。
  assert.equal(text, [
    '[3D标注] 用户在这个 3D 视图里选中了以下草图几何，请你按用户的意图修改模型。',
    '（这是用户交给你的修改任务，不是状态汇报。下面按 ① → ⑤ 读。）',
    '文件：D:\\work\\fracture-section-01.SLDPRT 设计ID：fracture-section-01',
    '',
    '【① 任务】',
    '修改【② 必须修改的对象】里点名的 2 条折线、1 个端点（合计 43.4 mm），具体改法看【④ 修改意图】。',
    '只改这两段点名的对象；其它几何、尺寸、特征一律不要动。',
    '',
    '【② 必须修改的对象】用户在视图里点选的，就是这些（编号 [1]…[3] 与截图上的数字标记一一对应）：',
    '选中：草图 fracture_profile（属于特征「凸台-拉伸1」，绘制在 基准面-上视） 的 2 条折线、1 个端点（合计 43.4 mm）',
    '  [1] 折线 #2 直线',
    '  [2] 折线 #8 圆',
    '  [3] 端点 折线#2 点#1',
    '',
    '【③ 坐标与长度 · 参考数据，不是目标值】',
    '这些数字只用来在模型里**定位**【②】里已有的那些几何。',
    '不要按这些坐标重新画一遍几何，也不要把它们当成「要改成的目标值」——用户要改的是形状/位置关系，不是把这些数字再抄一遍。',
    '  [1] 折线 #2 直线 长 12.0 mm 起点 [0.00,0.00,0.00] 终点 [12.00,0.00,0.00]',
    '  [2] 折线 #8 圆 长 31.4 mm 起点 [5.00,0.00,5.00] 终点 [5.00,0.00,5.00]',
    '  [3] 端点 折线#2 点#1 @ [12.00,0.00,0.00]',
    '',
    '【④ 修改意图】用户自己的补充（可能为空；「修改意见」之后就是用户写的原话）：',
    '修改意见：把这两条改成 15 mm',
    '',
    '【⑤ 动手前先复述】',
    '先确认你定位到的就是【②】里这 2 条折线、1 个端点（合计 43.4 mm）（草图名、折线号、起点/终点坐标都对得上），',
    '再给出修改方案并执行；对不上就先说明你实际找到的是哪些，不要凭坐标猜着改。',
  ].join('\n'));
  // 五个段落标题必须都在，且**按 ①→⑤ 的顺序**出现（顺序错了模型会读乱）。
  // 用「行首」匹配而不是 indexOf：②③④⑤ 这些标题在 ① 段的正文里也被引用过。
  const heads = ['【① 任务】', '【② 必须修改的对象】', '【③ 坐标与长度 · 参考数据，不是目标值】',
    '【④ 修改意图】', '【⑤ 动手前先复述】'];
  const headingRows = text.split('\n')
    .map((row, i) => ({ row, i }))
    .filter((item) => heads.some((head) => item.row.indexOf(head) === 0));
  assert.equal(headingRows.length, 5, '必须正好 5 个段落标题行：' + JSON.stringify(headingRows));
  assert.deepEqual(headingRows.map((item) => item.row.match(/^【[①②③④⑤]/)[0]),
    ['【①', '【②', '【③', '【④', '【⑤'],
    '段落必须按 ①→⑤ 顺序：' + JSON.stringify(headingRows.map((item) => item.row)));
  assert.deepEqual(headingRows.map((item) => item.i), [4, 8, 14, 21, 24],
    '段落标题的固定行号（2 线 + 1 点 = 3 个对象时）：' + JSON.stringify(headingRows.map((item) => item.i)));
  // 编号 [1]…[3] 必须连续出现（截图标记与正文共用同一顺序）
  for (const n of ['[1]', '[2]', '[3]']) assert.equal(text.split(n).length - 1 >= 2, true, n + ' 必须出现 ≥2 次（②段标题 + ③段数据）');
  assert.equal(text.includes('[4]'), false, '只有 3 个对象，不许出现 [4]');
  // 「坐标是参考数据、不要按它重画」这条**约束句**必须逐字符在（这是整段文案的核心禁令）
  assert.equal(text.includes('不要按这些坐标重新画一遍几何'), true, '坐标段必须带「不要按这些坐标重新画」的禁令：' + text);
  assert.equal(text.includes('参考数据，不是目标值'), true, '③ 段标题必须明说「参考数据，不是目标值」');
  // 缺省：文件/设计ID/修改意见都有可读兜底，绝不出现 undefined
  const bare = T.buildSketchSelectionInstruction({ sketch: { name: 'S1' }, lines: [], points: [] });
  assert.equal(bare.includes('undefined'), false, bare);
  assert.equal(bare.split('\n')[2], '文件：当前模型 设计ID：(未知)');
  assert.equal(bare.includes('选中：草图 S1（绘制在 未知基准面） 的 0 条折线、0 个端点（合计 0.0 mm）'), true,
    '没有 opts.sketch 的 feature 时只能写「绘制在」一句：' + bare);
  assert.equal(bare.includes('  （用户在视图里还没有点选任何折线/端点）'), true, '空选择要有明确占位：' + bare);
  assert.equal(bare.includes('  （无：这次没有点选任何几何）'), true, '③ 段空选择要有占位：' + bare);
  assert.equal(bare.includes('修改意见：（用户还没写具体改法：先按【⑤】复述你定位到的对象，再问清楚要改成什么样）'), true,
    '修改意见为空时给的占位必须对模型有意义：' + bare);
  // 草图种类中文名（未知种类原样返回）
  assert.equal(T.sketchKindLabel('arc'), '圆弧');
  assert.equal(T.sketchKindLabel('circle'), '圆');
  assert.equal(T.sketchKindLabel(undefined), '直线');
  assert.equal(T.sketchKindLabel('spline'), '样条');
  assert.equal(T.sketchKindLabel('weird'), 'weird');
});

check('草图视图：拾取没有被整体禁用，禁用清单只针对「实体」面/边/点', () => {
  const ids = T.SKETCH_ONLY_DISABLED.map((item) => item.id);
  assert.ok(ids.includes('pick'), 'id 保持稳定（UI/测试按 id 取）');
  const pickItem = T.SKETCH_ONLY_DISABLED.find((item) => item.id === 'pick');
  assert.match(pickItem.label, /实体/, '措辞必须说清是「实体的」面/边/点，而不是拾取整体：' + pickItem.label);
  assert.match(pickItem.reason, /草图折线/, '原因里要说明草图折线/端点仍然可点：' + pickItem.reason);
  assert.doesNotMatch(pickItem.label, /^面\/边\/点拾取$/, '旧的「拾取整体不可用」措辞必须消失');
  // 剖切/取样/封盖/标记这些依赖实体的能力仍然保持禁用（没有顺手放开）
  for (const id of ['section', 'sample', 'wireframe', 'edges', 'precision', 'marker']) {
    assert.ok(ids.includes(id), '仍应禁用：' + id);
  }
});

/* ------------------------------------------------------------------ */
/* 8. 端到端：真 createViewer + 真事件处理器（指针 / Ctrl / Esc / 菜单）   */
/*    WebGL 渲染器用假实现替掉（离线环境没有 GL 上下文），其余全是真代码：  */
/*    真 THREE 的射线、真 plane、真事件委托、真多选状态机。                */
/* ------------------------------------------------------------------ */

// requestAnimationFrame / cancelAnimationFrame：viewer 用它排帧
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

function makeElement() {
  const listeners = {};
  const el = {
    style: {}, className: '', textContent: '', title: '', type: '',
    children: [],
    setAttribute(name, value) { this[name] = value; },
    getAttribute(name) { return this[name]; },
    appendChild(child) { this.children.push(child); if (child) child.parentNode = this; return child; },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); return child; },
    insertBefore(child) { return this.appendChild(child); },
    contains() { return false; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn); },
    dispatch(type, event) { for (const fn of (listeners[type] || [])) fn(event); },
    setPointerCapture() {}, releasePointerCapture() {},
    getContext() { return null; },
    clientWidth: 800, clientHeight: 600, offsetWidth: 240, offsetHeight: 200,
    isConnected: true,
    __listeners: listeners,
  };
  return el;
}

const headlessDoc = {
  createElement() { return makeElement(); },
  createElementNS() { return makeElement(); },
  createTextNode(text) { return { textContent: String(text), style: {}, children: [] }; },
  addEventListener() {}, removeEventListener() {},
  defaultView: fakeWindow,
  body: makeElement(),
};

class HeadlessRenderer {
  constructor() {
    this.domElement = makeElement();
    this.domElement.ownerDocument = headlessDoc;
    this.info = { render: { calls: 0, triangles: 0, lines: 0 }, programs: [] };
    this.localClippingEnabled = false;
    this.capabilities = { isWebGL2: true };
  }
  setPixelRatio() {} setSize() {} setClearColor() {} render() {}
  dispose() {} forceContextLoss() {}
}

const THREE = T.loadTHREE();
THREE.WebGLRenderer = HeadlessRenderer;

// 一条「L 形」草图：折线 0 = (0,0)→(10,0)，折线 1 = (10,0)→(10,10)
const E2E_POLYLINES = [
  { points: [[0, 0, 0], [10, 0, 0]], closed: false, kind: 'line' },
  { points: [[10, 0, 0], [10, 10, 0]], closed: false, kind: 'line' },
];
const E2E_PAYLOAD = {
  ok: true, unit: 'mm', designId: 'e2e-01',
  sketches: [{ id: 'e2e', name: 'E2E', polylines: E2E_POLYLINES, bbox: [0, 0, 0, 10, 10, 0] }],
};

/** 建一个真 viewer（草图视图模型），返回 {viewer, container, selections}。 */
function makeE2EViewer() {
  const container = makeElement();
  container.ownerDocument = headlessDoc;
  container.parentNode = makeElement();
  const model = T.buildSketchOnlyModel(E2E_PAYLOAD, { path: 'C:\\x\\e2e.SLDPRT', minSize: 20 });
  model.sketch = E2E_PAYLOAD;
  const selections = [];
  const viewer = T.createViewer(container, model, {
    onSelect(sel) { selections.push(sel); },
  });
  viewer.setSketches(E2E_PAYLOAD);
  viewer.fit();
  return { viewer, container, selections };
}

/** 把模型坐标投到 client 坐标（用 viewer 自己的 project）。 */
function screenOf(container, viewer, point) {
  const p = viewer.project(point);
  const rect = container.getBoundingClientRect();
  return { clientX: rect.left + p.x, clientY: rect.top + p.y };
}

/** 事件监听挂在画布上（createViewer 把 dom 追加进 container），不是挂在 container 上。 */
function canvasOf(container) {
  const canvas = (container.children || []).find((c) => c && c.__listeners);
  assert.ok(canvas, '画布必须已经被挂进 container');
  return canvas;
}

/** 模拟一次「左键单击」：pointerdown → pointerup（不移动 → 不算拖拽）。 */
function clickAt(container, screen, modifiers = {}) {
  const dom = canvasOf(container);
  const base = {
    button: 0, pointerId: 1, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
    clientX: screen.clientX, clientY: screen.clientY,
    preventDefault() {}, stopPropagation() {},
  };
  const down = Object.assign({}, base, modifiers);
  dom.dispatch('pointerdown', down);
  dom.dispatch('pointerup', Object.assign({}, down, { button: 0 }));
}

check('端到端：草图视图下单击折线可以选中（不再「点不到任何东西」）', () => {
  const { viewer, container } = makeE2EViewer();
  const state = viewer.getSketchState();
  assert.equal(state.count, 1, '草图已加载');
  assert.equal(state.polylineCounts[0], 2, '一条草图 2 条折线');
  assert.equal(state.segmentCounts[0], 2, '2 段');

  // 点折线 0 的中点
  const screen = screenOf(container, viewer, [5, 0, 0]);
  const picked = viewer.pick(screen.clientX, screen.clientY);
  assert.ok(picked, '光标压在折线 0 上必须能拾取到东西（旧版这里只会返回整条 sketch）');
  assert.equal(picked.subject, 'sketchLine', '必须返回折线，而不是整条草图');
  assert.equal(picked.polylineIndex, 0, '折线下标');
  assert.equal(picked.kind, 'line');
  assert.equal(picked.lengthMm, 10, '折线长 10 mm');

  // 真事件：单击 → 多选集合里有 1 条线
  clickAt(container, screen);
  const sel = viewer.getSketchSelection();
  assert.equal(sel.lines.length, 1, '单击后集合里有 1 条线');
  assert.equal(sel.lines[0].polylineIndex, 0);
  assert.equal(viewer.getSketchState().selectedLines, 1);
  viewer.dispose();
});

check('端到端：单击草图端点选中的是「点」，不是折线', () => {
  const { viewer, container } = makeE2EViewer();
  const screen = screenOf(container, viewer, [0, 0, 0]);
  const picked = viewer.pick(screen.clientX, screen.clientY);
  assert.ok(picked, '端点必须能拾取');
  assert.equal(picked.subject, 'sketchPoint', '端点优先于折线');
  assert.equal(picked.polylineIndex, 0);
  assert.equal(picked.pointIndex, 0);
  assert.deepEqual(picked.position, [0, 0, 0]);

  clickAt(container, screen);
  const sel = viewer.getSketchSelection();
  assert.equal(sel.points.length, 1, '选中了 1 个点');
  assert.equal(sel.lines.length, 0, '不该同时选中折线');
  assert.equal(sel.points[0].pointIndex, 0);
  viewer.dispose();
});

check('端到端：Ctrl+左键累积 / toggle，不按 Ctrl 替换，Esc 清空', () => {
  const { viewer, container } = makeE2EViewer();
  const s0 = screenOf(container, viewer, [5, 0, 0]);      // 折线 0
  const s1 = screenOf(container, viewer, [10, 5, 0]);     // 折线 1 中点
  const keys = () => viewer.getSketchSelection().lines.map((l) => l.polylineIndex);

  clickAt(container, s0);                                  // 选 A（不按 Ctrl）
  assert.deepEqual(keys(), [0]);
  clickAt(container, s1, { ctrlKey: true });                // Ctrl 点 B
  assert.deepEqual(keys(), [0, 1], 'Ctrl 点击 = 累积');
  clickAt(container, s0, { ctrlKey: true });                // Ctrl 再点 A → 取消 A
  assert.deepEqual(keys(), [1], 'Ctrl 点已选中的项 = 取消');
  clickAt(container, s0, { metaKey: true });                // macOS 的 Cmd 等价
  assert.deepEqual(keys(), [1, 0], 'metaKey 也当 Ctrl（macOS 兼容）');
  clickAt(container, s1);                                   // 不按 Ctrl 点 B → 替换
  assert.deepEqual(keys(), [1], '不按 Ctrl = 替换选择');

  // Esc（真 keydown，走 viewer 注册在 window 上的 onKeyDown）
  const winListeners = fakeWindow.__listeners || [];
  const escapeHandlers = winListeners['keydown'] || [];
  assert.ok(escapeHandlers.length > 0, 'onKeyDown 必须注册在 window 上（Esc 才能生效）');
  for (const fn of escapeHandlers) fn({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(viewer.getSketchState().selectedLines, 0, 'Esc 之后多选集合必须为空');
  assert.deepEqual(keys(), []);
  assert.equal(viewer.getSelection(), null);
  viewer.dispose();
});

check('端到端：Ctrl+左键点空白不改变任何东西（状态 / 高亮 / 回调三者一致）', () => {
  const { viewer, container, selections } = makeE2EViewer();
  const onLine = screenOf(container, viewer, [5, 0, 0]);
  const blank = { clientX: 8, clientY: 8 };                 // 画布角落，离草图很远
  clickAt(container, onLine);
  assert.equal(viewer.getSketchState().selectedLines, 1);
  const hlBefore = viewer.getSketchHighlightState();
  assert.equal(hlBefore.pickLines.vertices, 2, '前提：高亮几何画着 1 条线');
  const cbBefore = selections.length;

  clickAt(container, blank, { ctrlKey: true });
  // 三处必须一致：集合还在、高亮还在、并且**没有发过任何新回调**
  assert.equal(viewer.getSketchState().selectedLines, 1, 'Ctrl+空白 = 不清空');
  assert.deepEqual(viewer.getSketchState().lineKeys, ['sk:0:0']);
  const hlAfter = viewer.getSketchHighlightState();
  assert.equal(hlAfter.pickLines.vertices, 2, 'Ctrl+空白之后画布高亮必须仍在');
  assert.equal(selections.length, cbBefore,
    'Ctrl+空白不许发 onSelect 回调：旧实现会发 null，React 侧把信息条撤掉，而集合与高亮都还在');
  assert.equal(viewer.getSelection().subject, 'sketchSelection', '「把所选填进对话框」必须仍拿得到数据');

  // 不按 Ctrl 点空白：彻底清空（三处一起）
  clickAt(container, blank);
  assert.equal(viewer.getSketchState().selectedLines, 0, '不按 Ctrl + 空白 = 清空');
  assert.equal(viewer.getSketchHighlightState().pickLines.vertices, 0, '清空后高亮必须一起消失');
  assert.equal(selections.length, cbBefore + 1, '清空必须补一次回调');
  assert.equal(selections[selections.length - 1], null, '清空回调的 payload 必须是 null');
  assert.equal(viewer.getSelection(), null);
  viewer.dispose();
});

check('端到端：Ctrl+点空白（无 Ctrl 的那次选中已清掉时）同样不发回调、不改状态', () => {
  const { viewer, container, selections } = makeE2EViewer();
  const blank = { clientX: 8, clientY: 8 };
  const before = selections.length;
  clickAt(container, blank, { ctrlKey: true });
  assert.equal(selections.length, before, '一开始就没有选择时，Ctrl+空白也不该发回调');
  assert.equal(viewer.getSketchState().selectedLines, 0);
  assert.equal(viewer.getSelection(), null);
  viewer.dispose();
});

check('端到端：多选信息（N 条线 / M 个点 / 合计长度）与「全选本草图」', () => {
  const { viewer, container } = makeE2EViewer();
  const s0 = screenOf(container, viewer, [5, 0, 0]);
  const s1 = screenOf(container, viewer, [10, 5, 0]);
  const sp = screenOf(container, viewer, [0, 0, 0]);
  clickAt(container, s0);
  clickAt(container, s1, { ctrlKey: true });
  clickAt(container, sp, { ctrlKey: true });
  const sel = viewer.getSketchSelection();
  assert.equal(sel.lines.length, 2);
  assert.equal(sel.points.length, 1);
  assert.equal(sel.summary, '已选 2 条线、1 个点（合计 20.0 mm）',
    '两条 10mm 的线 + 1 个点：' + sel.summary);
  // 卡片文本逐字符
  assert.equal(sel.text, [
    '已选 2 条线、1 个点（合计 20.0 mm）',
    '线 #0（直线，长 10.0 mm）',
    '线 #1（直线，长 10.0 mm）',
    '点 折线#0 点#0 @ [0.00,0.00,0.00]',
  ].join('\n'));

  // getSelection 报的是草图多选（不是 edge/face）
  const report = viewer.getSelection();
  assert.equal(report.subject, 'sketchSelection');
  assert.equal(report.lines.length, 2);
  assert.equal(report.points.length, 1);

  // 「全选本草图」：右键菜单里的入口（不绑 Ctrl+A）
  const all = viewer.selectAllSketchLines(0);
  assert.deepEqual(all, { lines: 2, points: 0 }, '全选后 2 条线、0 个点（点被清掉）');
  assert.equal(viewer.getSketchSelection().summary, '已选 2 条线、0 个点（合计 20.0 mm）');
  viewer.dispose();
});

check('端到端：右键菜单在草图上是 4 项（标记/全选本草图/编辑这条草图/把所选填进对话框）', () => {
  const { viewer, container } = makeE2EViewer();
  const onLine = screenOf(container, viewer, [5, 0, 0]);
  clickAt(container, onLine);
  // 真 showContextMenu：它会 pickAt + select + 建 DOM 菜单（假 DOM 元素）
  viewer.showContextMenu(onLine.clientX, onLine.clientY);
  // 菜单挂在 container 上；找最后一个 .sw3d-menu
  const menus = (container.children || []).filter((c) => c && c.className === 'sw3d-menu');
  assert.equal(menus.length, 1, '右键菜单必须被创建');
  const menu = menus[0];
  const labels = (menu.children || [])
    .filter((c) => c && c.className === 'sw3d-menu-item')
    .map((c) => (c.children || []).map((x) => x.textContent || '').join(''));
  assert.deepEqual(labels, ['标记此处', '全选本草图', '编辑这条草图', '把所选填进对话框'],
    '草图折线的右键菜单项：' + JSON.stringify(labels));
  viewer.closeContextMenu();
  viewer.dispose();
});

check('端到端：dispose 之后画布从 container 摘掉，草图多选节点也回收（不泄漏）', () => {
  const { viewer, container } = makeE2EViewer();
  const onLine = screenOf(container, viewer, [5, 0, 0]);
  clickAt(container, onLine);
  assert.equal(viewer.getSketchState().selectedLines, 1);
  // dispose 之前：画布确实挂在 container 上（先证明这个前提，再断言它被摘掉）
  const canvasBefore = canvasOf(container);
  assert.ok((container.children || []).includes(canvasBefore), 'dispose 前画布必须挂在 container 上');
  // 选中高亮几何确实建出来了（顶点数 = 选中折线的段数 × 2）
  const hlBefore = viewer.getSketchHighlightState();
  assert.ok(hlBefore.pickLines.vertices > 0,
    '选中后高亮几何必须有顶点：' + JSON.stringify(hlBefore.pickLines));
  assert.equal(hlBefore.pickLines.inScene, true, 'dispose 前选中高亮节点必须挂在 scene 上');
  assert.equal(hlBefore.hoverLines.inScene, true, 'dispose 前悬停高亮节点必须挂在 scene 上');
  assert.equal(hlBefore.pickLines.disposed, false);
  viewer.dispose();
  assert.equal((container.children || []).includes(canvasBefore), false, 'dispose 后画布必须被摘掉');
  assert.equal(container.children.length, 0, 'dispose 后 container 里不该再挂画布');
  // 关键（旧版这里只断言了画布，等于没测草图多选节点）：两块草图高亮几何都必须
  // (a) 从 scene 摘掉、(b) 几何**真的**执行过 dispose、(c) 小球分组清空。
  // disposed 现在不是「dispose() 跑到了这里」的布尔标记，而是几何对象上真实收到了
  // three 的 'dispose' 事件（BufferGeometry.dispose() 唯一做的事就是派发它）——
  // 注释掉 client.js 里那行 geometry.dispose()，下面这条就会红（M21）。
  const hlAfter = viewer.getSketchHighlightState();
  assert.equal(hlAfter.pickLines.inScene, false, 'dispose 后选中高亮节点必须从 scene 移出');
  assert.equal(hlAfter.pickLines.disposed, true,
    'dispose 后选中高亮的几何必须真的执行过 geometry.dispose()（M21：注释掉那行会让这条红）');
  assert.equal(hlAfter.pickLines.materialDisposed, true, '材质的 dispose() 也必须真的执行过');
  assert.equal(hlAfter.hoverLines.inScene, false, 'dispose 后悬停高亮节点必须从 scene 移出');
  assert.equal(hlAfter.hoverLines.disposed, true, '悬停高亮的几何也必须真的 dispose 过');
  assert.equal(hlAfter.hoverLines.materialDisposed, true, '悬停高亮的材质也必须真的 dispose 过');
  assert.equal(hlAfter.pointMarkers, 0, 'dispose 后选中端点的小球必须被清空');
  // 反向证明「disposed 不是无条件 true」：dispose 之前必须是 false
  assert.equal(hlBefore.pickLines.disposed, false, 'dispose 之前 disposed 必须是 false（否则断言恒真）');
  assert.equal(hlBefore.hoverLines.disposed, false, 'dispose 之前悬停几何的 disposed 也必须是 false');
});

check('端到端：悬停到折线只高亮那一条折线的几何（不是整条草图变色）', () => {
  const { viewer, container } = makeE2EViewer();
  const dom = canvasOf(container);
  const onLine1 = screenOf(container, viewer, [10, 5, 0]);
  dom.dispatch('pointermove', {
    clientX: onLine1.clientX, clientY: onLine1.clientY, pointerId: 1,
    button: -1, preventDefault() {}, stopPropagation() {},
  });
  const state = viewer.getSketchState();
  assert.equal(state.hovered, 0, '悬停到草图 0');
  // 关键断言：悬停高亮的**几何**只有那一条折线的段（1 段 → 2 个顶点），
  // 而不是整条草图（2 段 → 4 个顶点）。这才是「不是整条草图变色」的真正证据。
  const hl = viewer.getSketchHighlightState();
  assert.equal(hl.hoveredLineKey, 'sk:0:1', '悬停的是草图 0 的折线 1');
  // 悬停高亮有**自己的**几何对象（hoverLines），不再是选中那条管线
  assert.equal(hl.hoverLines.visible, true, '悬停后悬停高亮几何必须可见');
  assert.equal(hl.hoverLines.vertices, 2,
    '只画折线 1（1 段 = 2 顶点）；若整条草图变色会是 4 顶点。实际 ' + hl.hoverLines.vertices);
  assert.equal(hl.pickLines.visible, false, '悬停不是选中：选中高亮必须仍然关着');
  viewer.dispose();
});

check('端到端：悬停到折线 0 时高亮几何也只含 1 段（换一条线验证）', () => {
  const { viewer, container } = makeE2EViewer();
  const dom = canvasOf(container);
  const onLine0 = screenOf(container, viewer, [5, 0, 0]);
  dom.dispatch('pointermove', {
    clientX: onLine0.clientX, clientY: onLine0.clientY, pointerId: 1,
    button: -1, preventDefault() {}, stopPropagation() {},
  });
  const hl = viewer.getSketchHighlightState();
  assert.equal(hl.hoveredLineKey, 'sk:0:0');
  assert.equal(hl.hoverLines.vertices, 2, '折线 0 也只有 1 段');
  viewer.dispose();
});

check('端到端：有草图多选时选中实体对象 → 草图多选让位（两套状态不打架）', () => {
  const { viewer, container } = makeE2EViewer();
  const onLine = screenOf(container, viewer, [5, 0, 0]);
  clickAt(container, onLine);
  assert.equal(viewer.getSketchState().selectedLines, 1);
  // 草图视图没有实体，直接调 engine.select 传一个实体点：走的是同一条 select() 入口
  // （point 传 null：pickAt 里给的都是 Vector3，这里不构造，交给构造函数自己兜底）
  viewer.select({ subject: 'point', pointIndex: 0, point: null });
  assert.equal(viewer.getSketchState().selectedLines, 0, '选中实体点后草图多选必须清空');
  assert.equal(viewer.getSketchState().selectedPoints, 0);
  viewer.dispose();
});

check('规模：5000 点 / 4950 段的映射表是线性的，且包围球早期剔除不改结果', () => {
  // 真实库里单草图可能上千点；这里放大到 5000 点（50 条 × 100 点）
  const big = [];
  for (let p = 0; p < 50; p += 1) {
    const pts = [];
    for (let i = 0; i < 100; i += 1) pts.push([p * 2 + i * 0.1, Math.sin(i) * 5, 0]);
    big.push({ points: pts, closed: false, kind: 'line' });
  }
  const t0 = process.hrtime.bigint();
  const index = T.buildSketchSegmentIndex(big);
  const positions = T.buildSketchSegmentPositions(big);
  const buildMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(index.segmentCount, 4950, '49 段/折线 × 50 = 4950 段');
  assert.equal(index.segmentCount * 2, positions.length / 3, '段数×2 = 顶点数');
  assert.ok(buildMs < 200, '建表 + positions 必须是毫秒级（O(n)，实测 ' + buildMs.toFixed(1) + ' ms）');

  // 映射表是 O(1) 查找（不是每次线性搜）：一百万个下标必须逐条落在合法折线区间里。
  // 同时记录「哪些段下标被真正验证过」—— 这是对**数据**的断言（每个段都必须被覆盖到），
  // 不是「循环跑完了」那种恒真的空断言。
  const tMap = process.hrtime.bigint();
  const visited = new Set();
  for (let k = 0; k < 1000000; k += 1) {
    const seg = k % index.segmentCount;
    const poly = index.polylineOfSegment[seg];
    // 不用「同一个表达式取两次」的空断言：验证这个段下标确实落在它自己折线的区间内
    assert.ok(poly >= 0 && poly < big.length, '段 ' + seg + ' 的折线下标必须合法：' + poly);
    assert.ok(seg >= index.startOfPolyline[poly] &&
      seg < index.startOfPolyline[poly] + index.countOfPolyline[poly],
      '段 ' + seg + ' 必须落在折线 ' + poly + ' 的区间 [' + index.startOfPolyline[poly] + ', ' +
      (index.startOfPolyline[poly] + index.countOfPolyline[poly]) + ') 内');
    visited.add(seg);
  }
  const mapMs = Number(process.hrtime.bigint() - tMap) / 1e6;
  assert.equal(visited.size, index.segmentCount,
    '1e6 次取模必须覆盖到**每一个**段下标（覆盖 ' + visited.size + ' / ' + index.segmentCount + '）');
  assert.ok(mapMs < 500, '1e6 次 O(1) 映射查找必须很快（实测 ' + mapMs.toFixed(1) + ' ms）');

  // 每条折线的区间切片只碰自己那段（不是全表扫描）
  let hit = 0;
  let miss = 0;
  let mismatch = 0;
  const tPick = process.hrtime.bigint();
  const N = 500;
  for (let k = 0; k < N; k += 1) {
    const seg = (k * 7) % index.segmentCount;
    const base = seg * 6;
    const a = [positions[base], positions[base + 1], positions[base + 2]];
    const b = [positions[base + 3], positions[base + 4], positions[base + 5]];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const r = T.pickSketchSegmentInPositions(positions, index, [mid[0], mid[1], mid[2] + 1], [0, 0, -1], 0.05);
    if (!r) { miss += 1; continue; }
    hit += 1;
    if (index.polylineOfSegment[r.segmentIndex] !== r.polylineIndex) mismatch += 1;
  }
  const pickMs = Number(process.hrtime.bigint() - tPick) / 1e6;
  assert.equal(hit, N, '每一条「段中点正上方」的射线都必须命中（不许被包围球预筛误杀）');
  assert.equal(miss, 0);
  assert.equal(mismatch, 0, '命中段的折线下标必须与映射表一致');
  assert.ok(pickMs / N < 5, '单次拾取必须远低于 5ms（实测 ' + (pickMs / N).toFixed(4) + ' ms）');
  console.log('     # 5000 点规模：建表 ' + buildMs.toFixed(1) + ' ms · 单次拾取 ' +
    (pickMs / N).toFixed(4) + ' ms · 1e6 映射查找 ' + mapMs.toFixed(1) + ' ms');
});

check('双击判定：草图折线/端点各有独立键（否则两次草图点击会被误判成双击）', () => {
  // 这是我在集成测试里真抓到的一个缺陷：pickTargetKey 以前对草图返回 'none'，
  // 于是「点折线 A → 点折线 B」两次都算 'none'，被 isDoubleClickGesture 判成双击空白，
  // 第二次点选被当成双击、多选直接失效。
  assert.equal(T.pickTargetKey({ subject: 'sketchLine', sketchIndex: 0, polylineIndex: 0 }), 'sketchLine#0:0');
  assert.equal(T.pickTargetKey({ subject: 'sketchLine', sketchIndex: 0, polylineIndex: 1 }), 'sketchLine#0:1');
  assert.equal(T.pickTargetKey({ subject: 'sketchPoint', sketchIndex: 0, polylineIndex: 0, pointIndex: 3 }),
    'sketchPoint#0:0:3');
  assert.equal(T.pickTargetKey({ subject: 'sketch', sketchIndex: 2 }), 'sketch#2');
  // 两条不同的折线不许有同一个键（否则被当成双击）
  assert.notEqual(
    T.pickTargetKey({ subject: 'sketchLine', sketchIndex: 0, polylineIndex: 0 }),
    T.pickTargetKey({ subject: 'sketchLine', sketchIndex: 0, polylineIndex: 1 })
  );
  // 同一对象两次点击仍然是双击（这是想要的行为）
  assert.equal(T.isDoubleClickGesture(
    { subject: 'sketchLine', sketchIndex: 0, polylineIndex: 0 },
    { subject: 'sketchLine', sketchIndex: 0, polylineIndex: 0 }, 100
  ), true);
  assert.equal(T.isDoubleClickGesture(
    { subject: 'sketchLine', sketchIndex: 0, polylineIndex: 0 },
    { subject: 'sketchLine', sketchIndex: 0, polylineIndex: 1 }, 100
  ), false, '不同折线不许算双击');
  // 旧行为逐字节不变
  assert.equal(T.pickTargetKey({ subject: 'point', pointIndex: 3 }), 'point#3');
  assert.equal(T.pickTargetKey({ subject: 'edge', edgeIndex: 7 }), 'edge#7');
  assert.equal(T.pickTargetKey({ subject: 'face', faceIndex: 2 }), 'face#2');
  assert.equal(T.pickTargetKey(null), 'none');
});

/* ------------------------------------------------------------------ */
/* 9. 回归：审计驳回的 5 个缺陷（每条都是先红后绿）                       */
/* ------------------------------------------------------------------ */

check('缺陷1 回归：Ctrl 多选 2 条后右键其中一条 → 多选不被摧毁，菜单计数是动过之后的', () => {
  const { viewer, container } = makeE2EViewer();
  const s0 = screenOf(container, viewer, [5, 0, 0]);       // 折线 0
  const s1 = screenOf(container, viewer, [10, 5, 0]);      // 折线 1
  clickAt(container, s0);
  clickAt(container, s1, { ctrlKey: true });
  assert.equal(viewer.getSketchState().selectedLines, 2, '前提：已选 2 条');

  // 右键落在**已选中**的折线 1 上：不许动选择
  viewer.showContextMenu(s1.clientX, s1.clientY);
  assert.equal(viewer.getSketchState().selectedLines, 2,
    '右键已选中的项不许摧毁多选（旧实现会先 select(pick) 清成 1 条）');
  const sel = viewer.getSketchSelection();
  assert.equal(sel.lines.length, 2, '右键后「把所选填进对话框」必须仍拿到 2 条');
  assert.deepEqual(sel.lines.map((l) => l.polylineIndex).sort(), [0, 1]);
  viewer.closeContextMenu();

  // 右键真空白：pick 为 null，没有「替换」的对象 —— 保持既有行为（不动选择）。
  // 这条边界很重要：如果空白右键也清空，用户「Ctrl 选中几条 → 手滑右键空白」就白选了。
  let blank = null;
  for (const [bx, by] of [[2, 2], [798, 2], [2, 598], [798, 598], [4, 4]]) {
    if (!viewer.pick(bx, by)) { blank = { clientX: bx, clientY: by }; break; }
  }
  assert.ok(blank, '画布上必须存在一个真空白点（否则这条断言没意义）');
  viewer.showContextMenu(blank.clientX, blank.clientY);
  assert.equal(viewer.getSketchState().selectedLines, 2, '右键空白不动选择（和旧实现一致）');
  viewer.closeContextMenu();
  viewer.dispose();
});

check('缺陷1 回归（纯逻辑）：Ctrl 选 2 条后右键其中一条，键集合逐元素不变', () => {
  const { viewer, container } = makeE2EViewer();
  const s0 = screenOf(container, viewer, [5, 0, 0]);       // 折线 0
  const s1 = screenOf(container, viewer, [10, 5, 0]);      // 折线 1
  clickAt(container, s0);
  clickAt(container, s1, { ctrlKey: true });
  const before = viewer.getSketchState().lineKeys.slice();
  assert.deepEqual(before, ['sk:0:0', 'sk:0:1'], '前提：两条都选中');
  // 走引擎的右键入口、且落在**已选中**的第二条上：集合必须一个元素都不变。
  // （旧实现会先 select(pick) → 只剩 1 条；选 1 条再右键它则新旧实现结果相同，抓不到 bug。）
  viewer.showContextMenu(s1.clientX, s1.clientY);
  assert.deepEqual(viewer.getSketchState().lineKeys, before, '右键已选中项后键集合必须完全不变');
  assert.deepEqual(viewer.getSketchState().lineKeys, ['sk:0:0', 'sk:0:1']);
  viewer.closeContextMenu();
  viewer.dispose();
});

check('缺陷2 回归：普通点选后 300ms 内 Ctrl 点同一项 = 取消，且标记数不变', () => {
  const { viewer, container } = makeE2EViewer();
  const s0 = screenOf(container, viewer, [5, 0, 0]);
  clickAt(container, s0);                                   // 普通点选 A
  assert.equal(viewer.getSketchState().selectedLines, 1);
  const markersBefore = viewer.getMarkers().length;
  assert.equal(markersBefore, 0, '前提：还没有标记');
  // 300ms 内 Ctrl 点同一个 A —— 意图是「取消」，绝不能被判成双击
  clickAt(container, s0, { ctrlKey: true });
  assert.equal(viewer.getSketchState().selectedLines, 0,
    'Ctrl 点已选中的同一项必须取消（旧实现判成双击 → 又选中了）');
  assert.equal(viewer.getMarkers().length, markersBefore,
    'Ctrl 取消绝不许凭空多一个标记球（旧实现会 addMarker）');
  viewer.dispose();
});

check('缺陷3 回归：双击草图折线的标记文本逐字符（不是「面 #-1」）', () => {
  // 标记文本是纯函数，直接断言（这段文本会经 buildMarkersText 进用户输入框）
  assert.equal(
    T.markerLine({ subject: 'sketchLine', index: 3, point: [5, 0, 0] }, 0),
    '标记 #1（草图折线 #3 @ [5.00,0.00,0.00]）'
  );
  assert.equal(
    T.markerLine({ subject: 'sketchPoint', index: 7, point: [1, 2, 3] }, 1),
    '标记 #2（草图端点 #7 @ [1.00,2.00,3.00]）'
  );
  assert.equal(
    T.markerLine({ subject: 'sketch', index: 0, point: [0, 0, 0] }, 2),
    '标记 #3（草图 #0 @ [0.00,0.00,0.00]）'
  );
  // 旧的「面」标签回落在草图三档上必须彻底消失；label 必须换成草图自己的说法
  const expectLabels = { sketchLine: '草图折线', sketchPoint: '草图端点', sketch: '草图' };
  for (const [subject, label] of Object.entries(expectLabels)) {
    const text = T.markerLine({ subject, index: 2, point: [0, 0, 0] }, 0);
    assert.equal(text, '标记 #1（' + label + ' #2 @ [0.00,0.00,0.00]）',
      subject + ' 的标记文本必须用「' + label + '」：' + text);
    assert.equal(text.includes('（面 '), false, subject + ' 的标记文本不许回落成「面」：' + text);
  }
  // 四个既有档位逐字节不变
  assert.equal(T.markerLine({ subject: 'face', index: 12, point: [1, 2, 3] }, 0), '标记 #1（面 #12 @ [1.00,2.00,3.00]）');
  assert.equal(T.markerLine({ subject: 'edge', index: 33, point: [-1.5, 0, 2.25] }, 1), '标记 #2（边 #33 @ [-1.50,0.00,2.25]）');
  assert.equal(T.markerLine({ subject: 'point', index: 5, point: [0, 0, 0] }, 2), '标记 #3（点 #5 @ [0.00,0.00,0.00]）');
  assert.equal(T.markerLine({ subject: 'none', index: -1, point: [0, 0, 0] }, 0), '标记 #1（画布 @ [0.00,0.00,0.00]）');
  // 多行：草图标记与实体标记混排
  assert.equal(T.buildMarkersText([
    { subject: 'sketchLine', index: 0, point: [5, 0, 0] },
    { subject: 'sketchPoint', index: 2, point: [10, 0, 0] },
  ]), '标记 #1（草图折线 #0 @ [5.00,0.00,0.00]）\n标记 #2（草图端点 #2 @ [10.00,0.00,0.00]）');
});

check('缺陷3 回归（集成）：双击草图折线真的写入正确 subject/index 的标记', () => {
  const { viewer, container } = makeE2EViewer();
  const s1 = screenOf(container, viewer, [10, 5, 0]);       // 折线 1
  clickAt(container, s1);
  clickAt(container, s1);                                   // 300ms 内第二次 → 双击
  const list = viewer.getMarkers();
  assert.equal(list.length, 1, '双击应放 1 个标记');
  assert.equal(list[0].subject, 'sketchLine', '标记的 subject 必须是 sketchLine（旧实现回落成 face）');
  assert.equal(list[0].index, 1, '标记的 index 必须是折线下标 1（旧实现恒 -1）');
  // 标记落在射线与段的最近点上（浮点，别用精确相等）
  assert.ok(Math.abs(list[0].point[0] - 10) < 1e-6, '标记 x 落在命中点：' + list[0].point[0]);
  assert.ok(Math.abs(list[0].point[1] - 5) < 1e-6, '标记 y 落在命中点：' + list[0].point[1]);
  assert.ok(Math.abs(list[0].point[2] - 0) < 1e-6, '标记 z 落在命中点：' + list[0].point[2]);
  // 送进用户输入框的那行文本（逐字符：fmtPoint 固定两位小数，浮点噪声被吃掉）
  assert.equal(T.buildMarkersText(list), '标记 #1（草图折线 #1 @ [10.00,5.00,0.00]）');
  // 渲染侧：草图标记和实体标记走同一条路（一个球 + 一个序号标签），确实进了场景图
  const render = viewer.getMarkerRenderState();
  assert.equal(render.count, 1);
  assert.equal(render.meshes, 1, '草图标记必须有球');
  assert.equal(render.labels, 1, '草图标记必须有序号标签');
  assert.equal(render.groupChildren, 2, '球 + 标签 = 2 个场景子对象');
  assert.equal(render.visibleMeshes, 1, '不在剖切里时标记必须可见');
  viewer.dispose();
});

check('缺陷3 回归：草图端点标记也带 pointIndex，且渲染正常', () => {
  const { viewer, container } = makeE2EViewer();
  const sp = screenOf(container, viewer, [0, 0, 0]);        // 折线 0 的端点 0
  clickAt(container, sp);
  clickAt(container, sp);                                   // 双击
  const list = viewer.getMarkers();
  assert.equal(list.length, 1);
  assert.equal(list[0].subject, 'sketchPoint');
  assert.equal(list[0].index, 0, '端点标记的 index = 点下标');
  assert.equal(list[0].polylineIndex, 0, '端点标记额外带折线下标');
  assert.equal(list[0].pointIndex, 0, '端点标记额外带点下标');
  assert.equal(T.buildMarkersText(list), '标记 #1（草图端点 #0 @ [0.00,0.00,0.00]）');
  assert.equal(viewer.getMarkerRenderState().meshes, 1);
  viewer.dispose();
});

check('缺陷3 回归：SKETCH_ONLY_DISABLED 的 marker 条目不再和真实行为相反', () => {
  // id 必须保留（test/sketch-only.mjs:446 硬断言它存在，那个文件不在本任务可改范围），
  // 但 label/reason 必须改成实话：草图视图下双击草图折线/端点**是**能放标记的。
  const marker = T.SKETCH_ONLY_DISABLED.find((item) => item.id === 'marker');
  assert.ok(marker, 'id:marker 仍须存在（被 sketch-only.mjs 断言）');
  assert.equal(marker.reason.includes('标记要挂在面'), false,
    '旧的假话「标记要挂在面/边/点上」必须消失：' + marker.reason);
  assert.match(marker.reason, /草图折线与端点/, '原因里要说明草图折线/端点可标：' + marker.reason);
  assert.match(marker.label, /实体/, 'label 要说清是「实体上的」标记不可用：' + marker.label);
  // 提示条整体文本不许再说「双击标记 不可用」
  const text = T.sketchOnlyDisabledText();
  assert.equal(text.includes('双击标记'), false, '提示条不该再说「双击标记不可用」：' + text);
  assert.match(text, /实体面\/边\/点上的标记/, text);
});

check('缺陷4 回归：跨草图多选的指令文本按草图分组，逐字符', () => {
  // 两条草图各有一条 polylineIndex = 0 的折线（真实会撞号）
  const text = T.buildSketchSelectionInstruction({
    file: 'C:\\work\\two.SLDPRT',
    designId: 'two-sketches',
    lines: [
      { sketchIndex: 0, sketchName: 'Sketch_A', sketchPlane: '基准面-上视', polylineIndex: 0, kind: 'line', lengthMm: 10, start: [0, 0, 0], end: [10, 0, 0] },
      { sketchIndex: 1, sketchName: 'Sketch_B', sketchPlane: '基准面-前视', polylineIndex: 0, kind: 'line', lengthMm: 20, start: [0, 5, 0], end: [20, 5, 0] },
    ],
    points: [],
    note: '',
  });
  // 契约变更：①–⑤ 分段格式。**仍然整篇逐字符断言**（分组标题、缩进、编号、每条的
  // 长度与起终点坐标、合计 mm 全部写死），不是 `includes` 弱断言。
  assert.equal(text, [
    '[3D标注] 用户在这个 3D 视图里选中了以下草图几何，请你按用户的意图修改模型。',
    '（这是用户交给你的修改任务，不是状态汇报。下面按 ① → ⑤ 读。）',
    '文件：C:\\work\\two.SLDPRT 设计ID：two-sketches',
    '',
    '【① 任务】',
    '修改【② 必须修改的对象】里点名的 2 条折线、0 个端点（合计 30.0 mm），具体改法看【④ 修改意图】。',
    '只改这两段点名的对象；其它几何、尺寸、特征一律不要动。',
    '',
    '【② 必须修改的对象】用户在视图里点选的，就是这些（编号 [1]…[2] 与截图上的数字标记一一对应）：',
    '选中：2 条草图上的 2 条折线、0 个端点（合计 30.0 mm）',
    '  草图 Sketch_A（第 1 条 / 基准面-上视，1 条折线 / 0 个端点）：',
    '    [1] 折线 #0 直线',
    '  草图 Sketch_B（第 2 条 / 基准面-前视，1 条折线 / 0 个端点）：',
    '    [2] 折线 #0 直线',
    '',
    '【③ 坐标与长度 · 参考数据，不是目标值】',
    '这些数字只用来在模型里**定位**【②】里已有的那些几何。',
    '不要按这些坐标重新画一遍几何，也不要把它们当成「要改成的目标值」——用户要改的是形状/位置关系，不是把这些数字再抄一遍。',
    '  草图 Sketch_A（第 1 条 / 基准面-上视）：',
    '    [1] 折线 #0 直线 长 10.0 mm 起点 [0.00,0.00,0.00] 终点 [10.00,0.00,0.00]',
    '  草图 Sketch_B（第 2 条 / 基准面-前视）：',
    '    [2] 折线 #0 直线 长 20.0 mm 起点 [0.00,5.00,0.00] 终点 [20.00,5.00,0.00]',
    '',
    '【④ 修改意图】用户自己的补充（可能为空；「修改意见」之后就是用户写的原话）：',
    '修改意见：（用户还没写具体改法：先按【⑤】复述你定位到的对象，再问清楚要改成什么样）',
    '',
    '【⑤ 动手前先复述】',
    '先确认你定位到的就是【②】里这 2 条折线、0 个端点（合计 30.0 mm）（草图名、折线号、起点/终点坐标都对得上），',
    '再给出修改方案并执行；对不上就先说明你实际找到的是哪些，不要凭坐标猜着改。',
  ].join('\n'));
  // 关键：两条 polylineIndex=0 的线必须各带自己的草图名，不许都记在第一个草图名下
  assert.equal(text.split('草图 Sketch_A').length - 1, 2, 'Sketch_A 只在 ② 和 ③ 出现（各一次）');
  assert.equal(text.split('草图 Sketch_B').length - 1, 2, 'Sketch_B 只在 ② 和 ③ 出现（各一次）');
  // 跨草图时编号必须**连续、不撞号**：两条都是「折线 #0」，正文靠 [1]/[2] 区分
  assert.equal(text.includes('[1] 折线 #0 直线\n'), true, '第一条必须是 [1] 折线 #0：' + text);
  assert.equal(text.includes('[2] 折线 #0 直线\n'), true, '第二条必须是 [2] 折线 #0：' + text);
  // 单草图路径：仍然**只有一组**（不走分组格式），「属于特征 / 绘制在」两句必须保留
  const single = T.buildSketchSelectionInstruction({
    file: 'a.STEP', designId: 'd',
    sketch: { name: 'A', feature: '凸台-拉伸1', plane: '基准面-前视' },
    lines: [{ sketchIndex: 0, sketchName: 'A', polylineIndex: 3, kind: 'arc', lengthMm: 5, start: [0, 0, 0], end: [1, 0, 0] }],
    points: [{ sketchIndex: 0, sketchName: 'A', polylineIndex: 3, pointIndex: 1, position: [1, 0, 0] }],
  });
  const singleRows = single.split('\n');
  assert.equal(singleRows[9],
    '选中：草图 A（属于特征「凸台-拉伸1」，绘制在 基准面-前视） 的 1 条折线、1 个端点（合计 5.0 mm）',
    '单草图必须说「属于特征」「绘制在」两句');
  // ②段：编号标题（不带坐标）
  assert.equal(singleRows[10], '  [1] 折线 #3 圆弧');
  assert.equal(singleRows[11], '  [2] 端点 折线#3 点#1');
  // ③段：同编号 + 长度 + 起终点（参考数据）
  assert.equal(singleRows[16], '  [1] 折线 #3 圆弧 长 5.0 mm 起点 [0.00,0.00,0.00] 终点 [1.00,0.00,0.00]');
  assert.equal(singleRows[17], '  [2] 端点 折线#3 点#1 @ [1.00,0.00,0.00]');
  // ②③ 两段的编号必须**一一对应**（同号同对象）——这是「截图标记与正文对得上」的文本侧保证
  assert.equal(singleRows[10], '  [1] 折线 #3 圆弧');
  assert.equal(singleRows[16].indexOf(singleRows[10] + ' 长 '), 0,
    '③段 [1] 必须由 ②段 [1] 的标题加「 长 …」构成（同号同对象）：' + singleRows[16]);
  assert.equal(singleRows[17].indexOf(singleRows[11] + ' @ '), 0,
    '③段 [2] 必须由 ②段 [2] 的标题加「 @ …」构成（同号同对象）：' + singleRows[17]);
  // 单草图不允许出现分组标题「第 1 条 / …」那种写法
  assert.equal(single.includes('（第 1 条'), false, '单草图不该有分组标题：' + single);
  // 生产路径的形态：sketchLineInfo 总是带 sketchName，单草图仍然不能因此变成分组格式
  const singleNamed = T.buildSketchSelectionInstruction({
    file: 'a.STEP', designId: 'd',
    sketch: { name: 'PlateSketch', feature: 'Boss-Extrude1', plane: '基准面-前视' },
    lines: [{
      sketchIndex: 0, sketchName: 'PlateSketch · Boss-Extrude1',
      polylineIndex: 0, kind: 'line', lengthMm: 10, start: [-5, 0, 0], end: [5, 0, 0],
    }],
    points: [],
  });
  assert.equal(singleNamed.includes('属于特征'), true, '单草图必须说「属于特征」：' + singleNamed);
  assert.equal(singleNamed.includes('绘制在'), true, '单草图必须说「绘制在」：' + singleNamed);
  assert.equal(singleNamed.split('\n')[10], '  [1] 折线 #0 直线', '单草图 ②段必须是编号标题，不是分组格式');
  assert.equal(singleNamed.split('\n')[15],
    '  [1] 折线 #0 直线 长 10.0 mm 起点 [-5.00,0.00,0.00] 终点 [5.00,0.00,0.00]',
    '单草图 ③段必须带长度与起终点坐标');
});

check('缺陷4 回归：信息条文本也带草图名区分跨草图选择', () => {
  const lines = [
    { sketchIndex: 0, sketchName: 'Sketch_A', polylineIndex: 0, kind: 'line', lengthMm: 10, closed: false },
    { sketchIndex: 1, sketchName: 'Sketch_B', polylineIndex: 0, kind: 'line', lengthMm: 20, closed: false },
  ];
  const text = T.buildSketchSelectionText(lines, []);
  assert.equal(text, [
    '已选 2 条线、0 个点（合计 30.0 mm）',
    '草图 Sketch_A（第 1 条） · 线 #0（直线，长 10.0 mm）',
    '草图 Sketch_B（第 2 条） · 线 #0（直线，长 20.0 mm）',
  ].join('\n'));
  // 单草图：不加前缀（信息条别啰嗦）
  const one = T.buildSketchSelectionText([lines[0]], []);
  assert.equal(one, '已选 1 条线、0 个点（合计 10.0 mm）\n线 #0（直线，长 10.0 mm）');
});

check('缺陷4 回归（集成）：跨草图多选时 getSketchSelection 每条线带自己的 sketchName', () => {
  const TWO_POLYLINES_A = [{ points: [[0, 0, 0], [10, 0, 0]], closed: false, kind: 'line' }];
  const TWO_POLYLINES_B = [{ points: [[0, 5, 0], [20, 5, 0]], closed: false, kind: 'line' }];
  const payload = {
    ok: true, unit: 'mm',
    sketches: [
      { id: 'a', name: 'Sketch_A', polylines: TWO_POLYLINES_A },
      { id: 'b', name: 'Sketch_B', polylines: TWO_POLYLINES_B },
    ],
  };
  const container = makeElement();
  container.ownerDocument = headlessDoc;
  container.parentNode = makeElement();
  const model = T.buildSketchOnlyModel(payload, { path: 'C:\\x\\two.SLDPRT', minSize: 30 });
  const viewer = T.createViewer(container, model, {});
  viewer.setSketches(payload);
  viewer.fit();
  const sel = viewer.setSketchMultiSelect(['sk:0:0'], ['sk:1:0:pt:0']);
  const detail = viewer.getSketchSelection();
  assert.equal(detail.lines.length, 1);
  assert.equal(detail.points.length, 1);
  assert.equal(detail.lines[0].sketchName, 'Sketch_A', '线的 sketchName 必须是它自己的草图');
  assert.equal(detail.points[0].sketchName, 'Sketch_B', '点的 sketchName 必须是它自己的草图');
  // 指令文本里两个草图名都要出现
  const text = T.buildSketchSelectionInstruction({
    file: 'C:\\x\\two.SLDPRT', designId: 'two', lines: detail.lines, points: detail.points,
  });
  assert.ok(text.includes('Sketch_A'), '指令必须点名 Sketch_A：' + text);
  assert.ok(text.includes('Sketch_B'), '指令必须点名 Sketch_B：' + text);
  void sel;
  viewer.dispose();
});

check('缺陷5 回归：有多选时 clearSketches() 必须通知 React 清掉信息条', () => {
  const container = makeElement();
  container.ownerDocument = headlessDoc;
  container.parentNode = makeElement();
  const model = T.buildSketchOnlyModel(E2E_PAYLOAD, { path: 'C:\\x\\e2e.SLDPRT', minSize: 20 });
  const selections = [];
  const viewer = T.createViewer(container, model, {
    onSelect(sel) { selections.push(sel); },
  });
  viewer.setSketches(E2E_PAYLOAD);
  viewer.fit();
  const s0 = screenOf(container, viewer, [5, 0, 0]);
  clickAt(container, s0);
  assert.equal(viewer.getSketchState().selectedLines, 1, '前提：有 1 条选中');
  const before = selections.length;

  // 关工具栏「草图」开关 → clearSketches()
  viewer.clearSketches();
  assert.equal(viewer.getSketchState().selectedLines, 0, '集合被清空');
  // 关键：必须补一次 onSelect(null)，否则 React 侧信息条还挂着「已选 N 条线」
  assert.ok(selections.length > before, 'clearSketches 必须补一次 onSelect 回调（旧实现没有）');
  assert.equal(selections[selections.length - 1], null,
    'clearSketches 补的那次回调必须是 null（React 据此撤掉信息条）');
  viewer.dispose();
});

check('缺陷5 回归：setSketches() 不产生多余的 null 回调（只有真有选择时才补）', () => {
  const container = makeElement();
  container.ownerDocument = headlessDoc;
  container.parentNode = makeElement();
  const model = T.buildSketchOnlyModel(E2E_PAYLOAD, { path: 'C:\\x\\e2e.SLDPRT', minSize: 20 });
  const selections = [];
  const viewer = T.createViewer(container, model, {
    onSelect(sel) { selections.push(sel); },
  });
  // 没有任何选择时反复 setSketches：不许刷出 null 回调
  const countBefore = selections.length;
  viewer.setSketches(E2E_PAYLOAD);
  viewer.setSketches(E2E_PAYLOAD);
  assert.equal(selections.length, countBefore,
    '没有选择时 setSketches 不该产生 onSelect 回调（否则 React 每换一次数据就重渲染）');

  // 有选择时 setSketches：应该补一次 null
  viewer.fit();
  const s0 = screenOf(container, viewer, [5, 0, 0]);
  clickAt(container, s0);
  assert.equal(viewer.getSketchState().selectedLines, 1);
  const before = selections.length;
  viewer.setSketches(E2E_PAYLOAD);
  assert.equal(selections.length, before + 1, '有选择时 setSketches 应补一次回调');
  assert.equal(selections[selections.length - 1], null, '补的回调是 null');
  viewer.dispose();
});

check('缺陷5 回归：dispose() 里的 clearSketches 不回调已卸载的 React', () => {
  const container = makeElement();
  container.ownerDocument = headlessDoc;
  container.parentNode = makeElement();
  const model = T.buildSketchOnlyModel(E2E_PAYLOAD, { path: 'C:\\x\\e2e.SLDPRT', minSize: 20 });
  const selections = [];
  const viewer = T.createViewer(container, model, {
    onSelect(sel) { selections.push(sel); },
  });
  viewer.setSketches(E2E_PAYLOAD);
  viewer.fit();
  const s0 = screenOf(container, viewer, [5, 0, 0]);
  clickAt(container, s0);
  assert.equal(viewer.getSketchState().selectedLines, 1);
  const before = selections.length;
  viewer.dispose();                       // 组件卸载：disposed=true 已置位
  assert.equal(selections.length, before,
    'dispose 里不该再 onSelect(null)：React 侧可能已经卸载（旧版这里会多回调一次）');
  viewer.dispose();                       // 二次 dispose 幂等
});

/* ------------------------------------------------------------------ */
/* 10. 回归（第二轮审计）：悬停 ≠ 选中 / 草图悬停节流 / 真实拾取半径        */
/* ------------------------------------------------------------------ */

check('回归：悬停色与选中色不同，且是两块独立几何（都选中/悬停时颜色不相等）', () => {
  // 常量层面先立住：颜色值必须不同（同色等于没有指示）
  assert.notEqual(T.SKETCH_HOVER_LINE_COLOR, T.SKETCH_HOVER_COLOR,
    '悬停色与选中色必须是两个不同的颜色：0x' + T.SKETCH_HOVER_LINE_COLOR.toString(16) +
    ' vs 0x' + T.SKETCH_HOVER_COLOR.toString(16));
  // 悬停应该更淡（不透明度更低）——「扫过」比「选中」弱一档
  assert.ok(T.SKETCH_HOVER_LINE_OPACITY < 1, '悬停高亮的不透明度必须 < 1：' + T.SKETCH_HOVER_LINE_OPACITY);

  const { viewer, container } = makeE2EViewer();
  const s0 = screenOf(container, viewer, [5, 0, 0]);         // 折线 0 → 选中
  const hover1 = screenOf(container, viewer, [10, 5, 0]);    // 折线 1 → 悬停
  clickAt(container, s0);
  assert.equal(viewer.getSketchState().selectedLines, 1, '前提：折线 0 已选中');
  const dom = canvasOf(container);
  dom.dispatch('pointermove', {
    clientX: hover1.clientX, clientY: hover1.clientY, pointerId: 1,
    button: -1, preventDefault() {}, stopPropagation() {},
  });
  const hl = viewer.getSketchHighlightState();
  // 两块几何同时存在：选中画折线 0（2 顶点），悬停画折线 1（2 顶点）
  assert.equal(hl.selectedLineKeys.length, 1, '选中集合仍有 1 条');
  assert.equal(hl.hoveredLineKey, 'sk:0:1', '悬停的是另一条折线');
  assert.equal(hl.pickLines.vertices, 2, '选中高亮只画选中的那条');
  assert.equal(hl.hoverLines.vertices, 2, '悬停高亮只画悬停的那条');
  assert.equal(hl.pickLines.visible, true, '选中高亮可见');
  assert.equal(hl.hoverLines.visible, true, '悬停高亮可见');
  // 核心断言：两个高亮的颜色值**不相等**（旧实现把它们合并进同一个材质，颜色必然相等）
  assert.notEqual(hl.pickLines.color, hl.hoverLines.color,
    '悬停与选中必须是两个不同的颜色值（实际都是 0x' + (hl.pickLines.color || 0).toString(16) + '）');
  assert.equal(hl.pickLines.color, T.SKETCH_HOVER_COLOR, '选中的颜色是选中色');
  assert.equal(hl.hoverLines.color, T.SKETCH_HOVER_LINE_COLOR, '悬停的颜色是悬停色');
  assert.ok(hl.hoverLines.opacity < hl.pickLines.opacity, '悬停比选中更淡');
  assert.ok(hl.hoverLines.renderOrder < hl.pickLines.renderOrder, '悬停的 renderOrder 低于选中（选中压在上面）');
  viewer.dispose();
});

check('回归：悬停节流判据覆盖草图视图（triangleCount=0 时也必须能节流）', () => {
  // 草图视图：triangleCount 恒为 0 —— 旧判据 `0 > 100000` 永远 false，等于永不节流
  assert.equal(T.hoverThrottleNeeded({ triangleCount: 0 }, { pointCount: 10, segmentCount: 9 }), false,
    '几百点的小草图不节流（悬停不该有卡顿感）');
  assert.equal(T.hoverThrottleNeeded({ triangleCount: 0 }, { pointCount: 50000, segmentCount: 49750 }), true,
    '50000 点 / 49750 段的草图视图必须走到节流分支');
  // 阈值边界：刚好超过才节流（两侧都断言，避免「阈值写死成 1」这种假通过）
  const limit = T.HOVER_THROTTLE_SKETCH_ITEMS;
  assert.equal(T.hoverThrottleNeeded({ triangleCount: 0 }, { pointCount: limit, segmentCount: 0 }), false,
    '等于阈值不节流（' + limit + '）');
  assert.equal(T.hoverThrottleNeeded({ triangleCount: 0 }, { pointCount: limit + 1, segmentCount: 0 }), true,
    '超过阈值一节流（' + (limit + 1) + '）');
  // 实体模型的老路径逐字节不变
  assert.equal(T.hoverThrottleNeeded({ triangleCount: T.HOVER_THROTTLE_TRIANGLES }, {}), false);
  assert.equal(T.hoverThrottleNeeded({ triangleCount: T.HOVER_THROTTLE_TRIANGLES + 1 }, {}), true);
  assert.equal(T.hoverThrottleNeeded(null, null), false, '空输入不节流，不炸');
});

check('回归：端点索引与折线数组两种入参给出完全相同的拾取结果（缓存不改行为）', () => {
  const index = T.buildSketchPointIndex(POLYLINES);
  const totalPoints = POLYLINES.reduce((s, p) => s + p.points.length, 0);
  assert.equal(index.pointCount, totalPoints, '索引点数 = 172');
  assert.equal(index.positions.length, totalPoints * 3, '扁平坐标长度 = 点数 × 3');
  assert.equal(index.polylineOfPoint.length, totalPoints);
  assert.equal(index.pointIndexOfPoint.length, totalPoints);
  // 同一个射线：传折线数组 vs 传索引 → 结果逐字段一致
  const ends = T.sketchPolylineEndpoints(POLYLINES[5]);
  const mid = [(ends.start[0] + ends.end[0]) / 2, (ends.start[1] + ends.end[1]) / 2, (ends.start[2] + ends.end[2]) / 2];
  const origin = [mid[0], mid[1], mid[2] + 3];
  const direction = [0, 0, -1];
  const viaArray = T.pickSketchPointInPolylines(POLYLINES, origin, direction, 4);
  const viaIndex = T.pickSketchPointInPolylines(index, origin, direction, 4);
  assert.deepEqual(viaIndex, viaArray, '索引路径与数组路径必须给出完全相同的 {polylineIndex,pointIndex,distance,position}');
  // 阈值 0 仍什么都不命中（退化保护）
  assert.equal(T.pickSketchPointInPolylines(index, origin, direction, 0), null);
  assert.equal(T.pickSketchPointInPolylines(null, origin, direction, 4), null);
  assert.equal(T.pickSketchPointInPolylines([], origin, direction, 4), null);
});

check('性能（函数级，不是端到端）：50000 点纯函数直调 < 0.6ms（改前同口径 2.4ms）', () => {
  // 声明口径：这一条**直接调两个纯函数**（端点扫描 + 段扫描），不经过 viewer / entry /
  // pickSketchCandidates，所以它测的是「算法本身」的耗时，不是用户按一下鼠标的端到端耗时。
  // 端到端（含射线构造、候选合并、优先级判定）的同口径数字见报告，不在这里断言
  // —— 端到端受假渲染器与机器负载影响，写进套件只会变成抖动源。
  // 「生产路径有没有缓存索引」由下一条（真实 pointermove + 构建计数）负责，不靠这条。
  // 50000 点（100 条 × 500 点）+ 49750 段 —— 与审计实测的规模一致
  const big = [];
  for (let p = 0; p < 100; p += 1) {
    const pts = [];
    for (let i = 0; i < 500; i += 1) pts.push([p * 2 + i * 0.02, Math.sin(i * 0.1) * 5, 0]);
    big.push({ points: pts, closed: false, kind: 'line' });
  }
  const totalPoints = big.reduce((s, p) => s + p.points.length, 0);
  assert.equal(totalPoints, 50000, '规模：50000 点');

  const tBuild = process.hrtime.bigint();
  const pointIndex = T.buildSketchPointIndex(big);
  const segmentIndex = T.buildSketchSegmentIndex(big);
  const positions = T.buildSketchSegmentPositions(big);
  const buildMs = Number(process.hrtime.bigint() - tBuild) / 1e6;
  assert.equal(pointIndex.pointCount, 50000);
  assert.equal(segmentIndex.segmentCount, 49900, '段数（每条 500 点 → 499 段，× 100 条）');
  console.log('     # 50000 点：建索引 ' + buildMs.toFixed(1) + ' ms（一次性，随 entry 缓存）');

  // 一次「悬停」= 端点扫描 + 段扫描 + 阈值内的构造，每步都用真实的拾取函数
  const threshold = 0.01;
  const N = 400;
  const tPick = process.hrtime.bigint();
  let hits = 0;
  for (let k = 0; k < N; k += 1) {
    const seg = (k * 131) % segmentIndex.segmentCount;
    const base = seg * 6;
    const origin = [positions[base], positions[base + 1], positions[base + 2] + 0.001 + (k % 7) * 0.001];
    const direction = [0.001, 0.0005, -1];
    const pointHit = T.pickSketchPointInPolylines(pointIndex, origin, direction, threshold);
    const lineHit = T.pickSketchSegmentInPositions(positions, segmentIndex, origin, direction, threshold);
    if (pointHit || lineHit) hits += 1;
  }
  const perPickMs = Number(process.hrtime.bigint() - tPick) / 1e6 / N;
  console.log('     # 50000 点：单次悬停 ' + perPickMs.toFixed(3) + ' ms（命中 ' + hits + '/' + N + '）');
  assert.ok(hits > N * 0.9, '绝大多数射线必须命中（否则测的不是热路径）：' + hits + '/' + N);
  // 阈值必须**贴着实测**：0.6ms 是 1ms 目标线内的护栏；旧实现 2.5ms 会被它当场抓住。
  // （以前写的 `pickMs / N < 5` 比实测宽三个数量级，等于没有护栏。）
  assert.ok(perPickMs < 0.6,
    '50000 点单次悬停必须 < 0.6ms（目标 < 1ms；改前实测 2.5ms）。实测 ' + perPickMs.toFixed(3) + ' ms');
});

check('回归：真实拾取半径是「屏幕 7px 量级」—— 改实现里的阈值会让这条红', () => {
  // 这条是 mut9 的解药：审计把 client.js 里的实际阈值改成 1e-7（常量一个没动），
  // 旧套件 41 项全绿。这里**只走真实拾取路径**（viewer.pick → pickAt → pickSketchCandidates
  // → diagonal * SKETCH_PICK_RATIO），量出屏幕上「第一次点不中」的距离。
  const { viewer, container } = makeE2EViewer();
  const rect = container.getBoundingClientRect();
  const mid = viewer.project([5, 0, 0]);                    // 折线 0 的中点
  const mx = rect.left + mid.x;
  const my = rect.top + mid.y;
  assert.ok(viewer.pick(mx, my), '前提：正落在折线上必须命中');
  let missAt = -1;
  for (let d = 0.5; d <= 40; d += 0.5) {
    if (!viewer.pick(mx, my + d)) { missAt = d; break; }
  }
  assert.ok(missAt > 0, '必须能找到「第一次点不中」的偏移量');
  // 记住：dist(世界) = SKETCH_PICK_RATIO × 对角线；在 800×600 画布上算下来落在 6–9px。
  // 阈值 1e-7 时这个距离会塌到 < 0.1px（几乎必然 missAt=0.5），1e-2 时又会大到几十像素。
  assert.ok(missAt >= 4 && missAt <= 14,
    '屏幕拾取半径必须落在 4–14px（实测 ' + missAt + 'px）。' +
    '改 client.js 里的实际阈值（例如改成 1e-7）会让它掉到 0.5px，这条断言就是为它准备的');
  // 端点容差更宽：同一个端点往外推，端点的「点不中」距离必须比折线的更远
  const ep = viewer.project([0, 0, 0]);
  const ex = rect.left + ep.x;
  const ey = rect.top + ep.y;
  assert.equal((viewer.pick(ex, ey) || {}).subject, 'sketchPoint', '端点正中心必须命中「点」');
  let pointMissAt = -1;
  for (let d = 0.5; d <= 40; d += 0.5) {
    const hit = viewer.pick(ex + d * 0.7071, ey + d * 0.7071);
    if (!hit || hit.subject !== 'sketchPoint') { pointMissAt = d; break; }
  }
  assert.ok(pointMissAt > 0, '必须能找到端点「第一次不再命中点」的偏移量');
  assert.ok(pointMissAt > missAt,
    '端点拾取半径（' + pointMissAt + 'px）必须比折线（' + missAt + 'px）更宽，否则「点 > 线」永远轮不到');
  assert.ok(pointMissAt >= 6 && pointMissAt <= 20,
    '端点半径必须落在 6–20px（实测 ' + pointMissAt + 'px）');
  viewer.dispose();
});

check('回归：组名回退不带「草图」前缀（否则正文会出现「草图 草图 #1」）', () => {
  // 没有 sketchName 的项：组名回退成「#<下标>」，模板前置的「草图 」才是唯一的那一个
  const groups = T.groupSketchSelectionBySketch(
    [{ sketchIndex: 0, polylineIndex: 0, kind: 'line', lengthMm: 2 }], []
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].sketchName, '#0', '回退名不许自带「草图」二字：' + groups[0].sketchName);
  assert.equal(groups[0].sketchName.indexOf('草图'), -1);
  // 模板里前置一个「草图 」，拼出来必须是「草图 #0（…」而不是「草图 草图 #0」
  const text = T.buildSketchSelectionInstruction({
    file: 'x.STEP', designId: 'd',
    lines: [
      { sketchIndex: 0, polylineIndex: 0, kind: 'line', lengthMm: 2, start: [0, 0, 0], end: [2, 0, 0] },
      { sketchIndex: 1, polylineIndex: 0, kind: 'line', lengthMm: 3, start: [0, 1, 0], end: [3, 1, 0] },
    ],
    points: [],
  });
  assert.equal(text.includes('草图 草图'), false, '正文不许出现「草图 草图」：' + text);
  // 契约变更：①–⑤ 分段格式，分组标题在 ② 段里**带两个空格缩进**。
  // 仍然逐字符断言两个分组标题 + 各自的编号行（不是 includes 弱断言）。
  assert.equal(text.includes('  草图 #0（第 1 条，1 条折线 / 0 个端点）：'), true,
    '②段分组标题必须是「  草图 #0（第 1 条，1 条折线 / 0 个端点）：」：' + text);
  assert.equal(text.includes('  草图 #1（第 2 条，1 条折线 / 0 个端点）：'), true,
    '②段分组标题必须是「  草图 #1（第 2 条，1 条折线 / 0 个端点）：」：' + text);
  assert.equal(text.includes('    [1] 折线 #0 直线'), true, '②段第一条编号行：' + text);
  assert.equal(text.includes('    [2] 折线 #0 直线'), true, '②段第二条编号行：' + text);
  // ③段：组名重复一次（不带「N 条折线 / N 个端点」），随后是带坐标的编号行
  assert.equal(text.includes('  草图 #0（第 1 条）：'), true, '③段分组标题：' + text);
  assert.equal(text.includes('  草图 #1（第 2 条）：'), true, '③段分组标题：' + text);
  assert.equal(text.includes('    [1] 折线 #0 直线 长 2.0 mm 起点 [0.00,0.00,0.00] 终点 [2.00,0.00,0.00]'), true,
    '③段第一条必须带长度与起终点：' + text);
  assert.equal(text.includes('    [2] 折线 #0 直线 长 3.0 mm 起点 [0.00,1.00,0.00] 终点 [3.00,1.00,0.00]'), true,
    '③段第二条必须带长度与起终点：' + text);
  assert.equal(text.split('\n').filter((row) => row.trim().indexOf('草图 #0') === 0).length, 2,
    '「#0」必须是回退名而不是「草图 草图 #0」，且 ②③ 各出现一次');
});

check('回归：两条**同名**草图靠「第 N 条 / 基准面」区分（同名不再无法辨认）', () => {
  const lines = [
    { sketchIndex: 0, sketchName: 'Sketch1', sketchPlane: '基准面-前视', polylineIndex: 0, kind: 'line', lengthMm: 2, start: [0, 0, 0], end: [2, 0, 0] },
    { sketchIndex: 1, sketchName: 'Sketch1', sketchPlane: '基准面-上视', polylineIndex: 0, kind: 'line', lengthMm: 3, start: [0, 0, 5], end: [3, 0, 5] },
  ];
  const text = T.buildSketchSelectionInstruction({ file: 'x.STEP', designId: 'd', lines, points: [] });
  // 契约变更：新格式里分组标题**行首有缩进**（`  草图 Sketch1（...`），所以先 trim 再比。
  // 核心不变量不变：两条同名草图必须各有一行，且两行**必须可区分**。
  const rows = text.split('\n')
    .filter((row) => row.trim().indexOf('草图 Sketch1') === 0);
  assert.equal(rows.length, 4, '②③ 两段各两行（同名草图共 4 行）：' + JSON.stringify(rows));
  // ②段
  assert.equal(rows[0].trim(), '草图 Sketch1（第 1 条 / 基准面-前视，1 条折线 / 0 个端点）：');
  assert.equal(rows[1].trim(), '草图 Sketch1（第 2 条 / 基准面-上视，1 条折线 / 0 个端点）：');
  // ③段
  assert.equal(rows[2].trim(), '草图 Sketch1（第 1 条 / 基准面-前视）：');
  assert.equal(rows[3].trim(), '草图 Sketch1（第 2 条 / 基准面-上视）：');
  assert.equal(rows[0].trim() !== rows[1].trim(), true, '两条同名草图的两行必须可区分（旧实现逐字节相同）');
  assert.equal(rows[2].trim() !== rows[3].trim(), true, '③段两行也必须可区分');
  // 坐标也必须各归各家（[1] 是真第一条的坐标，[2] 是第二条）
  assert.equal(text.includes('    [1] 折线 #0 直线 长 2.0 mm 起点 [0.00,0.00,0.00] 终点 [2.00,0.00,0.00]'), true,
    '第一条的坐标必须归第一条：' + text);
  assert.equal(text.includes('    [2] 折线 #0 直线 长 3.0 mm 起点 [0.00,0.00,5.00] 终点 [3.00,0.00,5.00]'), true,
    '第二条的坐标必须归第二条：' + text);
  // 信息条同理：前缀带「第 N 条」
  const bar = T.buildSketchSelectionText(lines, []);
  assert.equal(bar, [
    '已选 2 条线、0 个点（合计 5.0 mm）',
    '草图 Sketch1（第 1 条） · 线 #0（直线，长 2.0 mm）',
    '草图 Sketch1（第 2 条） · 线 #0（直线，长 3.0 mm）',
  ].join('\n'));
  // 身份串本身
  assert.equal(T.sketchGroupIdentity({ sketchIndex: 1, sketchPlane: '基准面-上视' }), '第 2 条 / 基准面-上视');
  assert.equal(T.sketchGroupIdentity({ sketchIndex: 0 }), '第 1 条', '没有基准面时只写「第 N 条」');
});

check('必改7/阻断项4：草图视图真的被节流，且热路径不重建索引（走真实 pointermove）', () => {
  // 这一条同时服务三件事：
  //   (a) 节流**接线**正确（M20：把 HOVER_THROTTLE_MS 改成 3000 → 悬停彻底卡死，必须红）
  //   (b) 节流窗口**语义**正确（窗口内不更新、窗口外必须更新）
  //   (c) 生产路径**缓存**端点索引（M6：entry.pointIndex 换回 entry.polylines 每帧重建 → 必须红）
  // 用注入式假时钟：确定性，不靠碰运气，也杀得掉「间隔写错」的变异。
  const pad = [];
  for (let i = 0; i < 5000; i += 1) pad.push({ points: [[0, 0, 0], [10, 0, 0]], closed: false, kind: 'line' });
  const bigPayload = {
    ok: true, unit: 'mm',
    sketches: [{
      id: 'big', name: 'BIG',
      polylines: [
        { points: [[0, 0, 0], [10, 0, 0]], closed: false, kind: 'line' },   // 折线 0
        { points: [[10, 0, 0], [10, 10, 0]], closed: false, kind: 'line' },  // 折线 1
      ].concat(pad),
      bbox: [0, 0, 0, 10, 10, 0],
    }],
  };
  const container = makeElement();
  container.ownerDocument = headlessDoc;
  container.parentNode = makeElement();
  const model = T.buildSketchOnlyModel(bigPayload, { path: 'C:\\x\\big.SLDPRT', minSize: 20 });
  model.sketch = bigPayload;
  assert.equal(model.stats.triangleCount, 0, '前提：草图视图 triangleCount 恒为 0（旧判据在这里永远 false）');
  // 计数器是模块级的（前面的用例也建过索引）：从这里开始归零，只数这个 viewer 的
  T.resetSketchPointIndexBuilds();
  const viewer = T.createViewer(container, model, {});
  viewer.setSketches(bigPayload);
  viewer.fit();
  const dom = canvasOf(container);

  const onLine0 = screenOf(container, viewer, [5, 0, 0]);
  const onLine1 = screenOf(container, viewer, [10, 5, 0]);
  const move = (p) => dom.dispatch('pointermove', {
    clientX: p.clientX, clientY: p.clientY, pointerId: 1,
    button: -1, preventDefault() {}, stopPropagation() {},
  });
  const hovered = () => viewer.getSketchHighlightState().hoveredLineKey;

  // 假时钟：从 1000ms 开始，测试自己推进
  let clock = 1000;
  T.setHoverClock(() => clock);
  try {
    move(onLine0);
    assert.equal(hovered(), 'sk:0:0', '第一次悬停必须命中折线 0（实际 ' + hovered() + '）');
    // 同一个 33ms 窗口内（+10ms）再移动到折线 1：必须被节流掉
    clock += 10;
    move(onLine1);
    assert.equal(hovered(), 'sk:0:0',
      '窗口内（+10ms）第二次 pointermove 必须被节流，悬停不许更新（实际 ' + hovered() + '）');
    // 越过窗口（+40ms）再移动：必须更新到折线 1
    clock += 40;
    move(onLine1);
    assert.equal(hovered(), 'sk:0:1',
      '窗口外（+50ms）第二次 pointermove 必须更新悬停到折线 1。' +
      '若这里还是 sk:0:0，说明节流间隔被写成了很大值（M20：33→3000 会让悬停彻底卡死）');
    // 再回到折线 0：同样要生效
    clock += 40;
    move(onLine0);
    assert.equal(hovered(), 'sk:0:0', '窗口外再移动回折线 0 也必须生效');

    // (c) 索引缓存：三次 pointermove 之后，端点索引的构建次数必须**不随移动次数增长**。
    // setSketches 一次建 entry（1 次），此后每次 pointermove 必须复用 entry.pointIndex。
    const buildsAfterMoves = T.getSketchPointIndexBuilds();
    const before = buildsAfterMoves;
    for (let k = 0; k < 20; k += 1) { clock += 40; move(onLine1); clock += 40; move(onLine0); }
    const after = T.getSketchPointIndexBuilds();
    assert.equal(after - before, 0,
      '20 次 pointermove（40 次移动）之后端点索引构建次数必须**不再增长**（实际 +' +
      (after - before) + '）。这杀的是 M6：「把 entry.pointIndex 换回 entry.polylines」会让' +
      '每次悬停都重建 50002 个点的索引，正是我们刚修掉的 2.5ms/次成本');
    assert.ok(after <= 2, '整个测试里索引最多建 2 次（createViewer + setSketches），实际 ' + after);
  } finally {
    T.setHoverClock(null);
  }

  // 对照组：小草图（未超阈值）同样的两次移动**必须**立即更新 ——
  // 否则「节流」被写成「悬停永远不更新」也能过上面那条断言。
  const { viewer: smallViewer, container: smallContainer } = makeE2EViewer();
  const smallDom = canvasOf(smallContainer);
  const s0 = screenOf(smallContainer, smallViewer, [5, 0, 0]);
  const s1 = screenOf(smallContainer, smallViewer, [10, 5, 0]);
  const moveSmall = (p) => smallDom.dispatch('pointermove', {
    clientX: p.clientX, clientY: p.clientY, pointerId: 1,
    button: -1, preventDefault() {}, stopPropagation() {},
  });
  moveSmall(s0);
  assert.equal(smallViewer.getSketchHighlightState().hoveredLineKey, 'sk:0:0', '小草图第一次悬停折线 0');
  moveSmall(s1);
  assert.equal(smallViewer.getSketchHighlightState().hoveredLineKey, 'sk:0:1',
    '小草图不节流：第二次悬停必须立刻切到折线 1');
  smallViewer.dispose();
  viewer.dispose();
});

check('诚实标注：「整条草图」兜底（subject:sketch）在屏幕上不可达（防御性死代码）', () => {
  // 审计要求：不要假装它被覆盖了。这一条把「不可达」这件事**测出来**并留在套件里，
  // 这样以后谁改了容差逻辑、让它变可达，会立刻在这里看到（而不是靠注释猜）。
  // 不可达的原因：第 3 档用的射线阈值与第 2 档完全相同，第 2 档已经扫过所有段；
  // 所以「第 3 档命中」⇒「第 2 档命中」⇒ bestLine 非空 ⇒ 这个分支进不去。
  const { viewer, container } = makeE2EViewer();
  void container;
  const counts = {};
  let sampled = 0;
  for (let y = 0; y < 600; y += 6) {
    for (let x = 0; x < 800; x += 6) {
      const hit = viewer.pick(x, y);
      const key = hit ? hit.subject : 'null';
      counts[key] = (counts[key] || 0) + 1;
      sampled += 1;
    }
  }
  assert.ok(sampled > 10000, '采样量必须够大：' + sampled);
  assert.ok(counts.sketchLine > 20, '折线档必须真能选中（否则采样区域不对）：' + JSON.stringify(counts));
  assert.ok(counts.sketchPoint > 5, '端点档必须真能选中：' + JSON.stringify(counts));
  assert.equal(counts.sketch || 0, 0,
    'subject:sketch 在' + sampled + ' 个屏幕采样点里必须 0 次命中 —— 它是防御性死代码。' +
    '如果这条红了：要么你放宽了容差让它变可达（那就把这条改成正面覆盖），' +
    '要么兜底分支被改坏了。实测 ' + JSON.stringify(counts));
  // 但契约层面它必须仍然存在（select()/右键菜单/面板都依赖 'sketch' 这一档）
  assert.equal(T.pickSubjectByPriority({ sketch: {} }), 'sketch', '优先级函数里这一档仍然是公开契约');
  assert.deepEqual(T.contextMenuItemsFor({ subject: 'sketch', sketchIndex: 0 }).map((i) => i.id),
    ['select-all', 'edit-sketch'], '整条草图的右键菜单仍然存在');
  viewer.dispose();
});

/* ------------------------------------------------------------------ */
/* 11. 终审回归：编辑这条草图 / 全选先清空 / 右键不摧毁多选 / 强调色          */
/* ------------------------------------------------------------------ */

/** 建一个带两条草图的 viewer（A 有 2 条线、B 有 3 条线），跨草图断言用。 */
function makeTwoSketchViewer(extraCallbacks) {
  const payload = {
    ok: true, unit: 'mm', designId: 'two-01',
    sketches: [
      {
        id: 'sk-a', name: 'Sketch_A', plane: '基准面-前视', feature: 'Boss-Extrude1',
        polylines: [
          { points: [[0, 0, 0], [10, 0, 0]], closed: false, kind: 'line' },
          { points: [[10, 0, 0], [10, 6, 0]], closed: false, kind: 'line' },
        ],
        bbox: [0, 0, 0, 10, 6, 0],
      },
      {
        id: 'sk-b', name: 'Sketch_B', plane: '基准面-上视', feature: 'Cut-Extrude2',
        polylines: [
          { points: [[0, 20, 0], [8, 20, 0]], closed: false, kind: 'line' },
          { points: [[8, 20, 0], [8, 26, 0]], closed: false, kind: 'line' },
          { points: [[8, 26, 0], [0, 26, 0]], closed: false, kind: 'line' },
        ],
        bbox: [0, 20, 0, 8, 26, 0],
      },
    ],
  };
  const container = makeElement();
  container.ownerDocument = headlessDoc;
  container.parentNode = makeElement();
  const model = T.buildSketchOnlyModel(payload, { path: 'C:\\x\\two.SLDPRT', minSize: 40 });
  model.sketch = payload;
  const log = { select: [], edit: [], menu: [] };
  const viewer = T.createViewer(container, model, Object.assign({
    onSelect(sel) { log.select.push(sel); },
    onSketchEdit(text) { log.edit.push(text); },
    onMenuAction(payload2) { log.menu.push(payload2); },
    sketchFile: 'C:\\x\\two.SLDPRT',
  }, extraCallbacks || {}));
  viewer.setSketches(payload);
  viewer.fit();
  return { viewer, container, log, payload };
}

/** 取当前菜单（最后一个 .sw3d-menu）里的全部按钮项，**不点击、无副作用**。
 *  「想知道菜单里有没有某一项」和「点某一项」共用这一套查找，避免两条各写一遍。 */
function menuItemButtons(container) {
  const menus = (container.children || []).filter((c) => c && c.className === 'sw3d-menu');
  assert.ok(menus.length > 0, '菜单必须存在');
  const menu = menus[menus.length - 1];
  return (menu.children || []).filter((c) => c && c.className === 'sw3d-menu-item');
}

/** 点菜单里某个 data-action 的按钮（真 DOM 点击路径，不是直调函数）。 */
function clickMenuItem(container, actionId) {
  const buttons = menuItemButtons(container);
  const button = buttons.find((b) => b.getAttribute('data-action') === actionId);
  assert.ok(button, '菜单里必须有 ' + actionId + ' 这一项（实际 ' +
    JSON.stringify(buttons.map((b) => b.getAttribute('data-action'))) + '）');
  button.dispatch('click', { preventDefault() {}, stopPropagation() {} });
  return buttons;
}

check('阻断项1：右键「编辑这条草图」真的生成指令（onSketchEdit 收到以 [3D标注] 开头的文本）', () => {
  const { viewer, container, log } = makeTwoSketchViewer();
  const onLine = screenOf(container, viewer, [5, 0, 0]);        // 草图 A 的折线 0
  viewer.showContextMenu(onLine.clientX, onLine.clientY);
  assert.equal(log.edit.length, 0, '前提：右键本身不生成指令');
  clickMenuItem(container, 'edit-sketch');
  // 核心断言：走真实菜单点击路径 → onSketchEdit 收到文本
  assert.equal(log.edit.length, 1,
    '点「编辑这条草图」必须调 cb.onSketchEdit（旧版整条草图档不可达 → 这里 0 次）');
  const text = log.edit[0];
  assert.ok(text.startsWith('[3D标注] 文件：'),
    '指令必须以 [3D标注] 文件： 开头，实际：' + JSON.stringify(text.slice(0, 40)));
  // 逐字符：这是 buildSketchEditInstruction 的输出（草图名/特征/基准面/几何/修改意见）
  assert.equal(text, [
    '[3D标注] 文件：C:\\x\\two.SLDPRT 设计ID：two-01',
    '选中：草图 Sketch_A（属于特征「Boss-Extrude1」，绘制在 基准面-前视）',
    '尺寸：（该草图没有可读尺寸）',
    '几何：2 条折线（2 直线），包围盒 [0,0,0]–[10,6,0] mm',
    '修改意见：（在这里补完你想怎么改）',
  ].join('\n'));
  // 引擎侧状态也摆正了：整条草图被选中（面板有内容）
  assert.equal(viewer.getSketchState().selected, 0, 'selectedSketchIndex 必须被置为 0');
  // onMenuAction 里也带着同一份文本（React 侧兜底用）
  const menuCall = log.menu[log.menu.length - 1];
  assert.equal(menuCall.action, 'edit-sketch');
  assert.equal(menuCall.instruction, text, 'payload.instruction 与 onSketchEdit 的文本必须一致');
  viewer.closeContextMenu();
  viewer.dispose();
});

check('阻断项1：「编辑这条草图」对草图端点同样可用，且文本指向那条草图', () => {
  const { viewer, container, log } = makeTwoSketchViewer();
  const onPoint = screenOf(container, viewer, [8, 20, 0]);      // 草图 B 的折线 0 端点
  const picked = viewer.pick(onPoint.clientX, onPoint.clientY);
  assert.equal(picked.subject, 'sketchPoint', '前提：命中草图 B 的端点');
  assert.equal(picked.sketchIndex, 1, '前提：是草图 B（下标 1）');
  viewer.showContextMenu(onPoint.clientX, onPoint.clientY);
  clickMenuItem(container, 'edit-sketch');
  assert.equal(log.edit.length, 1, '端点右键「编辑这条草图」也必须生成指令');
  assert.ok(log.edit[0].startsWith('[3D标注] 文件：'), log.edit[0].slice(0, 40));
  assert.equal(log.edit[0].includes('Sketch_B'), true, '指令必须指向 Sketch_B：' + log.edit[0]);
  assert.equal(log.edit[0].includes('Sketch_A'), false, '不许串到 Sketch_A：' + log.edit[0]);
  assert.equal(viewer.getSketchState().selected, 1, 'selectedSketchIndex 必须是草图 B');
  viewer.closeContextMenu();
  viewer.dispose();
});

check('阻断项1：面板里的「编辑这条草图」按钮与右键走同一套文本', () => {
  // 整条草图档不可达，但 showSketchPanel 仍然会被 selectSketch / editSketchFromMenu 调到；
  // 这里直接验证「面板按钮」这条路径也真的回调（两个入口的文本必须一致）。
  const { viewer, container, log } = makeTwoSketchViewer();
  const onLine = screenOf(container, viewer, [5, 0, 0]);
  viewer.showContextMenu(onLine.clientX, onLine.clientY);
  clickMenuItem(container, 'edit-sketch');
  const fromMenu = log.edit[0];
  // 面板挂在 container 上；点它的按钮
  const panels = (container.children || []).filter((c) => c && c.__listeners);
  void panels;
  const panel = (container.children || []).find((c) => c && c.className === 'sw3d-sketch-panel');
  assert.ok(panel, '面板必须被创建（showSketchPanel）');
  const buttons = (panel.children || []).filter((c) => c && c.className === 'sw3d-sketch-edit');
  assert.equal(buttons.length, 1, '面板里必须有「编辑这条草图」按钮（旧版存在，不能丢）');
  assert.equal(buttons[0].textContent, '编辑这条草图');
  buttons[0].dispatch('click', { stopPropagation() {} });
  assert.equal(log.edit.length, 2, '点面板按钮也必须回调 onSketchEdit');
  assert.equal(log.edit[1], fromMenu, '面板与右键生成的文本必须逐字符一致');
  viewer.closeContextMenu();
  viewer.dispose();
});

check('阻断项2：跨草图「全选本草图」先清空已有选择（不再串味）', () => {
  const { viewer, container } = makeTwoSketchViewer();
  // 先选草图 B 的 1 条线
  const b0 = screenOf(container, viewer, [4, 20, 0]);
  clickAt(container, b0);
  assert.deepEqual(viewer.getSketchState().lineKeys, ['sk:1:0'], '前提：选中了草图 B 的折线 0');
  // 对草图 A 点「全选本草图」
  const a0 = screenOf(container, viewer, [5, 0, 0]);
  viewer.showContextMenu(a0.clientX, a0.clientY);
  clickMenuItem(container, 'select-all');
  // 改前：["sk:1:0","sk:0:0","sk:0:1"]（3 条，B 那条还在）；改后：只有 A 的 2 条
  assert.deepEqual(viewer.getSketchState().lineKeys, ['sk:0:0', 'sk:0:1'],
    '全选草图 A 之后集合必须**只有** A 的 2 条线（旧实现保留 B 的那条，共 3 条）');
  assert.equal(viewer.getSketchState().selectedLines, 2, '条数必须是 2，不是 3');
  // 返回值也必须说真话（不是回显 entry.polylines.length：全选后集合里就是它，
  // 中间若被别的逻辑改动，返回值必须反映**集合实际大小**）
  const again = viewer.selectAllSketchLines(1);
  assert.deepEqual(again, { lines: 3, points: 0 }, '全选草图 B：3 条线、0 个点');
  assert.equal(again.lines, viewer.getSketchState().selectedLines,
    '返回值必须等于集合实际条数（旧语义返回 entry.polylines.length，与集合脱钩）');
  assert.deepEqual(viewer.getSketchState().lineKeys, ['sk:1:0', 'sk:1:1', 'sk:1:2'],
    '全选草图 B 之后只剩 B 的 3 条线（A 的已清掉）');
  // 有一个「全选后集合 != 折线数」的真实场景：草图里有一条只有 1 个点的退化折线
  // （sketchPolylineSegmentCount === 0，不会进集合）。此时返回 entry.polylines.length 就会说谎。
  const degenerate = {
    ok: true, unit: 'mm',
    sketches: [{
      id: 'deg', name: 'DEG', polylines: [
        { points: [[0, 0, 0], [5, 0, 0]], closed: false, kind: 'line' },
        { points: [[5, 5, 0]], closed: false, kind: 'line' },        // 1 个点 = 0 段，不可选
      ], bbox: [0, 0, 0, 5, 5, 0],
    }],
  };
  const c2 = makeElement();
  c2.ownerDocument = headlessDoc;
  c2.parentNode = makeElement();
  const m2 = T.buildSketchOnlyModel(degenerate, { path: 'C:\\x\\deg.SLDPRT', minSize: 10 });
  m2.sketch = degenerate;
  const v2 = T.createViewer(c2, m2, {});
  v2.setSketches(degenerate);
  v2.fit();
  const degResult = v2.selectAllSketchLines(0);
  assert.deepEqual(degResult, { lines: 1, points: 0 },
    '退化折线（1 个点、0 段）不进集合，所以是 1 条而不是 2 条 —— ' +
    '返回 entry.polylines.length 会报 2，与集合和画布都不一致');
  assert.equal(degResult.lines, v2.getSketchState().selectedLines);
  assert.deepEqual(v2.getSketchState().lineKeys, ['sk:0:0'], '只有可画的第 1 条进集合');
  v2.dispose();
  // 信息条文本用的是 A 自己的名字（不串）
  assert.equal(viewer.getSketchSelection().lines.every((l) => l.sketchIndex === 1), true);
  viewer.closeContextMenu();
  viewer.dispose();
});

check('必改5：右键**未选中**的草图项不摧毁多选（集合非空时右键不动选择）', () => {
  const { viewer, container } = makeTwoSketchViewer();
  // 选中草图 A 的折线 0 和折线 1（用 Ctrl 多选）
  const a0 = screenOf(container, viewer, [5, 0, 0]);
  const a1 = screenOf(container, viewer, [10, 3, 0]);
  clickAt(container, a0);
  clickAt(container, a1, { ctrlKey: true });
  assert.deepEqual(viewer.getSketchState().lineKeys, ['sk:0:0', 'sk:0:1'], '前提：已选 2 条');
  // 右键**未选中**的草图 B 折线 0
  const b0 = screenOf(container, viewer, [4, 20, 0]);
  const picked = viewer.pick(b0.clientX, b0.clientY);
  assert.equal(picked.subject, 'sketchLine');
  assert.equal(picked.sketchIndex, 1);
  viewer.showContextMenu(b0.clientX, b0.clientY);
  // 改前：["sk:0:1"]（多选被替换成 1 条）；改后：一个字节都不动
  assert.deepEqual(viewer.getSketchState().lineKeys, ['sk:0:0', 'sk:0:1'],
    '右键未选中的草图项不许摧毁多选（右键不是选择操作）');
  assert.equal(viewer.getSketchSelection().lines.length, 2,
    '「把所选填进对话框」必须仍拿到 2 条');
  // 菜单里仍然有「把所选填进对话框」（因为集合非空）——只查不点：点它会执行 draft 生成，
  // 而这里要断言的是**菜单项存在**。旧写法点的却是 select-all（副作用：把集合换成另一条草图的全部线），
  // 返回值被 `&& null` 丢掉再 void，等于什么都没断言。
  const actions = menuItemButtons(container).map((b) => b.getAttribute('data-action'));
  assert.ok(actions.includes('sketch-fill'),
    '集合非空时右键**未选中**的草图项，菜单里必须有「把所选填进对话框」（实际菜单项：' +
    JSON.stringify(actions) + '）');
  // 顺带核对标签是「把所选填进对话框」（不是别的项凑数）
  const fillButton = menuItemButtons(container).find((b) => b.getAttribute('data-action') === 'sketch-fill');
  assert.equal((fillButton.children || []).map((x) => x.textContent || '').join(''), '把所选填进对话框',
    '这一项的标签必须是「把所选填进对话框」');
  // 集合没被这一轮动过（既没点 select-all，也没被右键摧毁）
  assert.deepEqual(viewer.getSketchState().lineKeys, ['sk:0:0', 'sk:0:1'],
    '枚举菜单项不许改动多选集合');
  viewer.closeContextMenu();

  // 对照组：集合为空时右键照旧选中它（老路径不能坏）
  viewer.clearSketchSelection();
  assert.equal(viewer.getSketchState().selectedLines, 0);
  viewer.showContextMenu(b0.clientX, b0.clientY);
  assert.deepEqual(viewer.getSketchState().lineKeys, ['sk:1:0'],
    '集合为空时右键必须选中命中项（老行为不变）');
  viewer.closeContextMenu();
  viewer.dispose();
});

check('必改6：悬停时整条草图的强调色 ≠ 选中色（多选高亮不被淹没）', () => {
  assert.notEqual(T.SKETCH_EMPHASIS_COLOR, T.SKETCH_HOVER_COLOR,
    '整条草图的强调色（0x' + T.SKETCH_EMPHASIS_COLOR.toString(16) +
    '）必须不等于选中色（0x' + T.SKETCH_HOVER_COLOR.toString(16) + '）');
  const { viewer, container } = makeTwoSketchViewer();
  // 选中 2 条，然后悬停第 3 条（同一草图内）
  const a0 = screenOf(container, viewer, [5, 0, 0]);
  const a1 = screenOf(container, viewer, [10, 3, 0]);
  clickAt(container, a0);
  clickAt(container, a1, { ctrlKey: true });
  assert.equal(viewer.getSketchState().selectedLines, 2);
  const dom = canvasOf(container);
  const hoverAt = screenOf(container, viewer, [5, 0, 0]);
  dom.dispatch('pointermove', {
    clientX: hoverAt.clientX, clientY: hoverAt.clientY, pointerId: 1,
    button: -1, preventDefault() {}, stopPropagation() {},
  });
  const hl = viewer.getSketchHighlightState();
  assert.equal(hl.hoveredLineKey, 'sk:0:0', '前提：悬停到折线 0');
  // 整条草图的 LineSegments 现在应该是强调色（提亮青绿），**不是**选中色
  const entryColor = hl.sketchEntryColors[0];
  assert.equal(entryColor, T.SKETCH_EMPHASIS_COLOR,
    '悬停时整条草图必须用强调色 0x' + T.SKETCH_EMPHASIS_COLOR.toString(16) +
    '，实际 0x' + (entryColor || 0).toString(16));
  assert.notEqual(entryColor, hl.pickLines.color,
    '整条草图的颜色不许等于已选中折线的颜色（旧实现两者都是 0xffe479，ΔE76=0）');
  viewer.dispose();
});

/* --- sketchNote 抛异常不能带崩「编辑这条草图」 ---------------------------------
 * cb.sketchNote 是外部嵌入方的回调（React 宿主目前不传）。它抛了如果没人兜，
 * 异常会从 click handler 冒出去：此刻选中态已改、面板已弹，但 onSketchEdit 没拿到文本
 * →「面板在、选中在、输入框空」的不一致状态。这条断言就是钉住「兜住了」。
 * 变异方式：把 client.js 里 sketchEditInstructionFor 的 try/catch 去掉（直接
 * `note: cb.sketchNote()`），这条必红。 */
check('阻断项3：cb.sketchNote 抛异常时「编辑这条草图」仍然工作（面板/选中/文本都不丢）', () => {
  let noteCalls = 0;
  const { viewer, container, log } = makeTwoSketchViewer({
    sketchNote() { noteCalls += 1; throw new Error('boom from sketchNote'); },
  });
  const onLine = screenOf(container, viewer, [5, 0, 0]);   // 草图 A 的折线 0
  viewer.showContextMenu(onLine.clientX, onLine.clientY);
  // 真实点击路径：异常绝不能冒到 dispatch 外面（冒出去这行直接 throw → 本 check 变红）
  clickMenuItem(container, 'edit-sketch');
  assert.equal(noteCalls, 1, '前提：确实调到了会抛的 sketchNote（兜的是它，不是没调用）');
  // 1) onSketchEdit 仍然被调用，且文本正确（抛异常只丢「修改意见」，其余照常）
  assert.equal(log.edit.length, 1,
    'sketchNote 抛异常时 onSketchEdit 仍必须被调用（旧实现里异常从这里冒出去 → 0 次）');
  const text = log.edit[0];
  assert.equal(text, [
    '[3D标注] 文件：C:\\x\\two.SLDPRT 设计ID：two-01',
    '选中：草图 Sketch_A（属于特征「Boss-Extrude1」，绘制在 基准面-前视）',
    '尺寸：（该草图没有可读尺寸）',
    '几何：2 条折线（2 直线），包围盒 [0,0,0]–[10,6,0] mm',
    '修改意见：（在这里补完你想怎么改）',
  ].join('\n'), '抛异常后文本必须与「没有修改意见」时逐字符一致，实际：' + JSON.stringify(text));
  // 2) 选中态摆正了（面板与卡片都还在）
  assert.equal(viewer.getSketchState().selected, 0, 'selectedSketchIndex 仍然必须是 0');
  assert.ok(viewer.getSketchState().selected >= 0, 'getSketchState().selected 必须 >= 0');
  // 3) 面板照旧弹出（用户看到的东西不少）
  const panel = (container.children || []).find((c) => c && c.className === 'sw3d-sketch-panel');
  assert.ok(panel, '面板必须仍然被创建（异常不许回滚界面）');
  // 4) onMenuAction 也照常收到，且 instruction 与 onSketchEdit 的文本一致
  const menuCall = log.menu[log.menu.length - 1];
  assert.equal(menuCall.action, 'edit-sketch');
  assert.equal(menuCall.instruction, text, 'payload.instruction 必须与 onSketchEdit 的文本一致');
  // 5) 面板按钮走同一个生成函数 → 同样不炸
  const editButtons = (panel.children || []).filter((c) => c && c.className === 'sw3d-sketch-edit');
  assert.equal(editButtons.length, 1);
  editButtons[0].dispatch('click', { stopPropagation() {} });
  assert.equal(noteCalls, 2, '面板按钮也要走到 sketchNote');
  assert.equal(log.edit.length, 2, '面板按钮在 sketchNote 抛异常时也必须回调 onSketchEdit');
  assert.equal(log.edit[1], text, '两条入口在异常下的文本必须一致');
  viewer.closeContextMenu();
  viewer.dispose();
});

/* ------------------------------------------------------------------ */
/* 11. 截图标记：编号与正文同源 / getSnapshotMarkers 真的接进了调用链      */
/* ------------------------------------------------------------------ */

check('截图标记：编号与正文 [1]…[N] 同源，顺序 = sketchSelectionNumberedPlan', () => {
  // 跨草图 + 端点混选：两条草图各有 polylineIndex=0 的折线，另有一个端点
  const lines = [
    { sketchIndex: 0, sketchName: 'Sketch_A', sketchPlane: '基准面-上视', polylineIndex: 0, kind: 'line', lengthMm: 10, start: [0, 0, 0], end: [10, 0, 0], anchor: [5, 20, 0] },
    { sketchIndex: 1, sketchName: 'Sketch_B', sketchPlane: '基准面-前视', polylineIndex: 0, kind: 'line', lengthMm: 20, start: [0, 5, 0], end: [20, 5, 0], anchor: [10, 40, 0] },
  ];
  const points = [{ sketchIndex: 0, polylineIndex: 0, pointIndex: 1, position: [30, 60, 0] }];
  const plan = T.sketchSelectionNumberedPlan(lines, points);
  assert.equal(plan.entries.length, 3);
  // 假投影：世界坐标 → CSS 像素（简单线性，方便断言）
  const markers = T.snapshotMarkersFromPlan(plan, (p) => ({ x: p[0] * 10, y: p[1] * 10, z: 0.3 }));
  assert.equal(markers.length, 3, '三个对象必须三个标记：' + JSON.stringify(markers));
  assert.deepEqual(markers.map((m) => m.label), ['[1]', '[2]', '[3]'], '标签就是正文编号');
  assert.deepEqual(markers.map((m) => m.number), [1, 2, 3], '编号连续、从 1 开始');
  // 顺序 = 分组顺序（首次出现），**组内先折线后端点**：所以端点在它自己那条草图组里
  // 排在折线之后 → [1] 折线#0(sk0)、[2] 端点(sk0)、[3] 折线#0(sk1)。
  // 折线用 anchor、端点用 position（三个点位互不重叠，不会被「重叠错开」逻辑推移）
  assert.deepEqual([markers[0].x, markers[0].y], [50, 200], '折线 #0 用 anchor [5,20,0]');
  assert.deepEqual([markers[1].x, markers[1].y], [300, 600], '端点用 position [30,60,0]（组内折线之后）');
  assert.deepEqual([markers[2].x, markers[2].y], [100, 400], '折线 #1 用 anchor [10,40,0]（第二条草图）');
  // 重叠错开：两个点位几乎重合时必须错开，否则图上的编号会「叠在一起只剩一个」
  const overlapping = T.snapshotMarkersFromPlan({
    entries: [{ number: 1, kind: 'line', anchor: [1, 1, 0] }, { number: 2, kind: 'line', anchor: [1, 1, 0] }],
  }, (p) => ({ x: p[0] * 10, y: p[1] * 10, z: 0.2 }));
  assert.notDeepEqual([overlapping[0].x, overlapping[0].y], [overlapping[1].x, overlapping[1].y],
    '两个标记压在同一点时必须错开（旧的单标记实现里第二个编号直接看不见）');
  // 编号与正文【②】【③】里的编号必须完全一致（同一份 plan）
  const text = T.buildSketchSelectionInstruction({ file: 'x.STEP', designId: 'd', lines, points });
  for (const m of markers) {
    assert.equal(text.includes(m.label + ' '), true, '正文里必须有 ' + m.label + '：' + text);
  }
  // 退化：没有 project / 空 plan / 点在相机后面 → 不炸、不产生标记
  assert.deepEqual(T.snapshotMarkersFromPlan(null, () => ({ x: 1, y: 1, z: 0 })), []);
  assert.deepEqual(T.snapshotMarkersFromPlan(plan, null), []);
  const behind = T.snapshotMarkersFromPlan(plan, () => ({ x: 1, y: 1, z: 2.5 }));
  assert.equal(behind.length, 3, '相机后面的标记仍然返回（但 visible=false，由绘制层过滤）');
  assert.equal(behind.every((m) => m.visible === false), true, 'z>1.6 必须 visible=false');
  const hidden = T.snapshotMarkersFromPlan(plan, () => ({ x: 1, y: 1, z: 0.2 }), () => false);
  assert.equal(hidden.every((m) => m.visible === false), true, '剖切掉的点必须 visible=false');
});

check('截图标记：viewer.getSnapshotMarkers 真的接进了 captureShot 调用链（多选标全）', () => {
  // 这条是「多选时只有第一个点被标」的解药：断言的是**生产路径**——
  // 真 createViewer → 真多选集合 → getSnapshotMarkers() → runSnapshotFlow → composeSnapshot 画出 N 个编号。
  const container = makeElement();
  container.ownerDocument = headlessDoc;
  container.parentNode = makeElement();
  const model = T.buildSketchOnlyModel(E2E_PAYLOAD, { path: 'C:\\x\\e2e.SLDPRT', minSize: 20 });
  model.sketch = E2E_PAYLOAD;
  const viewer = T.createViewer(container, model, {});
  viewer.setSketches(E2E_PAYLOAD);
  viewer.fit();
  assert.equal(typeof viewer.getSnapshotMarkers, 'function', 'viewer 必须暴露 getSnapshotMarkers');
  // 没选中：空数组（退回旧的单标记逻辑，不能凭空画编号）
  assert.deepEqual(viewer.getSnapshotMarkers(), [], '没有多选时必须返回空数组');
  // 选两条折线 + 一个端点
  viewer.setSketchMultiSelect(['sk:0:0', 'sk:0:1'], ['sk:0:0:pt:0']);
  const markers = viewer.getSnapshotMarkers();
  assert.equal(markers.length, 3, '2 条折线 + 1 个端点 = 3 个标记（旧实现只有一个）：' + JSON.stringify(markers));
  assert.deepEqual(markers.map((m) => m.label), ['[1]', '[2]', '[3]'], '编号连续且与正文同源');
  // 坐标必须是**屏幕像素**（落在 800×600 的画布范围内，而不是世界坐标的个位数）
  const rect = container.getBoundingClientRect();
  for (const m of markers) {
    assert.equal(m.x >= -1 && m.x <= rect.width + 1, true, '标记 x 必须在画布内（CSS 像素）：' + m.x);
    assert.equal(m.y >= -1 && m.y <= rect.height + 1, true, '标记 y 必须在画布内（CSS 像素）：' + m.y);
  }
  // 与 viewer.project 同一套换算：折线锚点 = sketchPolylineAnchor（点序列里中间那个点，
  // 2 点折线就是 index 1 = [10,0,0]），端点用 position。同一点位必须近似相等。
  const anchorOfLine0 = T.sketchPolylineAnchor(E2E_PAYLOAD.sketches[0].polylines[0]);
  assert.deepEqual(anchorOfLine0, [10, 0, 0], '前提：2 点折线的锚点是 index 1');
  const viaProject = viewer.project(anchorOfLine0);
  assert.ok(Math.abs(markers[0].x - viaProject.x) < 1e-6,
    '标记 x 必须与 viewer.project 一致：' + markers[0].x + ' vs ' + viaProject.x);
  assert.ok(Math.abs(markers[0].y - viaProject.y) < 1e-6,
    '标记 y 必须与 viewer.project 一致：' + markers[0].y + ' vs ' + viaProject.y);

  // 真的走一遍 composeSnapshot：N 个编号必须**全部**画进去
  const drawn = [];
  const ctx = {
    fillStyle: '', strokeStyle: '', font: '', lineWidth: 1,
    fillRect() {}, fillText(text) { drawn.push(String(text)); }, drawImage() {},
    beginPath() {}, arc() {}, stroke() {}, moveTo() {}, lineTo() {},
    measureText(t) { return { width: String(t).length * 7 }; },
  };
  const composed = T.composeSnapshot(
    { canvas: { width: 800, height: 600 }, cssWidth: 800, cssHeight: 600 },
    { lines: ['x.SLDPRT · 仅草图轮廓（没有实体）'], markers },
    { createCanvas(w, h) { return { width: w, height: h, getContext: () => ctx }; } },
  );
  assert.equal(composed.markers.length, 3, 'composeSnapshot 必须收到全部 3 个标记');
  for (const label of ['[1]', '[2]', '[3]']) {
    assert.equal(drawn.includes(label), true, label + ' 必须真的被画进图里：' + JSON.stringify(drawn));
  }
  assert.equal(composed.badge, '⚠ 用户标注 · 3 处', '徽章必须报出 3 处：' + composed.badge);
  assert.equal(drawn.includes('⚠ 用户标注 · 3 处'), true, '徽章文字必须真的画进图里');
  viewer.dispose();
});

check('截图标记：不可见标记被过滤后编号**不跳号**', () => {
  // 中间那个标记在相机后面 → 剩下两个必须重编成 [1] [2]，不能出现「只有 [1] 和 [3]」
  const plan = {
    entries: [
      { number: 1, kind: 'line', anchor: [0, 0, 0] },
      { number: 2, kind: 'line', anchor: [10, 0, 0] },
      { number: 3, kind: 'point', position: [20, 0, 0] },
    ],
  };
  const markers = T.snapshotMarkersFromPlan(plan, (p) => ({ x: p[0], y: 0, z: p[0] === 10 ? 2.5 : 0.2 }));
  const points = T.snapshotMarkerPoints(markers, { scale: 1 }, 100, 100);
  assert.equal(points.length, 2, '不可见的那一个必须被过滤掉：' + JSON.stringify(points));
  assert.deepEqual(points.map((m) => m.index), [1, 2], '过滤后编号必须连续重排，不许跳号');
  assert.deepEqual(points.map((m) => m.label), ['[1]', '[3]'], '标签仍是正文编号（[1] 和 [3]）');
});

/* ------------------------------------------------------------------ */
/* summary                                                             */
/* ------------------------------------------------------------------ */

const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length ? failed.length + ' test(s) failed' : 'all ' + results.length + ' tests passed'));
if (failed.length) process.exitCode = 1;
