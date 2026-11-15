/**
 * 路径与格式解析：把预览面板传来的路径解析成一个「可以拿去三角化的网格源」。
 *
 * 关键事实：
 * - .sldprt/.sldasm 是 SolidWorks 容器，本插件不解析；约定用 STEP 预览。
 * - .step/.stp 走 python + OCCT；.stl/.obj 由 node 直接解析。
 * - 预览面板传来的 path **可能是相对路径**（DSH 的 session 资源地址里就是相对工作区的），
 *   宿主必须能补全，否则真实场景直接不可用。补全来源见 lib/paths.js。
 * - 失败一律返回 200 + { ok:false, code, message, hint }，code 只用约定集合。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  baseNameOf,
  findDesignIdForPath,
  findPathByBaseName,
  isAbsoluteFsPath,
  rememberResolvedPath,
} from './paths.js';

export const MESH_EXTENSIONS = Object.freeze(['.step', '.stp', '.stl', '.obj']);
export const NATIVE_EXTENSIONS = Object.freeze(['.sldprt', '.sldasm']);
export const ALLOWED_EXTENSIONS = Object.freeze([...MESH_EXTENSIONS, ...NATIVE_EXTENSIONS]);
export const STEP_EXTENSIONS = Object.freeze(['.step', '.stp']);

export const DEFAULT_DEFLECTION = 0.2;
export const MIN_DEFLECTION = 0.01;
export const MAX_DEFLECTION = 50;

export const DEFAULT_MAX_TRIANGLES = 300000;
export const MIN_MAX_TRIANGLES = 2000;
export const MAX_MAX_TRIANGLES = 5000000;

/** 同名 STEP 比原生件旧超过这个时间，就提示「STEP 可能已过期」。 */
export const STALE_STEP_THRESHOLD_MS = 60000;

const NO_MESH_SOURCE_HINT =
  '让 agent 执行 deliver kind="step" designId=<设计ID> 导出 STEP，或把同名 .step 放到该目录再重试';

/** fs.stat 的静默版本：不存在/无权限都返回 null，不抛错。 */
export async function statSafe(target) {
  if (typeof target !== 'string' || !target) return null;
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

export function isAbsoluteFilePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 32767 && !value.includes('\0') && path.isAbsolute(value) && isAbsoluteFsPath(value);
}

export function extensionOf(value) {
  return typeof value === 'string' ? path.extname(value).toLowerCase() : '';
}

export function isAllowedExtension(value) {
  return ALLOWED_EXTENSIONS.includes(extensionOf(value));
}

export function isNativeExtension(value) {
  return NATIVE_EXTENSIONS.includes(extensionOf(value));
}

function fail(code, message, hint, extra) {
  return { ok: false, code, message, hint, ...(extra || {}) };
}

function roundMs(value) {
  return Math.round(Number(value) || 0);
}

function fmtTime(ms) {
  const value = roundMs(ms);
  if (!value) return '未知';
  try {
    return new Date(value).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  } catch {
    return '未知';
  }
}

function fmtBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return '未知大小';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

// --------------------------------------------------------------------------- 同名 / 兜底 STEP 查找

function baseNameLower(value) {
  return path.basename(value, path.extname(value)).toLowerCase();
}

/**
 * 在同目录里找同名 .step/.stp（扩展名与文件名都比较小写，优先 .step，其次 .stp）。
 * @returns {Promise<string|null>} 命中的绝对路径
 */
export async function findSiblingStep(requestedPath) {
  const dir = path.dirname(requestedPath);
  const baseName = baseNameLower(requestedPath);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const matches = [];
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const entryExt = extensionOf(entry.name);
    if (!STEP_EXTENSIONS.includes(entryExt)) continue;
    if (baseNameLower(entry.name) !== baseName) continue;
    matches.push({
      fullName: entry.name,
      rank: entryExt === '.step' ? 0 : 1,
      exactCase: entry.name === `${path.basename(requestedPath, path.extname(requestedPath))}${entryExt}` ? 0 : 1,
    });
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.rank - b.rank || a.exactCase - b.exactCase || a.fullName.localeCompare(b.fullName));
  return path.join(dir, matches[0].fullName);
}

