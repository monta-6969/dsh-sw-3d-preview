// Offline smoke test for the dsh-sw-3d-preview client bundle.
// Runs with plain Node (no browser, no network, no React):
//   node test/client-smoke.mjs
//
// 覆盖：S3DM v1/v2 解析、边拾取、面拾取、三点法取样、标注文本模板（逐字符）、
//       路径解析（相对地址 bug）、hover 空间哈希、剖切封盖几何、精度档与缓存 LRU、交接单。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// SW3D_CLIENT lets a regression run point at an older build (used to prove the new
// pending-fix tests really fail on the pre-fix bundle).
const clientPath = process.env.SW3D_CLIENT
  ? path.resolve(process.env.SW3D_CLIENT)
  : path.join(here, '..', 'client.js');
const source = fs.readFileSync(clientPath, 'utf8');
console.log('# client.js: ' + clientPath + ' (' + source.length + ' bytes)');

// 精度档的「真实来源」在宿主侧：lib/resolve.js 的 PRECISION_TIERS（档位 → 缓存键/三角化参数）
// 和 lib/mesh.js 的 DEFAULT_DEFLECTION_MM（不传参时的默认弦高）。client.js 里是同名副本，
// lib/resolve.js:577 的注释把「两边必须一致」写成硬约束，所以这里直接读宿主表来比对，
// 而不是在测试里再抄一份数字（抄的那份迟早和两边都对不上）。
const { PRECISION_TIERS: HOST_PRECISION_TIERS } = await import('../lib/resolve.js');
const { DEFAULT_DEFLECTION_MM: HOST_DEFAULT_DEFLECTION_MM } = await import('../lib/mesh.js');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log('ok   ' + name);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log('FAIL ' + name + '\n     ' + (err && err.message ? err.message : err));
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('ok   ' + name);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log('FAIL ' + name + '\n     ' + (err && err.stack ? err.stack : err));
  }
}

/* ------------------------------------------------------------------ */
/* fakes: window.__ModuleLoader__ + minimal react                      */
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
  addEventListener() {},
  removeEventListener() {},
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

/* ------------------------------------------------------------------ */
/* controllable clock + minimal react runtime                          */
/*                                                                     */
/* The pending-forever bug lived in a useEffect + setTimeout pair, so   */
/* the fake React below really runs effects and the bundle's setTimeout */
/* is injected: tests can advance the 1200ms path grace window and the  */
/* 20s hard timeout deterministically.                                  */
/* ------------------------------------------------------------------ */

const clock = { now: 0, seq: 0, timers: new Map() };

function fakeSetTimeout(fn, ms) {
  const id = ++clock.seq;
  clock.timers.set(id, { id, at: clock.now + Math.max(0, Number(ms) || 0), fn });
  return id;
}
function fakeClearTimeout(id) { clock.timers.delete(id); }
/** Run every timer due within `ms`, in due order (timers scheduled while running fire too). */
function advance(ms) {
  const target = clock.now + ms;
  for (let guard = 0; guard < 5000; guard += 1) {
    let due = null;
    for (const timer of clock.timers.values()) {
      if (timer.at > target) continue;
      if (due === null || timer.at < due.at || (timer.at === due.at && timer.id < due.id)) due = timer;
    }
    if (due === null) break;
    clock.timers.delete(due.id);
    clock.now = Math.max(clock.now, due.at);
    due.fn();
  }
  clock.now = target;
}
function pendingTimers() { return [...clock.timers.values()].map((t) => t.at - clock.now); }

const hooksState = { inst: null };

function hooksInstance(props) {
  return { props, index: 0, states: [], refs: [], effects: [], cleanups: [], dirty: false, renders: 0 };
}

const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children };
  },
  useState(init) {
    const inst = hooksState.inst;
    const initial = typeof init === 'function' ? init() : init;
    if (!inst) return [initial, () => {}];
    const i = inst.index++;
    if (!(i in inst.states)) inst.states[i] = { value: initial };
    const slot = inst.states[i];
    const set = (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next;
      if (Object.is(value, slot.value)) return;
      slot.value = value;
      inst.dirty = true;
      if (inst.schedule) inst.schedule();
    };
    return [slot.value, set];
  },
  useRef(init) {
    const inst = hooksState.inst;
    if (!inst) return { current: init };
    const i = inst.index++;
    if (!(i in inst.refs)) inst.refs[i] = { current: init };
    return inst.refs[i];
  },
  useMemo(fn) { return fn(); },
  useCallback(fn) { return fn; },
  useLayoutEffect() {},
  useEffect(fn, deps) {
    const inst = hooksState.inst;
    if (!inst) return;
    const i = inst.index++;
    inst.effects.push({ i, fn, deps });
  },
  Fragment: 'Fragment',
};

function sameDeps(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/** Minimal host node: enough for `Ref`-based canvas hosts and for three.js to refuse cleanly. */
function makeFakeNode() {
  return {
    style: {},
    className: '',
    children: [],
    ownerDocument: fakeDocument,
    clientWidth: 320,
    clientHeight: 200,
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); return child; },
    setAttribute() {},
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 320, height: 200, right: 320, bottom: 200 }; },
    getContext() { return null; },
    focus() {},
    contains() { return false; },
  };
}

/** Commit object refs the way React does: `ref.current` points at a host node after render. */
function commitRefs(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(commitRefs); return; }
  const ref = node.props && node.props.ref;
  if (ref && typeof ref === 'object' && !ref.current) ref.current = makeFakeNode();
  (node.children || []).forEach(commitRefs);
}

/** Mount a component with real hook semantics: state, effects, debuggable render count. */
function mount(Component, props) {
  const inst = hooksInstance(props);
  const root = {
    inst,
    tree: null,
    scheduled: false,
    destroyed: false,
    renderCount() { return inst.renders; },
    text() { return collectText(root.tree); },
    update(nextProps) { inst.props = nextProps; inst.dirty = true; schedule(); return root; },
    unmount() {
      root.destroyed = true;
      for (const cleanup of inst.cleanups) if (typeof cleanup === 'function') cleanup();
      inst.cleanups = [];
    },
  };
  inst.schedule = schedule;

  function schedule() {
    inst.dirty = true;
    if (root.scheduled || root.destroyed) return;
    root.scheduled = true;
    setImmediate(() => {
      root.scheduled = false;
      flush();
    });
  }

  function flush() {
    let guard = 0;
    while (inst.dirty && !root.destroyed) {
      guard += 1;
      assert.ok(guard <= 300, 'component did not settle (300 renders) — infinite render loop');
      inst.dirty = false;
      runRender();
    }
  }

  function runRender() {
    const previous = inst.effects;
    inst.effects = [];
    inst.index = 0;
    inst.renders += 1;
    hooksState.inst = inst;
    try {
      root.tree = Component(inst.props);
    } finally {
      hooksState.inst = null;
    }
    commitRefs(root.tree);
    // passive effects: unchanged deps keep their cleanup, changed/new deps re-run
    const kept = new Set();
    for (const next of inst.effects) {
      const prev = previous.find((e) => e.i === next.i);
      if (prev && sameDeps(prev.deps, next.deps)) kept.add(next.i);
    }
    for (const prev of previous) {
      if (kept.has(prev.i)) continue;
      const cleanup = inst.cleanups[prev.i];
      inst.cleanups[prev.i] = undefined;
      if (typeof cleanup === 'function') cleanup();
    }
    for (const next of inst.effects) {
      if (kept.has(next.i)) continue;
      const cleanup = next.fn();
      inst.cleanups[next.i] = typeof cleanup === 'function' ? cleanup : undefined;
    }
  }

  root.render = () => { runRender(); };   // initial mount (synchronous, then effects)
  root.render();
  flush();
  return root;
}

/** Let queued microtasks/macrotasks (fetch fakes, promise chains, scheduled renders) run. */
async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Depth-first text of a fake element tree (strings joined with '|'). */
function collectText(tree) {
  const text = [];
  (function walk(node) {
    if (node === null || node === undefined || node === false || node === true) return;
    if (typeof node === 'string' || typeof node === 'number') { text.push(String(node)); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== 'object') return;
    (node.children || []).forEach(walk);
  })(tree);
  return text.join('|');
}

/** Toolbar button labels of a fake element tree. */
function collectButtons(tree) {
  const buttons = [];
  (function walk(node) {
    if (node === null || node === undefined || node === false) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== 'object') return;
    if (node.type === 'button') {
      const label = (node.children || []).filter((c) => typeof c === 'string').join('');
      if (label) buttons.push(label);
    }
    (node.children || []).forEach(walk);
  })(tree);
  return buttons;
}


const fakeRequire = (id) => {
  if (id === 'react') return fakeReact;
  throw new Error('unexpected require: ' + id);
};

/* fake host for the /sw3d/* routes (no network: everything is served in memory) */
let hostResponder = null;

function jsonResponse(status, body) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  };
}

function binaryResponse(buffer) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name === 'x-sw3d-source' ? 'direct' : null) },
    text: async () => '',
    arrayBuffer: async () => buffer,
  };
}

function createHost(T, overrides) {
  const opts = Object.assign({
    ping: { ok: true, python: { ok: true, ocp: true }, cacheDir: 'C:/sw3d-cache', three: 'inline' },
    resolve: {
      ok: true,
      path: 'C:/work/parts/锁盖.STEP',
      format: 'step',
      meshSource: 'direct',
      sibling: null,
      bytes: 4096,
      mtimeMs: 1700000000000,
      designId: 'lock-cover',
      cached: { hit: false },
      hints: [],
    },
    meshFail: null,
    handoff: { ok: true, mdPath: 'C:\\Users\\mota\\AppData\\Local\\sw-3d-preview\\handoff\\abc.md', count: 3, bytes: 2048, designId: 'lock-cover' },
  }, overrides || {});
  const counts = { ping: 0, resolve: 0, mesh: 0, annotation: 0, handoff: 0 };
  const urls = [];
  const bodies = [];
  return {
    counts,
    urls,
    bodies,
    fetch(url, init) {
      const target = String(url);
      const body = init && init.body ? String(init.body) : '';
      urls.push(target);
      if (target.startsWith('/sw3d/ping')) { counts.ping += 1; return Promise.resolve(jsonResponse(200, opts.ping)); }
      if (target.startsWith('/sw3d/resolve')) { counts.resolve += 1; return Promise.resolve(jsonResponse(200, opts.resolve)); }
      if (target.startsWith('/sw3d/mesh')) {
        counts.mesh += 1;
        if (opts.meshFail) return Promise.resolve(jsonResponse(opts.meshFail.status || 422, opts.meshFail.body));
        return Promise.resolve(binaryResponse(T.buildSampleS3DM()));
      }
      if (target.startsWith('/sw3d/handoff')) {
        counts.handoff += 1;
        bodies.push(body);
        return Promise.resolve(jsonResponse(200, opts.handoff));
      }
      if (target.startsWith('/sw3d/annotation')) {
        counts.annotation += 1;
        bodies.push(body);
        return Promise.resolve(jsonResponse(200, { ok: true, id: 7, count: 1, items: [{ edgeIndex: 0 }] }));
      }
      return Promise.reject(new Error('unexpected request: ' + target));
    },
  };
}

function fakeFetch(url, init) {
  if (!hostResponder) throw new Error('smoke test must not perform network requests: ' + url);
  return hostResponder(String(url), init || {});
}

function runBundle() {
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
    fakeSetTimeout,
    fakeClearTimeout
  );
}

check('client.js loads and calls __ModuleLoader__.load once', () => {
  runBundle();
  assert.ok(loadedSpec, '__ModuleLoader__.load was not called');
  assert.equal(loadedSpec.id, 'dsh-sw-3d-preview');
  assert.equal(typeof loadedSpec.factory, 'function');
});

const api = loadedSpec.factory(fakeRequire);

check('factory(require) returns { inject: string[], apply: fn }', () => {
  assert.ok(api && typeof api === 'object', 'factory must return an object');
  assert.ok(Array.isArray(api.inject), 'inject must be an array');
  assert.ok(api.inject.every((s) => typeof s === 'string'), 'inject entries must be strings');
  assert.equal(typeof api.apply, 'function');
  assert.ok(api.__test && typeof api.__test === 'object', '__test surface missing');
});

/* ------------------------------------------------------------------ */
/* fake ctx: registrations                                             */
/* ------------------------------------------------------------------ */

function makeCtx() {
  const state = {
    definitions: [],
    keyed: [],
    actions: [],
    locales: [],
    effects: [],
    disposers: 0,
  };
  const disposer = (label) => () => { state.disposers += 1; void label; };
  const ctx = {
    documentPreviews: {
      register(definition) {
        state.definitions.push(definition);
        return disposer('definition');
      },
    },
    slots: {
      inject(name, callback) {
        state.effects.push('inject:' + name);
        return callback();
      },
      register(descriptor, component) {
        const entry = { descriptor, component };
        if (descriptor && descriptor.name === 'sidebar.right.tab.document') state.keyed.push(entry);
        else if (descriptor && descriptor.name === 'sidebar.right.tab.document.actions') state.actions.push(entry);
        else throw new Error('unexpected slot registration: ' + JSON.stringify(descriptor));
        return disposer('slot');
      },
    },
    locale: {
      register(ns, dict) { state.locales.push({ ns, dict }); },
      bind(ns) { return (key) => (state.locales[0] && state.locales[0].dict.zh[key]) || key; },
    },
    effect(callback, label) {
      const dispose = callback();
      state.effects.push(String(label));
      assert.equal(typeof dispose, 'function', 'effect callback must return a disposer');
      return dispose;
    },
  };
  return { ctx, state };
}

check('apply(ctx) registers definition / body / toolbar action', () => {
  const { ctx, state } = makeCtx();
  api.apply(ctx);

  assert.equal(state.definitions.length, 1, 'expected exactly one documentPreviews.register');
  const definition = state.definitions[0];
  assert.equal(definition.id, 'sw3d-preview');
  assert.ok(definition.extensions.includes('sldprt'), 'extensions must include sldprt');
  assert.ok(definition.extensions.includes('step') && definition.extensions.includes('stl'));
  assert.deepEqual(
    definition.binaryExtensions.slice().sort(),
    definition.extensions.slice().sort(),
    'binaryExtensions must cover all extensions'
  );
  assert.equal(definition.priority, 'extension');
  assert.equal(definition.loading, 'renderer');
  assert.equal(definition.wrap, false);
  assert.equal(typeof definition.title, 'function');
  assert.equal(definition.title(), '3D 成果预览');

  assert.equal(state.keyed.length, 1, 'expected one sidebar.right.tab.document keyed slot');
  assert.equal(state.keyed[0].descriptor.key, definition.id, 'keyed slot key must equal definition.id');
  assert.equal(typeof state.keyed[0].component, 'function');

  assert.equal(state.actions.length, 1, 'expected one sidebar.right.tab.document.actions registration');
  assert.equal(state.actions[0].descriptor.id, 'sw3d.rebuild-cache');
  assert.equal(state.actions[0].descriptor.order, 10);
  assert.equal(typeof state.actions[0].component, 'function');

  assert.equal(state.locales.length, 1, 'locale.register must be called');
  assert.equal(state.locales[0].ns, 'sw3d');
  assert.ok(state.locales[0].dict.zh && state.locales[0].dict.en);
});

/* ------------------------------------------------------------------ */
/* pure functions via factory.__test                                   */
/* ------------------------------------------------------------------ */

const T = api.__test;

