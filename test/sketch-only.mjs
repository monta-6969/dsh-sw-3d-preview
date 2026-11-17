#!/usr/bin/env node
/**
 * 「草图视图」降级（sketch-only）离线测试。
 *
 * 背景（用户直接诉求：「加入兼容此格式」）：
 *   .sldprt/.sldasm 是 SolidWorks 原生件，本插件靠同目录同名 STEP 预览。
 *   一个只有草图、零实体的零件（例：fracture-section-01）**永远导不出 STEP 几何**，
 *   旧行为是甩一块 NO_MESH_SOURCE 红字失败卡 + 让用户「执行 deliver 导出 STEP」——
 *   对它是死循环。现在降级成「草图视图」：ok:true + meshSource:'sketch-only'，
 *   客户端自动打开草图叠加层、用草图包围盒 fit 相机、显式禁用依赖实体几何的能力。
 *
 * 全程离线：不启动 SOLIDWORKS、不连真实 sw-mcp、不写任何 project json。
 *   宿主侧用临时目录里伪造的 %LOCALAPPDATA%\sw-mcp\projects\*.json；
 *   客户端侧把 client.js 当单文件插件加载（同 client-smoke.mjs 的方式）。
 *
 * 运行：node test/sketch-only.mjs     退出码 0 = 全绿。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.dirname(HERE);

/* ------------------------------------------------------------------ */
/* 0. 沙箱：LOCALAPPDATA 指向临时目录，sw-mcp 的 project json 全部伪造   */
/* ------------------------------------------------------------------ */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sw3d-sketch-only-'));
const projectsDir = path.join(sandbox, 'sw-mcp', 'projects');
fs.mkdirSync(projectsDir, { recursive: true });
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA;
process.env.LOCALAPPDATA = sandbox;

let failures = 0;
const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log('ok   ' + name);
  } catch (error) {
    failures += 1;
    results.push({ name, ok: false, error });
    console.log('FAIL ' + name + '\n     ' + (error && error.stack ? error.stack : error));
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('ok   ' + name);
  } catch (error) {
    failures += 1;
    results.push({ name, ok: false, error });
    console.log('FAIL ' + name + '\n     ' + (error && error.stack ? error.stack : error));
  }
}

const { resolveSource } = await import('../lib/resolve.js');
const host = await import('../index.js');

/* ------------------------------------------------------------------ */
/* 1. 伪造一份「只有草图、零实体」的 sw-mcp 记录（形状与真实数据一致）   */
/* ------------------------------------------------------------------ */

const SKETCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw3d-sketch-files-'));
const SKETCH_SLDPRT = path.join(SKETCH_DIR, 'plate-only.SLDPRT');
fs.writeFileSync(SKETCH_SLDPRT, 'fake native sldprt with no step sibling');

// 4 条直线组成一个 20×10 的矩形（line 坐标放在 params 下 —— 真实数据的写法）
const SKETCH_PROJECT = {
  designId: 'plate-only',
  goal: 'plate-only: 1 个特征（sketch×1）',
  definition: {
    designId: 'plate-only',
    schemaVersion: 3,
    units: 'mm',
    features: [
      {
        kind: 'sketch',
        id: 'plate_profile',
        plane: 0,
        curves: [
          { kind: 'line', id: 'b', params: { start: [0, 0], end: [20, 0] } },
          { kind: 'line', id: 'r', params: { start: [20, 0], end: [20, 10] } },
          { kind: 'line', id: 't', params: { start: [20, 10], end: [0, 10] } },
          { kind: 'line', id: 'l', params: { start: [0, 10], end: [0, 0] } },
          { kind: 'circle', id: 'hole', params: { center: [10, 5], radius: 2 } },
        ],
      },
    ],
    params: {},
  },
  artifacts: [{ kind: 'sldprt', path: SKETCH_SLDPRT, bytes: 1234 }],
};
const SKETCH_PROJECT_FILE = path.join(projectsDir, 'plate-only.json');
fs.writeFileSync(SKETCH_PROJECT_FILE, JSON.stringify(SKETCH_PROJECT, null, 2), 'utf8');

