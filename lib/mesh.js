/**
 * S3DM 网格容器的读/写，STL（binary + ASCII）/OBJ 解析，缓存路径，以及 STEP 三角化子进程。
 *
 * S3DM 布局（小端）：
 *   0      : 'S3DM'               4 字节 ASCII 魔数
 *   4      : u32 headerJsonLength
 *   8      : headerJson（UTF-8，尾部可能补空格，使 8+len 正好 4 字节对齐）
 *   8+len  : 各 buffer 依次拼接，每个 buffer 相对数据区起点的偏移 4 字节对齐（补 0x00）
 * header.buffers[].offset 相对于「buffer 数据区」起点（= 8 + headerJsonLength），不是文件起点。
 * 客户端 parseS3DM 直接拿 8+len 当数据区起点、并要求绝对偏移 %4===0，所以 JSON 要补空格对齐。
 *
 * 本模块不依赖 DSH 运行时，可被 node 直接 import 做离线测试。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const S3DM_MAGIC = 'S3DM';
/** v2：新增可选 buffers（faceEdge）+ header.precision/faceEdgeCount；v1 数据仍然可读（缺字段即降级）。 */
export const S3DM_VERSION = 2;
export const S3DM_VERSION_MIN = 1;

/** 各 buffer 默认分量数；调用方可用 {array, components} 或 header.buffers[].components 覆盖。 */
export const DEFAULT_COMPONENTS = Object.freeze({
  position: 3,
  normal: 3,
  index: 3,
  faceOfTriangle: 1,
  edgePosition: 3,
  edgeSegment: 2,
  faceEdge: 2,
});

const CTOR_BY_TYPE = {
  f32: Float32Array,
  u32: Uint32Array,
  u16: Uint16Array,
  u8: Uint8Array,
  i32: Int32Array,
  f64: Float64Array,
};
const TYPE_BY_CTOR = new Map(Object.entries(CTOR_BY_TYPE).map(([type, ctor]) => [ctor, type]));

/** 文件名，用于 python 探测与错误提示。 */
export const STEP_SCRIPT_NAME = 'step_mesh.py';
export const STEP_SCRIPT_PATH = fileURLToPath(new URL('./step_mesh.py', import.meta.url));

/** 已核实可用的 sw-mcp venv（含 OCP 8.0.1 + numpy）；只读引用，不修改该仓库。 */
export const RECOMMENDED_PYTHON = 'D:\\静静\\任务（干活的文件分类放这里）\\sw-mcp\\.venv\\Scripts\\python.exe';

export const PYTHON_MISSING_HINT =
  `把 SW_3D_PREVIEW_PYTHON 指向装了 OCP 的 python，或确认 ${RECOMMENDED_PYTHON} 存在，或安装 py 启动器后用 py -3 -m pip install cadquery-ocp`;

// --------------------------------------------------------------------------- 工具

export function align4(value) {
  const n = Math.max(0, Math.trunc(Number(value) || 0));
  return (n + 3) & ~3;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(value ?? '');
}

/** sha1(字符串按 UTF-8，Buffer 按原字节) → 40 位小写 hex。 */
export function sha1(value) {
  const hash = createHash('sha1');
  hash.update(Buffer.isBuffer(value) || value instanceof Uint8Array ? toBuffer(value) : String(value ?? ''), 'utf8');
  return hash.digest('hex');
}

// --------------------------------------------------------------------------- 缓存与标注目录

/** %LOCALAPPDATA%\sw-3d-preview（拿不到 LOCALAPPDATA 时退回 homedir\AppData\Local）。 */
export function localDataRoot() {
  const base =
    process.env.LOCALAPPDATA || process.env.LOCAL_APP_DATA || path.join(homedir(), 'AppData', 'Local');
  return path.join(base, 'sw-3d-preview');
}

export function cacheDir() {
  return path.join(localDataRoot(), 'cache');
}

export function annotationDir() {
  return path.join(localDataRoot(), 'annotations');
}