check('built-in S3DM sample: v2 header / faceEdge / triangleCount / bbox / polyline', () => {
  const buffer = T.buildSampleS3DM();
  assert.ok(buffer instanceof ArrayBuffer);
  const model = T.parseS3DM(buffer);
  assert.equal(model.version, 2);
  assert.equal(model.stats.triangleCount, 2);
  assert.equal(model.stats.edgeCount, 1);
  assert.equal(model.stats.vertexCount, 4);
  assert.deepEqual(model.bbox, [0, 0, 0, 10, 10, 0]);
  assert.equal(model.edges[0].polylineCount, 3);
  assert.equal(model.edgeGeometry.segmentCount, 2);
  assert.deepEqual(Array.from(model.edgeGeometry.segmentEdge), [0, 0]);
  assert.equal(model.edgeGeometry.positions.length, 12);
  // v2 face↔edge 关联：来自 faceEdge buffer
  assert.equal(model.faceEdge.length, 4);
  assert.equal(model.faceEdgeIndex.source, 'buffer');
  assert.deepEqual(model.faceEdgeIndex.byFace.get(0), [0]);
  assert.deepEqual(model.faceEdgeIndex.byFace.get(1), [0]);
  assert.deepEqual(model.faceEdgeIndex.byEdge.get(0), [0, 1]);
  // 客户端默认档的精度必须与宿主解析结果一致（宿主默认档 = PRECISION_TIERS.mid）
  assert.deepEqual(model.precision, {
    deflectionMm: HOST_PRECISION_TIERS.mid.deflection,
    maxTriangles: HOST_PRECISION_TIERS.mid.maxTriangles,
  });
});

check('parseS3DM also accepts legacy absolute buffer offsets', () => {
  const model = T.parseS3DM(T.buildSampleS3DM(true));
  assert.equal(model.stats.triangleCount, 2);
  assert.equal(model.stats.edgeCount, 1);
  assert.deepEqual(model.bbox, [0, 0, 0, 10, 10, 0]);
  const hosted = T.parseS3DM(T.buildSampleS3DM(false));
  assert.equal(hosted.stats.triangleCount, 2);
  assert.equal(hosted.edgeGeometry.segmentCount, 2);
});

check('parseS3DM rejects bad magic / truncated data', () => {
  const bad = new Uint8Array(32);
  bad[0] = 88; bad[1] = 89; bad[2] = 90; bad[3] = 87;
  assert.throws(() => T.parseS3DM(bad.buffer), /magic/);
  assert.throws(() => T.parseS3DM(new ArrayBuffer(4)), /数据为空/);
});

check('v1 header compatibility: no faceEdge buffer, incidence derived from edges[].faces', () => {
  const v1Buffer = T.buildSampleS3DM(false, { version: 1, withFaceEdge: false });
  const model = T.parseS3DM(v1Buffer);
  assert.equal(model.version, 1);
  assert.equal(model.faceEdge, null, 'v1 没有 faceEdge buffer');
  assert.equal(model.faceEdgeIndex.source, 'derived', 'v1 必须能降级推导 face↔edge');
  assert.deepEqual(model.faceEdgeIndex.byFace.get(0), [0]);
  assert.deepEqual(model.faceEdgeIndex.byFace.get(1), [0]);
  assert.equal(model.stats.faceCount, 2);
  // 面卡片在 v1 数据上也要能算出来
  const summary = T.faceSummary(model.header, 1, 'sample.step', { faceEdgeIndex: model.faceEdgeIndex });
  assert.equal(summary.index, 1);
  assert.equal(summary.kindLabelWithSize, '圆柱 Ø5.0');
  assert.equal(summary.edgeCount, 1);
  assert.deepEqual(summary.adjacentFaces.map((f) => f.index), [0]);
});

check('pickEdge maps segment hits to edge indexes and honours clipping', () => {
  const model = T.parseS3DM(T.buildSampleS3DM());
  const hits = [
    { index: 0, distance: 3, point: { x: 1, y: 0, z: 0 } },
    { index: 2, distance: 2, point: { x: 5, y: 0, z: 0 } },
  ];
  const picked = T.pickEdge(hits, model.edgeGeometry, null);
  assert.ok(picked);
  assert.equal(picked.edgeIndex, 0);
  assert.equal(picked.segmentIndex, 0);
  assert.equal(T.pickEdge(hits, model.edgeGeometry, () => false), null, 'clipped hits must be skipped');
  assert.equal(T.pickEdge([], model.edgeGeometry, null), null);
});

check('pickFace: ray hit on a triangle returns that triangle\'s face index', () => {
  const model = T.parseS3DM(T.buildSampleS3DM());
  // faceOfTriangle = [0, 1] → triangle 1 belongs to face 1
  const hits = [
    { faceIndex: 1, distance: 4, point: { x: 5, y: 5, z: 0 } },
    { faceIndex: 0, distance: 8, point: { x: 2, y: 2, z: 0 } },
  ];
  const picked = T.pickFace(hits, model.faceOfTriangle, null);
  assert.ok(picked, 'pickFace must return a hit');
  assert.equal(picked.subject, 'face');
  assert.equal(picked.faceIndex, 1, 'triangle 1 → face 1');
  assert.equal(picked.triangleIndex, 1);
  // 只给顶点 index 时（老版本 three）也能换算成三角形序号
  const viaIndex = T.pickFace([{ index: 3, distance: 4, point: { x: 5, y: 5, z: 0 } }], model.faceOfTriangle, null);
  assert.equal(viaIndex.faceIndex, 1);
  // 被剖切面裁掉的命中要跳过
  assert.equal(T.pickFace(hits, model.faceOfTriangle, () => false), null);
  // 越界三角面安全返回 null
  assert.equal(T.pickFace([{ faceIndex: 99, distance: 1, point: { x: 0, y: 0, z: 0 } }], model.faceOfTriangle, null), null);
  assert.equal(T.pickFace([], model.faceOfTriangle, null), null);
});

check('faceSummary: kind / size label / area / normal / edge count / adjacent faces', () => {
  const model = T.parseS3DM(T.buildSampleS3DM());
  const planeFace = T.faceSummary(model.header, 0, 'sample.step', { faceEdgeIndex: model.faceEdgeIndex });
  assert.equal(planeFace.subject, 'face');
  assert.equal(planeFace.kindLabel, '平面');
  assert.equal(planeFace.areaMm2, 50);
  assert.deepEqual(planeFace.normal, [0, 0, 1]);
  assert.equal(planeFace.edgeCount, 1);
  assert.deepEqual(planeFace.edgeIndexes, [0]);
  assert.deepEqual(planeFace.adjacentFaces.map((f) => f.kindLabel), ['圆柱']);

  const cylinderFace = T.faceSummary(model.header, 1, 'sample.step', { faceEdgeIndex: model.faceEdgeIndex });
  assert.equal(cylinderFace.kindLabel, '圆柱');
  assert.equal(cylinderFace.kindLabelWithSize, '圆柱 Ø5.0');
  assert.equal(cylinderFace.radiusMm, 2.5);
  assert.equal(cylinderFace.diameterMm, 5);
  assert.deepEqual(cylinderFace.adjacentFaces.map((f) => f.index), [0]);
});

check('edgeSamplePoints: 25% / 75% along start→mid→end', () => {
  const model = T.parseS3DM(T.buildSampleS3DM());
  const points = T.edgeSamplePoints(model.header, 0, model.edgePosition, model.edgeSegment);
  assert.equal(points.length, 2);
  assert.deepEqual(points[0], [2.5, 0, 0]);
  assert.deepEqual(points[1], [7.5, 0, 0]);
});

check('three-point sampling accumulates at most 3 model-space points', () => {
  let samples = [];
  samples = T.pushSamplePoint(samples, [1, 2, 3]);
  samples = T.pushSamplePoint(samples, [4, 5, 6]);
  assert.equal(samples.length, 2);
  assert.deepEqual(samples[1], [4, 5, 6]);
  samples = T.pushSamplePoint(samples, [7, 8, 9]);
  assert.equal(samples.length, 3, '3 个点应全部保留');
  const overflow = T.pushSamplePoint(samples, [10, 11, 12]);
  assert.equal(overflow.length, 3, '第 4 个点必须被忽略');
  assert.deepEqual(overflow[2], [7, 8, 9]);
  // 归一化坐标（相对 bbox）
  assert.deepEqual(T.normalizePointToBbox([5, 5, 0], [0, 0, 0, 10, 10, 0]), [0.5, 0.5, 0]);
  assert.deepEqual(T.normalizePointToBbox([12, 20, 0], [0, 0, 0, 10, 10, 0]), [1, 1, 0], '越界应夹到 0..1');
  assert.deepEqual(T.normalizePointToBbox([0, 0, 0], [0, 0, 0, 0, 10, 0]), [0, 0, 0], '零跨度轴不除零');
  // 打印格式（卡片与标注文本共用）
  assert.equal(T.fmtPoint([12.345, 5.678, 0]), '[12.35,5.68,0.00]');
  assert.equal(T.fmtPoint([-0.001, 0, 0]), '[0.00,0.00,0.00]', '负零要归一成 0.00');
  assert.equal(T.fmtNormalText([-0.70710678, 0, 0.70710678]), '[-0.707,0,0.707]');
});

check('edgeSummary + buildAnnotationText produce the new multi-line annotation text', () => {
  const model = T.parseS3DM(T.buildSampleS3DM());
  const summary = T.edgeSummary(model.header, 0, 'sample.step');
  assert.equal(summary.subject, 'edge');
  assert.equal(summary.index, 0);
  assert.equal(summary.isCircle, true);
  assert.equal(summary.kindLabel, '圆边 Ø5.0');
  assert.equal(summary.adjacentFaces.length, 2);
  assert.deepEqual(summary.adjacentFaces.map((f) => f.kindLabel), ['平面', '圆柱']);

  const text = T.buildAnnotationText(summary, '把这里改成 R2 圆角', { header: model.header });
  assert.equal(
    text,
    [
      '[3D标注] 文件：sample.step 设计ID：（无）',
      '选中：边 #0（圆边 Ø5.0，长 15.7 mm，端点 A [0.00,0.00,0.00] B [10.00,0.00,0.00]）',
      '取样（模型 mm）：P1 [2.50,0.00,0.00] P2 [7.50,0.00,0.00]（沿边 25% / 75%）',
      '相邻：面 #0（平面） / 面 #1（圆柱）',
      // 视角/剖切/精度行：模型读截图时要知道「用户是从哪个方向看的、有没有剖切」
      '视角：等轴测，剖切：关，精度：中',
      '修改意见：把这里改成 R2 圆角',
    ].join('\n'),
  );
  assert.equal(text.split('\n').length, 6, '标注文本必须是 6 行（相邻 + 视角/剖切/精度）');
  assert.ok(!text.includes('；边 #'), '不再使用旧的单行模板');

  // 空修改意见 → 兜底文案；带源说明与 designId
  const withSource = T.buildAnnotationText(
    Object.assign({}, summary, { sourceNote: '源：同名STEP of 锁盖.SLDPRT', designId: 'lock-cover' }),
    '',
    { header: model.header },
  );
  assert.equal(withSource.split('\n')[0], '[3D标注] 文件：sample.step（源：同名STEP of 锁盖.SLDPRT） 设计ID：lock-cover');
  assert.equal(withSource.split('\n')[5], '修改意见：请按标注修改此处');

  // 视角/剖切/精度行必须如实反映当前 UI 状态（不是写死的「关 / 中」）
  const liveState = T.buildAnnotationText(summary, '改一下', {
    header: model.header,
    view: 'front',
    section: { axis: 'y', t: 40, enabled: true, flip: true },
    precision: 'high',
  });
  assert.equal(
    liveState.split('\n')[4],
    '视角：前视图，剖切：Y 轴 40% · 翻转，精度：高',
    '剖切/精度/视角必须跟随真实状态，不能写死',
  );
});

check('face annotation text: 三点取样 + 法向 + 面积 + 相邻面（逐字符）', () => {
  const model = T.parseS3DM(T.buildSampleS3DM());
  const summary = T.faceSummary(model.header, 1, 'C:\\work\\锁盖.STEP', { faceEdgeIndex: model.faceEdgeIndex });
  summary.sourceNote = '源：同名STEP of 锁盖.SLDPRT';
  summary.designId = 'lock-cover';
  summary.samples = [[12.34, 5.67, 0], [1, 2, 3], [-0.5, 7, 0]];
  const text = T.buildAnnotationText(summary, '这个圆柱面改成 Ø6');
  assert.equal(
    text,
    [
      '[3D标注] 文件：C:\\work\\锁盖.STEP（源：同名STEP of 锁盖.SLDPRT） 设计ID：lock-cover',
      '选中：面 #1（圆柱 Ø5.0，面积 30 mm²，法向 [1,0,0]）',
      '三点取样（模型 mm）：P1 [12.34,5.67,0.00] P2 [1.00,2.00,3.00] P3 [-0.50,7.00,0.00]',
      '相邻：面 #0（平面）',
      '视角：等轴测，剖切：关，精度：中',
      '修改意见：这个圆柱面改成 Ø6',
    ].join('\n'),
  );
  // 没有取样点时给出可操作提示
  const noSamples = T.buildAnnotationText(Object.assign({}, summary, { samples: [] }), '');
  assert.equal(noSamples.split('\n')[2], '三点取样（模型 mm）：（未取样；按住 Alt 在面上点 3 次）');
});

check('buildHandoffDraftText: 多条标注只填摘要 + 交接单路径', () => {
  const text = T.buildHandoffDraftText({
    filePath: 'C:\\work\\锁盖.STEP',
    count: 12,
    designId: 'lock-cover',
    mdPath: 'C:\\Users\\mota\\AppData\\Local\\sw-3d-preview\\handoff\\1234.md',
  });
  assert.equal(
    text,
    '[3D标注] 文件：C:\\work\\锁盖.STEP 共 12 条标注（设计ID：lock-cover），交接单：C:\\Users\\mota\\AppData\\Local\\sw-3d-preview\\handoff\\1234.md' +
      '\n请按交接单里的逐条标注修改模型。',
  );
  assert.ok(!text.includes('选中：'), '摘要里不能塞逐条标注');
  const empty = T.buildHandoffDraftText({ filePath: 'C:\\a.step' });
  assert.ok(empty.includes('交接单：（尚未生成）'));
});

check('parseAddress handles dsh-resource session addresses', () => {
  const absolute = T.parseAddress('dsh-resource://file/session/abc-123/C:/work/parts/%E9%94%81%E7%9B%96.SLDPRT');
  assert.equal(absolute, 'C:\\work\\parts\\锁盖.SLDPRT');
  const relative = T.parseAddress('dsh-resource://file/session/abc-123/parts/lid.STEP');
  assert.equal(relative, 'parts/lid.STEP');
  assert.equal(T.parseAddress(''), '');
  assert.equal(T.extOfPath('C:/a/b.STEP'), 'step');
  assert.equal(T.isOwnExtension('C:/a/b.sldprt'), true);
  assert.equal(T.isOwnExtension('C:/a/b.txt'), false);
  assert.equal(T.baseNameOf('C:\\a\\b\\锁盖.SLDPRT'), '锁盖.SLDPRT');
});

/* ------------------------------------------------------------------ */
/* 路径解析 bug（面板只给出相对路径）                                    */
/* ------------------------------------------------------------------ */

check('isAbsoluteFsPath: 只有盘符/UNC 才算绝对路径', () => {
  assert.equal(T.isAbsoluteFsPath('C:\\work\\a.STEP'), true);
  assert.equal(T.isAbsoluteFsPath('D:/work/a.step'), true);
  assert.equal(T.isAbsoluteFsPath('\\\\server\\share\\a.step'), true);
  assert.equal(T.isAbsoluteFsPath('轴承支架.SLDPRT'), false, '裸文件名不是绝对路径');
  assert.equal(T.isAbsoluteFsPath('/c/work/a.step'), false);
  assert.equal(T.isAbsoluteFsPath(''), false);
  assert.equal(T.isAbsoluteFsPath(null), false);
});

check('normalizeResourceMeta: 兼容多种 useResource 形状，忽略相对路径', () => {
  assert.deepEqual(T.normalizeResourceMeta({ status: 'live', value: { absolutePath: 'C:\\a\\b.step' } }), {
    status: 'live', absolutePath: 'C:\\a\\b.step', hasMeta: true,
  });
  assert.equal(T.normalizeResourceMeta({ absolutePath: 'C:\\x\\c.step' }).absolutePath, 'C:\\x\\c.step');
  assert.equal(T.normalizeResourceMeta({ value: { stat: { path: 'C:\\x\\d.step' } } }).absolutePath, 'C:\\x\\d.step');
  assert.equal(T.normalizeResourceMeta({ status: 'loading', value: { path: '轴承支架.SLDPRT' } }).absolutePath, '');
  assert.equal(T.normalizeResourceMeta({ status: 'loading', value: { path: '锁盖.SLDPRT' } }).status, 'loading');
  assert.equal(T.normalizeResourceMeta(null).status, '');
  assert.equal(T.normalizeResourceMeta(null).absolutePath, '');
});