/** 有实体的设计（features 里除了 sketch 还有 extrude）→ deliver 有意义，提示不该说「导不出」 */
const SOLID_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw3d-sketch-solid-'));
const SOLID_SLDPRT = path.join(SOLID_DIR, 'bracket.SLDPRT');
fs.writeFileSync(SOLID_SLDPRT, 'fake native');
fs.writeFileSync(
  path.join(projectsDir, 'bracket-no-step.json'),
  JSON.stringify({
    designId: 'bracket-no-step',
    definition: {
      designId: 'bracket-no-step',
      schemaVersion: 3,
      units: 'mm',
      features: [
        { kind: 'sketch', id: 'sk1', plane: 1, curves: [{ kind: 'line', params: { start: [0, 0], end: [5, 0] } }, { kind: 'line', params: { start: [5, 0], end: [5, 5] } }] },
        { kind: 'extrude', id: 'ex1', profile: 'sk1' },
      ],
      params: {},
    },
    artifacts: [{ kind: 'sldprt', path: SOLID_SLDPRT }],
  }),
  'utf8',
);

/* ------------------------------------------------------------------ */
/* 2. 宿主侧 resolveSource：NATIVE 无 STEP 的三种去向                    */
/* ------------------------------------------------------------------ */

await checkAsync('resolveSource：原生件无 STEP + 有草图记录 → ok:true + meshSource:"sketch-only"', async () => {
  const resolved = await resolveSource(SKETCH_SLDPRT);
  assert.equal(resolved.ok, true, JSON.stringify(resolved).slice(0, 400));
  assert.equal(resolved.meshSource, 'sketch-only');
  assert.equal(resolved.code, undefined, '降级成功不该再带失败 code');
  assert.equal(resolved.format, 'sldprt');
  assert.equal(resolved.path.toLowerCase(), SKETCH_SLDPRT.toLowerCase());
  assert.equal(resolved.designId, 'plate-only');
  assert.equal(resolved.sibling, null, '草图视图没有 STEP 兄弟文件');
  assert.ok(resolved.bytes > 0 && resolved.mtimeMs > 0, '原生件的时间/大小要照旧带上');
  // sketch 摘要：客户端不请求 /sw3d/sketches 也能知道有几条
  assert.ok(resolved.sketch, 'sketch-only 必须带 sketch 摘要');
  assert.equal(resolved.sketch.designId, 'plate-only');
  assert.equal(resolved.sketch.sketchCount, 1);
  assert.ok(resolved.sketch.polylineCount >= 4, '至少 4 条矩形边：' + resolved.sketch.polylineCount);
  assert.match(resolved.sketch.url, /^\/sw3d\/sketches\?path=/);
  assert.equal(resolved.sketch.solidFeatureCount, 0, '零实体件：非草图特征数必须是 0');
  // 提示要人话 + 说清「先把草图轮廓给你看」
  const hints = resolved.hints.join('\n');
  assert.match(hints, /草图轮廓/, hints);
  assert.match(hints, /没有实体|零实体/, hints);
  assert.match(hints, /导不出 STEP/, '零实体件必须点明「导不出 STEP」而不是继续催 deliver：' + hints);
  assert.match(hints, /修改时间/);
  assert.match(hints, /大小/);
  // deliver 仍然给出（有设计ID，命令可直接复制），但文案不逼用户去跑它
  assert.match(resolved.deliver, /deliver kind="step" designId=plate-only/);
});

await checkAsync('resolveSource：有实体特征但没导出 STEP → 仍然 sketch-only，但提示让 agent 执行 deliver', async () => {
  const resolved = await resolveSource(SOLID_SLDPRT);
  assert.equal(resolved.ok, true, JSON.stringify(resolved).slice(0, 400));
  assert.equal(resolved.meshSource, 'sketch-only');
  assert.equal(resolved.sketch.solidFeatureCount, 1, 'extrude 应被算作非草图特征');
  const hints = resolved.hints.join('\n');
  assert.match(hints, /deliver kind="step" designId=bracket-no-step/, hints);
  assert.doesNotMatch(hints, /导不出 STEP/, '有实体特征时不该说「导不出 STEP」：' + hints);
});