/** 标注交接单目录：%LOCALAPPDATA%\sw-3d-preview\handoff。 */
export function handoffDir() {
  return path.join(localDataRoot(), 'handoff');
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 缓存键：sha1(绝对路径小写 | mtimeMs | bytes | deflection | maxTriangles)。
 * 路径按小写归一，符合 Windows 大小写不敏感的事实；deflection/maxTriangles 用调用方已归一过的数字，
 * 保证同一文件的不同精度档不会互相踩缓存。
 */
export function cacheKeyFor({ path: filePath = '', mtimeMs = 0, bytes = 0, deflection = 0.2, maxTriangles = 0 } = {}) {
  const normalizedPath = path.resolve(String(filePath)).toLowerCase();
  const key = sha1(
    `${normalizedPath}|${Math.round(Number(mtimeMs) || 0)}|${Math.round(Number(bytes) || 0)}|${deflection}|` +
      `max:${Math.round(Number(maxTriangles) || 0)}`,
  );
  return key;
}

/** 缓存文件路径：<LOCALAPPDATA>\sw-3d-preview\cache\<sha1>.s3dm（目录按需创建）。 */
export function cachePathFor(options = {}) {
  ensureDir(cacheDir());
  return path.join(cacheDir(), `${cacheKeyFor(options)}.s3dm`);
}

// --------------------------------------------------------------------------- S3DM 写

function normalizeBuffer(name, raw, header) {
  let array = raw;
  let typeHint;
  let componentsHint;
  let bufferName = name;
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && !ArrayBuffer.isView(raw) && 'array' in raw) {
    array = raw.array;
    typeHint = raw.type;
    componentsHint = raw.components;
    if (typeof raw.name === 'string' && raw.name) bufferName = raw.name;
  }
  const declared = Array.isArray(header.buffers)
    ? header.buffers.find((entry) => entry && entry.name === bufferName)
    : undefined;
  const type = typeHint || (declared && declared.type) || TYPE_BY_CTOR.get(array && array.constructor) || 'f32';
  const ctor = CTOR_BY_TYPE[type];
  if (!ctor) throw new TypeError(`S3DM 不支持的 buffer 类型：${type}（${bufferName}）`);
  if (!array || typeof array.length !== 'number') {
    throw new TypeError(`S3DM buffer 必须是 TypedArray 或普通数组：${bufferName}`);
  }
  const typed = ArrayBuffer.isView(array) && array instanceof ctor ? array : new ctor(array);
  const components = Number(
    componentsHint ?? (declared && declared.components) ?? DEFAULT_COMPONENTS[bufferName] ?? 1,
  );
  if (!Number.isInteger(components) || components < 1) {
    throw new TypeError(`S3DM buffer components 非法：${bufferName}=${components}`);
  }
  if (typed.length % components !== 0) {
    throw new RangeError(
      `S3DM buffer ${bufferName} 的元素数 ${typed.length} 不是 components ${components} 的整数倍`,
    );
  }
  return {
    name: bufferName,
    type,
    components,
    count: typed.length / components,
    byteLength: typed.byteLength,
    buffer: Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength),
  };
}

/**
 * 写 S3DM：header 里除 buffers 外的字段原样保留，buffers 由入参重算（含 offset）。
 * @param {object} header S3DM header JSON（version/units/format/source/bbox/各 count/faces/edges/warnings）
 * @param {Record<string, TypedArray | {array: ArrayLike<number>, type?: string, components?: number}>} buffers
 * @returns {Buffer}
 */