check('extractWorkspaceRoots: 从 props / meta 里尽量拿会话工作区根', () => {
  assert.deepEqual(T.extractWorkspaceRoots({ workspace: { path: 'D:\\ws' } }, null), ['D:\\ws']);
  assert.deepEqual(T.extractWorkspaceRoots({ workspaces: [{ path: 'D:\\a' }, { directory: 'D:\\b' }] }, null), ['D:\\a', 'D:\\b']);
  assert.deepEqual(T.extractWorkspaceRoots({ session: { cwd: 'D:\\sess' } }, null), ['D:\\sess']);
  assert.deepEqual(T.extractWorkspaceRoots({ cwd: 'D:\\cwd' }, null), ['D:\\cwd']);
  assert.deepEqual(T.extractWorkspaceRoots({ cwd: 'relative/dir' }, null), [], '相对目录不接受');
  assert.deepEqual(T.extractWorkspaceRoots({}, { value: { workspaceRoot: 'D:\\meta' } }), ['D:\\meta']);
});

check('decidePath: 相对地址先等资源 stat，绝不先发裸文件名请求', () => {
  const address = 'dsh-resource://file/session/S1/%E8%BD%B4%E6%89%BF%E6%94%AF%E6%9E%B6.SLDPRT';
  // 1) 资源还在 loading → pending，path 为空（上层不得发请求）
  const pending = T.decidePath({ address: address, meta: { status: 'loading' }, waitedOut: false });
  assert.equal(pending.phase, 'pending');
  assert.equal(pending.path, '');
  assert.equal(pending.reason, 'waiting-for-resource');
  // 2) stat 变 live 且带绝对路径 → ready + 绝对路径
  const ready = T.decidePath({
    address: address,
    meta: { status: 'live', value: { absolutePath: 'C:\\Users\\mota\\Desktop\\工程自动化\\轴承支架.SLDPRT' } },
    waitedOut: false,
  });
  assert.equal(ready.phase, 'ready');
  assert.equal(ready.path, 'C:\\Users\\mota\\Desktop\\工程自动化\\轴承支架.SLDPRT');
  assert.equal(ready.absolute, true);
  assert.equal(ready.reason, 'resource-stat');
  // 3) 宽限期到了还没有 stat → 降级成相对路径，由宿主按 project 记录补全
  const fallback = T.decidePath({ address: address, meta: { status: 'loading' }, waitedOut: true });
  assert.equal(fallback.phase, 'ready');
  assert.equal(fallback.path, '轴承支架.SLDPRT');
  assert.equal(fallback.absolute, false);
  assert.equal(fallback.reason, 'relative-fallback');
  // 4) 地址里本来就是绝对路径 → 立刻可用，不用等
  const direct = T.decidePath({
    address: 'dsh-resource://file/session/S1/C:/work/parts/%E9%94%81%E7%9B%96.SLDPRT',
    meta: null,
    waitedOut: false,
  });
  assert.equal(direct.phase, 'ready');
  assert.equal(direct.path, 'C:\\work\\parts\\锁盖.SLDPRT');
  assert.equal(direct.reason, 'address-absolute');
  // 5) 完全没有地址 → error
  assert.equal(T.decidePath({ address: '', meta: null, waitedOut: true }).phase, 'error');
  // 6) 工作区根会被带出来给宿主当 base
  const withRoot = T.decidePath({
    address: address,
    meta: { status: 'loading' },
    waitedOut: true,
    workspaceRoots: ['D:\\ws'],
  });
  assert.equal(withRoot.base, 'D:\\ws');
});

check('ViewerBody: 相对地址且资源未就绪时显示「正在解析路径…」（真实 useResource(address) 形状）', () => {
  // 已发布的 API 是 useResource(address) => {status,value,failure}（@deepseek-ai/dsh-client-resources）。
  const props = {
    resourceAddress: 'dsh-resource://file/session/S1/%E8%BD%B4%E6%89%BF%E6%94%AF%E6%9E%B6.SLDPRT',
    useResource: () => ({ status: 'loading', value: undefined, failure: undefined }),
    content: { loading: 'renderer', loaded() {}, failed() {}, reload() {} },
    inputActions: { setDraft() {} },
  };
  const root = mount(T.ViewerBody, props);
  try {
    const joined = root.text();
    assert.ok(joined.includes('正在解析路径…'), '应显示正在解析路径：' + joined.slice(0, 200));
    assert.ok(!joined.includes('正在准备 3D 数据'), '资源未就绪时不该进入"准备 3D 数据"阶段');
    assert.ok(joined.includes('1200ms'), '死等文案必须写明宽限上限：' + joined.slice(0, 240));
    const grace = pendingTimers().filter((ms) => Math.abs(ms - T.PATH_RESOLVE_GRACE_MS) < 5);
    assert.equal(grace.length, 1, 'pending 时必须挂上 1200ms 宽限计时器（否则永远等不到降级）');
  } finally {
    root.unmount();
  }
});

await checkAsync('ViewerBody: 相对地址 + live 绝对路径 → 直接进入准备阶段（不等 1200ms）', async () => {
  const props = {
    resourceAddress: 'dsh-resource://file/session/S1/%E8%BD%B4%E6%89%BF%E6%94%AF%E6%9E%B6.SLDPRT',
    useResource: () => ({
      status: 'live',
      value: { absolutePath: 'C:\\Users\\mota\\Desktop\\工程自动化\\轴承支架.SLDPRT', version: 'v1' },
      failure: undefined,
    }),
    content: { loading: 'renderer', loaded() {}, failed() {}, reload() {} },
    inputActions: { setDraft() {} },
  };
  const host = createHost(T);
  hostResponder = host.fetch;
  T.clearCaches();
  const root = mount(T.ViewerBody, props);
  try {
    const joined = root.text();
    assert.ok(joined.includes('正在准备 3D 数据'), joined.slice(0, 200));
    assert.ok(!joined.includes('正在解析路径…'));
    await settle();
    assert.equal(host.counts.resolve, 1, 'live 绝对路径应立刻请求 resolve：' + JSON.stringify(host.urls));
    assert.ok(host.urls.some((u) => u.startsWith('/sw3d/resolve') &&
      u.includes(encodeURIComponent('C:\\Users\\mota\\Desktop\\工程自动化\\轴承支架.SLDPRT'))));
  } finally {
    root.unmount();
    hostResponder = null;
  }
});

check('module-level mesh cache exists with an LRU budget', () => {
  assert.ok(T.meshCache instanceof Map);
  assert.ok(T.meshCacheBytes instanceof Map);
  assert.ok(T.resolveCache instanceof Map);
  assert.equal(T.MESH_CACHE_LIMITS.maxEntries, 6);
  assert.equal(T.MESH_CACHE_LIMITS.maxBytes, 300 * 1024 * 1024);
  assert.equal(T.MESH_CACHE_LIMITS.maxBytes / 1024 / 1024, 300);
  T.clearCaches();
});

check('trimMeshCache: 条目上限与字节预算都会淘汰最旧项', () => {
  const cache = new Map();
  const bytes = new Map();
  for (let i = 0; i < 10; i += 1) {
    cache.set('k' + i, Promise.resolve(new ArrayBuffer(1)));
    bytes.set('k' + i, 1000);
  }
  const evicted = T.trimMeshCache(cache, bytes, { maxEntries: 6, maxBytes: 1e9 });
  assert.equal(cache.size, 6);
  assert.deepEqual(evicted, ['k0', 'k1', 'k2', 'k3'], '先淘汰最旧的 4 个');
  assert.equal(bytes.size, 6);

  const cache2 = new Map();
  const bytes2 = new Map();
  for (let i = 0; i < 5; i += 1) {
    cache2.set('m' + i, Promise.resolve(new ArrayBuffer(1)));
    bytes2.set('m' + i, 100 * 1024 * 1024);
  }
  T.trimMeshCache(cache2, bytes2, { maxEntries: 100, maxBytes: 300 * 1024 * 1024 });
  assert.equal(cache2.size, 3, '300MB 预算 → 只留 3 个 100MB');
  assert.deepEqual([...cache2.keys()], ['m2', 'm3', 'm4']);
});

check('precision tiers: high/mid/low → deflection + maxTriangles（必须与 lib/resolve.js 的同名表一致）', () => {
  // 期望值取自宿主真实来源 lib/resolve.js，而不是在测试里再抄一遍数字：
  // 这条正是 lib/resolve.js:577 那条契约（「改这组数时必须同时改 client.js 的同名表」）的可执行版本。
  // label / key 是客户端独有的展示字段，仍然逐字断言（deepEqual 保证不多不少）。
  assert.deepEqual(T.PRECISION_TIERS.high, {
    key: 'high', label: '高',
    deflection: HOST_PRECISION_TIERS.high.deflection,
    maxTriangles: HOST_PRECISION_TIERS.high.maxTriangles,
  });
  assert.deepEqual(T.PRECISION_TIERS.mid, {
    key: 'mid', label: '中',
    deflection: HOST_PRECISION_TIERS.mid.deflection,
    maxTriangles: HOST_PRECISION_TIERS.mid.maxTriangles,
  });
  assert.deepEqual(T.PRECISION_TIERS.low, {
    key: 'low', label: '低',
    deflection: HOST_PRECISION_TIERS.low.deflection,
    maxTriangles: HOST_PRECISION_TIERS.low.maxTriangles,
  });
  assert.equal(T.DEFAULT_PRECISION, 'mid');
  assert.equal(T.precisionTierOf('low').deflection, HOST_PRECISION_TIERS.low.deflection);
  assert.equal(T.precisionTierOf('nonsense').key, 'mid', '未知档回落到中精度');
  assert.equal(T.LARGE_MODEL_TRIANGLES, 500000);
  // 不传 precision、只带 deflection 的路径用 DEFAULT_DEFLECTION：它必须等于宿主默认弦高，
  // 否则「只发 deflection」的请求会落到和宿主默认不同的缓存键上。
  assert.equal(T.DEFAULT_DEFLECTION, HOST_DEFAULT_DEFLECTION_MM);
  // 三档 deflection 必须严格递增（高精度数值更小），防止有人把表改反
  assert.ok(T.PRECISION_TIERS.high.deflection < T.PRECISION_TIERS.mid.deflection);
  assert.ok(T.PRECISION_TIERS.mid.deflection < T.PRECISION_TIERS.low.deflection);
  // 默认档的 deflection 必须与 DEFAULT_DEFLECTION 相等（不传参 == 传 mid）
  assert.equal(T.PRECISION_TIERS[T.DEFAULT_PRECISION].deflection, T.DEFAULT_DEFLECTION,
    '默认档与 DEFAULT_DEFLECTION 必须是同一个数，否则「不传参」和「传 mid」两条路径分叉');
});

check('precision tier titles 显示表里的真实毫米数（不写死文案）', () => {
  const expected = (name) => {
    const tier = T.PRECISION_TIERS[name];
    const wan = Number(tier.maxTriangles) / 10000;
    return tier.label + '精度（deflaction ' + Number((Math.round(tier.deflection * 100) / 100)) +
      '，三角形上限 ' + Number((Math.round(wan * 100) / 100)) + ' 万）';
  };
  for (const name of ['high', 'mid', 'low']) {
    assert.equal(T.precisionTierTitle(name), expected(name));
  }
  // 逐字钉住当前档位的文案（数字变了这里会红，提醒去改 README 与表）
  assert.equal(T.precisionTierTitle('high'), '高精度（deflaction 0.04，三角形上限 90 万）');
  assert.equal(T.precisionTierTitle('mid'), '中精度（deflaction 0.08，三角形上限 30 万）');
  assert.equal(T.precisionTierTitle('low'), '低精度（deflaction 0.2，三角形上限 12 万）');
});

/* ------------------------------------------------------------------ */
/* hover 加速结构：均匀空间哈希                                          */
/* ------------------------------------------------------------------ */

function buildSyntheticEdgeGeometry(count, extent) {
  const positions = new Float32Array(count * 6);
  const segmentEdge = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) {
    const x = (i % 100) * (extent / 100);
    const y = Math.floor(i / 100) % 100 * (extent / 100);
    const z = Math.floor(i / 10000) * (extent / 10);
    positions[i * 6] = x;
    positions[i * 6 + 1] = y;
    positions[i * 6 + 2] = z;
    positions[i * 6 + 3] = x + extent * 0.01;
    positions[i * 6 + 4] = y;
    positions[i * 6 + 5] = z;
    segmentEdge[i] = i % 37; // 每条边 37 段，接近真实 B-rep 折线
  }
  return { positions, segmentEdge, segmentCount: count, pointCount: count * 2, ranges: [], rangeByEdge: new Map() };
}

check('spatial grid: cell = 对角线/128，线段全部入格', () => {
  const geometry = buildSyntheticEdgeGeometry(20000, 100);
  const bbox = [0, 0, 0, 100, 100, 100];
  const diag = Math.sqrt(3 * 100 * 100);
  const grid = T.buildEdgeSpatialGrid(geometry, bbox);
  assert.equal(grid.segmentCount, 20000);
  assert.equal(grid.builtSegments, 20000);
  assert.ok(Math.abs(grid.cellSize - diag / 128) < 1e-9, 'cell 应等于对角线/128');
  assert.ok(grid.dims[0] >= 1 && grid.dims[0] <= 512);
  assert.ok(grid.cells.size > 0, '应有非空网格单元');
  assert.ok(grid.cells.size < 20000, '网格单元数应远小于线段数（说明真的聚合了）');
});

check('spatial grid: 给定点查最近边与暴力解一致，且只测少量线段', () => {
  const geometry = buildSyntheticEdgeGeometry(20000, 100);
  const bbox = [0, 0, 0, 100, 100, 100];
  const grid = T.buildEdgeSpatialGrid(geometry, bbox);
  const points = [[0.01, 0.0, 0.0], [49.5, 50.0, 0.0], [99.9, 99.0, 0.0], [12.3, 45.6, 0.02]];
  for (const point of points) {
    const picked = T.queryNearestEdgeSegment(grid, point, 1);
    assert.ok(picked, '应能找到最近线段：' + JSON.stringify(point));
    // 暴力解
    let best = null;
    for (let s = 0; s < grid.segmentCount; s += 1) {
      const a = [geometry.positions[s * 6], geometry.positions[s * 6 + 1], geometry.positions[s * 6 + 2]];
      const b = [geometry.positions[s * 6 + 3], geometry.positions[s * 6 + 4], geometry.positions[s * 6 + 5]];
      const closest = T.closestPointOnSegment(point, a, b);
      const d = Math.hypot(point[0] - closest[0], point[1] - closest[1], point[2] - closest[2]);
      if (!best || d < best.distance) best = { segmentIndex: s, distance: d };
    }
    assert.ok(Math.abs(picked.distance - best.distance) < 1e-6, '距离应与暴力解一致');
    assert.ok(picked.distance < 1.6, '最近线段应在 1.6mm 内');
    assert.ok(picked.testedSegments < grid.segmentCount / 4, `只应测少量线段（实测 ${picked.testedSegments}/${grid.segmentCount}）`);
  }
});

