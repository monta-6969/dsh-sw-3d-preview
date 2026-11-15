/**
 * @local/dsh-sw-3d-preview —— Host 半边。
 *
 * 给 DSH 文件预览面板里的 3D 成果提供网格数据：
 *   GET  /sw3d/ping        健康检查（python/OCP、缓存目录、three.cjs 是否就位）
 *   GET  /sw3d/resolve     路径 → 格式/网格源/缓存命中
 *   GET  /sw3d/mesh        → S3DM 二进制（application/octet-stream）
 *   GET  /sw3d/three.js    → vendor/three.cjs 原样返回
 *   POST /sw3d/annotation  标注 upsert / list（GET 等价 list）
 *
 * 约束：
 * - 每个路由自己做信任栅栏（ctx.connection.requestRejection）与方法校验；
 * - 失败只回约定字段（{ok:false,code,message,hint}），不反射任意文件内容，不泄漏堆栈；
 * - 只读写自己的缓存/标注目录（%LOCALAPPDATA%\sw-3d-preview），不修改被预览的原始文件。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PYTHON_MISSING_HINT,
  S3DM_VERSION,
  cacheDir,
  cacheKeyFor,
  cachePathFor,
  ensureDir,
  annotationDir,
  localDataRoot,
  parseObj,
  parseStl,
  probePythonCached,
  readS3dmHeader,
  runStepMesh,
  sha1,
  writeS3dm,
} from './lib/mesh.js';
import {
  completeFilePath,
  isAllowedExtension,
  normalizeDeflection,
  normalizeMaxTriangles,
  precisionTier,
  resolveSource,
  statSafe,
} from './lib/resolve.js';
import { handoffPathFor, writeHandoffFile } from './lib/handoff.js';
import { findDesignIdForPath } from './lib/paths.js';
import { readSketchesForPath } from './lib/sketches.js';

export const name = 'sw-3d-preview';
export const inject = ['webServer', 'connection'];

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const THREE_CJS_PATH = path.join(PLUGIN_DIR, 'vendor', 'three.cjs');
const STEP_TIMEOUT_MS = 120000;
const MAX_ANNOTATION_BODY = 256 * 1024;
// 截图走 base64，文本体积 = 图片体积 × 4/3：8 MB 的图 ≈ 10.7 MB 文本，
// 所以文本上限放到 12 MB（512 KB 的文本根本装不下一张 1280 宽的 PNG）。
const MAX_SNAPSHOT_TEXT_BODY = 12 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

const ROUTES = Object.freeze({
  ping: '/sw3d/ping',
  resolve: '/sw3d/resolve',
  mesh: '/sw3d/mesh',
  three: '/sw3d/three.js',
  annotation: '/sw3d/annotation',
  handoff: '/sw3d/handoff',
  snapshot: '/sw3d/snapshot',
  sketches: '/sw3d/sketches',
});

const PACKAGE = (() => {
  try {
    const parsed = JSON.parse(readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8'));
    return {
      name: typeof parsed.name === 'string' ? parsed.name : '@local/dsh-sw-3d-preview',
      version: typeof parsed.version === 'string' ? parsed.version : '0.1.0',
    };
  } catch {
    return { name: '@local/dsh-sw-3d-preview', version: '0.1.0' };
  }
})();

// --------------------------------------------------------------------------- HTTP 小工具

function logError(message, error) {
  const detail = error && error.stack ? error.stack : String(error);
  process.stderr.write(`[sw-3d-preview] ${message}: ${detail}\n`);
}

function errorBody(code, message, hint, detail) {
  const body = { ok: false, code, message, hint };
  if (detail) body.detail = String(detail).slice(-800);
  return body;
}

function sendJson(req, res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(body.length),
  });
  if (String(req.method || '').toUpperCase() === 'HEAD') res.end();
  else res.end(body);
}

function sendText(req, res, status, text, contentType = 'text/plain; charset=utf-8') {
  const body = Buffer.from(String(text ?? ''), 'utf8');
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-length': String(body.length),
  });
  if (String(req.method || '').toUpperCase() === 'HEAD') res.end();
  else res.end(body);
}

function fail(res, error) {
  logError('未处理的异常', error);
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      /* 客户端已断开 */
    }
    return;
  }
  const body = Buffer.from(JSON.stringify(errorBody('INTERNAL', '插件内部错误', '重试；仍然失败就看 DSH 日志里 [sw-3d-preview] 的堆栈')), 'utf8');
  try {
    res.writeHead(500, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': String(body.length),
    });
    res.end(body);
  } catch {
    /* 客户端已断开 */
  }
}