/** 文件名相似度 0..1：二元组 Dice 系数 + 公共前缀比例，各权重 0.6 / 0.4。 */
export function nameSimilarity(a, b) {
  const left = String(a || '').toLowerCase().replace(/\.[^.]+$/, '');
  const right = String(b || '').toLowerCase().replace(/\.[^.]+$/, '');
  if (!left || !right) return 0;
  if (left === right) return 1;
  const bigrams = (text) => {
    const out = new Map();
    for (let i = 0; i + 1 < text.length; i += 1) {
      const key = text.slice(i, i + 2);
      out.set(key, (out.get(key) || 0) + 1);
    }
    return out;
  };
  const leftGrams = bigrams(left);
  const rightGrams = bigrams(right);
  let overlap = 0;
  let leftTotal = 0;
  let rightTotal = 0;
  for (const count of leftGrams.values()) leftTotal += count;
  for (const count of rightGrams.values()) rightTotal += count;
  for (const [key, count] of leftGrams) overlap += Math.min(count, rightGrams.get(key) || 0);
  const dice = leftTotal + rightTotal > 0 ? (2 * overlap) / (leftTotal + rightTotal) : 0;
  let prefix = 0;
  const span = Math.min(left.length, right.length);
  while (prefix < span && left[prefix] === right[prefix]) prefix += 1;
  return Math.round((0.6 * dice + 0.4 * (prefix / Math.max(left.length, right.length))) * 1000) / 1000;
}

/**
 * 第二级兜底：同目录里任意名字的 .step/.stp。
 * 规则：文件名相似度 >= 0.25 才有资格；先看「相似（>=0.5）」的组，再按修改时间新→旧挑。
 * 返回 null 表示没有像样的候选（宁可不猜，也不要给用户一个完全无关的模型）。
 * @returns {Promise<{path:string, name:string, similarity:number, mtimeMs:number, bytes:number}|null>}
 */
export async function findFallbackStep(requestedPath) {
  const dir = path.dirname(requestedPath);
  const targetName = path.basename(requestedPath);
  const selfPath = path.resolve(requestedPath);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const entryExt = extensionOf(entry.name);
    if (!STEP_EXTENSIONS.includes(entryExt)) continue;
    const fullPath = path.join(dir, entry.name);
    if (path.resolve(fullPath).toLowerCase() === selfPath.toLowerCase()) continue;
    const similarity = nameSimilarity(entry.name, targetName);
    if (similarity < 0.25) continue;
    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size <= 0) continue;
    candidates.push({
      path: fullPath,
      name: entry.name,
      similarity,
      mtimeMs: roundMs(stat.mtimeMs),
      bytes: stat.size,
    });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const groupA = a.similarity >= 0.5 ? 1 : 0;
    const groupB = b.similarity >= 0.5 ? 1 : 0;
    if (groupA !== groupB) return groupB - groupA;
    if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return b.similarity - a.similarity;
  });
  return candidates[0];
}

// --------------------------------------------------------------------------- 路径补全

/**
 * 把相对路径补成绝对路径：先看 `base`（客户端给的会话工作区根），再按文件名查
 * sw-mcp 的 project 记录与最近成功解析索引。
 * @returns {Promise<{ok:true, path:string, completed:boolean, designId:string, source:string, notes:string[]}
 *                  |{ok:false, code:string, message:string, hint:string, received:string}>}
 */
export async function completeFilePath(requestedPath, { base = '' } = {}) {
  const received = typeof requestedPath === 'string' ? requestedPath.trim() : '';
  if (!received) {
    return fail('NOT_FOUND', '没有给出文件路径', '把预览文件的绝对路径通过 ?path= 传进来');
  }
  if (isAbsoluteFilePath(received)) {
    return { ok: true, path: path.resolve(received), completed: false, designId: '', source: 'absolute', notes: [] };
  }
  const notes = [];
  const baseName = baseNameOf(received);

  // 1) 客户端给了工作区根：直接用（随后由调用方 stat 校验）
  if (base && isAbsoluteFilePath(base)) {
    const joined = path.resolve(base, received);
    const stat = await statSafe(joined);
    if (stat && stat.isFile()) {
      notes.push(`已用会话工作区根补全路径：${base}`);
      return {
        ok: true,
        path: joined,
        completed: true,
        designId: await findDesignIdForPath(joined),
        source: 'workspace',
        notes,
      };
    }
  }

  // 2) 按文件名在 project 记录 / 最近索引里找真实存在的绝对路径
  const found = await findPathByBaseName(received);
  if (found) {
    notes.push(
      found.source === 'project'
        ? `已从 sw-mcp 的 project 记录补全为绝对路径（designId=${found.designId || '未知'}）`
        : '已从本插件最近解析索引补全为绝对路径',
    );
    return {
      ok: true,
      path: found.absolutePath,
      completed: true,
      designId: found.designId || '',
      source: found.source,
      notes,
    };
  }

  return fail(
    'NOT_FOUND',
    `需要绝对路径，收到的是：${received}` +
      (baseName && baseName !== received ? `（文件名 ${baseName} 也没在 project 记录/最近索引里找到）` : '（也没在 project 记录/最近索引里找到同名文件）'),
    '期望形态：C:\\work\\part.STEP（盘符 + 目录 + 文件名）。可以先用资源面板确认文件的完整路径，' +
      '或让 agent 用 deliver kind="step" 导出到已知目录后再打开',
    { received, expected: 'C:\\work\\part.STEP', completed: false },
  );
}