check('spatial grid: ray 查询与逐段暴力 raycast 结果一致', () => {
  const geometry = buildSyntheticEdgeGeometry(20000, 100);
  const bbox = [0, 0, 0, 100, 100, 100];
  const grid = T.buildEdgeSpatialGrid(geometry, bbox);
  const threshold = 1.5;
  const rays = [
    [[0.005, 0, 200], [0, 0, -1]],
    [[49.505, 50, 200], [0, 0, -1]],
    [[12.305, 45.6, 200], [0, 0, -1]],
    [[0.005, 0, -200], [0, 0, 1]],
  ];
  for (const [origin, direction] of rays) {
    const hit = T.raycastEdgeGrid(grid, origin, direction, { threshold: threshold });
    // 暴力：射线与每段求最近距离，取 t 最小的可用命中
    const dir = (function (v) {
      const len = Math.hypot(v[0], v[1], v[2]) || 1;
      return [v[0] / len, v[1] / len, v[2] / len];
    })(direction);
    let best = null;
    for (let s = 0; s < grid.segmentCount; s += 1) {
      const a = [geometry.positions[s * 6], geometry.positions[s * 6 + 1], geometry.positions[s * 6 + 2]];
      const b = [geometry.positions[s * 6 + 3], geometry.positions[s * 6 + 4], geometry.positions[s * 6 + 5]];
      const closest = T.raySegmentDistance(origin, dir, a, b);
      if (closest.distance > threshold) continue;
      if (!best || closest.t < best.t) best = { t: closest.t, segmentIndex: s, distance: closest.distance };
    }
    assert.ok(hit, 'ray 应命中至少一段：' + JSON.stringify(origin));
    assert.ok(best, '暴力解也应命中');
    assert.ok(Math.abs(hit.t - best.t) < 1e-6, `ray t 应一致（grid=${hit.t} brute=${best.t}）`);
    assert.equal(hit.segmentIndex, best.segmentIndex);
    assert.ok(hit.testedSegments < grid.segmentCount, `只应测少量线段（实测 ${hit.testedSegments}/${grid.segmentCount}）`);
  }
  // 完全打偏的射线返回 null
  assert.equal(T.raycastEdgeGrid(grid, [500, 500, 500], [0, 0, 1], { threshold: 1 }), null);
});

check('raySegmentDistance: 平行射线（轴向边）也能取到正确最近点', () => {
  // 射线沿 +x，线段也沿 +x 且偏 0.1：最近点应在 x=50，距离 0.1
  const parallel = T.raySegmentDistance([0, 0, 0], [1, 0, 0], [50, 0.1, 0], [60, 0.1, 0]);
  assert.ok(Math.abs(parallel.distance - 0.1) < 1e-9, 'distance=' + parallel.distance);
  assert.ok(Math.abs(parallel.t - 50) < 1e-9, 't=' + parallel.t);
  assert.deepEqual(parallel.point, [50, 0.1, 0]);
  // 垂直情形：从 (5,5,0) 沿 -z 打到 y=0 的那条边；沿射线距离恒为 5，t 取 0 即可
  const perpendicular = T.raySegmentDistance([5, 5, 0], [0, 0, -1], [0, 0, 0], [10, 0, 0]);
  assert.ok(Math.abs(perpendicular.distance - 5) < 1e-9, 'distance=' + perpendicular.distance);
  assert.ok(perpendicular.t >= 0 && perpendicular.t < 1e-9, 't=' + perpendicular.t);
  assert.deepEqual(perpendicular.point, [5, 0, 0]);
  // 线段在射线起点后方 → t 夹到 0
  const behind = T.raySegmentDistance([0, 0, 0], [1, 0, 0], [-10, 0, 0], [-5, 0, 0]);
  assert.equal(behind.t, 0);
  assert.ok(Math.abs(behind.distance - 5) < 1e-9);
});

check('spatial grid: 与线段平行的轴向射线也能命中', () => {
  const geometry = buildSyntheticEdgeGeometry(20000, 100);
  const bbox = [0, 0, 0, 100, 100, 100];
  const grid = T.buildEdgeSpatialGrid(geometry, bbox);
  const hit = T.raycastEdgeGrid(grid, [-50, 0.005, 0], [1, 0, 0], { threshold: 0.05 });
  assert.ok(hit, '平行射线应命中 x 轴方向的边');
  assert.equal(hit.edgeIndex, 0);
  assert.ok(Math.abs(hit.distance - 0.005) < 1e-6, 'distance=' + hit.distance);
  assert.ok(Math.abs(hit.point[0]) < 1e-6, '最近点应在 x≈0');
  assert.equal(T.raycastEdgeGrid(grid, [-50, 5, 5], [1, 0, 0], { threshold: 0.05 }), null, '打偏的平行射线不该命中');
});

check('spatial grid: 真实样例模型的边也能被网格拾取到', () => {
  const model = T.parseS3DM(T.buildSampleS3DM());
  const grid = T.buildEdgeSpatialGrid(model.edgeGeometry, model.bbox);
  assert.equal(grid.segmentCount, 2);
  const hit = T.raycastEdgeGrid(grid, [5, 0, 5], [0, 0, -1], { threshold: 0.5 });
  assert.ok(hit, '正对边的射线应命中');
  assert.equal(hit.edgeIndex, 0);
  assert.equal(hit.segmentIndex, 0, 'x=5 落在第 0 段（0→5）');
});

/* ------------------------------------------------------------------ */
/* 剖切封盖几何                                                        */
/* ------------------------------------------------------------------ */

check('sectionPlaneInfo / capPlacement: 剖切面与封盖 quad 的数值', () => {
  const bbox = [0, 0, 0, 10, 10, 0];
  const xPlane = T.sectionPlaneInfo({ axis: 'x', t: 50, enabled: true, flip: false }, bbox);
  assert.deepEqual(xPlane.normal, [1, 0, 0]);
  assert.equal(xPlane.index, 0);
  assert.equal(xPlane.value, 5);
  assert.deepEqual(xPlane.point, [5, 5, 0]);
  assert.equal(xPlane.constant, -5, 'Plane.constant = -n·p');
  assert.equal(xPlane.enabled, true);

  const flipped = T.sectionPlaneInfo({ axis: 'x', t: 100, enabled: true, flip: true }, bbox);
  assert.deepEqual(flipped.normal, [-1, 0, 0]);
  assert.equal(flipped.value, 10);
  assert.equal(flipped.constant, 10);

  const yPlane = T.sectionPlaneInfo({ axis: 'y', t: 25, enabled: true }, bbox);
  assert.deepEqual(yPlane.normal, [0, 1, 0]);
  assert.equal(yPlane.value, 2.5);
  const zPlane = T.sectionPlaneInfo({ axis: 'z', t: 0, enabled: true }, bbox);
  assert.deepEqual(zPlane.normal, [0, 0, 1]);
  assert.equal(zPlane.value, 0);

  const diag = Math.hypot(10, 10, 0);
  const placement = T.capPlacement(xPlane, bbox, diag);
  assert.deepEqual(placement.center, [5, 5, 0]);
  assert.ok(Math.abs(placement.size - diag * 1.6) < 1e-9, 'quad 尺寸 = 1.6 × 对角线');
  assert.deepEqual(placement.normal, [1, 0, 0]);
});

check('client source wires the geometric cap (no stencil quad, ShapeUtils triangulation)', () => {
  // 封盖从「stencil quad」换成「几何法三角化断面」：源码必须真的走新路径
  assert.ok(source.includes('function computeSectionCap('), '必须导出几何法封盖');
  assert.ok(source.includes('ShapeUtils.triangulateShape'), '必须用 three 自带三角化');
  assert.ok(source.includes('capSolid'), '断面色必须是深灰偏暖的实色');
  assert.ok(!/capMaterial[\s\S]{0,400}?stencilWrite: true/.test(source), '封盖材质不许再写 stencil');
  assert.ok(source.includes('polygonOffsetFactor: -1'), '断面要 polygonOffset 防共面 z-fighting');
  assert.ok(source.includes('function setCap('), 'viewer 必须暴露 setCap');
  assert.ok(source.includes('封盖'), '工具栏必须有封盖按钮');
});

/* ------------------------------------------------------------------ */
/* 几何法封盖：立方体挖通孔                                            */
/* ------------------------------------------------------------------ */

// 20×20×20 的立方体（只造 4 面侧壁，x ∈ [0,20]）里挖一个 R=4 沿 X 的通孔；
// X 轴 50% 处剖面 = 正方形外轮廓 + 1 个圆形洞。
function boxWithThroughHole() {
  const position = [];
  const index = [];
  function quad(a, b, c, d) {
    const base = position.length / 3;
    position.push(...a, ...b, ...c, ...d);
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const HW = 10, R = 4, SEG = 24, X0 = 0, X1 = 20;
  quad([X0, -HW, -HW], [X1, -HW, -HW], [X1, -HW, HW], [X0, -HW, HW]);
  quad([X0, HW, HW], [X1, HW, HW], [X1, HW, -HW], [X0, HW, -HW]);
  quad([X0, -HW, HW], [X1, -HW, HW], [X1, HW, HW], [X0, HW, HW]);
  quad([X0, HW, -HW], [X1, HW, -HW], [X1, -HW, -HW], [X0, -HW, -HW]);
  for (let s = 0; s < SEG; s += 1) {
    const a0 = (2 * Math.PI * s) / SEG;
    const a1 = (2 * Math.PI * (s + 1)) / SEG;
    const p0 = [X0, R * Math.cos(a0), R * Math.sin(a0)];
    const p1 = [X1, R * Math.cos(a0), R * Math.sin(a0)];
    const q1 = [X1, R * Math.cos(a1), R * Math.sin(a1)];
    const q0 = [X0, R * Math.cos(a1), R * Math.sin(a1)];
    quad(p0, p1, q1, q0);
  }
  return { position: new Float32Array(position), index: new Uint32Array(index), bbox: [0, -HW, -HW, 20, HW, HW] };
}

check('__test.computeSectionCap: 立方体通孔在 X 50% 的断面（三角形 / 平面距离 / 外轮廓）', () => {
  T.clearSectionCapCache();
  const mesh = boxWithThroughHole();
  const info = T.sectionPlaneInfo({ axis: 'x', t: 50, enabled: true, flip: false }, mesh.bbox);
  assert.equal(info.value, 10);
  const cap = T.computeSectionCap(mesh.position, mesh.index, info, { diagonal: Math.hypot(20, 20, 20) });
  assert.ok(cap.triangles > 0, '断面三角形数必须 > 0，实际 ' + cap.triangles);
  assert.ok(cap.segmentCount >= 24, '至少 4 面侧壁 + 24 段圆柱，实际 ' + cap.segmentCount);
  assert.ok(cap.outlineCount >= 1, '外轮廓数 ≥ 1，实际 ' + cap.outlineCount);
  assert.equal(cap.positions.length, cap.triangles * 9);
  let maxDistance = 0;
  for (let i = 0; i < cap.positions.length; i += 3) {
    maxDistance = Math.max(maxDistance, Math.abs(cap.positions[i] - info.value));
  }
  assert.ok(maxDistance < 1e-6, '所有断面顶点必须落在平面上，最大偏差 ' + maxDistance);
  assert.equal(cap.warnings.length, 0, '干净输入不该有 warning：' + cap.warnings.join(';'));
});

check('__test.computeSectionCap: 带洞场景（洞被识别 + 无退化三角形）', () => {
  T.clearSectionCapCache();
  const mesh = boxWithThroughHole();
  const info = T.sectionPlaneInfo({ axis: 'x', t: 50, enabled: true }, mesh.bbox);
  const cap = T.computeSectionCap(mesh.position, mesh.index, info, { diagonal: Math.hypot(20, 20, 20) });
  assert.ok(cap.holeCount >= 1, '圆孔必须被识别为洞，实际 ' + cap.holeCount);
  assert.equal(cap.loopCount, 2, '正方形 + 圆 = 2 个闭环，实际 ' + cap.loopCount);
  assert.ok(cap.triangles > 0, '带洞断面必须真的三角化出三角形，实际 ' + cap.triangles);
  let minArea = Infinity;
  for (let i = 0; i < cap.positions.length; i += 9) {
    const ax = cap.positions[i], ay = cap.positions[i + 1], az = cap.positions[i + 2];
    const bx = cap.positions[i + 3], by = cap.positions[i + 4], bz = cap.positions[i + 5];
    const cx = cap.positions[i + 6], cy = cap.positions[i + 7], cz = cap.positions[i + 8];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    minArea = Math.min(minArea, 0.5 * Math.hypot(nx, ny, nz));
  }
  assert.ok(minArea > 1e-9, '不允许退化三角形，最小面积 ' + minArea);
});

check('__test.computeSectionCap: 开环 / 退化输入返回空 + warning，不抛异常', () => {
  T.clearSectionCapCache();
  // 两个互不相连的三角形，各给出一条孤立线段 → 端点度数 1，串不成闭环
  const position = new Float32Array([
    0, 0, 0, 20, 0, 0, 0, 10, 0,
    0, 100, 0, 20, 100, 0, 0, 110, 0,
  ]);
  const info = T.sectionPlaneInfo({ axis: 'x', t: 50, enabled: true }, [0, 0, 0, 20, 110, 1]);
  let cap;
  assert.doesNotThrow(() => {
    cap = T.computeSectionCap(position, null, info, { diagonal: 150, noCache: true });
  }, '开环输入绝不能抛异常');
  assert.equal(cap.triangles, 0, '开环时不许画出乱七八糟的东西');
  assert.equal(cap.positions.length, 0);
  assert.ok(cap.warnings.length >= 1, '跳过的环必须记 warning');
  assert.ok(cap.droppedLoops >= 2, '两条开环都应被丢弃，实际 ' + cap.droppedLoops);
  // 空网格同样安全
  const empty = T.computeSectionCap(new Float32Array(0), null, info, { noCache: true });
  assert.equal(empty.triangles, 0);
  assert.ok(empty.warnings.length >= 1);
});

check('__test.computeSectionCap: 同参数二次调用命中缓存（同一对象 / 不重复构建）', () => {
  T.clearSectionCapCache();
  const mesh = boxWithThroughHole();
  const diagonal = Math.hypot(20, 20, 20);
  const info = T.sectionPlaneInfo({ axis: 'x', t: 50, enabled: true }, mesh.bbox);
  const first = T.computeSectionCap(mesh.position, mesh.index, info, { diagonal, cacheId: 'cache-probe' });
  const statsAfterFirst = T.sectionCapCacheStats();
  const second = T.computeSectionCap(mesh.position, mesh.index, info, { diagonal, cacheId: 'cache-probe' });
  const statsAfterSecond = T.sectionCapCacheStats();
  assert.equal(second, first, '同参数必须命中缓存并返回同一对象');
  assert.equal(statsAfterSecond.hits, statsAfterFirst.hits + 1);
  assert.equal(statsAfterSecond.builds, statsAfterFirst.builds, '命中缓存不许再构建');
  // key 只有 (axis, round(offset,3), flip) 变化才变
  const moved = T.sectionPlaneInfo({ axis: 'x', t: 50.01, enabled: true }, mesh.bbox);
  assert.notEqual(T.computeSectionCap(mesh.position, mesh.index, moved, { diagonal, cacheId: 'cache-probe' }), first);
  assert.ok(T.CAP_CACHE_MAX === 8, '缓存上限 8 个 offset');
  assert.ok(T.CAP_REBUILD_DEBOUNCE_MS === 60, '拖动 offset 用 60ms debounce');
});

check('__test.buildSectionFillMaterials: 正面 FrontSide + 背面暗 ≥ 30%', () => {
  const THREE = T.loadTHREE();
  const appearance = 0x9fb2c8;
  const plan = T.buildSectionFillMaterials(THREE, { mesh: appearance });
  assert.equal(plan.front.side, THREE.FrontSide, '实体正面材质必须 FrontSide');
  assert.equal(plan.back.side, THREE.BackSide, '内壁材质必须 BackSide');
  const lumFront = T.colorLuminance(appearance);
  const lumBack = T.colorLuminance(plan.back.color.getHex());
  assert.ok(lumBack <= lumFront * 0.7 + 1e-9, '背面亮度必须比外观暗 ≥30%：' + lumBack + ' vs ' + lumFront);
  // viewer 实际用的 meshMaterial 也会被改成 FrontSide（同一个对象被复用）
  const meshMaterial = new THREE.MeshStandardMaterial({ color: appearance });
  const reused = T.buildSectionFillMaterials(THREE, { mesh: appearance }, meshMaterial);
  assert.equal(reused.front, meshMaterial);
  assert.equal(meshMaterial.side, THREE.FrontSide);
  assert.equal(T.sectionBackfillColor(0xffffff), 0x999999);
});


check('inlined three.js r187 is complete and clippable (no CDN / no network)', () => {
  const THREE = T.loadTHREE();
  assert.equal(THREE.REVISION, '187');
  for (const name of [
    'WebGLRenderer', 'Scene', 'PerspectiveCamera', 'BufferGeometry', 'BufferAttribute',
    'LineSegments', 'LineBasicMaterial', 'MeshStandardMaterial', 'Mesh', 'Plane',
    'Raycaster', 'Box3', 'Vector3', 'Vector2', 'AmbientLight', 'DirectionalLight',
    'PlaneGeometry', 'SphereGeometry', 'Group', 'MeshBasicMaterial',
    'NotEqualStencilFunc', 'IncrementWrapStencilOp', 'ReplaceStencilOp', 'DoubleSide',
  ]) {
    assert.ok(name in THREE, 'three.js is missing ' + name);
  }
  // 封盖材质的关键参数确实是 three 认识的对象（类型检查，不涉及 GL）
  const capMat = new THREE.MeshStandardMaterial({
    stencilWrite: true,
    stencilRef: 0,
    stencilFunc: THREE.NotEqualStencilFunc,
    stencilFail: THREE.ReplaceStencilOp,
    stencilZFail: THREE.ReplaceStencilOp,
    stencilZPass: THREE.ReplaceStencilOp,
  });
  assert.equal(capMat.stencilWrite, true);
  assert.equal(capMat.stencilFunc, THREE.NotEqualStencilFunc);
  assert.equal(capMat.stencilFail, THREE.ReplaceStencilOp);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), capMat);
  quad.scale.set(12, 12, 1);
  assert.equal(quad.scale.x, 12);
  // 一个真实的 LineSegments raycast 仍然可用（作为加速结构的对照基准）
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 10, 0, 0]), 3));
  const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial());
  lines.updateMatrixWorld(true);
  const raycaster = new THREE.Raycaster();
  raycaster.params.Line = raycaster.params.Line || {};
  raycaster.params.Line.threshold = 0.5;
  raycaster.set(new THREE.Vector3(5, 0.1, 5), new THREE.Vector3(0, 0, -1));
  const hits = raycaster.intersectObject(lines, false);
  assert.equal(hits.length, 1);
  const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
  const material = new THREE.LineBasicMaterial();
  material.clippingPlanes = [plane];
  assert.equal(material.clippingPlanes.length, 1);
});

