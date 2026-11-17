// 草图解析单元测试（纯函数，无浏览器、无网络、无磁盘依赖）
//
// 被 test/client-smoke.mjs 引入：registerSketchParseTests(check)。
// 真实数据来自 %LOCALAPPDATA%\sw-mcp\projects\fracture-section-01.json，
// features 原文**内联**在这里当 fixture —— 测试运行时**不依赖**那个绝对路径。
//
// 覆盖的 bug（已修）：
//   1. `lib/sketches.js` 的 line 分支只读 `curve.start/end`，而真实数据的坐标在
//      `curve.params.start/end` 下 → fracture-section-01 的 4 条轮廓直边全被丢掉，
//      画出来是不闭合的残图。
//   2. `construction: true` 的构造几何（那条 axis 中心线）被当成轮廓画进去。
//   3. circle 的 radius/diameter 只看 params，老格式把 radius 写在 curve 上就丢圆；
//      半径写成参数名（"r"）时 Number("r") = NaN 也丢圆。
import assert from 'node:assert/strict';

import { buildSketchPayload, tessellateSketch, resolveParams } from '../lib/sketches.js';

/* ------------------------------------------------------------------ */
/* 内联 fixture：fracture-section-01.json 原文                          */
/* ------------------------------------------------------------------ */

/** definition.params（原文是空表）。 */
const FRACTURE_PARAMS = {};

/**
 * fracture-section-01.json 的 definition.features[0]（kind=sketch, id=fracture_profile）
 * —— 原文照抄：11 段曲线（4 arc + 4 line + 2 circle + 1 条 construction 的 line）。
 * 注意 line 的坐标全在 params.start / params.end 下，这正是出 bug 的形状。
 */
const FRACTURE_FEATURE = {
  kind: 'sketch',
  id: 'fracture_profile',
  plane: 0,
  curves: [
    {
      kind: 'arc',
      id: 'bottom_arc',
      construction: false,
      params: {
        center: [0, 52.833333],
        radius: 52.833333,
        startAngle: 103.685547,
        endAngle: 76.314453,
        direction: 1,
        start: [-12.5, 1.5],
        end: [12.5, 1.5],
      },
      constraints: [],
      dimensions: [],
      source: 'spec',
    },
    {
      kind: 'arc',
      id: 'side_right',
      construction: false,
      params: {
        center: [0, 1.5],
        radius: 12.5,
        startAngle: 0,
        endAngle: 61.642363,
        direction: 1,
        start: [12.5, 1.5],
        end: [5.937171, 12.5],
      },
      constraints: [],
      dimensions: [],
      source: 'spec',
    },
    {
      kind: 'line',
      id: 'top_right',
      construction: false,
      params: {
        start: [5.937171, 12.5],
        end: [1.7, 12.5],
      },
      constraints: [{ type: 'horizontal', refs: ['top_right'] }],
      dimensions: [],
      source: 'spec',
    },
    {
      kind: 'line',
      id: 'slot_right',
      construction: false,
      params: {
        start: [1.7, 12.5],
        end: [1.7, 3.8],
      },
      constraints: [{ type: 'vertical', refs: ['slot_right'] }],
      dimensions: [],
      source: 'spec',
    },
    {
      kind: 'arc',
      id: 'slot_arc',
      construction: false,
      params: {
        center: [0, 3.8],
        radius: 1.7,
        startAngle: 0,
        endAngle: -180,
        direction: -1,
        start: [1.7, 3.8],
        end: [-1.7, 3.8],
      },
      constraints: [],
      dimensions: [],
      source: 'spec',
    },
    {
      kind: 'line',
      id: 'slot_left',
      construction: false,
      params: {
        start: [-1.7, 3.8],
        end: [-1.7, 12.5],
      },
      constraints: [{ type: 'vertical', refs: ['slot_left'] }],
      dimensions: [],
      source: 'spec',
    },
    {
      kind: 'line',
      id: 'top_left',
      construction: false,
      params: {
        start: [-1.7, 12.5],
        end: [-5.937171, 12.5],
      },
      constraints: [{ type: 'horizontal', refs: ['top_left'] }],
      dimensions: [],
      source: 'spec',
    },
    {
      kind: 'arc',
      id: 'side_left',
      construction: false,
      params: {
        center: [0, 1.5],
        radius: 12.5,
        startAngle: 118.357637,
        endAngle: 180,
        direction: 1,
        start: [-5.937171, 12.5],
        end: [-12.5, 1.5],
      },
      constraints: [],
      dimensions: [],
      source: 'spec',
    },
    {
      // 构造几何：SOLIDWORKS 的中心线，不是轮廓的一部分
      kind: 'line',
      id: 'axis',
      construction: true,
      params: {
        start: [0, -2],
        end: [0, 14],
      },
      constraints: [{ type: 'vertical', refs: ['axis'] }],
      dimensions: [],
      source: 'spec',
    },
    {
      kind: 'circle',
      id: 'screw_l',
      construction: false,
      params: {
        center: [-7.5, 5.3],
        radius: 1.25,
      },
      constraints: [],
      dimensions: [],
      source: 'spec',
    },
    {
      kind: 'circle',
      id: 'screw_r',
      construction: false,
      params: {
        center: [7.5, 5.3],
        radius: 1.25,
      },
      constraints: [],
      dimensions: [],
      source: 'spec',
    },
  ],
  relations: [],
  dimensions: [
    { name: 'profile.side_r', type: 'radius', value: 12.5, refs: ['side_right'] },
    { name: 'profile.side_r_l', type: 'radius', value: 12.5, refs: ['side_left'] },
    { name: 'profile.bottom_r', type: 'radius', value: 52.833333, refs: ['bottom_arc'] },
    { name: 'profile.slot_r', type: 'radius', value: 1.7, refs: ['slot_arc'] },
    { name: 'screw.d_l', type: 'diameter', value: 2.5, refs: ['screw_l'] },
    { name: 'screw.d_r', type: 'diameter', value: 2.5, refs: ['screw_r'] },
  ],
};