// --------------------------------------------------------------------------- 解析入口

/**
 * 解析一个请求路径。
 * 成功：
 *   { ok:true, path, format, meshSource:'step'|'sibling-step'|'fallback-step'|'stl'|'obj',
 *     sibling:string|null, bytes, mtimeMs, hints:string[], designId:string, completed:boolean }
 * 失败：{ ok:false, code:'NO_MESH_SOURCE'|'UNSUPPORTED'|'NOT_FOUND', message, hint, received? }
 */
export async function resolveSource(requestedPath, options = {}) {
  const completed = await completeFilePath(requestedPath, options);
  if (!completed.ok) return completed;

  const normalized = completed.path;
  const extension = extensionOf(normalized);
  const stat = await statSafe(normalized);
  if (!stat || !stat.isFile()) {
    const richer =
      completed.completed || !isAbsoluteFilePath(String(requestedPath || ''))
        ? '路径补全后仍然找不到该文件（可能已被移动或删除）'
        : '文件不存在或不是文件';
    return fail(
      'NOT_FOUND',
      `${richer}：${normalized}`,
      '确认文件还在本机磁盘上，且预览的面板指向的是文件而不是目录',
      { received: String(requestedPath ?? '') },
    );
  }
  if (!ALLOWED_EXTENSIONS.includes(extension)) {
    return fail(
      'UNSUPPORTED',
      `暂不支持 ${extension || '(无扩展名)'} 文件：${path.basename(normalized)}`,
      '支持 .step/.stp/.stl/.obj；SolidWorks 原生件 .sldprt/.sldasm 需要同目录同名 .step/.stp',
    );
  }

  const designId = completed.designId || (await findDesignIdForPath(normalized));
  const notes = completed.notes ? completed.notes.slice() : [];

  if (NATIVE_EXTENSIONS.includes(extension)) {
    const nativeLabel = extension.slice(1).toUpperCase();
    const sibling = await findSiblingStep(normalized);
    if (sibling) {
      const siblingStat = await statSafe(sibling);
      if (!siblingStat || !siblingStat.isFile()) {
        return fail('NO_MESH_SOURCE', `同名 STEP 存在但读不到：${sibling}`, NO_MESH_SOURCE_HINT);
      }
      const hints = [
        `${nativeLabel} 本身不能解析，已使用同名 ${path.extname(sibling).toUpperCase()}`,
        '模型改动后请重新导出 STEP，缓存按 STEP 的体积与修改时间失效',
        ...notes,
      ];
      appendStaleHint(hints, stat, siblingStat, nativeLabel, path.basename(sibling));
      void rememberResolvedPath(normalized);
      return {
        ok: true,
        path: normalized,
        format: extension.slice(1),
        meshSource: 'sibling-step',
        sibling,
        bytes: siblingStat.size,
        mtimeMs: roundMs(siblingStat.mtimeMs),
        hints,
        designId,
        completed: !!completed.completed,
      };
    }

    // 第二级兜底：同目录里名字最像、修改时间最新的 STEP（不启动 SOLIDWORKS）
    const fallback = await findFallbackStep(normalized);
    if (fallback) {
      const hints = [
        `未找到同名 STEP，使用最接近的 ${fallback.name}（文件名相似度 ${Math.round(fallback.similarity * 100)}%）`,
        '这是按文件名相似度 + 修改时间猜的，模型可能不是同一个零件：确认无误后让 agent 导出正式的同名 STEP',
        `候选 STEP 修改时间：${fmtTime(fallback.mtimeMs)}，大小 ${fmtBytes(fallback.bytes)}`,
        ...notes,
      ];
      appendStaleHint(hints, stat, { mtimeMs: fallback.mtimeMs }, nativeLabel, fallback.name);
      void rememberResolvedPath(normalized);
      return {
        ok: true,
        path: normalized,
        format: extension.slice(1),
        meshSource: 'fallback-step',
        sibling: fallback.path,
        bytes: fallback.bytes,
        mtimeMs: fallback.mtimeMs,
        hints,
        designId,
        completed: !!completed.completed,
        fallback: { name: fallback.name, similarity: fallback.similarity },
      };
    }

    // 第四级：什么都没有 —— 给出可直接复制的下一步 + 原生件的时间/大小，便于 agent 判断
    const deliver = `deliver kind="step" designId=${designId || '<设计ID>'}`;
    return fail(
      'NO_MESH_SOURCE',
      `${nativeLabel} 是 SolidWorks 原生格式，无法直接解析；同目录也没有可用的 .step/.stp`,
      `${NO_MESH_SOURCE_HINT}\n可直接复制的下一步：${deliver}\n` +
        `或把同名 .step 放到：${path.dirname(normalized)}\n` +
        `${path.basename(normalized)} 现状：修改时间 ${fmtTime(roundMs(stat.mtimeMs))}，大小 ${fmtBytes(stat.size)}`,
      {
        designId,
        deliver,
        directory: path.dirname(normalized),
        native: {
          path: normalized,
          bytes: stat.size,
          mtimeMs: roundMs(stat.mtimeMs),
          updatedAt: fmtTime(roundMs(stat.mtimeMs)),
        },
      },
    );
  }

  const format = extension === '.stp' ? 'step' : extension.slice(1);
  void rememberResolvedPath(normalized);
  return {
    ok: true,
    path: normalized,
    format,
    meshSource: format,
    sibling: null,
    bytes: stat.size,
    mtimeMs: roundMs(stat.mtimeMs),
    hints: format === 'stl' || format === 'obj'
      ? ['STL/OBJ 没有 B-rep 面/边拓扑，面按平面法向归并，线框为空', ...notes]
      : notes,
    designId,
    completed: !!completed.completed,
  };
}