check('ViewerBody renders toolbar (views / section / 封盖 / 精度) without throwing', () => {
  assert.equal(typeof T.ViewerBody, 'function');
  const props = {
    resourceAddress: 'dsh-resource://file/session/s1/C:/work/parts/%E9%94%81%E7%9B%96.SLDPRT',
    useResource: () => () => ({ value: { absolutePath: 'C:\\work\\parts\\锁盖.SLDPRT' } }),
    content: { loading: 'renderer', loaded() {}, failed() {}, reload() {} },
    inputActions: { setDraft() {} },
  };
  const tree = T.ViewerBody(props);
  assert.ok(tree, 'ViewerBody must return an element');
  assert.equal(tree.type, 'div');
  assert.equal(tree.props.className, 'sw3d-root');

  const text = [];
  const buttons = [];
  (function walk(node) {
    if (node == null || node === false) return;
    if (typeof node === 'string' || typeof node === 'number') { text.push(String(node)); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== 'object') return;
    if (node.type === 'button') {
      const label = (node.children || []).filter((c) => typeof c === 'string').join('');
      if (label) buttons.push(label);
    }
    (node.children || []).forEach(walk);
  })(tree);

  for (const label of ['等轴测', '前', '上', '右', '适配', '边线', '剖切', '翻转', 'X', 'Y', 'Z', '封盖', '高', '中', '低']) {
    assert.ok(buttons.includes(label), 'missing toolbar button: ' + label + ' (got ' + buttons.join(',') + ')');
  }
  assert.ok(text.some((t) => t.indexOf('正在准备 3D 数据') >= 0), 'loading text missing');
  assert.ok(text.some((t) => t.indexOf('着色') >= 0), 'shading/wireframe toggle missing');
  assert.ok(text.some((t) => t.indexOf('精度') >= 0), 'precision group label missing');
});

check('RebuildAction only shows for supported extensions', () => {
  assert.equal(typeof T.RebuildAction, 'function');
  const shown = T.RebuildAction({ absolutePath: 'C:\\work\\parts\\锁盖.SLDPRT' });
  assert.ok(shown && shown.type === 'button');
  const label = (shown.children || []).filter((c) => typeof c === 'string').join('');
  assert.equal(label, '重建 3D 缓存');
  assert.equal(T.RebuildAction({ absolutePath: 'C:\\work\\parts\\notes.txt' }), null);
  assert.equal(T.RebuildAction({}), null);
});

/* ------------------------------------------------------------------ */
/* host HTTP pipeline (ping -> resolve -> mesh -> parse)               */
/* ------------------------------------------------------------------ */

await checkAsync('loadModelData: ping -> resolve -> mesh -> parse, with progress + resolve payload', async () => {
  const host = createHost(T);
  hostResponder = host.fetch;
  T.clearCaches();
  const progress = [];
  const resolved = [];
  const model = await T.loadModelData('C:\\work\\parts\\锁盖.STEP', {
    fileName: '锁盖.STEP',
    fileExt: 'STEP',
    onProgress: (message, detail) => progress.push(message + '|' + detail),
    onResolved: (payload) => resolved.push(payload),
  });
  assert.equal(model.stats.triangleCount, 2);
  assert.equal(model.stats.edgeCount, 1);
  assert.equal(model.version, 2);
  assert.ok(progress.length >= 4, 'expected several progress phases, got ' + JSON.stringify(progress));
  assert.ok(progress[0].startsWith('正在准备 3D 数据'), progress[0]);
  assert.ok(progress.some((p) => p.startsWith('读取文件信息')), progress.join(' / '));
  assert.ok(progress.some((p) => p.startsWith('解析 STEP')), progress.join(' / '));
  assert.ok(progress.some((p) => p.startsWith('解析网格数据')), progress.join(' / '));
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].format, 'step');
  assert.equal(host.counts.ping, 1);
  assert.equal(host.counts.resolve, 1);
  assert.equal(host.counts.mesh, 1);
  const meshUrl = host.urls[host.urls.length - 1];
  assert.ok(meshUrl.indexOf('/sw3d/mesh?path=') === 0, meshUrl);
  assert.ok(meshUrl.indexOf('refresh=0') > 0, meshUrl);
  assert.ok(meshUrl.indexOf('precision=mid') > 0, '默认精度档要带给宿主：' + meshUrl);
  assert.ok(meshUrl.indexOf('maxTriangles=' + HOST_PRECISION_TIERS.mid.maxTriangles) > 0, meshUrl);
  assert.ok(meshUrl.indexOf('deflection=' + HOST_PRECISION_TIERS.mid.deflection) > 0, meshUrl);

  // reopening the same file must not hit the host again
  await T.loadModelData('C:\\work\\parts\\锁盖.STEP', { fileName: '锁盖.STEP', fileExt: 'STEP' });
  assert.equal(host.counts.ping, 1, 'ping must be cached at module level');
  assert.equal(host.counts.resolve, 1, 'resolve must be cached per path');
  assert.equal(host.counts.mesh, 1, 'mesh must be cached per path (Map<path, Promise<ArrayBuffer>>)');
});

await checkAsync('loadModelData: base（会话工作区根）会作为 &base= 传给宿主', async () => {
  const host = createHost(T);
  hostResponder = host.fetch;
  T.clearCaches();
  await T.loadModelData('轴承支架.SLDPRT', {
    fileName: '轴承支架.SLDPRT',
    fileExt: 'SLDPRT',
    base: 'D:\\ws',
  });
  const resolveUrl = host.urls.find((u) => u.startsWith('/sw3d/resolve'));
  assert.ok(resolveUrl.indexOf('base=' + encodeURIComponent('D:\\ws')) > 0, resolveUrl);
  const meshUrl = host.urls.find((u) => u.startsWith('/sw3d/mesh'));
  assert.ok(meshUrl.indexOf('base=' + encodeURIComponent('D:\\ws')) > 0, meshUrl);
  // 相对路径原样发出去（宿主负责补全），不能被客户端拼成半成品
  assert.ok(resolveUrl.indexOf('path=' + encodeURIComponent('轴承支架.SLDPRT')) > 0, resolveUrl);
});

await checkAsync('loadModelData: fallback-step 的进度文案说明用的是兜底 STEP', async () => {
  const host = createHost(T, {
    resolve: {
      ok: true,
      path: 'C:\\work\\parts\\封板.SLDPRT',
      format: 'sldprt',
      meshSource: 'fallback-step',
      sibling: 'C:\\work\\parts\\封板-01.step',
      bytes: 4096,
      mtimeMs: 1700000000000,
      cached: { hit: true },
      hints: ['未找到同名 STEP，使用最接近的 封板-01.step'],
    },
  });
  hostResponder = host.fetch;
  T.clearCaches();
  const progress = [];
  await T.loadModelData('C:\\work\\parts\\封板.SLDPRT', {
    fileName: '封板.SLDPRT',
    fileExt: 'SLDPRT',
    onProgress: (message) => progress.push(message),
  });
  assert.ok(progress.some((p) => p.includes('最接近的 STEP')), progress.join(' / '));
});

await checkAsync('loadModelData: NO_MESH_SOURCE keeps message/hint/code', async () => {
  const host = createHost(T, {
    resolve: {
      ok: false,
      code: 'NO_MESH_SOURCE',
      message: 'SLDPRT 没有可用的同名 STEP',
      hint: '请先导出 STEP（deliver）后再预览',
    },
  });
  hostResponder = host.fetch;
  T.clearCaches();
  await assert.rejects(
    T.loadModelData('C:\\work\\parts\\锁盖.SLDPRT', { fileName: '锁盖.SLDPRT', fileExt: 'SLDPRT' }),
    (err) => {
      assert.equal(err.code, 'NO_MESH_SOURCE');
      assert.equal(err.message, 'SLDPRT 没有可用的同名 STEP');
      assert.equal(err.hint, '请先导出 STEP（deliver）后再预览');
      return true;
    }
  );
  assert.equal(host.counts.mesh, 0, 'mesh must not be requested when resolve fails');
});

await checkAsync('loadModelData: NOT_FOUND（相对路径补全失败）原样透传 received/expected', async () => {
  const host = createHost(T, {
    resolve: {
      ok: false,
      code: 'NOT_FOUND',
      message: '需要绝对路径，收到的是：轴承支架.SLDPRT',
      hint: '期望形态：C:\\work\\part.STEP',
      received: '轴承支架.SLDPRT',
      expected: 'C:\\work\\part.STEP',
    },
  });
  hostResponder = host.fetch;
  T.clearCaches();
  await assert.rejects(
    T.loadModelData('轴承支架.SLDPRT', { fileName: '轴承支架.SLDPRT', fileExt: 'SLDPRT' }),
    (err) => {
      assert.equal(err.code, 'NOT_FOUND');
      assert.ok(err.message.includes('需要绝对路径'), err.message);
      assert.ok(err.hint.includes('期望形态'), err.hint);
      return true;
    }
  );
});

await checkAsync('loadModelData: 422 mesh failure surfaces host message/hint', async () => {
  const host = createHost(T, {
    meshFail: {
      status: 422,
      body: { ok: false, code: 'OCP_MESH_FAILED', message: 'OCP 网格化失败', hint: 'STEP 文件可能已损坏' },
    },
  });
  hostResponder = host.fetch;
  T.clearCaches();
  await assert.rejects(
    T.loadModelData('C:\\work\\parts\\bad.STEP', { fileName: 'bad.STEP', fileExt: 'STEP' }),
    (err) => {
      assert.equal(err.code, 'OCP_MESH_FAILED');
      assert.equal(err.message, 'OCP 网格化失败');
      assert.equal(err.hint, 'STEP 文件可能已损坏');
      return true;
    }
  );
});

await checkAsync('rebuild cache: refresh=1 bypasses the mesh cache', async () => {
  const host = createHost(T);
  hostResponder = host.fetch;
  T.clearCaches();
  await T.fetchMeshBuffer('C:\\work\\parts\\锁盖.STEP', T.DEFAULT_DEFLECTION, false);
  assert.equal(host.counts.mesh, 1);
  await T.fetchMeshBuffer('C:\\work\\parts\\锁盖.STEP', T.DEFAULT_DEFLECTION, false);
  assert.equal(host.counts.mesh, 1, 'cached mesh must be reused');
  await T.fetchMeshBuffer('C:\\work\\parts\\锁盖.STEP', T.DEFAULT_DEFLECTION, true);
  assert.equal(host.counts.mesh, 2, 'refresh must bypass the cache');
  assert.ok(host.urls[host.urls.length - 1].indexOf('refresh=1') > 0, host.urls[host.urls.length - 1]);
});

await checkAsync('precision tiers get independent cache entries and URL params', async () => {
  const host = createHost(T);
  hostResponder = host.fetch;
  T.clearCaches();
  await T.fetchMeshBuffer('C:\\work\\parts\\锁盖.STEP', 'low', false);
  assert.equal(host.counts.mesh, 1);
  const lowUrl = host.urls[host.urls.length - 1];
  assert.ok(lowUrl.indexOf('precision=low') > 0, lowUrl);
  assert.ok(lowUrl.indexOf('maxTriangles=' + HOST_PRECISION_TIERS.low.maxTriangles) > 0, lowUrl);
  assert.ok(lowUrl.indexOf('deflection=' + HOST_PRECISION_TIERS.low.deflection) > 0,
    'URL 里的 deflection 必须等于宿主 low 档的弦高：' + lowUrl);
  assert.equal(T.meshCache.size, 1);

  await T.fetchMeshBuffer('C:\\work\\parts\\锁盖.STEP', 'high', false);
  assert.equal(host.counts.mesh, 2, '不同精度档必须是不同缓存条目');
  assert.equal(T.meshCache.size, 2);
  const highUrl = host.urls[host.urls.length - 1];
  assert.ok(highUrl.indexOf('precision=high') > 0, highUrl);
  assert.ok(highUrl.indexOf('maxTriangles=' + HOST_PRECISION_TIERS.high.maxTriangles) > 0, highUrl);
  assert.ok(highUrl.indexOf('deflection=' + HOST_PRECISION_TIERS.high.deflection) > 0,
    'URL 里的 deflection 必须等于宿主 high 档的弦高：' + highUrl);

  await T.fetchMeshBuffer('C:\\work\\parts\\锁盖.STEP', 'high', false);
  assert.equal(host.counts.mesh, 2, '同档重复请求应命中缓存');
  T.clearCaches();
});

await checkAsync('postHandoff: POST /sw3d/handoff with {path} returns mdPath/count/bytes', async () => {
  const host = createHost(T);
  hostResponder = host.fetch;
  const res = await T.postHandoff('C:\\work\\parts\\锁盖.STEP');
  assert.equal(host.counts.handoff, 1);
  const url = host.urls[host.urls.length - 1];
  assert.equal(url, '/sw3d/handoff');
  assert.deepEqual(JSON.parse(host.bodies[host.bodies.length - 1]), { path: 'C:\\work\\parts\\锁盖.STEP' });
  assert.equal(res.ok, true);
  assert.equal(res.count, 3);
  assert.ok(res.mdPath.endsWith('.md'));
  assert.ok(res.mdPath.toLowerCase().includes('sw-3d-preview\\handoff'));
  assert.equal(res.designId, 'lock-cover');
  // 宿主失败时抛出带 message 的错误
  const failing = createHost(T, { handoff: { ok: false, code: 'NOT_FOUND', message: '文件不存在' } });
  hostResponder = failing.fetch;
  const bad = await T.postHandoff('C:\\work\\parts\\nope.STEP');
  assert.equal(bad.ok, false);
  assert.equal(bad.message, '文件不存在');
});

await checkAsync('postHandoff: 新生成的交接单会清掉旧的 handoff 状态路径（缓存一致性）', async () => {
  const host = createHost(T);
  hostResponder = host.fetch;
  const first = await T.postHandoff('C:\\work\\parts\\锁盖.STEP');
  const second = await T.postHandoff('C:\\work\\parts\\锁盖.STEP');
  assert.equal(first.mdPath, second.mdPath, '同一文件必须复用同一个交接单路径');
  assert.equal(host.counts.handoff, 2);
});

/* ------------------------------------------------------------------ */
/* regression: 「正在解析路径…」再也不许无限 pending                      */
/* ------------------------------------------------------------------ */