export function writeS3dm(header, buffers = {}) {
  const base = header && typeof header === 'object' ? header : {};
  const entries = [];
  for (const [name, raw] of Object.entries(buffers || {})) entries.push(normalizeBuffer(name, raw, base));

  let cursor = 0;
  for (const entry of entries) {
    entry.offset = cursor;
    cursor += entry.byteLength;
    cursor += (4 - (cursor % 4)) % 4;
  }

  const outHeader = {
    ...base,
    buffers: entries.map(({ name, type, components, count, offset }) => ({
      name,
      type,
      components,
      count,
      offset,
    })),
  };
  const json = Buffer.from(JSON.stringify(outHeader), 'utf8');
  // 客户端（client.js 的 parseS3DM）把 base = 8 + headerJsonLength 直接当数据区起点，
  // 并且要求每个 buffer 的绝对偏移 % 4 === 0。为了让「8+len」既是数据区起点又是 4 的倍数，
  // 这里用空格把 header JSON 补到 4 字节对齐（JSON 尾部空白合法）。
  const pad = (4 - ((8 + json.length) % 4)) % 4;
  const headerJson = pad === 0 ? json : Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
  const sectionStart = 8 + headerJson.length;
  const out = Buffer.alloc(sectionStart + cursor);
  out.write(S3DM_MAGIC, 0, 'latin1');
  out.writeUInt32LE(headerJson.length, 4);
  headerJson.copy(out, 8);
  for (const entry of entries) entry.buffer.copy(out, sectionStart + entry.offset);
  return out;
}

// --------------------------------------------------------------------------- S3DM 读

export function readS3dmHeader(input) {
  const buf = toBuffer(input);
  if (buf.length < 8) throw new Error('S3DM 数据太短（不足 8 字节）');
  const magic = buf.toString('latin1', 0, 4);
  if (magic !== S3DM_MAGIC) throw new Error(`S3DM 魔数不匹配：${JSON.stringify(magic)}`);
  const jsonLength = buf.readUInt32LE(4);
  if (jsonLength < 2 || 8 + jsonLength > buf.length) throw new Error(`S3DM 头长度非法：${jsonLength}`);
  const header = JSON.parse(buf.toString('utf8', 8, 8 + jsonLength));
  return { header, jsonLength, sectionStart: align4(8 + jsonLength) };
}

/**
 * 读 S3DM：返回 header 与 name → TypedArray 的视图（对齐时零拷贝，不对齐时复制）。
 * 越界与未知类型都抛错，不返回半截数据。
 */
export function readS3dm(input) {
  const buf = toBuffer(input);
  const { header, jsonLength, sectionStart } = readS3dmHeader(buf);
  const buffers = {};
  for (const descriptor of Array.isArray(header.buffers) ? header.buffers : []) {
    const ctor = CTOR_BY_TYPE[descriptor && descriptor.type];
    if (!ctor) throw new Error(`S3DM 不认识的 buffer 类型：${descriptor && descriptor.type}`);
    const components = Math.max(1, Math.trunc(Number(descriptor.components) || 1));
    const count = Math.max(0, Math.trunc(Number(descriptor.count) || 0));
    const elements = count * components;
    const byteLength = elements * ctor.BYTES_PER_ELEMENT;
    const start = sectionStart + Math.max(0, Math.trunc(Number(descriptor.offset) || 0));
    const end = start + byteLength;
    if (end > buf.length) throw new Error(`S3DM buffer 越界：${descriptor.name}（需要 ${byteLength} 字节）`);
    if (start % ctor.BYTES_PER_ELEMENT === 0) {
      buffers[descriptor.name] = new ctor(buf.buffer, buf.byteOffset + start, elements);
    } else {
      const copy = Buffer.alloc(byteLength);
      buf.copy(copy, 0, start, end);
      buffers[descriptor.name] = new ctor(copy.buffer, copy.byteOffset, elements);
    }
  }
  return { header, buffers, jsonLength, sectionStart, byteLength: buf.length };
}