function appendStaleHint(hints, nativeStat, stepStat, nativeLabel, stepName) {
  const nativeMs = roundMs(nativeStat && nativeStat.mtimeMs);
  const stepMs = roundMs(stepStat && stepStat.mtimeMs);
  if (!nativeMs || !stepMs) return;
  if (nativeMs - stepMs <= STALE_STEP_THRESHOLD_MS) return;
  hints.push(
    `${nativeLabel} 比 ${stepName} 新 ${Math.round((nativeMs - stepMs) / 1000)} 秒：同名 STEP 可能已过期，` +
      `看到的几何可能不是最新模型（${nativeLabel} 更新于 ${fmtTime(nativeMs)}，STEP 更新于 ${fmtTime(stepMs)}）`,
  );
}

/** 把 deflection 归一到 [0.01, 50]，非数字用默认 0.2；缓存键用它保证同参数同文件。 */
export function normalizeDeflection(value) {
  const parsed = Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DEFLECTION;
  const clamped = Math.min(MAX_DEFLECTION, Math.max(MIN_DEFLECTION, parsed));
  return Math.round(clamped * 10000) / 10000;
}

/** 三角形上限：非数字用默认 300k，夹到 [2000, 5M]，取整。缓存键必须带上它。 */
export function normalizeMaxTriangles(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_TRIANGLES;
  return Math.min(MAX_MAX_TRIANGLES, Math.max(MIN_MAX_TRIANGLES, Math.round(parsed)));
}

/** 精度档 → {deflection, maxTriangles}；未知档返回 null。 */
export const PRECISION_TIERS = Object.freeze({
  high: { deflection: 0.1, maxTriangles: 900000 },
  mid: { deflection: 0.2, maxTriangles: 300000 },
  low: { deflection: 0.5, maxTriangles: 120000 },
});

export function precisionTier(name) {
  const key = String(name || '').toLowerCase();
  return PRECISION_TIERS[key] ? { name: key, ...PRECISION_TIERS[key] } : null;
}