const BEARING_ADDRESS =
  'dsh-resource://file/session/S1/' + encodeURIComponent('轴承支架.SLDPRT');
const BEARING_ABS = 'C:\\Users\\mota\\Desktop\\工程自动化\\轴承支架.SLDPRT';

function viewerProps(useResource, overrides) {
  return Object.assign({
    resourceAddress: BEARING_ADDRESS,
    useResource,
    content: { loading: 'renderer', loaded() {}, failed() {}, reload() {} },
    inputActions: { setDraft() {} },
  }, overrides || {});
}

/**
 * Host responder with a manual gate on /sw3d/resolve, so a test can observe the UI while
 * the host is still thinking (that is exactly the state the real panel got stuck in).
 * @returns {{urls:string[], release:(response?:object)=>void, fail:(status:number, body:object)=>void}}
 */
function gatedResolveHost(options) {
  const opts = options || {};
  const state = { urls: [], pending: null };
  hostResponder = (url) => {
    const target = String(url);
    state.urls.push(target);
    if (target.startsWith('/sw3d/ping')) {
      return Promise.resolve(jsonResponse(200, { ok: true, python: { ok: true, ocp: true }, cacheDir: 'C:/cache' }));
    }
    if (target.startsWith('/sw3d/resolve')) {
      return new Promise((resolve) => {
        state.pending = {
          resolve: (body, status) => resolve(jsonResponse(status || 200, body || {
            ok: true, path: BEARING_ABS, format: 'sldprt', meshSource: 'sibling-step',
            sibling: 'C:\\Users\\mota\\Desktop\\工程自动化\\轴承支架.step', bytes: 76259,
          })),
        };
      });
    }
    if (target.startsWith('/sw3d/mesh')) {
      if (opts.meshFail) return Promise.resolve(jsonResponse(opts.meshFail.status || 422, opts.meshFail.body));
      return Promise.resolve(binaryResponse(T.buildSampleS3DM()));
    }
    return Promise.reject(new Error('unexpected request: ' + target));
  };
  return state;
}

await checkAsync('回归：stat 永远 loading → 1200ms 后带原始地址发请求（不再无限 pending）', async () => {
  const host = gatedResolveHost();
  T.clearCaches();
  const root = mount(T.ViewerBody, viewerProps(() => ({ status: 'loading', value: undefined, failure: undefined })));
  try {
    await settle();
    assert.ok(root.text().includes('正在解析路径…'), root.text().slice(0, 200));
    assert.equal(host.urls.filter((u) => u.startsWith('/sw3d/resolve')).length, 0, '宽限期内绝不发请求');

    advance(T.PATH_RESOLVE_GRACE_MS);
    await settle();
    const resolveUrls = host.urls.filter((u) => u.startsWith('/sw3d/resolve'));
    assert.equal(resolveUrls.length, 1, '1200ms 后必须发出 resolve：' + JSON.stringify(host.urls));
    assert.ok(resolveUrls[0].includes('path=' + encodeURIComponent('轴承支架.SLDPRT')), resolveUrls[0]);
    assert.ok(!resolveUrls[0].includes('base='), '没有工作区根时不该乱带 base：' + resolveUrls[0]);

    // 降级后文案要变，不许还是死等
    assert.ok(!root.text().includes('正在解析路径…'), '降级后不能再显示死等文案');
    assert.ok(root.text().includes('正在按文件名补全路径'), root.text().slice(0, 300));

    // 关键回归点：旧实现每 1.5s 重发一次并在 cleanup 里取消 → 这里必须只发一次
    advance(6000);
    await settle();
    assert.equal(host.urls.filter((u) => u.startsWith('/sw3d/resolve')).length, 1, '降级只能发一次，不许振荡重发');
    assert.ok(root.renderCount() < 60, '渲染次数异常，疑似渲染循环：' + root.renderCount());
  } finally {
    root.unmount();
    hostResponder = null;
  }
});

await checkAsync('回归：stat loading→live 且 value.absolutePath 有值 → 立刻 ready，不发相对请求', async () => {
  const host = gatedResolveHost();
  T.clearCaches();
  let live = false;
  const root = mount(T.ViewerBody, viewerProps(() => (live
    ? { status: 'live', value: { absolutePath: BEARING_ABS, version: 'v9' }, failure: undefined }
    : { status: 'loading', value: undefined, failure: undefined })));
  try {
    await settle();
    assert.ok(root.text().includes('正在解析路径…'));
    live = true;
    // 让组件感知：真实环境里是 useResource 的订阅驱动的，这里重挂一次等价于它重渲染。
    const root2 = mount(T.ViewerBody, viewerProps(() => ({ status: 'live', value: { absolutePath: BEARING_ABS }, failure: undefined })));
    await settle();
    assert.ok(!root2.text().includes('正在解析路径…'), 'live 之后不许再 pending');
    const resolveUrls = host.urls.filter((u) => u.startsWith('/sw3d/resolve'));
    assert.equal(resolveUrls.length, 1, JSON.stringify(host.urls));
    assert.ok(resolveUrls[0].includes('path=' + encodeURIComponent(BEARING_ABS)), resolveUrls[0]);
    assert.ok(!resolveUrls[0].includes(encodeURIComponent('轴承支架.SLDPRT&')),
      'live 时不该先发相对路径请求：' + resolveUrls[0]);
    root2.unmount();
  } finally {
    root.unmount();
    hostResponder = null;
  }
});

await checkAsync('回归：stat 变 failed → 立刻降级请求，不滞留 pending（不等 1200ms）', async () => {
  const host = gatedResolveHost();
  T.clearCaches();
  const root = mount(T.ViewerBody, viewerProps(() => ({
    status: 'failed',
    value: undefined,
    failure: { code: 'workspace-file/not-found', message: 'no entry' },
  })));
  try {
    await settle();
    const resolveUrls = host.urls.filter((u) => u.startsWith('/sw3d/resolve'));
    assert.equal(resolveUrls.length, 1, 'failed 必须立刻降级：' + JSON.stringify(host.urls));
    assert.ok(resolveUrls[0].includes('path=' + encodeURIComponent('轴承支架.SLDPRT')), resolveUrls[0]);
    assert.ok(!root.text().includes('正在解析路径…'), root.text().slice(0, 200));
  } finally {
    root.unmount();
    hostResponder = null;
  }
});

await checkAsync('回归：相对地址 + props 里有工作区根 → 客户端拼成绝对路径再发请求', async () => {
  const host = gatedResolveHost();
  T.clearCaches();
  const root = mount(T.ViewerBody, viewerProps(
    () => ({ status: 'loading', value: undefined, failure: undefined }),
    { cwd: 'C:\\Users\\mota\\Desktop\\工程自动化' },
  ));
  try {
    await settle();
    advance(T.PATH_RESOLVE_GRACE_MS);
    await settle();
    const resolveUrls = host.urls.filter((u) => u.startsWith('/sw3d/resolve'));
    assert.equal(resolveUrls.length, 1, JSON.stringify(host.urls));
    assert.ok(resolveUrls[0].includes('path=' + encodeURIComponent(BEARING_ABS)),
      '工作区根必须被拼进路径：' + resolveUrls[0]);
  } finally {
    root.unmount();
    hostResponder = null;
  }
});

await checkAsync('回归：地址本身是盘符绝对路径 → 不等 stat，直接 ready 并请求宿主', async () => {
  const host = gatedResolveHost();
  T.clearCaches();
  const address = 'dsh-resource://file/session/S1/' + encodeURIComponent('C:/Users/mota/Desktop/工程自动化/锁盖.STEP');
  const root = mount(T.ViewerBody, viewerProps(
    () => ({ status: 'loading', value: undefined, failure: undefined }),
    { resourceAddress: address },
  ));
  try {
    await settle();
    assert.ok(!root.text().includes('正在解析路径…'), '绝对地址不该等 stat：' + root.text().slice(0, 200));
    const resolveUrls = host.urls.filter((u) => u.startsWith('/sw3d/resolve'));
    assert.equal(resolveUrls.length, 1, JSON.stringify(host.urls));
    assert.ok(resolveUrls[0].includes('path=' + encodeURIComponent('C:\\Users\\mota\\Desktop\\工程自动化\\锁盖.STEP')), resolveUrls[0]);
  } finally {
    root.unmount();
    hostResponder = null;
  }
});

await checkAsync('回归：宿主 404（resolve）→ 失败卡片含 code/message/hint，且不再显示「正在解析」', async () => {
  const state = gatedResolveHost();
  T.clearCaches();
  const root = mount(T.ViewerBody, viewerProps(() => ({ status: 'loading', value: undefined, failure: undefined })));
  try {
    await settle();
    advance(T.PATH_RESOLVE_GRACE_MS);
    await settle();
    state.pending.resolve({
      ok: false,
      code: 'NOT_FOUND',
      message: '找不到文件 轴承支架.SLDPRT',
      hint: '先让 agent 执行 deliver 导出 STEP',
    }, 404);
    await settle();
    const text = root.text();
    assert.ok(text.includes('3D 预览失败'), text.slice(0, 300));
    assert.ok(text.includes('找不到文件 轴承支架.SLDPRT'), '必须显示宿主 message：' + text.slice(0, 400));
    assert.ok(text.includes('先让 agent 执行 deliver 导出 STEP'), '必须显示宿主 hint');
    assert.ok(text.includes('错误码：NOT_FOUND'), '必须显示宿主 code');
    assert.ok(text.includes('面板路径栏显示的是：'), '必须带「面板路径栏显示的是 / 实际发出的是」');
    assert.ok(text.includes('实际发出的是：轴承支架.SLDPRT'), text.slice(0, 400));
    assert.ok(!text.includes('正在解析路径…'), '失败卡片不许再混着死等文案');
  } finally {
    root.unmount();
    hostResponder = null;
  }
});

await checkAsync('回归：宿主 422（mesh）→ 失败卡片含 code/message/hint', async () => {
  const state = gatedResolveHost({
    meshFail: { status: 422, body: { ok: false, code: 'OCP_MESH_FAILED', message: 'OCP 网格化失败', hint: 'STEP 文件可能已损坏' } },
  });
  T.clearCaches();
  const root = mount(T.ViewerBody, viewerProps(
    () => ({ status: 'live', value: { absolutePath: BEARING_ABS }, failure: undefined }),
  ));
  try {
    await settle();
    assert.ok(state.pending, 'live 绝对路径应直接请求 resolve：' + JSON.stringify(state.urls));
    state.pending.resolve();
    await settle();
    const text = root.text();
    assert.ok(text.includes('3D 预览失败'), text.slice(0, 300));
    assert.ok(text.includes('OCP 网格化失败'), text.slice(0, 400));
    assert.ok(text.includes('STEP 文件可能已损坏'));
    assert.ok(text.includes('错误码：OCP_MESH_FAILED'));
    assert.ok(text.includes('实际发出的是：' + BEARING_ABS), '失败卡片要写清真正发出去的绝对路径');
    assert.ok(!text.includes('正在解析路径…'));
  } finally {
    root.unmount();
    hostResponder = null;
  }
});

await checkAsync('回归：20s 硬超时 → 宿主一直不响应也必须显示失败卡片', async () => {
  hostResponder = (url) => {
    const target = String(url);
    if (target.startsWith('/sw3d/ping')) {
      return Promise.resolve(jsonResponse(200, { ok: true, python: { ok: true, ocp: true }, cacheDir: 'C:/cache' }));
    }
    return new Promise(() => {});      // 永远不返回
  };
  T.clearCaches();
  const root = mount(T.ViewerBody, viewerProps(
    () => ({ status: 'live', value: { absolutePath: BEARING_ABS }, failure: undefined }),
  ));
  try {
    await settle();
    assert.ok(!root.text().includes('3D 预览失败'), '超时前不该报错');
    advance(T.PATH_HARD_TIMEOUT_MS);
    await settle();
    const text = root.text();
    assert.ok(text.includes('3D 预览失败'), text.slice(0, 300));
    assert.ok(text.includes('超时'), text.slice(0, 300));
    assert.ok(text.includes('错误码：TIMEOUT'), text.slice(0, 400));
    assert.ok(!text.includes('正在解析路径…'));
  } finally {
    root.unmount();
    hostResponder = null;
  }
});

check('joinWorkspaceRoot / useResourceSnapshot：纯函数层的兜底行为', () => {
  assert.equal(T.joinWorkspaceRoot('C:\\Users\\mota\\Desktop\\工程自动化', '轴承支架.SLDPRT'), BEARING_ABS);
  assert.equal(T.joinWorkspaceRoot('D:\\ws\\', 'parts\\a.STEP'), 'D:\\ws\\parts\\a.STEP');
  assert.equal(T.joinWorkspaceRoot('', 'a.STEP'), '', '没有根就返回空，交给宿主补全');
  assert.equal(T.joinWorkspaceRoot('D:\\ws', '..\\escape.STEP'), '', '不许把 .. 拼进工作区根');
  // 两种 useResource 形状都要能读到？绝对路径
  const address = BEARING_ADDRESS;
  assert.equal(
    T.decidePath({ address, meta: T.useResourceSnapshot({ useResource: () => ({ status: 'live', value: { absolutePath: BEARING_ABS } }) }, address) }).path,
    BEARING_ABS,
  );
  assert.equal(
    T.decidePath({ address, meta: T.useResourceSnapshot({ useResource: () => () => ({ status: 'live', value: { absolutePath: BEARING_ABS } }) }, address) }).path,
    BEARING_ABS,
    '旧版 factory 形状（useResource(protocol)(address)）也要兼容',
  );
  assert.equal(T.useResourceSnapshot({}, address), null);
  assert.equal(T.useResourceSnapshot({ useResource: () => { throw new Error('boom'); } }, address), null,
    'useResource 抛错时只能失去快路径，不能把组件打崩');
});

/* ------------------------------------------------------------------ */
/* 用户视角截图：信息带 / 合成 / 编码 / 通道 A→B 降级                    */
/* ------------------------------------------------------------------ */

/** 假 2D canvas：记录 fillText/fillRect，toBlob 产出一张指定大小的假图。 */
function fake2dCanvas(blobSize = 4096, mime = 'image/png') {
  const drawn = [];
  const rects = [];
  const styles = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    font: '',
    lineWidth: 1,
    fillRect(x, y, w, h) { rects.push({ x, y, w, h, fillStyle: this.fillStyle }); },
    fillText(text, x, y) { drawn.push({ text: String(text), x, y, fillStyle: this.fillStyle }); },
    drawImage() { styles.push('drawImage'); },
    beginPath() {},
    arc() {},
    stroke() {},
    measureText(text) { return { width: String(text).length * 7 }; },
  };
  const canvas = {
    width: 0,
    height: 0,
    drawn,
    rects,
    getContext(kind) { return kind === '2d' ? ctx : null; },
    toBlob(cb) { cb(new Blob([new Uint8Array(blobSize)], { type: mime })); },
  };
  return canvas;
}

check('snapshotMetaLines：信息带正好两行，逐字符断言（边 / 面 / 无选中）', () => {
  const at = new Date(2026, 10, 15, 1, 12, 0);   // 本地时间构造：断言不依赖 TZ
  const edge = T.snapshotMetaLines({
    fileName: '锁盖.STEP',
    summary: { subject: 'edge', index: 33, kindLabel: '直线', lengthMm: 211 },
    view: 'iso',
    section: { axis: 'x', t: 44, enabled: true, flip: false },
    precision: 'mid',
    cap: true,
    at,
  });
  assert.equal(edge.length, 2, '信息带必须正好两行：' + JSON.stringify(edge));
  assert.equal(edge[0], '锁盖.STEP · 边 #33 直线 211mm');
  assert.equal(edge[1], '视角 等轴测 · 剖切 X 44%（封盖开）· 精度 中 · 2026-11-15 01:12');

  const face = T.snapshotMetaLines({
    fileName: '锁盖.STEP',
    summary: { subject: 'face', index: 12, kindLabel: '圆柱', diameterMm: 5 },
    view: 'front',
    section: { axis: 'y', t: 30, enabled: true, flip: true },
    precision: 'low',
    cap: false,
    at,
  });
  assert.equal(face[0], '锁盖.STEP · 面 #12 圆柱 Ø5');
  assert.equal(face[1], '视角 前视图 · 剖切 Y 30%（封盖关）· 精度 低 · 2026-11-15 01:12');

  const none = T.snapshotMetaLines({ fileName: '锁盖.STEP', summary: null, section: null, at });
  assert.equal(none[0], '锁盖.STEP · 未选中边/面（仅当前视角）');
  assert.ok(none[1].startsWith('视角 等轴测 · 剖切 关（封盖开）· 精度 中 · '), none[1]);
});