// --------------------------------------------------------------------------- 小几何工具

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cross(a, b, c) {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

function magnitude(v) {
  return Math.hypot(v[0], v[1], v[2]);
}

function normalizeVector(v) {
  const length = magnitude(v);
  if (!(length > 1e-12)) return null;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

/**
 * 由三角面表生成非索引化顶点/法向 + 面分组。
 * tris: [{ points: [[x,y,z]×3], normal: [x,y,z]|null }]
 * 面分组规则：法向（3 位小数）相同的三角形归为同一面 —— STL 没有 B-rep 面编号，按平面归并能让预览
 * 的点选面得到「同一平面区域」这种有意义的结果，而不是几万个单三角形面。
 */
function buildTriangles(tris) {
  const positions = [];
  const normals = [];
  const indices = [];
  const faceOf = [];
  const buckets = new Map();
  const faces = [];

  for (const tri of tris) {
    const [a, b, c] = tri.points;
    const computed = cross(a, b, c);
    const area = magnitude(computed) / 2;
    const unit = normalizeVector(tri.normal || [0, 0, 0]) || normalizeVector(computed) || [0, 0, 1];
    const key = `${roundTo(unit[0], 3)},${roundTo(unit[1], 3)},${roundTo(unit[2], 3)}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { index: faces.length, area: 0, normal: unit, centroid: [0, 0, 0] };
      buckets.set(key, bucket);
      faces.push(bucket);
    }
    bucket.area += area;
    bucket.centroid[0] += (area * (a[0] + b[0] + c[0])) / 3;
    bucket.centroid[1] += (area * (a[1] + b[1] + c[1])) / 3;
    bucket.centroid[2] += (area * (a[2] + b[2] + c[2])) / 3;

    const base = positions.length / 3;
    for (const point of tri.points) positions.push(point[0], point[1], point[2]);
    for (let i = 0; i < 3; i += 1) normals.push(unit[0], unit[1], unit[2]);
    indices.push(base, base + 1, base + 2);
    faceOf.push(bucket.index);
  }

  const faceEntries = faces.map((bucket) => {
    const area = bucket.area > 0 ? bucket.area : 0;
    const divisor = area > 0 ? area : 1;
    return {
      index: bucket.index,
      kind: 'plane',
      areaMm2: roundTo(area, 4),
      normal: bucket.normal.map((value) => roundTo(value, 6)),
      point: [
        roundTo(bucket.centroid[0] / divisor, 4),
        roundTo(bucket.centroid[1] / divisor, 4),
        roundTo(bucket.centroid[2] / divisor, 4),
      ],
      radiusMm: null,
    };
  });

  return {
    vertices: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    indices: Uint32Array.from(indices),
    triangles: faceOf.map((face, index) => ({ face, index })),
    faces: faceEntries,
  };
}

// --------------------------------------------------------------------------- STL

function looksBinaryStl(buf) {
  if (buf.length < 84) return false;
  const declaredCount = buf.readUInt32LE(80);
  const expected = 84 + declaredCount * 50;
  if (expected === buf.length) return true;
  const head = buf.toString('latin1', 0, Math.min(5, buf.length)).toLowerCase();
  // 有些导出器把 binary STL 的头写成 "solid ..."；此时长度校验更可信。
  if (head !== 'solid') return true;
  if (declaredCount > 0 && expected <= buf.length && buf.length - expected < 50) return true;
  return false;
}

function parseBinaryStl(buf) {
  const declaredCount = buf.readUInt32LE(80);
  const room = Math.floor((buf.length - 84) / 50);
  const count = Math.min(declaredCount, room);
  const tris = [];
  for (let i = 0; i < count; i += 1) {
    const base = 84 + i * 50;
    const normal = [buf.readFloatLE(base), buf.readFloatLE(base + 4), buf.readFloatLE(base + 8)];
    const points = [];
    for (let corner = 0; corner < 3; corner += 1) {
      const offset = base + 12 + corner * 12;
      points.push([buf.readFloatLE(offset), buf.readFloatLE(offset + 4), buf.readFloatLE(offset + 8)]);
    }
    tris.push({ points, normal: magnitude(normal) > 0 ? normal : null });
  }
  return buildTriangles(tris);
}

function parseAsciiStl(buf) {
  const text = buf.toString('utf8');
  const tris = [];
  let currentNormal = null;
  let pending = [];
  const flush = () => {
    if (pending.length >= 3) {
      for (let i = 1; i + 1 < pending.length; i += 1) {
        tris.push({ points: [pending[0], pending[i], pending[i + 1]], normal: currentNormal });
      }
    }
    pending = [];
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const lower = line.toLowerCase();
    if (lower.startsWith('facet')) {
      flush();
      const parts = line.split(/\s+/);
      currentNormal = [num(parts[2]), num(parts[3]), num(parts[4])];
      if (magnitude(currentNormal) === 0) currentNormal = null;
    } else if (lower.startsWith('vertex')) {
      const parts = line.split(/\s+/);
      pending.push([num(parts[1]), num(parts[2]), num(parts[3])]);
    } else if (lower.startsWith('endfacet')) {
      flush();
      currentNormal = null;
    }
  }
  flush();
  return buildTriangles(tris);
}

/**
 * 解析 STL（binary 与 ASCII 都支持）。
 * binary 判定：文件长度与 84 + 50*n 一致（含 50 字节容差），或前 5 字节不是 "solid"。
 * @returns {{vertices: Float32Array, normals: Float32Array, indices: Uint32Array, triangles: {face:number}[], faces: object[]}}
 */
export function parseStl(bytes) {
  const buf = toBuffer(bytes);
  if (buf.length === 0) throw new Error('STL 内容为空');
  const binary = looksBinaryStl(buf);
  return binary ? parseBinaryStl(buf) : parseAsciiStl(buf);
}

// --------------------------------------------------------------------------- OBJ

function parseObjCorner(token) {
  const parts = String(token).split('/');
  const vertexIndex = Number.parseInt(parts[0], 10);
  const normalIndex = parts.length >= 3 && parts[2] !== '' ? Number.parseInt(parts[2], 10) : null;
  return { vertexIndex, normalIndex };
}

function resolveIndex(rawIndex, list) {
  if (!Number.isInteger(rawIndex) || rawIndex === 0) return null;
  const index = rawIndex > 0 ? rawIndex - 1 : list.length + rawIndex;
  return list[index] || null;
}

/**
 * 解析 OBJ 文本：v / vn / f（支持 a、a/b、a//c、a/b/c 与负索引、多边形扇形三角化）。
 * 每条 `f` 语句 = 一个面（n 边形拆成 n-2 个三角形共用同一个 face 序号）。
 */
export function parseObj(text) {
  const source = String(text ?? '');
  const positions = [];
  const normals = [];
  const tris = [];
  const faces = [];

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const tag = parts[0];
    if (tag === 'v' && parts.length >= 4) {
      positions.push([num(parts[1]), num(parts[2]), num(parts[3])]);
    } else if (tag === 'vn' && parts.length >= 4) {
      normals.push([num(parts[1]), num(parts[2]), num(parts[3])]);
    } else if (tag === 'f' && parts.length >= 4) {
      const corners = parts.slice(1).map(parseObjCorner);
      const resolved = corners.map((corner) => ({
        point: resolveIndex(corner.vertexIndex, positions),
        normal: corner.normalIndex === null ? null : resolveIndex(corner.normalIndex, normals),
      }));
      if (resolved.some((corner) => !corner.point)) continue;

      const faceIndex = faces.length;
      const bucket = { index: faceIndex, area: 0, normal: [0, 0, 0], centroid: [0, 0, 0], weight: 0 };
      for (let i = 1; i + 1 < resolved.length; i += 1) {
        const a = resolved[0];
        const b = resolved[i];
        const c = resolved[i + 1];
        const computed = cross(a.point, b.point, c.point);
        const area = magnitude(computed) / 2;
        const unit = normalizeVector(computed) || [0, 0, 1];
        bucket.area += area;
        bucket.normal[0] += computed[0];
        bucket.normal[1] += computed[1];
        bucket.normal[2] += computed[2];
        bucket.centroid[0] += (area * (a.point[0] + b.point[0] + c.point[0])) / 3;
        bucket.centroid[1] += (area * (a.point[1] + b.point[1] + c.point[1])) / 3;
        bucket.centroid[2] += (area * (a.point[2] + b.point[2] + c.point[2])) / 3;
        bucket.weight += area;
        tris.push({ points: [a.point, b.point, c.point], normal: unit, face: faceIndex, corners: [a, b, c] });
      }
      faces.push(bucket);
    }
  }

  const vertexOut = [];
  const normalOut = [];
  const indexOut = [];
  const faceOf = [];
  for (const tri of tris) {
    const base = vertexOut.length / 3;
    tri.points.forEach((point, corner) => {
      vertexOut.push(point[0], point[1], point[2]);
      const explicit = tri.corners[corner].normal && normalizeVector(tri.corners[corner].normal);
      const unit = explicit || tri.normal;
      normalOut.push(unit[0], unit[1], unit[2]);
    });
    indexOut.push(base, base + 1, base + 2);
    faceOf.push(tri.face);
  }

  return {
    vertices: Float32Array.from(vertexOut),
    normals: Float32Array.from(normalOut),
    indices: Uint32Array.from(indexOut),
    triangles: faceOf.map((face, index) => ({ face, index })),
    faces: faces.map((bucket) => {
      const weight = bucket.weight > 0 ? bucket.weight : 1;
      const unit = normalizeVector(bucket.normal) || [0, 0, 1];
      return {
        index: bucket.index,
        kind: 'plane',
        areaMm2: roundTo(bucket.area, 4),
        normal: unit.map((value) => roundTo(value, 6)),
        point: bucket.centroid.map((value) => roundTo(value / weight, 4)),
        radiusMm: null,
      };
    }),
  };
}

// --------------------------------------------------------------------------- python 探测与 STEP 三角化

/** python 候选：① 环境变量 ② sw-mcp venv ③ py -3。 */
export function pythonCandidates() {
  const candidates = [];
  const fromEnv = (process.env.SW_3D_PREVIEW_PYTHON || '').trim().replace(/^"|"$/g, '');
  if (fromEnv) candidates.push({ command: fromEnv, prefixArgs: [], label: fromEnv, origin: 'env' });
  candidates.push({ command: RECOMMENDED_PYTHON, prefixArgs: [], label: RECOMMENDED_PYTHON, origin: 'venv' });
  candidates.push({ command: 'py', prefixArgs: ['-3'], label: 'py -3', origin: 'launcher' });
  return candidates;
}

function collectLines(stream, sink) {
  stream?.setEncoding?.('utf8');
  stream?.on?.('data', (chunk) => sink.push(String(chunk)));
}

function tailText(text, limit = 800) {
  const trimmed = String(text ?? '').trim();
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(-limit)}`;
}

const PROBE_CODE = [
  'import sys',
  "print('python=' + sys.version.split()[0])",
  'try:',
  '    import OCP',
  "    print('ocp=' + str(OCP.__version__))",
  'except Exception as error:',
  "    print('ocpError=' + type(error).__name__ + ': ' + str(error)[:200])",
].join('\n');

async function runProcess(command, args, { timeoutMs = 15000 } = {}) {
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, spawnError: error, stdout: '', stderr: '', timedOut: false, exitCode: null });
      return;
    }
    const out = [];
    const err = [];
    collectLines(child.stdout, out);
    collectLines(child.stderr, err);
    let settled = false;
    let timedOut = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...payload, stdout: out.join(''), stderr: err.join(''), timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* 已经退出 */
      }
      finish({ ok: false, exitCode: null, spawnError: null });
    }, timeoutMs);
    child.on('error', (error) => finish({ ok: false, spawnError: error, exitCode: null }));
    child.on('close', (code) => finish({ ok: code === 0, exitCode: code, spawnError: null }));
  });
}