/** 整份 project 记录（只保留断言用得到的字段，值全部来自原文）。 */
export const FRACTURE_PROJECT = {
  designId: 'fracture-section-01',
  goal: 'fracture-section-01: 1 个特征（sketch×1）',
  definition: {
    designId: 'fracture-section-01',
    schemaVersion: 3,
    units: 'mm',
    features: [FRACTURE_FEATURE],
    params: FRACTURE_PARAMS,
  },
  measurements: { closed: true, segments: 11, relations: 11, openEnds: 0 },
};

/** 老格式：坐标直接放在 curve 上（curve-zoo.json 的原文形状）。 */
const LEGACY_PROJECT = {
  designId: 'curve-zoo',
  definition: {
    designId: 'curve-zoo',
    schemaVersion: 3,
    units: 'mm',
    params: { r: 15, depth: 5 },
    features: [
      {
        kind: 'sketch',
        id: 'curve_zoo',
        plane: 1,
        curves: [
          { kind: 'line', id: 'L1', start: [0, 0], end: [20, 0] },
          { kind: 'circle', id: 'C1', center: [0, 10], radius: 5 },
          { kind: 'arc', id: 'A1', center: [30, 10], radius: 5, startAngle: 0, endAngle: 90 },
          { kind: 'spline', id: 'S1', points: [[0, 30], [5, 35], [10, 30], [15, 35]] },
          { kind: 'polyline', id: 'P1', points: [[0, 50], [10, 50], [10, 60], [0, 60]] },
        ],
      },
      {
        kind: 'sketch',
        id: 'profile',
        plane: 1,
        curves: [{ kind: 'circle', id: 'C2', center: [0, 0], radius: 'r' }],
      },
      { kind: 'extrude', id: 'body', profile: 'profile', depth: 'depth', direction: '+Y' },
    ],
  },
};

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** 世界坐标点 → 平面 0 的二维 (u,v)（plane 0: u→X, v→Y）。 */
function uv(point) {
  return [point[0], point[1]];
}