function requestUrl(req) {
  try {
    return new URL(req.url || '/', 'http://127.0.0.1');
  } catch {
    return new URL('http://127.0.0.1/');
  }
}

function formatBbox(bbox) {
  const values = Array.isArray(bbox) ? bbox : [];
  const parts = [];
  for (let index = 0; index < 6; index += 1) {
    const value = Number(values[index]);
    parts.push(Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : '0');
  }
  return parts.join(',');
}

function computeBbox(positions) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let index = 0; index + 2 < positions.length; index += 3) {
    const x = positions[index];
    const y = positions[index + 1];
    const z = positions[index + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) return [0, 0, 0, 0, 0, 0];
  return [minX, minY, minZ, maxX, maxY, maxZ].map((value) => Math.round(value * 1000) / 1000);
}

// --------------------------------------------------------------------------- 请求体

async function readJsonBody(req, limit = MAX_ANNOTATION_BODY) {
  const chunks = [];
  let total = 0;
  let tooLarge = false;
  try {
    for await (const chunk of req) {
      total += chunk.length;
      if (total > limit) {
        tooLarge = true;
        break;
      }
      chunks.push(chunk);
    }
  } catch (error) {
    logError('读取请求体失败', error);
    return { ok: false, status: 400, body: errorBody('BAD_REQUEST', '读取请求体失败', '重试这个请求') };
  }
  if (tooLarge) {
    try {
      req.resume();
    } catch {
      /* 流已关闭 */
    }
    return {
      ok: false,
      status: 413,
      body: errorBody('UNSUPPORTED', `请求体超过 ${Math.round(limit / 1024)} KB 上限`, '减小 annotation 体积；只放前端需要的字段'),
    };
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return { ok: false, status: 400, body: errorBody('BAD_REQUEST', '请求体为空', '例如 {"op":"list","path":"C:\\\\work\\\\part.STEP"}') };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, body: errorBody('BAD_REQUEST', '请求体不是合法 JSON', '检查 JSON 语法与引号转义') };
  }
}

// --------------------------------------------------------------------------- 标注存储

function annotationFile() {
  return path.join(annotationDir(), 'annotations.jsonl');
}

/** 用户视角截图目录：%LOCALAPPDATA%\sw-3d-preview\shots。 */
function snapshotDir() {
  return path.join(localDataRoot(), 'shots');
}

/** 魔数嗅探：只认 PNG / JPEG（扩展名与声明的 mediaType 都不作数）。 */
function sniffImageType(bytes) {
  if (!bytes || !bytes.length) return null;
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { mediaType: 'image/png', ext: '.png' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mediaType: 'image/jpeg', ext: '.jpg' };
  }
  return null;
}

function annotationHash(filePath) {
  // Windows 路径大小写不敏感：归一成小写再算，避免同一文件两条哈希。
  return sha1(String(filePath).toLowerCase());
}

async function listAnnotations(filePath) {
  const target = path.resolve(String(filePath));
  const hash = annotationHash(target);
  let text;
  try {
    text = await fs.readFile(annotationFile(), 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const items = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed);
      if (record && record.fileHash === hash) items.push(record);
    } catch {
      /* 坏行跳过：标注是追加日志，不能因为一行坏了丢掉全部 */
    }
  }
  return items;
}

// --------------------------------------------------------------------------- 网格构建

function meshFromParsed(parsed, { meshPath, format, bytes, mtimeMs, deflection = 0.2, maxTriangles = 0 }) {
  const positions = parsed.vertices;
  const vertexCount = positions.length / 3;
  const triangleCount = parsed.indices.length / 3;
  if (!(vertexCount > 0) || !(triangleCount > 0)) throw new Error('没有解析到三角形');
  const faceOfTriangle = Uint32Array.from(parsed.triangles.map((triangle) => triangle.face || 0));
  const header = {
    version: S3DM_VERSION,
    units: 'mm',
    format,
    source: { path: meshPath, bytes, mtimeMs },
    bbox: computeBbox(positions),
    vertexCount,
    triangleCount,
    faceCount: parsed.faces.length,
    edgeCount: 0,
    faceEdgeCount: 0,
    faces: parsed.faces,
    edges: [],
    precision: { deflectionMm: deflection, maxTriangles: Math.round(Number(maxTriangles) || 0) },
    generatedAt: new Date().toISOString(),
    warnings: [
      `${format.toUpperCase()} 没有 B-rep 拓扑：面按平面法向归并成 ${parsed.faces.length} 个，边线框为空`,
    ],
  };
  const buffers = {
    position: { array: parsed.vertices, type: 'f32', components: 3 },
    normal: { array: parsed.normals, type: 'f32', components: 3 },
    index: { array: parsed.indices, type: 'u32', components: 3 },
    faceOfTriangle: { array: faceOfTriangle, type: 'u32', components: 1 },
    edgePosition: { array: new Float32Array(0), type: 'f32', components: 3 },
    edgeSegment: { array: new Uint32Array(0), type: 'u32', components: 2 },
    faceEdge: { array: new Uint32Array(0), type: 'u32', components: 2 },
  };
  return { header, buffers };
}