let probeMemo = { value: null, at: 0, inflight: null };

/**
 * 探测一个可用的 python（能 import OCP 才算成功）。
 * @returns {Promise<{path:string, ok:boolean, ocp:boolean, version:string, ocpVersion:string, error:string|null}>}
 */
export async function probePython({ timeoutMs = 15000 } = {}) {
  const failures = [];
  for (const candidate of pythonCandidates()) {
    const result = await runProcess(candidate.command, [...candidate.prefixArgs, '-c', PROBE_CODE], { timeoutMs });
    if (result.spawnError) {
      failures.push(`${candidate.label}: ${result.spawnError.code || result.spawnError.message}`);
      continue;
    }
    const stdout = result.stdout || '';
    const pythonVersion = /python=(\S+)/.exec(stdout)?.[1] || '';
    const ocpVersion = /ocp=(\S+)/.exec(stdout)?.[1] || '';
    const ocpError = /ocpError=(.*)/.exec(stdout)?.[1] || null;
    if (result.ok && pythonVersion && !ocpError) {
      return {
        path: [candidate.command, ...candidate.prefixArgs].join(' '),
        ok: true,
        ocp: true,
        version: pythonVersion,
        ocpVersion,
        error: null,
        candidate,
      };
    }
    failures.push(`${candidate.label}: ${ocpError || (result.timedOut ? '探测超时' : tailText(result.stderr, 200) || '不可用')}`);
  }
  return {
    path: pythonCandidates()[0]?.label || '',
    ok: false,
    ocp: false,
    version: '',
    ocpVersion: '',
    error: failures.join(' | ') || '没有可用的 python',
    candidate: null,
  };
}