check('snapshotPlan：小画布等比放大到 ≥1280×720，宽度不超过 2400', () => {
  const small = T.snapshotPlan(880, 576);
  assert.ok(small.width >= 1280, '宽必须 ≥1280：' + JSON.stringify(small));
  assert.ok(small.height >= 720, '高必须 ≥720：' + JSON.stringify(small));
  assert.equal(small.width, 1280);
  assert.equal(small.height, 838, '等比放大：880×576 × 1.4545');
  const huge = T.snapshotPlan(3000, 2000);
  assert.equal(huge.width, 2400, '超宽画布要压到 2400');
  assert.equal(huge.scale > 0, true);
});

check('composeSnapshot：把两行信息带画在底图下方（深色半透明底 + 白字）', () => {
  const line1 = '锁盖.STEP · 边 #33 直线 211mm';
  const line2 = '视角 等轴测 · 剖切 X 44%（封盖开）· 精度 中 · 2026-11-15 01:12';
  let sourceCanvas = null;
  const composed = T.composeSnapshot(
    { canvas: { width: 880, height: 576 }, cssWidth: 880, cssHeight: 576 },
    { lines: [line1, line2] },
    {
      createCanvas(width, height) {
        sourceCanvas = fake2dCanvas();
        sourceCanvas.width = width;
        sourceCanvas.height = height;
        return sourceCanvas;
      },
    },
  );
  assert.equal(composed.width, 1280);
  assert.equal(composed.height, 838 + 2 * 18 + 2 * 10, '底图 + 两行 × 18px + 上下留白');
  assert.equal(composed.footerHeight, 2 * 18 + 2 * 10);
  assert.deepEqual(sourceCanvas.drawn.map((d) => d.text), [line1, line2], '两行文字逐字符进图');
  const footer = sourceCanvas.rects.find((r) => r.y === 838 && r.w === 1280);
  assert.ok(footer, '必须有底部信息带背景：' + JSON.stringify(sourceCanvas.rects));
  assert.equal(footer.fillStyle, 'rgba(10, 14, 20, 0.86)', '信息带底色是深色半透明');
  assert.ok(sourceCanvas.drawn.every((d) => d.fillStyle === '#dfe6ee'), '白字（浅前景色）');
});

await checkAsync('encodeSnapshot：假 canvas 产出非空 PNG，mediaType 正确', async () => {
  const canvas = fake2dCanvas(4096, 'image/png');
  canvas.width = 1280;
  canvas.height = 894;
  const result = await T.encodeSnapshot(canvas);
  assert.equal(result.mime, 'image/png', '小图必须保持 PNG');
  assert.equal(result.bytes, 4096);
  assert.ok(result.blob && result.blob.size === 4096, '必须产出真实字节');
  assert.equal(result.recompressed, false);
  assert.equal(result.width, 1280);
});

await checkAsync('encodeSnapshot：PNG >1.5 MB 自动重编成 JPEG(0.9)', async () => {
  const calls = [];
  const bigPng = Math.round(1.6 * 1024 * 1024);
  const canvas = {
    width: 1280,
    height: 894,
    toBlob(cb, mime, quality) {
      calls.push({ mime, quality });
      const size = mime === 'image/jpeg' ? 300 * 1024 : bigPng;
      cb(new Blob([new Uint8Array(size)], { type: mime }));
    },
  };
  const result = await T.encodeSnapshot(canvas);
  assert.equal(result.mime, 'image/jpeg', '>1.5MB 的 PNG 必须降成 JPEG');
  assert.equal(result.recompressed, true);
  assert.equal(result.pngBytes, bigPng);
  assert.equal(result.bytes, 300 * 1024);
  assert.equal(calls[0].mime, 'image/png');
  assert.equal(calls[1].mime, 'image/jpeg');
  assert.equal(calls[1].quality, T.SNAPSHOT_JPEG_QUALITY, 'JPEG 质量必须是 0.9');
});

await checkAsync('postSnapshot：宿主 404 → 返回 null，不抛（草稿文本照填）', async () => {
  const seen = [];
  hostResponder = (url, init) => {
    seen.push({ url: String(url), body: init && init.body ? String(init.body) : '' });
    return Promise.resolve(jsonResponse(404, { ok: false, code: 'NOT_FOUND', message: '没有这个路由' }));
  };
  try {
    const blob = new Blob([new Uint8Array(128)], { type: 'image/png' });
    const result = await T.postSnapshot('C:\\work\\锁盖.STEP', blob);
    assert.equal(result, null, '404 必须安静地降级成 null');
    assert.equal(seen.length, 1, '只发一次请求，不重试炸场');
    assert.ok(seen[0].url.startsWith('/sw3d/snapshot'));
    const body = JSON.parse(seen[0].body);
    assert.equal(body.path, 'C:\\work\\锁盖.STEP');
    assert.equal(typeof body.base64, 'string', '宿主契约字段是 base64');
    assert.equal(body.mediaType, 'image/png', '宿主契约字段是 mediaType');
  } finally {
    hostResponder = null;
  }
});

await checkAsync('截图通道 A 失败/抛错 → 自动降级通道 B，草稿文本仍带「截图：」行', async () => {
  const posts = [];
  hostResponder = (url, init) => {
    posts.push({ url: String(url), body: init && init.body ? String(init.body) : '' });
    if (String(url).startsWith('/sw3d/snapshot')) {
      return Promise.resolve(jsonResponse(200, {
        ok: true,
        shotPath: 'C:\\Users\\mota\\AppData\\Local\\sw-3d-preview\\shots\\deadbeef-1.png',
        bytes: 4096,
        mediaType: 'image/png',
      }));
    }
    return Promise.reject(new Error('unexpected request: ' + url));
  };
  try {
    const released = [];
    const conversation = {
      createDrafts() { return [{ id: 'draft-1' }, { id: 'draft-2' }]; },
      releaseDraftAttachments(list) { released.push(list); },
    };
    const props = {
      sessionId: 'S1',
      inputActions: {
        setDraft() {},
        addAttachments() { throw new Error('busy phase：发送中不接受新附件'); },
      },
    };
    const ctx = { get(name) { return name === 'conversation' ? conversation : null; } };
    const flow = await T.runSnapshotFlow({
      engine: {
        renderNow() { this.rendered = (this.rendered || 0) + 1; },
        getSnapshotSource() {
          return { canvas: { width: 880, height: 576 }, cssWidth: 880, cssHeight: 576 };
        },
      },
      lines: ['锁盖.STEP · 边 #33 直线 211mm', '视角 等轴测 · 剖切 X 44%（封盖开）· 精度 中 · 2026-11-15 01:12'],
      filePath: 'C:\\work\\锁盖.STEP',
      name: '锁盖-视角.png',
      props,
      ctx,
      createCanvas(width, height) {
        const canvas = fake2dCanvas(4096, 'image/png');
        canvas.width = width;
        canvas.height = height;
        return canvas;
      },
    });
    assert.equal(flow.ok, true, JSON.stringify(flow));
    assert.equal(flow.channel, 'host', 'A 失败必须降到 B：' + JSON.stringify(flow));
    assert.equal(flow.draftReason, 'ATTACH_REFUSED');
    assert.ok(flow.shotPath && flow.shotPath.endsWith('-1.png'), JSON.stringify(flow));
    assert.equal(flow.width, 1280);
    assert.equal(released.length, 1, 'A 被拒绝时必须回收刚建的草稿附件');
    assert.equal(released[0].length, 2, 'releaseDraftAttachments 拿到的是 createDrafts 的返回值');
    assert.equal(posts.length, 1, '只发一次 /sw3d/snapshot');
    const body = JSON.parse(posts[0].body);
    assert.equal(body.base64.length > 0, true);
    assert.equal(body.mediaType, 'image/png');

    // 草稿文本：既有格式原样保留，末尾多一行「截图：<路径>」
    const text = T.draftTextWithShot(T.buildAnnotationText({
      subject: 'edge', file: '锁盖.STEP', index: 33, kindLabel: '直线', lengthMm: 211,
      adjacentFaces: [], samples: [],
    }, '这里倒角加大', {}), flow.shotPath);
    assert.ok(text.includes('视角：等轴测，剖切：关，精度：中'), text);
    const shotLines = text.split('\n').filter((line) => line.startsWith('截图：'));
    assert.deepEqual(shotLines, ['截图：' + flow.shotPath], '必须正好一行截图路径：' + text);
    assert.equal(T.draftTextWithShot(text, flow.shotPath), text, '重复追加要幂等');
  } finally {
    hostResponder = null;
  }
});

/* ------------------------------------------------------------------ */
/* 三种选中（点/边/面） + 双击标记 + 右键菜单                            */
/* ------------------------------------------------------------------ */

// 构造用的 B-rep 边：0 号 (0,0,0)-(10,0,0)；1 号 (10,0,0)-(10,10,0)；
// 2 号 (10,10,0.0005)-(0,10,0) —— 与 1 号的终点只差 0.0005，必须被焊接掉。
const weldEdges = [
  { index: 0, start: [0, 0, 0], end: [10, 0, 0], mid: [5, 0, 0], faces: [0, 1], polylineStart: 0, polylineCount: 2 },
  { index: 1, start: [10, 0, 0], end: [10, 10, 0], mid: [10, 5, 0], faces: [1], polylineStart: 2, polylineCount: 3 },
  { index: 2, start: [10, 10, 0.0005], end: [0, 10, 0], faces: [0, 1], polylineStart: 5, polylineCount: 2 },
];
const weldEdgePosition = new Float32Array([
  0, 0, 0, 10, 0, 0,      // 0 号边折线
  10, 0, 0, 10, 5, 0, 10, 10, 0, // 1 号边折线
  10, 10, 0, 0, 10, 0,    // 2 号边折线
]);
const WELD_BBOX = [0, 0, 0, 10, 10, 0];

check('顶点焊接：角点只来自边端点，重复端点（差 0.0005mm）被合并，直边 mid 不算角点', () => {
  const tolerance = T.cornerWeldTolerance(WELD_BBOX);
  assert.ok(tolerance > 0.0005, '容差必须大于 0.0005mm，否则焊接不掉：' + tolerance);
  const set = T.buildCornerSet(weldEdges, weldEdgePosition, WELD_BBOX);
  assert.equal(set.corners.length, 4, '四个角：(0,0,0)/(10,0,0)/(10,10,0)/(0,10,0)，实际 ' +
    JSON.stringify(set.corners.map((c) => c.position)));
  assert.deepEqual(set.corners.map((c) => c.index), [0, 1, 2, 3], 'index 必须等于数组下标');
  const corner10 = set.corners.find((c) => Math.abs(c.position[0] - 10) < 1e-9 && Math.abs(c.position[1] - 10) < 1e-9);
  assert.ok(corner10, '必须存在 (10,10,0) 这个角点');
  assert.deepEqual(corner10.edges.slice().sort(), [1, 2], '(10,10,0) 相邻边 #1 / #2');
  assert.deepEqual(corner10.faces.slice().sort(), [0, 1], '相邻面并集 #0 / #1');
  // 直边的 mid（5,0,0）不是角点
  assert.equal(set.corners.some((c) => Math.abs(c.position[0] - 5) < 1e-6), false, '直边 mid 不能进角点集');
  // 圆边的 mid 才算角点（否则圆边的对径点永远选不到）
  const circleSet = T.buildCornerSet([
    { index: 0, isCircle: true, start: [0, 0, 0], end: [0, 0, 0], mid: [5, 0, 0], faces: [0], polylineStart: 0, polylineCount: 2 },
  ], new Float32Array([0, 0, 0, 0, 0, 0]), [0, 0, 0, 10, 10, 10]);
  assert.equal(circleSet.corners.length, 2, '圆边：闭合端点焊成 1 个 + mid 1 个');
});

check('拾取优先级：同一根射线同时命中顶点/边/面时返回顶点', () => {
  const set = T.buildCornerSet(weldEdges, weldEdgePosition, WELD_BBOX);
  const threshold = T.vertexPickThreshold(WELD_BBOX);
  // 从 (10,0,0) 正上方往下打，射线穿过该角点
  const hit = T.pickVertexFromCorners(set.corners, [10, 0, 20], [0, 0, -1], threshold, null);
  assert.ok(hit, '射线应当命中角点 (10,0,0)');
  assert.equal(hit.vertexIndex, 1);
  const nearMiss = T.pickVertexFromCorners(set.corners, [10, 0, 20], [0, 0, -1], threshold * 0.5, null);
  assert.ok(nearMiss === null || nearMiss.vertexIndex >= 0);
  // 剖切裁掉的角点不可选
  const culled = T.pickVertexFromCorners(set.corners, [10, 0, 20], [0, 0, -1], threshold, (p) => p[0] < 5);
  assert.equal(culled, null, 'planeTest 为假（被剖切裁掉）的角点必须跳过');
  // 优先级表：顶点 > 边 > 面
  assert.equal(T.pickSubjectByPriority({ vertex: { v: 1 }, edge: { e: 1 }, face: { f: 1 } }), 'vertex');
  assert.equal(T.pickSubjectByPriority({ edge: { e: 1 }, face: { f: 1 } }), 'edge');
  assert.equal(T.pickSubjectByPriority({ face: { f: 1 } }), 'face');
  assert.equal(T.pickSubjectByPriority({}), 'none');
});

check('双击判定：299ms 同对象=双击、301ms=单击、不同对象=两次单击', () => {
  assert.equal(T.DOUBLE_CLICK_MS, 300);
  const a = { subject: 'face', faceIndex: 12 };
  const b = { subject: 'face', faceIndex: 13 };
  assert.equal(T.isDoubleClickGesture(a, { subject: 'face', faceIndex: 12 }, 299), true, '299ms 同对象=双击');
  assert.equal(T.isDoubleClickGesture(a, { subject: 'face', faceIndex: 12 }, 300), true, '300ms 仍算双击');
  assert.equal(T.isDoubleClickGesture(a, { subject: 'face', faceIndex: 12 }, 301), false, '301ms=两次单击');
  assert.equal(T.isDoubleClickGesture(a, b, 120), false, '不同对象=两次单击');
  assert.equal(T.isDoubleClickGesture(a, null, 120), false, '第二次落在空白不算双击对象');
  assert.equal(T.isDoubleClickGesture(null, null, 120), false, '空白×2 由调用方按「双击空白=适配」处理，这里不判双击对象');
  assert.equal(T.pickTargetKey({ subject: 'point', pointIndex: 3 }), 'point#3');
  assert.equal(T.pickTargetKey({ subject: 'edge', edgeIndex: 7 }), 'edge#7');
  assert.equal(T.pickTargetKey(null), 'none');
});

check('标记点文本：逐字符（含面/边/点三种来源 + 多行拼接）', () => {
  assert.equal(
    T.markerLine({ subject: 'face', index: 12, point: [1, 2, 3] }, 0),
    '标记 #1（面 #12 @ [1.00,2.00,3.00]）');
  assert.equal(
    T.markerLine({ subject: 'edge', index: 33, point: [-1.5, 0, 2.25] }, 1),
    '标记 #2（边 #33 @ [-1.50,0.00,2.25]）');
  assert.equal(
    T.markerLine({ subject: 'point', index: 5, point: [0, 0, 0] }, 2),
    '标记 #3（点 #5 @ [0.00,0.00,0.00]）');
  assert.equal(
    T.buildMarkersText([
      { subject: 'face', index: 12, point: [1, 2, 3] },
      { subject: 'edge', index: 33, point: [4, 5, 6] },
    ]),
    '标记 #1（面 #12 @ [1.00,2.00,3.00]）\n标记 #2（边 #33 @ [4.00,5.00,6.00]）');
  assert.equal(T.buildMarkersText([]), '');
});