// --------------------------------------------------------------------------- handlers

function createHandlers(ctx) {
  const builds = new Map();
  let annotationTail = Promise.resolve();

  function allowTrusted(req, res) {
    let rejection;
    try {
      rejection = ctx.connection.requestRejection(req);
    } catch (error) {
      logError('requestRejection 失败', error);
      rejection = 403;
    }
    if (rejection === undefined) return true;
    res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end();
    return false;
  }

  function allowMethods(req, res, methods) {
    const method = String(req.method || 'GET').toUpperCase();
    if (methods.includes(method)) return true;
    const payload = errorBody('METHOD_NOT_ALLOWED', `${method} 不被支持`, `改用 ${methods.join(' / ')}`);
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    res.writeHead(405, {
      allow: methods.join(', '),
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': String(body.length),
    });
    res.end(body);
    return false;
  }

  async function pythonInfo() {
    try {
      const probe = await probePythonCached();
      if (probe) return probe;
    } catch (error) {
      logError('python 探测失败', error);
    }
    return { path: '', ok: false, ocp: false, version: '', ocpVersion: '', candidate: null, error: '探测失败' };
  }

  async function handlePing(req, res) {
    if (!allowTrusted(req, res)) return;
    if (!allowMethods(req, res, ['GET', 'HEAD'])) return;
    const python = await pythonInfo();
    sendJson(req, res, 200, {
      ok: true,
      name: PACKAGE.name,
      version: PACKAGE.version,
      python: {
        path: python.path || '',
        ok: Boolean(python.ok),
        ocp: Boolean(python.ocp),
        version: python.version || '',
      },
      cacheDir: cacheDir(),
      three: existsSync(THREE_CJS_PATH),
    });
  }

  async function handleResolve(req, res) {
    if (!allowTrusted(req, res)) return;
    if (!allowMethods(req, res, ['GET', 'HEAD'])) return;
    const url = requestUrl(req);
    const requested = url.searchParams.get('path') || '';
    if (!requested) {
      sendJson(req, res, 400, errorBody('BAD_REQUEST', '缺少 path 参数', '用 ?path=<encodeURIComponent(绝对路径)> 传进来'));
      return;
    }
    const params = meshParams(url);
    const base = url.searchParams.get('base') || '';
    const resolved = await resolveSource(requested, { base });
    if (!resolved.ok) {
      sendJson(req, res, 200, resolved);
      return;
    }
    const refresh = ['1', 'true', 'yes', 'on'].includes(String(url.searchParams.get('refresh') || '').toLowerCase());
    const meshPath = resolved.sibling || resolved.path;
    const cacheOptions = {
      path: meshPath,
      mtimeMs: resolved.mtimeMs,
      bytes: resolved.bytes,
      deflection: params.deflection,
      maxTriangles: params.maxTriangles,
    };
    const cacheFile = cachePathFor(cacheOptions);
    const cachedStat = refresh ? null : await statSafe(cacheFile);
    const cached = Boolean(cachedStat && cachedStat.isFile() && cachedStat.size > 0);
    sendJson(req, res, 200, {
      ok: true,
      path: resolved.path,
      format: resolved.format,
      meshSource: resolved.meshSource,
      sibling: resolved.sibling || null,
      bytes: resolved.bytes,
      mtimeMs: resolved.mtimeMs,
      designId: resolved.designId || '',
      completed: !!resolved.completed,
      fallback: resolved.fallback || null,
      precision: {
        tier: params.tier || '',
        deflectionMm: params.deflection,
        maxTriangles: params.maxTriangles,
      },
      cached: {
        hit: cached,
        key: cacheKeyFor(cacheOptions),
        path: cacheFile,
        bytes: cached ? cachedStat.size : 0,
        mtimeMs: cached ? Math.round(cachedStat.mtimeMs) : null,
      },
      hints: resolved.hints || [],
    });
  }

  /** 精度参数：precision=high|mid|low 优先，其次 deflection/maxTriangles 显式值。 */
  function meshParams(url) {
    const tier = precisionTier(url.searchParams.get('precision'));
    const deflection = tier ? tier.deflection : normalizeDeflection(url.searchParams.get('deflection'));
    const maxTriangles = tier ? tier.maxTriangles : normalizeMaxTriangles(url.searchParams.get('maxTriangles'));
    return { tier: tier ? tier.name : '', deflection, maxTriangles };
  }

  async function buildS3dm({ cacheFile, resolved, deflection, maxTriangles, meshPath }) {
    const temporary = `${cacheFile}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      ensureDir(path.dirname(cacheFile));
      if (resolved.meshSource === 'step' || resolved.meshSource === 'sibling-step' || resolved.meshSource === 'fallback-step') {
        const python = await pythonInfo();
        if (!python.ok || !python.ocp) {
          return {
            ok: false,
            code: 'PYTHON_MISSING',
            message: `没有找到能 import OCP 的 Python（${python.error || '探测失败'}）`,
            hint: PYTHON_MISSING_HINT,
          };
        }
        const result = await runStepMesh({
          python,
          input: meshPath,
          output: temporary,
          deflection,
          maxTriangles,
          timeoutMs: STEP_TIMEOUT_MS,
        });
        if (!result.ok) {
          await fs.rm(temporary, { force: true }).catch(() => {});
          const code = result.code === 'TIMEOUT' ? 'INTERNAL' : 'UNSUPPORTED';
          const message = result.summary?.message || `step_mesh.py 失败（${result.code || '未知错误'}）`;
          return {
            ok: false,
            code,
            message: `STEP 三角化失败：${message}`,
            hint: '确认这个 STEP 能被 OCCT 读入（可先用同一 python 跑一遍 lib/step_mesh.py）；单位与碎面问题会在 warnings 里提示',
            detail: result.stderrTail || undefined,
          };
        }
        await fs.rename(temporary, cacheFile);
        return { ok: true, summary: result.summary };
      }

      const fileBytes = await fs.readFile(meshPath);
      let parsed;
      try {
        parsed = resolved.format === 'obj' ? parseObj(fileBytes.toString('utf8')) : parseStl(fileBytes);
      } catch (error) {
        return {
          ok: false,
          code: 'UNSUPPORTED',
          message: `无法解析 ${resolved.format.toUpperCase()}：${error && error.message ? error.message : error}`,
          hint: '确认文件没有损坏，且是标准 binary/ASCII STL 或 OBJ',
        };
      }
      const built = meshFromParsed(parsed, {
        meshPath,
        format: resolved.format,
        bytes: resolved.bytes,
        mtimeMs: resolved.mtimeMs,
        deflection,
        maxTriangles,
      });
      const encoded = writeS3dm(built.header, built.buffers);
      await fs.writeFile(temporary, encoded);
      await fs.rename(temporary, cacheFile);
      return { ok: true, header: built.header };
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      logError('构建 S3DM 失败', error);
      return {
        ok: false,
        code: 'INTERNAL',
        message: '生成网格失败',
        hint: '看 DSH 日志里 [sw-3d-preview] 的堆栈，或先把缓存目录清掉重试',
      };
    }
  }

  function buildTask({ key, cacheFile, resolved, deflection, maxTriangles, meshPath }) {
    const inflight = builds.get(key);
    if (inflight) return inflight;
    const task = buildS3dm({ cacheFile, resolved, deflection, maxTriangles, meshPath }).finally(() => {
      builds.delete(key);
    });
    builds.set(key, task);
    return task;
  }

  async function readMeshFile(cacheFile) {
    const buffer = await fs.readFile(cacheFile);
    const parsed = readS3dmHeader(buffer);
    return { buffer, header: parsed.header };
  }

  async function handleMesh(req, res) {
    if (!allowTrusted(req, res)) return;
    if (!allowMethods(req, res, ['GET', 'HEAD'])) return;
    const url = requestUrl(req);
    const requested = url.searchParams.get('path') || '';
    if (!requested) {
      sendJson(req, res, 400, errorBody('BAD_REQUEST', '缺少 path 参数', '用 ?path=<encodeURIComponent(绝对路径)> 传进来'));
      return;
    }
    const params = meshParams(url);
    const refresh = ['1', 'true', 'yes', 'on'].includes(String(url.searchParams.get('refresh') || '').toLowerCase());

    const resolved = await resolveSource(requested, { base: url.searchParams.get('base') || '' });
    if (!resolved.ok) {
      sendJson(req, res, 422, resolved);
      return;
    }
    const meshPath = resolved.sibling || resolved.path;
    const cacheOptions = {
      path: meshPath,
      mtimeMs: resolved.mtimeMs,
      bytes: resolved.bytes,
      deflection: params.deflection,
      maxTriangles: params.maxTriangles,
    };
    const key = cacheKeyFor(cacheOptions);
    const cacheFile = cachePathFor(cacheOptions);

    let hit = false;
    let loaded = null;
    if (!refresh) {
      const cachedStat = await statSafe(cacheFile);
      if (cachedStat && cachedStat.isFile() && cachedStat.size > 0) {
        try {
          loaded = await readMeshFile(cacheFile);
          hit = true;
        } catch (error) {
          logError('缓存文件损坏，重建', error);
          await fs.rm(cacheFile, { force: true }).catch(() => {});
          loaded = null;
          hit = false;
        }
      }
    }

    if (!loaded) {
      const outcome = await buildTask({
        key,
        cacheFile,
        resolved,
        deflection: params.deflection,
        maxTriangles: params.maxTriangles,
        meshPath,
      });
      if (!outcome.ok) {
        sendJson(req, res, 422, errorBody(outcome.code, outcome.message, outcome.hint, outcome.detail));
        return;
      }
      try {
        loaded = await readMeshFile(cacheFile);
      } catch (error) {
        logError('构建完成但读不回 S3DM', error);
        sendJson(req, res, 422, errorBody('INTERNAL', '网格已生成但读不回来', '清掉缓存目录后重试'));
        return;
      }
    }

    const body = loaded.buffer;
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'content-length': String(body.length),
      'x-sw3d-source': resolved.meshSource,
      'x-sw3d-cache': hit ? 'hit' : 'miss',
      'x-sw3d-version': String(loaded.header.version || 1),
      'x-sw3d-precision': `${params.deflection}/${params.maxTriangles}`,
      'x-sw3d-bbox': formatBbox(loaded.header.bbox),
    });
    if (String(req.method || '').toUpperCase() === 'HEAD') res.end();
    else res.end(body);
  }

  async function handleThree(req, res) {
    if (!allowTrusted(req, res)) return;
    if (!allowMethods(req, res, ['GET', 'HEAD'])) return;
    if (!existsSync(THREE_CJS_PATH)) {
      sendText(req, res, 404, 'vendor/three.cjs 不存在');
      return;
    }
    let body;
    try {
      body = await fs.readFile(THREE_CJS_PATH);
    } catch (error) {
      logError('读取 vendor/three.cjs 失败', error);
      sendText(req, res, 500, '读不到 vendor/three.cjs');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': String(body.length),
    });
    if (String(req.method || '').toUpperCase() === 'HEAD') res.end();
    else res.end(body);
  }

  function withAnnotationLock(task) {
    const run = annotationTail.then(task, task);
    annotationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * 校验标注/交接单的目标文件：允许相对路径（按 project 记录/最近索引补全），
   * 这样面板只给出文件名时标注也能落地。
   */
  async function validateAnnotationPath(value) {
    if (typeof value !== 'string' || !value.trim()) {
      return { ok: false, status: 400, body: errorBody('BAD_REQUEST', '缺少 path 参数', '传预览文件的绝对路径') };
    }
    const completed = await completeFilePath(value.trim());
    if (!completed.ok) {
      return {
        ok: false,
        status: completed.code === 'NOT_FOUND' ? 404 : 400,
        body: errorBody(completed.code || 'BAD_REQUEST', completed.message, completed.hint),
      };
    }
    const normalized = path.resolve(completed.path);
    if (!isAllowedExtension(normalized)) {
      return {
        ok: false,
        status: 422,
        body: errorBody('UNSUPPORTED', `不支持为该类型文件标注：${path.extname(normalized) || '(无扩展名)'}`, '只接受 .step/.stp/.stl/.obj/.sldprt/.sldasm'),
      };
    }
    const stat = await statSafe(normalized);
    if (!stat || !stat.isFile()) {
      return {
        ok: false,
        status: 404,
        body: errorBody('NOT_FOUND', `文件不存在或不是文件：${normalized}`, '确认预览的文件还在本机磁盘上'),
      };
    }
    return { ok: true, path: normalized, completed: !!completed.completed, designId: completed.designId || '' };
  }

  async function handleAnnotation(req, res) {
    if (!allowTrusted(req, res)) return;
    if (!allowMethods(req, res, ['GET', 'POST'])) return;
    const file = annotationFile();

    if (String(req.method || '').toUpperCase() === 'GET') {
      const url = requestUrl(req);
      const direct = url.searchParams.get('path') || '';
      if (!direct) {
        sendJson(req, res, 400, errorBody('BAD_REQUEST', '缺少 path 参数', '用 ?path=<encodeURIComponent(绝对路径)> 或 POST {"op":"list"}'));
        return;
      }
      const validation = await validateAnnotationPath(direct);
      if (!validation.ok) {
        sendJson(req, res, validation.status, validation.body);
        return;
      }
      const items = await listAnnotations(validation.path);
      sendJson(req, res, 200, { ok: true, items });
      return;
    }

    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (!contentType.includes('application/json')) {
      sendJson(req, res, 415, errorBody('UNSUPPORTED', '请求体必须是 application/json', '带上 content-type: application/json'));
      return;
    }
    const body = await readJsonBody(req);
    if (!body.ok) {
      sendJson(req, res, body.status, body.body);
      return;
    }
    const payload = body.value;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      sendJson(req, res, 400, errorBody('BAD_REQUEST', '请求体必须是 JSON 对象', '示例：{"op":"upsert","path":"C:\\\\…","annotation":{"note":"…"}}'));
      return;
    }
    const op = String(payload.op || (payload.annotation === undefined ? 'list' : 'upsert')).toLowerCase();
    const validation = await validateAnnotationPath(payload.path);
    if (!validation.ok) {
      sendJson(req, res, validation.status, validation.body);
      return;
    }
    if (op !== 'upsert' && op !== 'list') {
      sendJson(req, res, 400, errorBody('BAD_REQUEST', `不认识的 op：${op}`, '只支持 upsert / list'));
      return;
    }
    if (op === 'upsert' && payload.annotation === undefined) {
      sendJson(req, res, 400, errorBody('BAD_REQUEST', 'upsert 需要 annotation 字段', 'annotation 可以是任意 JSON（对象/数组/字符串）'));
      return;
    }

    if (op === 'list') {
      const items = await listAnnotations(validation.path);
      sendJson(req, res, 200, { ok: true, items });
      return;
    }

    const record = {
      id: `ann_${Date.now()}_${randomBytes(4).toString('hex')}`,
      at: new Date().toISOString(),
      file: validation.path,
      fileHash: annotationHash(validation.path),
      annotation: payload.annotation,
    };
    try {
      await withAnnotationLock(async () => {
        ensureDir(path.dirname(file));
        await fs.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
      });
    } catch (error) {
      logError('写标注失败', error);
      sendJson(req, res, 500, errorBody('INTERNAL', '标注没写进去', '看 DSH 日志里 [sw-3d-preview] 的堆栈'));
      return;
    }
    const items = await listAnnotations(validation.path);
    sendJson(req, res, 200, { ok: true, id: record.id, count: items.length });
  }

  /**
   * /sw3d/handoff
   *   POST {path}  → 生成交接单 Markdown，返回 {ok, mdPath, count, bytes, designId, generatedAt}
   *   GET  ?path=  → 返回 Markdown 文本（text/markdown；没有就先生成）
   */
  async function handleHandoff(req, res) {
    if (!allowTrusted(req, res)) return;
    if (!allowMethods(req, res, ['GET', 'POST'])) return;
    const method = String(req.method || 'GET').toUpperCase();
    let requested = '';

    if (method === 'GET') {
      const url = requestUrl(req);
      requested = url.searchParams.get('path') || '';
      if (!requested) {
        sendText(req, res, 400, '缺少 path 参数：用 /sw3d/handoff?path=<encodeURIComponent(绝对路径)>');
        return;
      }
    } else {
      const contentType = String(req.headers['content-type'] || '').toLowerCase();
      if (!contentType.includes('application/json')) {
        sendJson(req, res, 415, errorBody('UNSUPPORTED', '请求体必须是 application/json', '带上 content-type: application/json'));
        return;
      }
      const body = await readJsonBody(req);
      if (!body.ok) {
        sendJson(req, res, body.status, body.body);
        return;
      }
      requested = body.value && typeof body.value.path === 'string' ? body.value.path : '';
      if (!requested) {
        sendJson(req, res, 400, errorBody('BAD_REQUEST', '缺少 path 字段', '例如 {"path":"C:\\\\work\\\\part.STEP"}'));
        return;
      }
    }

    const validation = await validateAnnotationPath(requested);
    if (!validation.ok) {
      if (method === 'GET') sendText(req, res, validation.status, validation.body.message || '路径无效');
      else sendJson(req, res, validation.status, validation.body);
      return;
    }

    const filePath = validation.path;
    const items = await listAnnotations(filePath);
    const designId = validation.designId || (await findDesignIdForPath(filePath));
    const mdPath = handoffPathFor(filePath);

    if (method === 'GET') {
      // GET 只读：已有交接单就原样返回（不自造新时间戳），没有再按当前标注生成
      let markdown = null;
      try {
        markdown = await fs.readFile(mdPath, 'utf8');
      } catch {
        markdown = null;
      }
      if (markdown == null) {
        const written = await writeHandoffFile({ filePath, annotations: items, designId });
        if (!written.ok) {
          sendText(req, res, 500, written.message || '生成交接单失败');
          return;
        }
        markdown = await fs.readFile(written.mdPath, 'utf8');
      }
      sendText(req, res, 200, markdown, 'text/markdown; charset=utf-8');
      return;
    }

    const written = await writeHandoffFile({ filePath, annotations: items, designId });
    if (!written.ok) {
      sendJson(req, res, 500, errorBody(written.code || 'INTERNAL', written.message || '生成交接单失败', '看 DSH 日志里 [sw-3d-preview] 的堆栈'));
      return;
    }
    sendJson(req, res, 200, {
      ok: true,
      mdPath: written.mdPath,
      count: written.count,
      bytes: written.bytes,
      designId: written.designId,
      generatedAt: written.generatedAt,
    });
  }

  /**
   * /sw3d/snapshot
   *   POST {path, base64, mediaType} → 把用户视角截图写到
   *   %LOCALAPPDATA%\sw-3d-preview\shots\<sha1(模型路径小写)>-<时间戳>.<png|jpg>
   *   返回 {ok, shotPath, bytes, mediaType}
   *   （通道 B：草稿附件通道不可用时的兜底，模型可以直接 read_image 这个路径）
   */
  async function handleSnapshot(req, res) {
    if (!allowTrusted(req, res)) return;
    if (!allowMethods(req, res, ['POST'])) return;
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (!contentType.includes('application/json')) {
      sendJson(req, res, 415, errorBody('UNSUPPORTED', '请求体必须是 application/json', '带上 content-type: application/json'));
      return;
    }
    const body = await readJsonBody(req, MAX_SNAPSHOT_TEXT_BODY);
    if (!body.ok) {
      sendJson(req, res, body.status, body.body);
      return;
    }
    const payload = body.value;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      sendJson(req, res, 400, errorBody('BAD_REQUEST', '请求体必须是 JSON 对象', '示例：{"path":"C:\\\\…\\\\锁盖.STEP","base64":"iVBORw0…","mediaType":"image/png"}'));
      return;
    }
    const requested = typeof payload.path === 'string' ? payload.path.trim() : '';
    if (!requested) {
      sendJson(req, res, 400, errorBody('BAD_REQUEST', '缺少 path 字段', '传被预览模型的绝对路径（截图按它归类）'));
      return;
    }
    if (!path.isAbsolute(requested)) {
      sendJson(req, res, 400, errorBody('BAD_REQUEST', `path 必须是绝对路径：${requested}`, '例如 {"path":"C:\\\\work\\\\锁盖.STEP"}'));
      return;
    }
    if (!isAllowedExtension(requested)) {
      sendJson(req, res, 400, errorBody('BAD_REQUEST', `截图只能挂在已支持的模型文件上：${path.extname(requested) || '(无扩展名)'}`, '只接受 .step/.stp/.stl/.obj/.sldprt/.sldasm'));
      return;
    }
    const base64 = typeof payload.base64 === 'string'
      ? payload.base64
      : (typeof payload.pngBase64 === 'string' ? payload.pngBase64 : '');
    if (!base64) {
      sendJson(req, res, 400, errorBody('BAD_REQUEST', '缺少 base64 字段', '把 PNG/JPEG 的 base64（不带 data: 前缀也可以）放进 base64'));
      return;
    }
    let bytes;
    try {
      bytes = Buffer.from(String(base64).replace(/^data:[^,]*,/, ''), 'base64');
    } catch {
      sendJson(req, res, 400, errorBody('BAD_REQUEST', 'base64 解码失败', '检查是否把 data URL 前缀与换行一起塞进来了'));
      return;
    }
    if (!bytes.length) {
      sendJson(req, res, 400, errorBody('BAD_REQUEST', 'base64 解码后是空图', '确认截图真的编码出了像素'));
      return;
    }
    if (bytes.length > MAX_SNAPSHOT_BYTES) {
      sendJson(req, res, 413, errorBody('UNSUPPORTED', `截图解码后 ${(bytes.length / 1048576).toFixed(1)} MB，超过 8 MB 上限`, '客户端会先把 >1.5 MB 的 PNG 重编成 JPEG，这里不该超；真超了就降分辨率'));
      return;
    }
    const sniffed = sniffImageType(bytes);
    if (!sniffed) {
      sendJson(req, res, 415, errorBody('UNSUPPORTED', '截图不是 PNG 或 JPEG（魔数校验失败）', '只接受 PNG(89 50 4E 47) / JPEG(FF D8 FF) —— 扩展名与 mediaType 不作数'));
      return;
    }

    const modelPath = path.resolve(requested);
    const shotPath = path.join(snapshotDir(), `${sha1(modelPath.toLowerCase())}-${Date.now()}${sniffed.ext}`);
    try {
      ensureDir(snapshotDir());
      await fs.writeFile(shotPath, bytes);
    } catch (error) {
      logError('写截图失败', error);
      sendJson(req, res, 500, errorBody('INTERNAL', '截图没写进去', '看 DSH 日志里 [sw-3d-preview] 的堆栈'));
      return;
    }
    sendJson(req, res, 200, { ok: true, shotPath, bytes: bytes.length, mediaType: sniffed.mediaType });
  }

  /**
   * /sw3d/sketches?path=<模型绝对路径>
   *   只读：把模型路径反查成 sw-mcp 的 designId，再把 definition.features 里的草图段
   *   摊平成「三维折线 + 尺寸」，给客户端画草图叠加层。
   *   - 缺 path      → 400 BAD_REQUEST
   *   - 没有 designId / 没有草图 / 读不出来 → 200 {ok:false, code, message, hint}
   *   不修改任何 project json，不碰 SOLIDWORKS。
   */
  async function handleSketches(req, res) {
    if (!allowTrusted(req, res)) return;
    if (!allowMethods(req, res, ['GET', 'HEAD'])) return;
    const url = requestUrl(req);
    const requested = url.searchParams.get('path') || '';
    if (!requested) {
      sendJson(req, res, 400, errorBody('BAD_REQUEST', '缺少 path 参数', '用 ?path=<encodeURIComponent(绝对路径)> 传进来'));
      return;
    }
    let payload;
    try {
      payload = await readSketchesForPath(requested);
    } catch (error) {
      logError('读草图数据失败', error);
      payload = errorBody('INTERNAL', '读草图数据时出错了', '看 DSH 日志里 [sw-3d-preview] 的堆栈；草图数据只读 sw-mcp 的 project json');
    }
    sendJson(req, res, 200, payload);
  }

  return {
    ping: handlePing,
    resolve: handleResolve,
    mesh: handleMesh,
    three: handleThree,
    annotation: handleAnnotation,
    handoff: handleHandoff,
    snapshot: handleSnapshot,
    sketches: handleSketches,
  };
}

// --------------------------------------------------------------------------- 插件入口

export function apply(ctx) {
  const handlers = createHandlers(ctx);
  const register = (routePath, handler, label) => {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path: routePath,
          handler: (req, res) => Promise.resolve(handler(req, res)).catch((error) => fail(res, error)),
        }),
      label,
    );
  };
  register(ROUTES.ping, handlers.ping, 'sw-3d-preview:ping');
  register(ROUTES.resolve, handlers.resolve, 'sw-3d-preview:resolve');
  register(ROUTES.mesh, handlers.mesh, 'sw-3d-preview:mesh');
  register(ROUTES.three, handlers.three, 'sw-3d-preview:three');
  register(ROUTES.annotation, handlers.annotation, 'sw-3d-preview:annotation');
  register(ROUTES.handoff, handlers.handoff, 'sw-3d-preview:handoff');
  register(ROUTES.snapshot, handlers.snapshot, 'sw-3d-preview:snapshot');
  register(ROUTES.sketches, handlers.sketches, 'sw-3d-preview:sketches');
}