function round(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function key2(point) {
  return round(point[0]) + ',' + round(point[1]);
}

/** 一条折线的首尾端点（闭合折线返回 null：不参与「首尾相接」判定）。 */
function openEnds(line) {
  if (!line || line.closed) return null;
  const points = line.points || [];
  if (points.length < 2) return null;
  return [key2(uv(points[0])), key2(uv(points[points.length - 1]))];
}

function warningsMatching(warnings, needle) {
  return (warnings || []).filter((text) => String(text).includes(needle));
}

/* ------------------------------------------------------------------ */
/* tests                                                               */
/* ------------------------------------------------------------------ */

export function registerSketchParseTests(check) {
  check('草图解析（真实 fracture-section-01）：11 段 → 10 条非构造折线，4 条 line 全在', () => {
    const params = resolveParams(FRACTURE_PROJECT.definition.params);
    const result = tessellateSketch(FRACTURE_FEATURE, params);

    // 11 段曲线减 1 条构造中心线 = 10 条折线（4 arc + 4 line + 2 circle）
    assert.equal(result.polylines.length, 10, '折线数必须是 10：' + JSON.stringify(result.polylines.map((p) => p.kind)));
    const counts = {};
    for (const line of result.polylines) counts[line.kind] = (counts[line.kind] || 0) + 1;
    assert.deepEqual(counts, { arc: 4, line: 4, circle: 2 }, '种类统计：' + JSON.stringify(counts));

    // 4 条轮廓直边必须一条不少（修复前这 4 条全被「缺少 start/end」丢掉）
    const lines = result.polylines.filter((line) => line.kind === 'line');
    assert.equal(lines.length, 4, '4 条 line 必须都在（修复前是 0 条）');
    const expectedLines = [
      [[5.937171, 12.5], [1.7, 12.5]],      // top_right
      [[1.7, 12.5], [1.7, 3.8]],            // slot_right
      [[-1.7, 3.8], [-1.7, 12.5]],          // slot_left
      [[-1.7, 12.5], [-5.937171, 12.5]],    // top_left
    ];
    for (const [from, to] of expectedLines) {
      const hit = lines.find((line) => {
        const got = [uv(line.points[0]), uv(line.points[line.points.length - 1])];
        return key2(got[0]) === key2(from) && key2(got[1]) === key2(to);
      });
      assert.ok(hit, `缺少直边 ${JSON.stringify(from)} → ${JSON.stringify(to)}`);
    }

    // 守住「不许悄悄丢」：构造几何要计数、要提示，数据本身留在 constructionPolylines 里
    assert.equal(result.constructionSkipped, 1, '应跳过 1 条构造几何');
    assert.equal(result.constructionPolylines.length, 1, '构造几何的折线要留着（将来可做「显示构造线」）');
    assert.deepEqual(
      result.constructionPolylines[0].points.map(uv).map((p) => [round(p[0]), round(p[1])]),
      [[0, -2], [0, 14]],
      '被跳过的正是 axis 中心线',
    );
    const notices = warningsMatching(result.warnings, '构造几何');
    assert.equal(notices.length, 1, '必须有一条说明构造几何被跳过的 warning：' + JSON.stringify(result.warnings));
    assert.ok(notices[0].includes('已跳过 1 条构造几何'), notices[0]);
    // 修复前这里会有 4 条「缺少 start/end」；现在一条都不许有
    assert.equal(warningsMatching(result.warnings, '缺少 start/end').length, 0,
      '不许再出现「缺少 start/end」：' + JSON.stringify(result.warnings));
  });

  check('草图解析（真实 fracture-section-01）：轮廓首尾相接，闭合链没有断口', () => {
    const result = tessellateSketch(FRACTURE_FEATURE, resolveParams(FRACTURE_PROJECT.definition.params));
    // 只取非圆的开放折线（8 段：4 line + 4 arc）；圆自身闭合，不参与链式拼接
    const open = result.polylines.filter((line) => !line.closed && line.kind !== 'circle');
    assert.equal(open.length, 8, '4 条直边 + 4 段圆弧 = 8 条开放折线，实际 ' + open.length);

    const endpointCount = new Map();
    for (const line of open) {
      for (const key of openEnds(line)) endpointCount.set(key, (endpointCount.get(key) || 0) + 1);
    }
    // 11 段草图是闭合轮廓（measurements.closed=true）：每个接缝必须正好被 2 条折线共用
    assert.equal(endpointCount.size, 8, '8 个接缝点：' + JSON.stringify([...endpointCount.keys()]));
    for (const [key, count] of endpointCount) {
      assert.equal(count, 2, `接缝 ${key} 必须被恰好 2 条折线共用，实际 ${count}（断口）`);
    }
    // 关键接缝抽查：修复前 top_right/slot_right 这些直边根本不存在，链就断在这里
    for (const key of ['5.937,12.5', '1.7,12.5', '1.7,3.8', '-1.7,3.8', '-1.7,12.5', '-5.937,12.5', '12.5,1.5', '-12.5,1.5']) {
      assert.equal(endpointCount.get(key), 2, `接缝 ${key} 缺失或没接上`);
    }
  });

  check('草图解析（真实 fracture-section-01）：buildSketchPayload 透传折线数 / 构造计数 / warning', () => {
    const payload = buildSketchPayload(FRACTURE_PROJECT, { designId: 'fracture-section-01' });
    assert.equal(payload.ok, true);
    assert.equal(payload.designId, 'fracture-section-01');
    assert.equal(payload.sketches.length, 1);
    const sketch = payload.sketches[0];
    assert.equal(sketch.name, 'fracture_profile');
    assert.equal(sketch.plane, '基准面-前视');
    assert.equal(sketch.polylines.length, 10);
    assert.deepEqual(sketch.stats.counts, { arc: 4, line: 4, circle: 2 });
    assert.equal(sketch.stats.text, '10 条折线（4 圆弧 4 直线 2 圆）');
    assert.equal(sketch.constructionSkipped, 1, '构造几何计数必须出现在响应里');
    assert.equal(sketch.constructionPolylines.length, 1);
    // bbox 必须覆盖直边（Y 到 12.5）与圆（X 到 ±8.75），修复前缺直边会偏小
    assert.equal(sketch.bbox[3], 12.5, 'X 上界应来自 side_right/side_left 圆弧起点 12.5：' + JSON.stringify(sketch.bbox));
    assert.equal(sketch.bbox[4], 12.5, 'Y 上界 12.5（直边 top_right/top_left 所在的水平线）');
    assert.ok(payload.warnings.some((text) => text.includes('已跳过 1 条构造几何')), JSON.stringify(payload.warnings));
    assert.equal(payload.warnings.length, 1, '干净的真实数据只该剩这 1 条提示：' + JSON.stringify(payload.warnings));
  });

  check('草图解析（老格式）：坐标直接放 curve.start/end 仍然能解析', () => {
    const payload = buildSketchPayload(LEGACY_PROJECT, { designId: 'curve-zoo' });
    assert.equal(payload.ok, true);
    const zoo = payload.sketches.find((item) => item.name === 'curve_zoo');
    assert.ok(zoo, 'curve_zoo 草图必须存在');

    // 老格式 line：curve.start/end
    const line = zoo.polylines.find((item) => item.kind === 'line');
    assert.ok(line, '老格式 line 必须解析出来（curve.start/end 写法）');
    // plane 1：u→X, v→-Z
    assert.deepEqual(line.points, [[0, 0, 0], [20, 0, 0]]);

    // 老格式 circle：curve.center/curve.radius（radius 在 curve 上，不在 params 里）
    const circles = zoo.polylines.filter((item) => item.kind === 'circle');
    assert.equal(circles.length, 1, '老格式圆必须解析出来（curve.radius 写法），实际 ' + circles.length);
    const circleXs = circles[0].points.map((point) => round(point[0]));
    assert.equal(Math.min(...circleXs), -5, '圆半径 5（curve.radius）→ X 最小 -5');
    assert.equal(Math.max(...circleXs), 5, '圆半径 5 → X 最大 5');

    // 老格式 arc：只有 center/radius/startAngle/endAngle（curve-zoo 的 A1，没有 start/end 点）
    const arcs = zoo.polylines.filter((item) => item.kind === 'arc');
    assert.equal(arcs.length, 1, 'A1（无 start/end、按角度补）必须解析出来：' + JSON.stringify(zoo.stats));
    const a1 = arcs.find((item) => item.points.some((point) => round(point[0]) === 35 && round(point[2]) === -10));
    assert.ok(a1, 'A1 从 0° 扫到 90°：(35, -10) 应在折线上');

    // 半径写成参数名（radius:"r" + definition.params.r=15）也要按参数表求值
    const profile = payload.sketches.find((item) => item.name === 'profile');
    assert.equal(profile.polylines.length, 1, 'radius:"r" 的圆必须能解析（不能 Number("r")→NaN）：' + JSON.stringify(profile.stats));
    const profileXs = profile.polylines[0].points.map((point) => round(point[0]));
    assert.equal(Math.max(...profileXs), 15, 'definition.params.r = 15 → 圆半径 15');
    assert.equal(Math.min(...profileXs), -15);
  });

  check('草图解析（病态输入）：缺坐标只产生 warning，不抛异常', () => {
    const feature = {
      kind: 'sketch',
      id: 'broken',
      plane: 0,
      curves: [
        { kind: 'line', id: 'no_coords' },                                     // 两边都没有坐标
        { kind: 'line', id: 'only_start', params: { start: [0, 0] } },          // 只有 start
        { kind: 'arc', id: 'no_center', params: { radius: 5 } },                // 缺圆心
        { kind: 'circle', id: 'no_radius', params: { center: [1, 1] } },        // 缺半径
        { kind: 'circle', id: 'nan_radius', params: { center: [1, 1], radius: 'not_a_param' } },
        { kind: 'spline', id: 'one_point', points: [[1, 1]] },                  // 点数不足
        { kind: 'equationCurve', id: 'eq' },                                    // 拿不到离散坐标
        { kind: 'nonsense', id: 'unknown' },                                    // 不认识的类型
        null,                                                                   // 坏条目
        { kind: 'line', id: 'bad_point', params: { start: 'x', end: [1, 1] } }, // 类型不对
      ],
      primitives: [
        { shape: 'circle', diameter: 'not_a_param' },                           // 图元缺直径
        { shape: 'unknown', center: [0, 0] },                                   // 不认识的图元
        null,
      ],
    };
    let result;
    assert.doesNotThrow(() => {
      result = tessellateSketch(feature, {});
    }, '病态输入绝不能抛异常');
    assert.ok(Array.isArray(result.polylines));
    assert.equal(result.polylines.length, 0, '没有可用坐标时不许瞎画：' + JSON.stringify(result.polylines));
    assert.ok(result.warnings.length >= 6, '每种缺字段都要有自己的 warning，实际 ' + result.warnings.length);
    assert.equal(typeof result.warnings[0], 'string');
    // 具体提示必须说明是哪个字段缺了
    const joined = result.warnings.join('\n');
    assert.ok(joined.includes('缺少 start/end'), joined);
    assert.ok(joined.includes('圆弧参数不全'), joined);
    assert.ok(joined.includes('半径无效'), joined);
    assert.ok(joined.includes('点数不足 2'), joined);

    // 整个 payload 走一遍也不许炸：草图在但没折线 → ok:true + 「画不出来」提示
    const payload = buildSketchPayload({
      designId: 'broken',
      definition: { schemaVersion: 3, units: 'mm', features: [feature], params: {} },
    }, {});
    assert.equal(payload.ok, true);
    assert.equal(payload.sketches.length, 1);
    assert.equal(payload.sketches[0].polylines.length, 0);
    assert.ok(warningsMatching(payload.warnings, '叠加层无法画线').length === 1,
      '全部草图都没有坐标时要给「无法画线」提示：' + JSON.stringify(payload.warnings));
  });

  check('草图解析（构造几何）：默认不进 polylines，但计数 + 提示，不静默丢', () => {
    const feature = {
      kind: 'sketch',
      id: 'cons',
      plane: 0,
      curves: [
        { kind: 'line', construction: true, params: { start: [0, 0], end: [0, 10] } },  // 中心线
        { kind: 'line', params: { start: [0, 0], end: [10, 0] } },                       // 轮廓
        { kind: 'line', params: { start: [10, 0], end: [10, 10] } },                     // 轮廓
      ],
    };
    const result = tessellateSketch(feature, {});
    assert.equal(result.polylines.length, 2, '构造线不许进轮廓：' + JSON.stringify(result.polylines.length));
    assert.equal(result.constructionSkipped, 1);
    assert.equal(result.constructionPolylines.length, 1, '构造线数据要保留');
    assert.ok(result.warnings.some((text) => text.includes('已跳过 1 条构造几何')), JSON.stringify(result.warnings));
    // 没有构造几何的草图不许凭空多出一条提示
    const clean = tessellateSketch({
      kind: 'sketch', id: 'clean', plane: 0,
      curves: [{ kind: 'line', params: { start: [0, 0], end: [1, 1] } }],
    }, {});
    assert.equal(clean.constructionSkipped, 0);
    assert.equal(warningsMatching(clean.warnings, '构造几何').length, 0);
  });
}