check('右键菜单项：面对/边对/点对/空白对的 id 与数量（2–4 项）', () => {
  const face = T.contextMenuItemsFor({ subject: 'face', faceIndex: 12 });
  assert.deepEqual(face.map((i) => i.id), ['mark', 'new-sketch', 'edit-sketch']);
  assert.deepEqual(face.map((i) => i.label), ['标记此处', '添加草图', '编辑成型草图']);
  const edge = T.contextMenuItemsFor({ subject: 'edge', edgeIndex: 3 });
  assert.deepEqual(edge.map((i) => i.id), ['mark', 'fillet', 'datum']);
  assert.deepEqual(edge.map((i) => i.label), ['标记此处', '倒圆角/倒角', '作为基准']);
  const point = T.contextMenuItemsFor({ subject: 'point', pointIndex: 2 });
  assert.deepEqual(point.map((i) => i.id), ['mark', 'datum-point']);
  assert.deepEqual(point.map((i) => i.label), ['标记此处', '设为基准点']);
  const blank = T.contextMenuItemsFor(null);
  assert.deepEqual(blank.map((i) => i.id), ['fit', 'reset-view', 'copy-shot']);
  for (const [name, items] of [['面', face], ['边', edge], ['点', point], ['空白', blank]]) {
    assert.ok(items.length >= 2 && items.length <= 4, name + '菜单必须 2–4 项，实际 ' + items.length);
  }
  // 菜单项行为：mark = 真放标记；draft = 只生成指令
  assert.deepEqual(face.map((i) => i.behavior), ['mark', 'draft', 'draft']);
  assert.deepEqual(edge.map((i) => i.behavior), ['mark', 'draft', 'draft']);
  assert.deepEqual(point.map((i) => i.behavior), ['mark', 'draft']);
  assert.deepEqual(blank.map((i) => i.behavior), ['action', 'action', 'action']);
});

check('「添加草图」生成的指令文本：逐字符（含当面三点取样）', () => {
  const summary = {
    subject: 'face', index: 12, kind: 'cylinder', kindLabelWithSize: '圆柱 Ø5',
    areaMm2: 78.5, normal: [-0.707, 0, 0.707],
    samples: [[1, 2, 3], [4, 5, 6], [7, 8, 9]],
  };
  const text = T.buildSketchInstruction({
    action: 'new-sketch',
    file: 'C:\\work\\锁盖.STEP',
    summary,
  });
  assert.equal(text,
    '在当前选中对象上新建草图：文件 C:\\work\\锁盖.STEP，选中面 #12（圆柱 Ø5，面积 78.5 mm²，法向 [-0.707,0,0.707]），' +
    '取样点 P1 [1.00,2.00,3.00] P2 [4.00,5.00,6.00] P3 [7.00,8.00,9.00]；' +
    '请在该面上新建草图，并把我补充的意图画成草图轮廓。');
  // 边上的「倒圆角/倒角」也走同一模板，只是主体与尾巴不同
  const edgeText = T.buildSketchInstruction({
    action: 'fillet',
    file: '支架06.STEP',
    summary: { subject: 'edge', index: 33, kindLabel: '直线', lengthMm: 211, start: [0, 0, 0], end: [211, 0, 0], samples: [] },
  });
  assert.equal(edgeText,
    '对选中的边做倒圆角/倒角：文件 支架06.STEP，选中边 #33（直线，长 211 mm，端点 A [0.00,0.00,0.00] B [211.00,0.00,0.00]）；' +
    '请先给出该边的可倒半径区间，再按我补充的意图倒圆角。');
  assert.equal(T.buildSketchInstruction({ action: 'nonsense', summary: null, file: 'X.STEP' }).startsWith('在当前选中对象上新建草图：文件 X.STEP，选中未选中对象；'), true);
});

check('剖切裁切：被裁掉的标记点 visible===false（隐藏而不是半透明）', () => {
  const bbox = [0, 0, 0, 10, 10, 10];
  const section = { axis: 'x', t: 50, enabled: true, flip: false };
  // X 轴 50% → 平面 x=5，法向 +X：x >= 5 保留
  assert.equal(T.markerVisibleWithSection([4, 5, 5], section, bbox), false, 'x=4 被裁掉 → 不可见');
  assert.equal(T.markerVisibleWithSection([5, 5, 5], section, bbox), true, '正好在切面上的点仍然可见');
  assert.equal(T.markerVisibleWithSection([6, 5, 5], section, bbox), true);
  // 关掉剖切一切可见
  assert.equal(T.markerVisibleWithSection([4, 5, 5], { axis: 'x', t: 50, enabled: false }, bbox), true);
  // flip 后判定反向
  assert.equal(T.markerVisibleWithSection([4, 5, 5], { axis: 'x', t: 50, enabled: true, flip: true }, bbox), true);
  assert.equal(T.markerVisibleWithSection([6, 5, 5], { axis: 'x', t: 50, enabled: true, flip: true }, bbox), false);
  // 与 sectionPlaneInfo 的数学一致
  const info = T.sectionPlaneInfo(section, bbox);
  assert.equal(info.value, 5);
  assert.deepEqual(info.normal, [1, 0, 0]);
});

check('点卡片 / 点标注文本：4 行逐字符（模型坐标 + 归一化 + 相邻边/面）', () => {
  const set = T.buildCornerSet(weldEdges, weldEdgePosition, WELD_BBOX);
  const summary = T.pointSummary(set, 1, '锁盖.STEP', { bbox: WELD_BBOX });
  assert.equal(summary.subject, 'point');
  assert.deepEqual(summary.position, [10, 0, 0]);
  assert.deepEqual(summary.normalized, [1, 0, 0]);
  assert.deepEqual(summary.adjacentEdgeIndexes, [0, 1]);
  assert.deepEqual(summary.adjacentFaceIndexes, [0, 1]);
  const text = T.buildAnnotationText(summary, '这里加个标记', {});
  assert.equal(text, [
    '[3D标注] 文件：锁盖.STEP 设计ID：（无）',
    '选中：点 #1（模型坐标 [10.00,0.00,0.00]，归一化 [1,0,0]）',
    '相邻：边 #0 / #1，面 #0 / #1',
    '修改意见：这里加个标记',
  ].join('\n'));
  assert.equal(T.buildPointAnnotationText(summary, '').endsWith('修改意见：请按标注修改此处'), true);
  // 设计ID 有值时照填
  const withId = T.buildPointAnnotationText(Object.assign({}, summary, { designId: 'D-42' }), 'x');
  assert.equal(withId.split('\n')[0], '[3D标注] 文件：锁盖.STEP 设计ID：D-42');
});

/* ------------------------------------------------------------------ */
/* 草图叠加层（只读展示）                                                */
/* ------------------------------------------------------------------ */

const SKETCH_SAMPLE = {
  id: 'sk-1',
  name: 'Sketch1',
  feature: '凸台-拉伸1',
  plane: '基准面-上',
  polylines: [
    { points: [[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]], closed: true, kind: 'line' },
    { points: [[0, 0, 0], [10, 0, 0]], closed: false, kind: 'line' },
    { points: [[0, 0, 0], [5, 0, 0], [5, 0, 5]], closed: false, kind: 'arc' },
  ],
  dimensions: [
    { name: 'D1', value: 54, unit: 'mm' },
    { name: 'D2', value: 30, unit: 'mm' },
  ],
  bbox: [0, 0, 0, 10, 0, 10],
};

check('草图折线 → LineSegments 顶点数换算（闭合补一段，段数×2）', () => {
  // 闭合 4 点 = 4 段；开放 2 点 = 1 段；开放 3 点 = 2 段 → 7 段 → 14 个顶点
  assert.equal(T.sketchPolylineSegmentCount(SKETCH_SAMPLE.polylines[0]), 4);
  assert.equal(T.sketchPolylineSegmentCount(SKETCH_SAMPLE.polylines[1]), 1);
  assert.equal(T.sketchPolylineSegmentCount(SKETCH_SAMPLE.polylines[2]), 2);
  assert.equal(T.sketchPolylineVertexCount(SKETCH_SAMPLE.polylines), 14);
  // 退化输入不炸
  assert.equal(T.sketchPolylineVertexCount(null), 0);
  assert.equal(T.sketchPolylineVertexCount([{ points: [[0, 0, 0]] }]), 0);
  assert.equal(T.sketchPolylineVertexCount([{ points: [[0, 0, 0], [1, 1, 1]], closed: true }]), 4);
  const positions = T.buildSketchSegmentPositions(SKETCH_SAMPLE.polylines);
  assert.equal(positions.length, 14 * 3);
  // 闭合折线的最后一段必须回到起点：前 3 段是 6 个顶点（18 个浮点数），闭合段的两个端点紧随其后
  assert.deepEqual([positions[18], positions[19], positions[20]], [0, 0, 10]);
  assert.deepEqual([positions[21], positions[22], positions[23]], [0, 0, 0]);
  // 真 THREE 也不打折：同一个 LineSegments 的 position.count 就是 14
  const THREE = T.loadTHREE();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial());
  assert.equal(lines.geometry.attributes.position.count, T.sketchPolylineVertexCount(SKETCH_SAMPLE.polylines));
  geometry.dispose();
  lines.material.dispose();
});

check('草图标签 / 图例 / 尺寸 / 包围盒 / 折线统计文本：逐字符', () => {
  assert.equal(T.buildSketchLabelText(SKETCH_SAMPLE), 'Sketch1 · 凸台-拉伸1');
  assert.equal(T.buildSketchLabelText({ name: 'plate_band' }), 'plate_band');
  assert.equal(T.buildSketchLabelText({}), 'Sketch');
  assert.equal(T.sketchDimensionsText(SKETCH_SAMPLE), 'D1 = 54 mm，D2 = 30 mm');
  assert.equal(T.sketchDimensionsText({ dimensions: [] }), '');
  assert.equal(T.sketchBBoxText(SKETCH_SAMPLE.bbox), '[0,0,0]–[10,0,10] mm');
  assert.equal(T.sketchBBoxText(null), '');
  assert.equal(T.sketchPolylineStatsText(SKETCH_SAMPLE.polylines), '3 条折线（2 直线 1 圆弧）');
  assert.equal(T.sketchPolylineStatsText([{ points: [[0, 0, 0], [1, 1, 1]], kind: 'circle' }]), '1 条折线（1 圆）');
  assert.equal(T.sketchPolylineStatsText([]), '0 条折线');
  // 图例：草图数 + 去重后的特征数
  assert.equal(T.buildSketchLegendText({
    ok: true,
    sketches: [SKETCH_SAMPLE, { name: 'Sketch2', feature: '凸台-拉伸1' }, { name: 'Sketch3', feature: '切除-拉伸2' }],
  }), '草图 3 · 特征 2');
  assert.equal(T.buildSketchLegendText({ ok: false }), '草图 0 · 特征 0');
  assert.equal(T.buildSketchLegendText(null), '草图 0 · 特征 0');
});

check('「编辑这条草图」指令：逐字符（含默认留空提示）', () => {
  const text = T.buildSketchEditInstruction({
    file: 'D:\\work\\bracket-6.STEP',
    designId: 'bracket-6',
    sketch: SKETCH_SAMPLE,
    note: '把 D1 改成 60',
  });
  assert.equal(text, [
    '[3D标注] 文件：D:\\work\\bracket-6.STEP 设计ID：bracket-6',
    '选中：草图 Sketch1（属于特征「凸台-拉伸1」，绘制在 基准面-上）',
    '尺寸：D1 = 54 mm，D2 = 30 mm',
    '几何：3 条折线（2 直线 1 圆弧），包围盒 [0,0,0]–[10,0,10] mm',
    '修改意见：把 D1 改成 60',
  ].join('\n'));
  // 不给修改意见：留空占位并提示补完；缺 designId 也要有可读占位
  const bare = T.buildSketchEditInstruction({ sketch: SKETCH_SAMPLE });
  assert.equal(bare.split('\n')[0], '[3D标注] 文件：当前模型 设计ID：(未知)');
  assert.equal(bare.split('\n')[4], '修改意见：（在这里补完你想怎么改）');
  // 没有尺寸/几何也要有兜底文案，不能出现 undefined
  const empty = T.buildSketchEditInstruction({ file: 'a.STEP', designId: 'd', sketch: { name: 'S9' } });
  assert.equal(empty.includes('undefined'), false);
  assert.equal(empty.split('\n')[2], '尺寸：（该草图没有可读尺寸）');
  assert.equal(empty.split('\n')[3], '几何：0 条折线');
});

check('草图叠加层关闭：dispose 几何/材质/贴图并移出 group（断言对象被移除）', () => {
  const disposed = { geometry: 0, material: 0, texture: 0 };
  function material(label) {
    return {
      map: { dispose() { disposed.texture += 1; } },
      dispose() { disposed.material += 1; },
      label,
    };
  }
  function child(label) {
    return {
      label,
      geometry: { dispose() { disposed.geometry += 1; } },
      material: material(label),
    };
  }
  const group = {
    children: [child('line-1'), child('line-2'), { label: 'sprite', material: material('sprite') }],
    remove(node) {
      const at = this.children.indexOf(node);
      if (at >= 0) this.children.splice(at, 1);
    },
  };
  const stats = T.disposeSketchGroup(group);
  assert.equal(stats.removed, 3);
  assert.equal(stats.geometries, 2);
  assert.equal(stats.materials, 3);
  assert.equal(stats.textures, 3);
  assert.equal(group.children.length, 0, '关闭后 group 里不许再留对象（否则内存泄漏）');
  assert.deepEqual(disposed, { geometry: 2, material: 3, texture: 3 });
  // 空/null 输入不炸
  assert.deepEqual(T.disposeSketchGroup(null), { removed: 0, geometries: 0, materials: 0, textures: 0 });
  assert.deepEqual(T.disposeSketchGroup({ children: [] }), { removed: 0, geometries: 0, materials: 0, textures: 0 });
  // 默认关：开关不能默认打开（不然每个模型都被叠加层打扰）
  assert.equal(T.SKETCH_DEFAULT_ON, false);
  assert.equal(T.SKETCH_OPACITY, 0.9);
  assert.equal(T.SKETCH_COLOR, 0x57d1a8);
});

check('草图悬停尺寸列表：逐字符（有尺寸 / 无尺寸 / 整数与小数格式化）', () => {
  assert.equal(T.sketchDimensionsText(SKETCH_SAMPLE), 'D1 = 54 mm，D2 = 30 mm');
  assert.equal(T.sketchDimensionsText({
    dimensions: [{ name: 'plate_l', value: 225, unit: 'mm' }, { name: 'corner_r', value: 10.0004, unit: 'mm' }],
  }), 'plate_l = 225 mm，corner_r = 10 mm');
  assert.equal(T.sketchDimensionsText({
    dimensions: [{ name: 'bore_d', value: 40, unit: 'mm' }, { name: 'web_h', value: 30, unit: 'mm' }],
  }), 'bore_d = 40 mm，web_h = 30 mm');
  assert.equal(T.sketchDimensionsText({ dimensions: [{ value: 1 }] }), '', '没有 name 的尺寸项要跳过');
  assert.equal(T.sketchDimensionsText(undefined), '');
  // 图例/标签组合起来就是悬停卡片第一行
  assert.equal(T.buildSketchLabelText(SKETCH_SAMPLE) + '\n' + T.sketchDimensionsText(SKETCH_SAMPLE),
    'Sketch1 · 凸台-拉伸1\nD1 = 54 mm，D2 = 30 mm');
});

/* ------------------------------------------------------------------ */
/* 草图解析（宿主侧纯函数，真实 project 数据的内联 fixture）              */
/* ------------------------------------------------------------------ */

// 从 lib/sketches.js 直接 import 纯函数断言：不走 client bundle（宿主半边是独立模块）。
// 真实 fracture-section-01.json 的 features 原文以 fixture 形式内联在 sketch-parse.mjs 里，
// 测试运行时**不读** %LOCALAPPDATA% 下的绝对路径。
const sketchParse = await import('./sketch-parse.mjs');
sketchParse.registerSketchParseTests(check);

/* ------------------------------------------------------------------ */
/* summary                                                             */
/* ------------------------------------------------------------------ */

const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length ? failed.length + ' test(s) failed' : 'all ' + results.length + ' tests passed'));
if (failed.length) process.exitCode = 1;