await checkAsync('resolveSource：原生件无 STEP 且 sw-mcp 里没有该项目 → 仍然 NO_MESH_SOURCE + designId/deliver 提示', async () => {
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw3d-sketch-bare-'));
  try {
    const bare = path.join(bareDir, 'totally-unknown.SLDPRT');
    fs.writeFileSync(bare, 'fake native with nothing behind it');
    const failed = await resolveSource(bare);
    assert.equal(failed.ok, false, 'NO_MESH_SOURCE 这条路径必须继续存在：' + JSON.stringify(failed).slice(0, 300));
    assert.equal(failed.code, 'NO_MESH_SOURCE');
    assert.match(failed.hint, /deliver kind="step"/);
    assert.ok(failed.deliver, '失败体仍要给出可复制的 deliver 命令');
    assert.equal(failed.designId, '');
    assert.match(failed.deliver, /designId=<设计ID>/, '没有 designId 时用占位符');
    assert.ok(failed.native && failed.native.bytes > 0, '失败体仍要带原生件大小');
    assert.ok(failed.native.mtimeMs > 0, '失败体仍要带原生件修改时间');
    assert.equal(failed.directory, bareDir);
  } finally {
    fs.rmSync(bareDir, { recursive: true, force: true });
  }
});

await checkAsync('resolveSource：有同名 STEP 时行为完全不变（sibling-step，逐字段）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw3d-sketch-sibling-'));
  try {
    const native = path.join(dir, 'part.SLDPRT');
    const step = path.join(dir, 'part.STEP');
    fs.writeFileSync(native, 'fake native');
    fs.writeFileSync(step, 'ISO-10303-21;');
    const t = Date.now();
    fs.utimesSync(step, new Date(t), new Date(t));
    fs.utimesSync(native, new Date(t + 20000), new Date(t + 20000));
    const resolved = await resolveSource(native);
    assert.equal(resolved.ok, true);
    assert.equal(resolved.meshSource, 'sibling-step', '有同名 STEP 就必须还是 sibling-step');
    assert.equal(resolved.sibling, step);
    assert.equal(resolved.format, 'sldprt');
    assert.equal(resolved.bytes, fs.statSync(step).size);
    assert.ok(!('sketch' in resolved), 'sibling-step 不该多出 sketch 字段');
    assert.ok(!('deliver' in resolved), 'sibling-step 不该多出 deliver 字段');
    assert.ok(resolved.hints.some((h) => h.includes('已使用同名 .STEP')), resolved.hints.join(' | '));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 3. 宿主路由：/sw3d/resolve 与 /sw3d/mesh 的降级响应                   */
/* ------------------------------------------------------------------ */

const routes = new Map();
host.apply({
  webServer: {
    register(route) {
      assert.equal(route.kind, 'exact');
      assert.equal(routes.has(route.path), false, 'duplicate route ' + route.path);
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
  },
  connection: { requestRejection: () => undefined },
  effect: (fn) => fn(),
});

function fakeResponse() {
  const chunks = [];
  const headers = {};
  let status = 0;
  return {
    get statusCode() { return status; },
    set statusCode(value) { status = value; },
    get headersSent() { return status !== 0; },
    writeHead(code, extra = {}) { status = code; Object.assign(headers, extra); return this; },
    end(chunk) { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return this; },
    result() { return { status, headers, body: Buffer.concat(chunks) }; },
  };
}

async function call(handler, method, url) {
  const request = Readable.from([]);
  request.method = method;
  request.url = url;
  request.headers = {};
  const response = fakeResponse();
  await handler(request, response);
  return response.result();
}

await checkAsync('/sw3d/resolve：sketch-only 透出 meshSource/sketch/deliver，且谎报「无缓存」', async () => {
  const response = await call(routes.get('/sw3d/resolve'), 'GET', `/sw3d/resolve?path=${encodeURIComponent(SKETCH_SLDPRT)}`);
  assert.equal(response.status, 200);
  const body = JSON.parse(response.body.toString('utf8'));
  assert.equal(body.ok, true);
  assert.equal(body.meshSource, 'sketch-only');
  assert.equal(body.designId, 'plate-only');
  assert.equal(body.sibling, null);
  assert.ok(body.sketch && body.sketch.polylineCount >= 4, JSON.stringify(body.sketch));
  assert.match(body.deliver, /deliver kind="step"/);
  assert.equal(body.cached.hit, false, '草图视图没有 S3DM 缓存，不许说命中');
  assert.ok(Array.isArray(body.hints) && body.hints.length >= 3);
});

await checkAsync('/sw3d/mesh：sketch-only 回 200 + JSON（mode/sketchUrl），不再是 422', async () => {
  const response = await call(routes.get('/sw3d/mesh'), 'GET', `/sw3d/mesh?path=${encodeURIComponent(SKETCH_SLDPRT)}`);
  assert.equal(response.status, 200, '降级必须回 200，不能 422/500：' + response.body.toString('utf8').slice(0, 300));
  assert.match(String(response.headers['content-type']), /application\/json/, '降级响应是 JSON，不是 S3DM 二进制');
  const body = JSON.parse(response.body.toString('utf8'));
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'sketch-only', '响应必须是可区分的降级造型');
  assert.equal(body.meshSource, 'sketch-only');
  assert.match(body.sketchUrl, /^\/sw3d\/sketches\?path=/, JSON.stringify(body.sketchUrl));
  assert.ok(body.sketchUrl.includes(encodeURIComponent(SKETCH_SLDPRT)));
  assert.match(body.hint, /没有实体/, '降级响应要说清没有实体：' + body.hint);
  assert.equal(body.path.toLowerCase(), SKETCH_SLDPRT.toLowerCase());
});

await checkAsync('/sw3d/mesh：sketchUrl 真的能取到草图数据（同一台宿主，端到端）', async () => {
  const meshResponse = await call(routes.get('/sw3d/mesh'), 'GET', `/sw3d/mesh?path=${encodeURIComponent(SKETCH_SLDPRT)}`);
  const mesh = JSON.parse(meshResponse.body.toString('utf8'));
  const sketchResponse = await call(routes.get('/sw3d/sketches'), 'GET', mesh.sketchUrl);
  assert.equal(sketchResponse.status, 200);
  const payload = JSON.parse(sketchResponse.body.toString('utf8'));
  assert.equal(payload.ok, true, JSON.stringify(payload).slice(0, 300));
  assert.equal(payload.designId, 'plate-only');
  assert.ok(payload.sketches.length >= 1);
  const polylineCount = payload.sketches.reduce((sum, s) => sum + s.polylines.length, 0);
  assert.ok(polylineCount >= 4, '矩形 4 条边 + 圆：' + polylineCount);
  assert.ok(payload.sketches[0].bbox, '草图必须有包围盒给客户端 fit 相机');
});

await checkAsync('/sw3d/mesh：没有草图记录的原生件仍然 422 + NO_MESH_SOURCE（既有行为未被破坏）', async () => {
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw3d-sketch-bare2-'));
  try {
    const bare = path.join(bareDir, 'lonely.SLDPRT');
    fs.writeFileSync(bare, 'fake');
    const response = await call(routes.get('/sw3d/mesh'), 'GET', `/sw3d/mesh?path=${encodeURIComponent(bare)}`);
    assert.equal(response.status, 422, '连草图都读不到时必须继续硬失败');
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(body.ok, false);
    assert.equal(body.code, 'NO_MESH_SOURCE');
    assert.match(body.hint, /deliver|同名/);
  } finally {
    fs.rmSync(bareDir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 4. 客户端：client.js 的草图视图纯函数 + ViewerBody 行为               */
/* ------------------------------------------------------------------ */

const clientSource = fs.readFileSync(path.join(PLUGIN_DIR, 'client.js'), 'utf8');
let loadedSpec = null;
const fakeWindow = {
  devicePixelRatio: 1,
  __ModuleLoader__: { load(spec) { loadedSpec = spec; } },
  addEventListener() {},
  removeEventListener() {},
};
const fakeDocument = {
  createElementNS() { return { style: {}, getContext() { return null; }, setAttribute() {}, addEventListener() {}, removeEventListener() {} }; },
  createElement() { return this.createElementNS(); },
  addEventListener() {},
  removeEventListener() {},
  defaultView: fakeWindow,
};
const fakeReact = {
  createElement(type, props, ...children) { return { type, props: props || {}, children }; },
  useState(init) { const value = typeof init === 'function' ? init() : init; return [value, () => {}]; },
  useRef(init) { return { current: init }; },
  useMemo(fn) { return fn(); },
  useCallback(fn) { return fn; },
  useLayoutEffect() {},
  useEffect() {},
  Fragment: 'Fragment',
};
new Function(
  'window', 'document', 'navigator', 'self', 'fetch', 'console', 'TextEncoder', 'setTimeout', 'clearTimeout',
  clientSource + '\n//# sourceURL=dsh-sw-3d-preview/client.js'
)(fakeWindow, fakeDocument, { clipboard: { writeText: async () => {} }, userAgent: 'node' }, fakeWindow,
  () => Promise.reject(new Error('no network in this test')), console, TextEncoder, setTimeout, clearTimeout);
const T = loadedSpec.factory((id) => {
  if (id === 'react') return fakeReact;
  throw new Error('unexpected require: ' + id);
}).__test;

const PAYLOAD = {
  ok: true,
  designId: 'plate-only',
  unit: 'mm',
  sketches: [
    {
      id: 'sk-1',
      name: 'plate_profile',
      feature: '',
      plane: '基准面-前视',
      polylines: [
        { points: [[0, 0, 0], [20, 0, 0]], closed: false, kind: 'line' },
        { points: [[20, 0, 0], [20, 10, 0]], closed: false, kind: 'line' },
        { points: [[20, 10, 0], [0, 10, 0]], closed: false, kind: 'line' },
        { points: [[0, 10, 0], [0, 0, 0]], closed: false, kind: 'line' },
      ],
      dimensions: [],
      bbox: [0, 0, 0, 20, 10, 0],
    },
  ],
  warnings: [],
  featureCount: 0,
};

check('sketchPayloadBbox：从草图坐标算包围盒（不是空网格的 1mm 退化盒）', () => {
  const bbox = T.sketchPayloadBbox(PAYLOAD);
  assert.deepEqual(bbox, [0, 0, 0, 20, 10, 0]);
  // 空/坏输入 → null（上层不会拿到 1mm 小盒去 fit 相机）
  assert.equal(T.sketchPayloadBbox(null), null);
  assert.equal(T.sketchPayloadBbox({ ok: true, sketches: [] }), null);
  assert.equal(T.sketchPayloadBbox({ sketches: [{ polylines: [{ points: [[0, 0]] }] }] }), null, '不完整的点必须跳过');
});

check('inflateBbox：零厚度草图平面撑到最小尺寸（相机 near/far 不被零体积坑掉）', () => {
  // Z 跨度 0 → 撑到 ±0.5；X/Y 本来就够大 → 一毫米都不动
  assert.deepEqual(T.inflateBbox([0, 0, 0, 20, 10, 0], 1), [0, 0, -0.5, 20, 10, 0.5]);
  assert.deepEqual(T.inflateBbox([0, 0, 0, 20, 10, 5], 1), [0, 0, 0, 20, 10, 5], '够大就不动');
  // 整块退化成一个点：三个轴都撑开
  assert.deepEqual(T.inflateBbox([3, 4, 5, 3, 4, 5], 2), [2, 3, 4, 4, 5, 6]);
  assert.deepEqual(T.inflateBbox(null, 1), [-1, -1, -1, 1, 1, 1], '坏输入退到单位盒，不抛');
});

check('buildSketchOnlyModel：0 三角形 + 一致的 header/stats，包围盒来自草图', () => {
  const model = T.buildSketchOnlyModel(PAYLOAD, { path: 'C:\\work\\plate-only.SLDPRT' });
  assert.equal(model.sketchOnly, true, '必须显式标记，上层据此禁用能力');
  assert.equal(model.stats.triangleCount, 0);
  assert.equal(model.stats.faceCount, 0);
  assert.equal(model.stats.edgeCount, 0);
  assert.equal(model.stats.sketchCount, 1);
  assert.equal(model.stats.polylineCount, 4);
  assert.equal(model.position.length, 0, '没有顶点');
  assert.equal(model.index.length, 0, '没有三角形索引');
  assert.equal(model.faces.length, 0);
  assert.equal(model.edges.length, 0);
  assert.deepEqual(model.bbox, [0, 0, -0.5, 20, 10, 0.5], 'bbox 应是草图盒 + 撑开零厚度轴');
  const size = [0, 1, 2].map((i) => model.bbox[i + 3] - model.bbox[i]);
  assert.ok(size[0] > 15 && size[1] > 5, '包围盒必须来自草图（不是 1mm 小盒）：' + size.join('×'));
  // header 里字数也要自洽（截图/标注文本会读）
  assert.equal(model.header.triangleCount, 0);
  assert.equal(model.header.faceCount, 0);
  assert.equal(model.header.edgeCount, 0);
  assert.deepEqual(model.header.bbox, model.bbox);
  // 真 three.js 能接受这份模型（不抛、射线打不到东西）
  const THREE = T.loadTHREE();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(model.position, 3));
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  const raycaster = new THREE.Raycaster();
  raycaster.set(new THREE.Vector3(10, 5, 100), new THREE.Vector3(0, 0, -1));
  assert.equal(raycaster.intersectObject(mesh, false).length, 0, '草图视图不该命中任何三角面');
  geometry.dispose();
  mesh.material.dispose();
});

check('buildSketchOnlyNotice：说清「只有草图、没有实体」+ 零实体件不催 deliver', () => {
  const zeroBody = T.buildSketchOnlyModel(PAYLOAD, { path: 'x.SLDPRT' });
  zeroBody.resolve = { designId: 'plate-only', deliver: 'deliver kind="step" designId=plate-only', sketch: { solidFeatureCount: 0 } };
  const notice = T.buildSketchOnlyNotice(zeroBody);
  assert.match(notice, /只显示草图轮廓/, notice);
  assert.match(notice, /没有实体/, notice);
  assert.match(notice, /草图 1 条 \/ 折线 4 条/, notice);
  assert.match(notice, /设计 plate-only/, notice);
  assert.match(notice, /不可用/, notice);
  assert.match(notice, /拉伸成实体/, '零实体件必须给出真正可行的下一步：' + notice);
  assert.doesNotMatch(notice, /执行 deliver/, '零实体件不该被推去 deliver（死循环）：' + notice);

  const solidBody = T.buildSketchOnlyModel(PAYLOAD, { path: 'x.SLDPRT' });
  solidBody.resolve = { designId: 'bracket-no-step', deliver: 'deliver kind="step" designId=bracket-no-step', sketch: { solidFeatureCount: 2 } };
  const solidNotice = T.buildSketchOnlyNotice(solidBody);
  assert.match(solidNotice, /deliver kind="step" designId=bracket-no-step/, solidNotice);
});

check('SKETCH_ONLY_DISABLED / disabledToolButton：能力禁用清单 + 禁用态按钮带原因', () => {
  const ids = T.SKETCH_ONLY_DISABLED.map((item) => item.id);
  for (const id of ['pick', 'section', 'sample', 'wireframe', 'edges', 'precision', 'marker']) {
    assert.ok(ids.includes(id), '禁用清单必须包含 ' + id + '（实际 ' + ids.join(',') + '）');
  }
  for (const item of T.SKETCH_ONLY_DISABLED) {
    assert.ok(item.label && item.reason, '每项都要有 label 与原因：' + JSON.stringify(item));
  }
  // 正常模型：原样返回可点按钮
  const normal = T.disabledToolButton('剖切', false, () => {}, false, '开启 / 关闭剖视图');
  assert.equal(normal.props.disabled, undefined);
  assert.equal(normal.props.style, T.UI.btn);
  // 草图视图：真 disabled + 样式灰掉 + title 说明原因
  const disabled = T.disabledToolButton('剖切', false, () => {}, true, '开启 / 关闭剖视图');
  assert.equal(disabled.props.disabled, true, '草图视图下按钮必须真禁用（不是点了没反应）');
  assert.equal(disabled.props.style, T.UI.btnDisabled);
  assert.match(disabled.props.title, /草图视图/, disabled.props.title);
});

check('snapshotMetaLines：草图视图的截图信息带写明「仅草图轮廓」、剖切/精度不可用', () => {
  const lines = T.snapshotMetaLines({
    fileName: 'plate-only.SLDPRT',
    summary: null,
    view: 'iso',
    section: { axis: 'x', t: 44, enabled: true, flip: false },
    precision: 'mid',
    cap: true,
    sketchOnly: true,
    at: new Date(2026, 10, 15, 1, 12, 0),
  });
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'plate-only.SLDPRT · 仅草图轮廓（没有实体）');
  assert.equal(lines[1], '视角 等轴测 · 剖切 不可用（封盖不可用）· 精度 不可用 · 2026-11-15 01:12');
  // 非草图视图逐字节不变
  const normal = T.snapshotMetaLines({ fileName: '锁盖.STEP', summary: null, section: null, at: new Date(2026, 10, 15, 1, 12, 0) });
  assert.equal(normal[0], '锁盖.STEP · 未选中边/面（仅当前视角）');
});

/* ------------------------------------------------------------------ */
/* 5. 收尾                                                            */
/* ------------------------------------------------------------------ */

process.env.LOCALAPPDATA = REAL_LOCALAPPDATA;
fs.rmSync(sandbox, { recursive: true, force: true });
fs.rmSync(SKETCH_DIR, { recursive: true, force: true });
fs.rmSync(SOLID_DIR, { recursive: true, force: true });

const failed = results.filter((item) => !item.ok);
console.log('');
if (failed.length) {
  console.log(failed.length + ' of ' + results.length + ' FAILED');
  process.exitCode = 1;
} else {
  console.log('all ' + results.length + ' tests passed');
}