/** 带缓存的探测：成功缓存 5 分钟，失败缓存 30 秒，并发调用共享同一个 inflight。 */
export async function probePythonCached(options = {}) {
  const now = Date.now();
  if (probeMemo.value && now - probeMemo.at < (probeMemo.value.ok ? 300000 : 30000)) return probeMemo.value;
  if (probeMemo.inflight) return probeMemo.inflight;
  probeMemo.inflight = probePython(options).then(
    (value) => {
      probeMemo = { value, at: Date.now(), inflight: null };
      return value;
    },
    (error) => {
      probeMemo.inflight = null;
      throw error;
    },
  );
  return probeMemo.inflight;
}

/**
 * 调 lib/step_mesh.py 把 STEP 三角化成 S3DM 写到 output。
 * @param {object} options
 * @param {number} [options.maxTriangles] 三角形上限（精度档）；透传给 --max-triangles
 * @returns {Promise<{ok:boolean, code?:string, summary?:object, stderrTail:string, exitCode:number|null, timedOut:boolean}>}
 */
export async function runStepMesh({ python, input, output, deflection = 0.2, maxTriangles = 0, timeoutMs = 120000 } = {}) {
  const candidate = python?.candidate || (python?.command ? { command: python.command, prefixArgs: python.prefixArgs || [] } : null);
  if (!candidate) return { ok: false, code: 'PYTHON_MISSING', stderrTail: '', exitCode: null, timedOut: false };
  const args = [
    ...(candidate.prefixArgs || []),
    STEP_SCRIPT_PATH,
    '--in',
    String(input),
    '--out',
    String(output),
    '--deflection',
    String(deflection),
  ];
  const cap = Math.round(Number(maxTriangles) || 0);
  if (cap > 0) args.push('--max-triangles', String(cap));
  const result = await runProcess(candidate.command, args, { timeoutMs });
  const stderrTail = tailText(result.stderr, 800);
  if (result.spawnError) {
    return { ok: false, code: 'PYTHON_SPAWN_FAILED', stderrTail: tailText(result.spawnError.message, 400), exitCode: null, timedOut: false };
  }
  if (result.timedOut) return { ok: false, code: 'TIMEOUT', stderrTail: stderrTail || 'step_mesh.py 超过超时时间', exitCode: null, timedOut: true };
  const lines = String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let summary = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    try {
      summary = JSON.parse(lines[i]);
      break;
    } catch {
      /* 继续往前找 */
    }
  }
  if (!result.ok) {
    return {
      ok: false,
      code: summary?.code || 'STEP_MESH_FAILED',
      summary,
      stderrTail: stderrTail || `step_mesh.py 退出码 ${result.exitCode}`,
      exitCode: result.exitCode,
      timedOut: false,
    };
  }
  if (!summary) return { ok: false, code: 'STEP_MESH_BAD_OUTPUT', stderrTail: stderrTail || '没有 JSON 摘要', exitCode: result.exitCode, timedOut: false };
  return { ok: true, summary, stderrTail, exitCode: result.exitCode, timedOut: false };
}
