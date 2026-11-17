#!/usr/bin/env node
/**
 * 外部 Bearer token 旁路的离线测试（不启动 DSH、不碰浏览器、不碰 SOLIDWORKS）。
 *
 * 断言的都是**真的会失败**的行为：每条用例只在实现满足语义时通过，把它们各自对应的
 * 实现改坏（例如把比较改成恒真、把默认值改成非空）都会让对应用例变红。
 *
 * 运行：node test/ext-token.mjs     退出码 0 = 全过。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.dirname(HERE);

const host = await import('../index.js');
const extToken = await import('../lib/ext-token.js');

let passed = 0;
const failures = [];
async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    passed += 1;
    console.log(`✔ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`✘ ${name} — ${error && error.message ? error.message : error}`);
  }
}

// --------------------------------------------------------------------------- 假 ctx / 假 req / 假 res
//
// 思路照抄 test/host.mjs：webServer.register 收 handler，connection.requestRejection
// 模拟信任栅栏，effect 直接执行。区别是这里 requestRejection 的返回值可配，
// 用来分别模拟「浏览器已信任」（undefined）与「未信任」（401/403）。

const TRUSTED = undefined;

function fakeResponse() {
  const chunks = [];
  const headers = {};
  let status = 0;
  return {
    get statusCode() {
      return status;
    },
    set statusCode(value) {
      status = value;
    },
    get headersSent() {
      return status !== 0;
    },
    writeHead(code, extra = {}) {
      status = code;
      Object.assign(headers, extra);
      return this;
    },
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value;
      return this;
    },
    getHeader(name) {
      return headers[String(name).toLowerCase()];
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return this;
    },
    result() {
      return { status, headers, body: Buffer.concat(chunks) };
    },
  };
}

async function call(handler, method, url, { headers = {}, body = null } = {}) {
  const request = Readable.from(body === null ? [] : [Buffer.from(body)]);
  request.method = method;
  request.url = url;
  request.headers = { ...headers };
  const response = fakeResponse();
  await Promise.resolve(handler(request, response));
  return response.result();
}

/**
 * 用给定配置挂一套路由。
 *
 * 注意：**不要**写成 `{ rejection = 401 }` 再用 `rejection: undefined` 表达「浏览器已信任」——
 * 解构默认值会把显式 undefined 也换成 401（JS 默认参数的坑），于是「已信任」的用例会
 * 静默变成「未信任」，看起来像实现坏了。这里用独立字段 trusted 明确表达。
 *
 * @param {object|undefined} config 插件 config（undefined = 完全不传第二个参数）
 * @param {{trusted?: boolean, rejection?: number}} options trusted=true 表示浏览器已受信
 */
function mount(config, options = {}) {
  const { trusted = false, rejection = 401 } = options;
  const routes = new Map();
  const ctx = {
    webServer: {
      register(route) {
        assert.equal(route.kind, 'exact', '本插件只注册 exact 路由');
        assert.equal(routes.has(route.path), false, `重复注册 ${route.path}`);
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
    },
    connection: {
      requestRejection: () => (trusted ? TRUSTED : rejection),
    },
    effect: (fn) => fn(),
  };
  if (config === undefined) host.apply(ctx);
  else host.apply(ctx, config);
  return routes;
}

const TOKEN = 'test-token-0123456789abcdef'; // 27 字符，远超 16 下限
const OTHER_TOKEN = 'other-token-0123456789abcdef';
const bearer = (token) => ({ authorization: `Bearer ${token}` });

// --------------------------------------------------------------------------- 0. 前置：导出与 scope 表自洽

await checkAsync('0. index.js 导出 name/inject/Config，且 Config 是 standard-schema', () => {
  assert.equal(host.name, 'sw-3d-preview');
  assert.deepEqual([...host.inject], ['webServer', 'connection']);
  assert.equal(typeof host.apply, 'function');
  assert.equal(typeof host.Config, 'object', 'index.js 必须导出 Config');
  const standard = host.Config['~standard'];
  assert.equal(typeof standard.validate, 'function', 'Config 必须提供 ~standard.validate');
  const result = standard.validate({});
  assert.ok(!('then' in result), 'Config 校验不能是异步的（cordis 不支持）');
  assert.deepEqual(result.value, { extToken: '', extTokenScopes: ['read'] }, '空配置的默认值必须是关闭 + read');
  return `Config 默认 {extToken:'', extTokenScopes:['read']}`;
});

await checkAsync('0b. 8 条路由全部在 scope 表里有归类，且归类符合读写语义', () => {
  const routes = mount({}, { trusted: true });
  assert.deepEqual(
    [...routes.keys()].sort(),
    ['/sw3d/annotation', '/sw3d/handoff', '/sw3d/mesh', '/sw3d/ping', '/sw3d/resolve', '/sw3d/sketches', '/sw3d/snapshot', '/sw3d/three.js'],
    '路由集合与预期一致（多/少一条都说明 scope 表可能要补）',
  );
  // 归类表是外部访问的权限边界：这里逐条钉死，改错任何一条都会变红
  const expected = [
    // [路由, 方法, 期望 scope]
    ['/sw3d/ping', 'GET', 'read'],
    ['/sw3d/resolve', 'GET', 'read'],
    ['/sw3d/mesh', 'GET', 'read'],
    ['/sw3d/three.js', 'GET', 'read'],
    ['/sw3d/sketches', 'GET', 'read'],
    // annotation 按方法细分：GET 只列标注 = read，POST 会 upsert 写盘 = write
    ['/sw3d/annotation', 'GET', 'read'],
    ['/sw3d/annotation', 'POST', 'write'],
    // handoff 整条 write，**包括 GET**（GET 在交接单缺失时会现场生成并写盘）
    ['/sw3d/handoff', 'GET', 'write'],
    ['/sw3d/handoff', 'POST', 'write'],
    ['/sw3d/snapshot', 'POST', 'write'],
  ];
  for (const [routePath, method, scope] of expected) {
    assert.equal(host.scopeForRoute(routePath, method), scope, `${method} ${routePath} 应归类为 ${scope}`);
  }
  // 单一 scope 简写对任意方法都应成立（ping 只支持 GET/HEAD，但归类不该随方法变）
  assert.equal(host.scopeForRoute('/sw3d/ping', 'POST'), 'read', '整条路由单一 scope 的简写形式必须与旧行为一致');
  // 未归类路由必须落到最严的 write，绝不能默认成 read
  assert.equal(host.FALLBACK_SCOPE, 'write', '未归类路由的兜底必须是 write');
  assert.equal(host.scopeForRoute('/sw3d/not-a-real-route', 'GET'), 'write', '未归类路由必须落到 write');
  // 按方法细分的路由：方法缺省 / 未列出 → 最严（不能因为「没传 method」意外放宽）
  assert.equal(host.scopeForRoute('/sw3d/annotation'), 'write', 'method 缺省时 annotation 必须落到最严的 write');
  assert.equal(host.scopeForRoute('/sw3d/annotation', 'DELETE'), 'write', '方法未列出时必须落到最严的 write');
  assert.equal(host.scopeForRoute('/sw3d/annotation', 'get'), 'read', '方法名大小写不敏感');
  return `${expected.length} 条 (路由,方法)→scope 全部符合`;
});

// --------------------------------------------------------------------------- 1. 未配置 extToken：回归，不能放松

await checkAsync('1. 未配置 extToken + 无 cookie → 仍然 401（回归）', async () => {
  const routes = mount({}, { rejection: 401 });
  const res = await call(routes.get('/sw3d/ping'), 'GET', '/sw3d/ping');
  assert.equal(res.status, 401, '未配置 token 时无凭据请求必须还是 401');
  assert.equal(res.headers['cache-control'], 'no-store');
  return '401';
});

await checkAsync('1b. row 里完全没写 config（apply(ctx) 不带第二个参数）→ 仍然 401', async () => {
  const routes = mount(undefined, { rejection: 401 });
  const res = await call(routes.get('/sw3d/ping'), 'GET', '/sw3d/ping');
  assert.equal(res.status, 401, '完全不传 config 也必须关闭外部访问');
  return '401';
});

await checkAsync('1c. 未配置 extToken（空串）+ 每个 scope 都填上 → 仍然 401', async () => {
  // 关键回归：scopes 里写了 write/read 也不能把「没配 token」变成「放行任何人」
  const routes = mount({ extToken: '', extTokenScopes: ['read', 'write'] }, { rejection: 401 });
  const res = await call(routes.get('/sw3d/ping'), 'GET', '/sw3d/ping', { headers: bearer('') });
  assert.equal(res.status, 401, 'extToken 为空时任何请求都不能放行');
  return '401';
});

// --------------------------------------------------------------------------- 2. 未配置 extToken：随便带 Bearer 也不行

await checkAsync('2. 未配置 extToken + 随便带个 Bearer → 仍然 401', async () => {
  const routes = mount({}, { rejection: 401 });
  const res = await call(routes.get('/sw3d/ping'), 'GET', '/sw3d/ping', { headers: bearer('anything-at-all-0123456789') });
  assert.equal(res.status, 401, '没配 extToken 时 Bearer 头必须被完全忽略');
  assert.equal(res.body.length, 0, '401 响应体保持为空（不泄漏任何提示）');
  return '401';
});

// --------------------------------------------------------------------------- 3. 配了 token + 正确 token → read 路由 200

await checkAsync('3. 配了 extToken + 正确 token → read 路由 200', async () => {
  const routes = mount({ extToken: TOKEN, extTokenScopes: ['read'] }, { rejection: 401 });
  const res = await call(routes.get('/sw3d/ping'), 'GET', '/sw3d/ping', { headers: bearer(TOKEN) });
  assert.equal(res.status, 200, `正确 token 必须放行 read 路由，实际 ${res.status}`);
  const payload = JSON.parse(res.body.toString('utf8'));
  assert.equal(payload.ok, true);
  assert.equal(payload.name, 'dsh-sw-3d-preview');
  return '200 + ok:true';
});

await checkAsync('3b. read 路由全部放行（ping/mesh 缺参数 400 说明已过栅栏，不是 401）', async () => {
  const routes = mount({ extToken: TOKEN, extTokenScopes: ['read'] }, { rejection: 401 });
  // mesh 不带 path：过了鉴权才发现缺参数 → 400。断言 400 而不是 200，
  // 避免依赖 python/样例文件，同时证明「确实进到 handler 里了」。
  const mesh = await call(routes.get('/sw3d/mesh'), 'GET', '/sw3d/mesh', { headers: bearer(TOKEN) });
  assert.equal(mesh.status, 400, `read+token 应进到 handler（400 缺参数），实际 ${mesh.status}`);
  const sketches = await call(routes.get('/sw3d/sketches'), 'GET', '/sw3d/sketches', { headers: bearer(TOKEN) });
  assert.equal(sketches.status, 400, `read+token 应进到 handler（400 缺参数），实际 ${sketches.status}`);
  return '/sw3d/mesh 与 /sw3d/sketches 都进了 handler';
});

// --------------------------------------------------------------------------- 4. 错误 token → 401

await checkAsync('4. 配了 extToken + 错误 token → 401', async () => {
  const routes = mount({ extToken: TOKEN, extTokenScopes: ['read'] }, { rejection: 401 });
  const res = await call(routes.get('/sw3d/ping'), 'GET', '/sw3d/ping', { headers: bearer(OTHER_TOKEN) });
  assert.equal(res.status, 401, '错误 token 必须 401');
  assert.equal(res.body.length, 0, '错误 token 的响应体必须与「完全没带凭据」一致（空）');
  return '401';
});

await checkAsync('4b. 错误 token 与「根本没带 token」的响应逐字节一致', async () => {
  const routes = mount({ extToken: TOKEN, extTokenScopes: ['read', 'write'] }, { rejection: 401 });
  const noHeader = await call(routes.get('/sw3d/ping'), 'GET', '/sw3d/ping');
  const wrongToken = await call(routes.get('/sw3d/ping'), 'GET', '/sw3d/ping', { headers: bearer(OTHER_TOKEN) });
  const wrongScheme = await call(routes.get('/sw3d/ping'), 'GET', '/sw3d/ping', { headers: { authorization: `Basic ${TOKEN}` } });
  assert.equal(wrongToken.status, noHeader.status, '状态码不能有区别');
  assert.equal(wrongToken.body.length, noHeader.body.length, '响应体长度不能有区别');
  assert.equal(wrongToken.headers['content-type'], noHeader.headers['content-type'], 'content-type 不能有区别');
  assert.equal(wrongScheme.status, noHeader.status, '非 Bearer scheme 也必须走同一条拒绝路径');
  return '401 / 空体 / 同 content-type';
});

// --------------------------------------------------------------------------- 5. token 对但 scope 不够 → 403（固定这个选择）

await checkAsync('5. token 正确但只有 read、访问 write 路由 → 403', async () => {
  const routes = mount({ extToken: TOKEN, extTokenScopes: ['read'] }, { rejection: 403 });
  // 注意：GET /sw3d/annotation 现在是 read（只列标注），不再是 403 的样本。
  // 这里用 POST /sw3d/annotation（会 upsert 写盘）+ snapshot + handoff 三条真正的 write。
  const annotationPost = await call(routes.get('/sw3d/annotation'), 'POST', '/sw3d/annotation', {
    headers: { ...bearer(TOKEN), 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'list', path: 'not-a-real-file.STEP' }),
  });
  // 本插件的选择：scope 不够时**沿用原栅栏的状态码**（requestRejection 的返回值），
  // 外部无法据此区分「token 错」与「scope 不够」——两者都只是「不是受信浏览器」。
  assert.equal(annotationPost.status, 403, `POST annotation 是 write，只给 read 应 403，实际 ${annotationPost.status}`);
  const snapshot = await call(routes.get('/sw3d/snapshot'), 'POST', '/sw3d/snapshot', { headers: bearer(TOKEN) });
  assert.equal(snapshot.status, 403, `snapshot 是 write，只给 read 时也要 403，实际 ${snapshot.status}`);
  const handoff = await call(routes.get('/sw3d/handoff'), 'POST', '/sw3d/handoff', { headers: bearer(TOKEN) });
  assert.equal(handoff.status, 403, `handoff 是 write，只给 read 时也要 403，实际 ${handoff.status}`);
  // handoff 的 GET 也会写盘（交接单缺失时现场生成），所以整条 write，GET 同样 403
  const handoffGet = await call(routes.get('/sw3d/handoff'), 'GET', '/sw3d/handoff?path=C%3A%5Cx.STEP', { headers: bearer(TOKEN) });
  assert.equal(handoffGet.status, 403, `handoff 的 GET 也会写盘，只给 read 时必须 403，实际 ${handoffGet.status}`);
  return 'POST annotation / snapshot / handoff(GET+POST) 均 403';
});

await checkAsync('5b. scope 不够时的响应与「token 错」逐字节一致（不泄漏原因）', async () => {
  const routes = mount({ extToken: TOKEN, extTokenScopes: ['read'] }, { rejection: 403 });
  const scopeDenied = await call(routes.get('/sw3d/snapshot'), 'POST', '/sw3d/snapshot', { headers: bearer(TOKEN) });
  const tokenWrong = await call(routes.get('/sw3d/snapshot'), 'POST', '/sw3d/snapshot', { headers: bearer(OTHER_TOKEN) });
  assert.equal(scopeDenied.status, tokenWrong.status, 'scope 不够与 token 错的状态码必须一致');
  assert.equal(scopeDenied.body.length, tokenWrong.body.length, '响应体长度必须一致');
  return '两者都是 403 + 空体';
});

// --------------------------------------------------- 5c. 按方法细分：annotation 的 GET/POST
//
// 这是核心场景：外部客户端默认只有 read，必须能**读**到人类批注（GET），
// 但不能**写**批注（POST）。整条路由单一 scope 的做法会让 GET 也被拦。

await checkAsync('5c. read scope 下 GET /sw3d/annotation 放行、POST 拒绝', async () => {
  const routes = mount({ extToken: TOKEN, extTokenScopes: ['read'] }, { rejection: 401 });

  // GET：只读列出标注。给一个必然不存在的路径，断言「不是 401/403」即可 ——
  // 重点是被鉴权放行、进到了 handler 的参数/路径校验，而不是它的具体业务响应。
  const get = await call(routes.get('/sw3d/annotation'), 'GET', '/sw3d/annotation?path=C%3A%5Cno-such-file.STEP', {
    headers: bearer(TOKEN),
  });
  assert.notEqual(get.status, 401, `read scope 必须能 GET annotation，实际 ${get.status}`);
  assert.notEqual(get.status, 403, `read scope 必须能 GET annotation，实际 ${get.status}`);
  assert.ok(get.status >= 400 && get.status < 500, `GET annotation 应进到 handler 的路径校验（4xx），实际 ${get.status}`);

  // POST：会 upsert 写盘 → 只有 read 时必须被拦，且状态码沿用原栅栏
  const post = await call(routes.get('/sw3d/annotation'), 'POST', '/sw3d/annotation', {
    headers: { ...bearer(TOKEN), 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'list', path: 'C:\\no-such-file.STEP' }),
  });
  assert.equal(post.status, 401, `POST annotation 是 write，只有 read 时必须 401，实际 ${post.status}`);
  assert.equal(post.body.length, 0, '被拦的响应体必须为空');

  return `GET → ${get.status}（放行到 handler），POST → 401（拦）`;
});

await checkAsync('5d. write scope 下 GET 与 POST /sw3d/annotation 都放行', async () => {
  const routes = mount({ extToken: TOKEN, extTokenScopes: ['read', 'write'] }, { rejection: 401 });
  const get = await call(routes.get('/sw3d/annotation'), 'GET', '/sw3d/annotation?path=C%3A%5Cno-such-file.STEP', {
    headers: bearer(TOKEN),
  });
  assert.notEqual(get.status, 401);
  assert.notEqual(get.status, 403);
  const post = await call(routes.get('/sw3d/annotation'), 'POST', '/sw3d/annotation', {
    headers: { ...bearer(TOKEN), 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'list', path: 'C:\\no-such-file.STEP' }),
  });
  assert.notEqual(post.status, 401, `write scope 下 POST annotation 必须放行，实际 ${post.status}`);
  assert.notEqual(post.status, 403, `write scope 下 POST annotation 必须放行，实际 ${post.status}`);
  return `GET → ${get.status}，POST → ${post.status}，均过鉴权`;
});

await checkAsync('5e. 只给 write 时 GET annotation 仍被拒（scope 是白名单，不是等级）', async () => {
  const routes = mount({ extToken: TOKEN, extTokenScopes: ['write'] }, { rejection: 401 });
  const get = await call(routes.get('/sw3d/annotation'), 'GET', '/sw3d/annotation?path=C%3A%5Cno-such-file.STEP', {
    headers: bearer(TOKEN),
  });
  assert.equal(get.status, 401, 'GET annotation 是 read；只给 write 时必须仍然被拒');
  return '401';
});

// --------------------------------------------------------------------------- 6. scopes 含 write → write 路由放行

await checkAsync('6. 配了 extToken + scopes 含 write → write 路由放行', async () => {
  const routes = mount({ extToken: TOKEN, extTokenScopes: ['read', 'write'] }, { rejection: 401 });
  const res = await call(routes.get('/sw3d/annotation'), 'POST', '/sw3d/annotation', {
    headers: { ...bearer(TOKEN), 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'list', path: 'not-a-real-file.STEP' }),
  });
  // 过了鉴权才会走到路径校验：不是 401/403 就说明 write scope 生效了
  assert.notEqual(res.status, 401, 'write scope 生效后不该再被鉴权拦');
  assert.notEqual(res.status, 403, 'write scope 生效后不该再被鉴权拦');
  assert.ok(res.status >= 400 && res.status < 500, `应进到 handler 的参数校验（4xx），实际 ${res.status}`);
  return `passed auth, handler returned ${res.status}`;
});

await checkAsync('6b. scopes 只给 write 时 read 路由被拒（scope 是白名单不是等级）', async () => {
  const routes = mount({ extToken: TOKEN, extTokenScopes: ['write'] }, { rejection: 401 });
  const res = await call(routes.get('/sw3d/ping'), 'GET', '/sw3d/ping', { headers: bearer(TOKEN) });
  assert.equal(res.status, 401, 'write 不隐含 read：read 路由必须仍然被拒');
  return '401';
});

// --------------------------------------------------------------------------- 7. 浏览器 cookie 路径行为不变

await checkAsync('7. 有 cookie 的正常浏览器路径不受新代码影响', async () => {
  // 即使显式配了 token，浏览器（栅栏通过）也必须照旧放行，不需要也不看 Authorization
  for (const config of [{}, { extToken: TOKEN, extTokenScopes: ['read'] }, undefined]) {
    const routes = mount(config, { trusted: true });
    const res = await call(routes.get('/sw3d/ping'), 'GET', '/sw3d/ping');
    assert.equal(res.status, 200, `浏览器路径必须 200（config=${JSON.stringify(config)}）`);
  }
  return 'config 为空 / 有 token / 完全不传 三种情况下浏览器都 200';
});

await checkAsync('7b. 浏览器路径下带错误 Bearer 也不影响（栅栏已通过就不看 token）', async () => {
  const routes = mount({ extToken: TOKEN, extTokenScopes: ['read'] }, { trusted: true });
  const res = await call(routes.get('/sw3d/ping'), 'GET', '/sw3d/ping', { headers: bearer(OTHER_TOKEN) });
  assert.equal(res.status, 200, '栅栏通过后 Authorization 头必须被完全忽略');
  return '200';
});

await checkAsync('7c. 浏览器访问 write 路由与 scope 配置无关', async () => {
  const routes = mount({ extToken: TOKEN, extTokenScopes: ['read'] }, { trusted: true });
  const res = await call(routes.get('/sw3d/annotation'), 'GET', '/sw3d/annotation', { headers: { 'content-type': 'application/json' } });
  // 缺 path → 400。重点是不被 scope=read 影响成 401/403
  assert.equal(res.status, 400, `浏览器 GET annotation 缺 path 应 400，实际 ${res.status}`);
  return '400';
});

await checkAsync('7d. 栅栏异常时退回 403 的旧行为仍在', async () => {
  const routes = new Map();
  host.apply(
    {
      webServer: {
        register(route) {
          routes.set(route.path, route.handler);
          return () => routes.delete(route.path);
        },
      },
      connection: {
        requestRejection: () => {
          throw new Error('boom');
        },
      },
      effect: (fn) => fn(),
    },
    { extToken: TOKEN, extTokenScopes: ['read', 'write'] },
  );
  const res = await call(routes.get('/sw3d/ping'), 'GET', '/sw3d/ping', { headers: bearer(TOKEN) });
  // requestRejection 抛错 → rejection=403。token 正确且 scope 够 → 应放行（200），
  // 证明「栅栏异常」也算栅栏失败、旁路仍然生效，而不是把异常当成放行。
  assert.equal(res.status, 200, `栅栏抛错时正确 token 仍应走旁路放行，实际 ${res.status}`);
  return '200（异常被当作栅栏失败，未当成放行）';
});

// --------------------------------------------------------------------------- 8. 长度不同的 token（timingSafeEqual 长度陷阱）

await checkAsync('8. 长度不同的 token → 401 且不抛异常', async () => {
  const routes = mount({ extToken: TOKEN, extTokenScopes: ['read'] }, { rejection: 401 });
  const candidates = ['', 'x', 'short', TOKEN.slice(0, -1), `${TOKEN}extra`, 'A'.repeat(200), '😀'.repeat(30)];
  for (const candidate of candidates) {
    const res = await call(routes.get('/sw3d/ping'), 'GET', '/sw3d/ping', {
      headers: { authorization: `Bearer ${candidate}` },
    });
    assert.equal(res.status, 401, `长度/内容不匹配的 token 必须 401（candidate.length=${candidate.length}）`);
    assert.equal(res.body.length, 0);
  }
  // 空 Bearer（"Bearer " 后面什么都没有）不应崩，也不应命中
  const bare = await call(routes.get('/sw3d/ping'), 'GET', '/sw3d/ping', { headers: { authorization: 'Bearer ' } });
  assert.equal(bare.status, 401);
  const noScheme = await call(routes.get('/sw3d/ping'), 'GET', '/sw3d/ping', { headers: { authorization: TOKEN } });
  assert.equal(noScheme.status, 401, '没有 Bearer 前缀的 Authorization 头不能被当成 token');
  return `${candidates.length + 2} 个畸形 token 全部 401，无异常`;
});

await checkAsync('8b. tokensEqual 对任意长度都不抛异常，且只有完全相同才 true', () => {
  const cases = [
    ['abc', 'abc', true],
    ['abc', 'abcd', false],
    ['', 'abc', false],
    ['abc', '', false],
    ['A'.repeat(10000), 'A'.repeat(10000), true],
    ['A'.repeat(10000), 'A'.repeat(9999), false],
    ['😀😀', '😀😀', true],
    ['😀😀', '😀', false],
  ];
  for (const [a, b, expected] of cases) {
    let actual;
    assert.doesNotThrow(() => {
      actual = extToken.tokensEqual(a, b);
    }, `tokensEqual 不能抛异常（左 ${a.length} / 右 ${b.length}）`);
    assert.equal(actual, expected, `tokensEqual(${JSON.stringify(a.slice(0, 8))}…, ${JSON.stringify(b.slice(0, 8))}…) 应为 ${expected}`);
  }
  // 非字符串输入一律 false，不抛
  for (const value of [null, undefined, 123, {}, []]) {
    assert.doesNotThrow(() => extToken.tokensEqual(value, 'abc'));
    assert.equal(extToken.tokensEqual(value, 'abc'), false);
  }
  return `${cases.length + 5} 组输入全部符合预期`;
});

await checkAsync('8c. readBearerToken 只认 Bearer，大小写不敏感，拒绝歧义头', () => {
  const mk = (headers) => ({ headers });
  assert.equal(extToken.readBearerToken(mk({ authorization: 'Bearer abc' })), 'abc');
  assert.equal(extToken.readBearerToken(mk({ authorization: 'bearer abc' })), 'abc');
  assert.equal(extToken.readBearerToken(mk({ authorization: '  Bearer   abc  ' })), 'abc');
  assert.equal(extToken.readBearerToken(mk({ authorization: 'Basic abc' })), null);
  assert.equal(extToken.readBearerToken(mk({ authorization: 'Bearer' })), null);
  assert.equal(extToken.readBearerToken(mk({})), null);
  assert.equal(extToken.readBearerToken(mk({ authorization: ['Bearer a', 'Bearer b'] })), null, '重复头要当作没有');

  // 逗号拒绝必须用「无空格、能被 \S+ 整个吃下去」的形态来锁。
  //
  // 曾经这里写的是 'Bearer a,Bearer b' —— 那条**测不出** `raw.includes(',')` 那行有没有：
  // 去掉逗号检查后，正则 /^\s*bearer\s+(\S+)\s*$/i 因为 \S+ 不匹配中间的**空格**而同样返回 null，
  // 于是用例照样绿。变异验证（删掉 lib/ext-token.js 的逗号判断）当时 27 项全绿，就是这个原因。
  //
  // 下面的形态没有空格：`Bearer xxx,junk` 去掉逗号检查后 \S+ 会把 'xxx,junk' 整个吃掉并返回它，
  // 从而真正暴露「逗号没被拒绝」。
  assert.equal(
    extToken.readBearerToken(mk({ authorization: `Bearer ${'a'.repeat(16)},junk` })),
    null,
    '逗号拼接的歧义头必须返回 null；能返回字符串说明逗号检查失效了',
  );
  assert.equal(
    extToken.readBearerToken(mk({ authorization: 'Bearer validtoken123,second' })),
    null,
    '逗号后面没有空格时也必须被拒（这正是 \S+ 会误吃的形态）',
  );
  assert.equal(extToken.readBearerToken(null), null);
  return '11 种头部形态（含 2 种真实锁死逗号拒绝的形态）';
});

// --------------------------------------------------------------------------- 9. 极短 token → 视为未配置

await checkAsync('9. 极短 token（abc）→ 按配置错误处理，外部访问关闭', async () => {
  const resolved = extToken.resolveExternalAuth({ extToken: 'abc' });
  assert.equal(resolved.enabled, false, '短于下限的 token 必须 fail-closed');
  assert.equal(resolved.token, '');
  assert.ok(resolved.problems.length > 0, '要留下可诊断的原因');
  assert.ok(
    resolved.problems.some((p) => p.includes(String(extToken.MIN_TOKEN_LENGTH))),
    `问题描述里应提到下限 ${extToken.MIN_TOKEN_LENGTH}`,
  );

  const routes = mount({ extToken: 'abc', extTokenScopes: ['read', 'write'] }, { rejection: 401 });
  const res = await call(routes.get('/sw3d/ping'), 'GET', '/sw3d/ping', { headers: bearer('abc') });
  assert.equal(res.status, 401, '短 token 即使原样带上来也不能放行');

  // 恰好等于下限的 token 是合法的
  const atLimit = 'a'.repeat(extToken.MIN_TOKEN_LENGTH);
  assert.equal(extToken.resolveExternalAuth({ extToken: atLimit }).enabled, true, '正好等于下限应视为有效');
  const okRoutes = mount({ extToken: atLimit, extTokenScopes: ['read'] }, { rejection: 401 });
  const ok = await call(okRoutes.get('/sw3d/ping'), 'GET', '/sw3d/ping', { headers: bearer(atLimit) });
  assert.equal(ok.status, 200, '正好等于下限的 token 应放行');
  return `abc → 关闭；${extToken.MIN_TOKEN_LENGTH} 字符 → 有效`;
});

await checkAsync('9b-2. 含逗号/空白的 token 会留下可诊断的 problem（配置成功但带不上来）', () => {
  // readBearerToken 拒绝含逗号的 Authorization 头（防重复头合并歧义），
  // 而 token 内部的空白会让正则只吃下前半截 —— 两种 token 都能「配置成功」却永远用不了。
  // 这里只要求**留下一条 problem**，不改变 enabled（安全逻辑保持原样）。
  const cases = [
    ['逗号', 'token,with,commas-0123456789'],
    ['内部空格', 'token with spaces 0123456789'],
    ['制表符', 'token\twith\ttabs-0123456789'],
  ];
  for (const [label, value] of cases) {
    const resolved = extToken.resolveExternalAuth({ extToken: value });
    assert.ok(
      resolved.problems.some((p) => p.includes('逗号') && p.includes('空白')),
      `${label} token 应留下「含逗号或空白」的 problem，实际：${JSON.stringify(resolved.problems)}`,
    );
  }
  // 合法 token 不该有这类误报
  const clean = extToken.resolveExternalAuth({ extToken: TOKEN });
  assert.equal(
    clean.problems.some((p) => p.includes('逗号') && p.includes('空白')),
    false,
    `合法 token 不该被误报：${JSON.stringify(clean.problems)}`,
  );
  // hex/base64 这类常见生成方式都不带逗号与空格，确认它们不触发
  for (const good of ['a'.repeat(64), 'ABCdef0123456789+/=', '0123456789abcdef'.repeat(2)]) {
    const resolved = extToken.resolveExternalAuth({ extToken: good });
    assert.equal(
      resolved.problems.some((p) => p.includes('逗号') && p.includes('空白')),
      false,
      `常见 token 形态不该被误报：${good.slice(0, 12)}…`,
    );
  }
  return '3 种脏 token 有 problem，4 种干净 token 无误报';
});

await checkAsync('9b. 非字符串 / 缺失的 extToken 都按未配置处理', () => {
  for (const value of [null, undefined, 123, {}, [], true]) {
    const resolved = extToken.resolveExternalAuth({ extToken: value });
    assert.equal(resolved.enabled, false, `extToken=${JSON.stringify(value)} 必须关闭外部访问`);
  }
  assert.equal(extToken.resolveExternalAuth(undefined).enabled, false);
  assert.equal(extToken.resolveExternalAuth(null).enabled, false);
  assert.equal(extToken.resolveExternalAuth('a string config').enabled, false, 'config 本身不是对象时也要关闭');
  return '8 种非法 extToken 全部关闭';
});

await checkAsync('9c. 配了 token 但没配 scopes → 默认只给 read', () => {
  const resolved = extToken.resolveExternalAuth({ extToken: TOKEN });
  assert.equal(resolved.enabled, true);
  assert.deepEqual(resolved.scopes, ['read'], '没配 scopes 时必须默认 read');
  const empty = extToken.resolveExternalAuth({ extToken: TOKEN, extTokenScopes: [] });
  assert.deepEqual(empty.scopes, ['read'], '空数组也要落回默认 read');
  const bogus = extToken.resolveExternalAuth({ extToken: TOKEN, extTokenScopes: ['admin', 'root'] });
  assert.deepEqual(bogus.scopes, ['read'], '全是未知 scope 时要落回默认 read，不能变成空集合或全开');
  assert.ok(bogus.problems.length > 0, '未知 scope 要留下可诊断的原因');
  return '默认 read，未知值落回 read';
});

await checkAsync('9d. scopes 归一化：去重、大小写、未知值忽略、保留合法值', () => {
  assert.deepEqual(extToken.resolveExternalAuth({ extToken: TOKEN, extTokenScopes: ['READ'] }).scopes, ['read']);
  assert.deepEqual(extToken.resolveExternalAuth({ extToken: TOKEN, extTokenScopes: ['read', 'read', 'write'] }).scopes, ['read', 'write']);
  assert.deepEqual(extToken.resolveExternalAuth({ extToken: TOKEN, extTokenScopes: ['read', 'admin'] }).scopes, ['read']);
  assert.deepEqual(extToken.resolveExternalAuth({ extToken: TOKEN, extTokenScopes: 'write' }).scopes, ['write'], '单个字符串也要能用');
  return '4 种归一化场景';
});

// --------------------------------------------------------------------------- 10. 不泄漏 token
//
// 10b 的来历（别把它改回「只测 200」）：
// 早先 allowTrusted 的放行分支里有一句 res.setHeader('cache-control','no-store')，
// 注释把它说成 no-store 的保障。实际那三行是**死代码** —— 放行后 handler 必然走
// sendJson/sendText，它们的 writeHead 会覆盖 setHeader。变异验证（删掉那三行）27 项全绿，
// 因为 10b 只断言了 200 响应的头，而那个头本来就由 sendJson 提供。
// 所以这里改成三条路径逐条断言：无论放行还是拒绝，no-store 都必须出现，
// 且**不依赖** allowTrusted 里任何补写。
await checkAsync('10b. 放行与拒绝的响应都带 Cache-Control: no-store', async () => {
  // scope 不够时沿用栅栏状态码：这里栅栏给 403，所以「scope 不够」那条期望 403。
  // 放行/token 错是同一套路由对象，栅栏返回值对它们都一样是 403 起点 —— 但放行成功不回写头，
  // token 错会回 403。为避免语义混乱，两条拒绝路径各用一份独立 mount。
  const routes403 = mount({ extToken: TOKEN, extTokenScopes: ['read'] }, { rejection: 403 });
  const routes401 = mount({ extToken: TOKEN, extTokenScopes: ['read'] }, { rejection: 401 });
  const cases = [
    ['放行 200', await call(routes401.get('/sw3d/ping'), 'GET', '/sw3d/ping', { headers: bearer(TOKEN) }), 200],
    ['token 错 401', await call(routes401.get('/sw3d/ping'), 'GET', '/sw3d/ping', { headers: bearer(OTHER_TOKEN) }), 401],
    [
      'scope 不够 403',
      await call(routes403.get('/sw3d/snapshot'), 'POST', '/sw3d/snapshot', { headers: bearer(TOKEN) }),
      403,
    ],
    ['方法不允许 405', await call(routes401.get('/sw3d/mesh'), 'POST', '/sw3d/mesh', { headers: bearer(TOKEN) }), 405],
  ];
  for (const [label, res, expectedStatus] of cases) {
    assert.equal(res.status, expectedStatus, `${label} 状态码应为 ${expectedStatus}，实际 ${res.status}`);
    assert.equal(res.headers['cache-control'], 'no-store', `${label} 必须带 Cache-Control: no-store`);
  }
  return '200 / 401 / 403 / 405 四条路径都是 no-store';
});

await checkAsync('10. 日志与响应体里绝不出现 token 明文', async () => {
  const captured = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    captured.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    return true;
  };
  let responses;
  try {
    const routes = mount({ extToken: TOKEN, extTokenScopes: ['read'] }, { rejection: 401 });
    responses = [
      await call(routes.get('/sw3d/ping'), 'GET', '/sw3d/ping', { headers: bearer(TOKEN) }),
      await call(routes.get('/sw3d/ping'), 'GET', '/sw3d/ping', { headers: bearer(OTHER_TOKEN) }),
      // 用 POST annotation（write）触发 denied 分支，日志里应出现 scope=write
      await call(routes.get('/sw3d/annotation'), 'POST', '/sw3d/annotation', {
        headers: { ...bearer(TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'list', path: 'C:\\no-such-file.STEP' }),
      }),
    ];
    // 配置类日志（logWarn）也必须走统一前缀，且不能回显 token。
    // 注意：这里的 token 必须**真的**触发问题分支 —— 早先写的是 'abc-short-token-x'，
    // 它其实有 17 个字符、超过 16 的下限，压根不产生 warning，于是这段日志断言是空转的
    // （变异验证把 logWarn 改回裸中文前缀时 31 项全绿，才暴露出来）。
    mount({ extToken: 'short7', extTokenScopes: ['read'] }, { rejection: 401 }); // 6 字符 → 短 token warning
    mount({ extToken: 'has,comma-and-space token', extTokenScopes: ['read'] }, { rejection: 401 }); // P3：脏字符 warning
  } finally {
    process.stderr.write = original;
  }
  const logs = captured.join('');
  assert.ok(logs.length > 0, '应该产生了日志（否则这条断言没意义）');
  assert.ok(!logs.includes(TOKEN), '配置 token 明文不能出现在任何日志里');
  assert.ok(!logs.includes(OTHER_TOKEN), '错误 token 明文不能出现在任何日志里');
  assert.ok(!logs.includes('short7'), '被拒的短 token 明文也不能出现在日志里');
  assert.ok(!logs.includes('has,comma-and-space token'), '含脏字符的 token 明文也不能出现在日志里');
  assert.ok(logs.includes('external client authorized'), `命中时应有 authorized 日志，实际日志：${logs.slice(0, 400)}`);
  assert.ok(logs.includes('external client rejected'), 'token 错时应有 rejected 日志');
  assert.ok(logs.includes('scope=write'), 'scope 不够时应说明需要哪个 scope');
  // 确认配置告警确实产生了（否则上面的前缀检查覆盖不到 warn 路径）
  assert.ok(logs.includes('[sw-3d-preview] warn:'), `配置问题应以 warn 级别记录，实际日志：${logs.slice(0, 600)}`);
  assert.ok(logs.includes('短于下限'), '短 token 应留下可读原因');

  // 日志前缀必须统一成 `[sw-3d-preview] <level>: <message>`。
  // 曾经这里并存三种风格（`sw3d: …`、裸中文 `配置提醒：`、带堆栈的 error），
  // 混在一起时无法按前缀统一过滤；这条断言把格式钉住。
  const prefixViolations = [];
  for (const raw of captured) {
    for (const line of String(raw).split(/\r?\n/)) {
      if (!line.startsWith('[sw-3d-preview] ')) {
        prefixViolations.push(line);
        continue;
      }
      const rest = line.slice('[sw-3d-preview] '.length);
      if (!/^(error|warn|info|auth): /.test(rest)) prefixViolations.push(line);
    }
  }
  assert.deepEqual(
    prefixViolations.filter((line) => line.trim() !== '').slice(0, 3),
    [],
    `日志前缀不统一，应全部是「[sw-3d-preview] <error|warn|info|auth>: …」：${prefixViolations.slice(0, 3).join(' | ')}`,
  );
  for (const res of responses) {
    const text = res.body.toString('utf8');
    assert.ok(!text.includes(TOKEN), '响应体里不能出现 token');
    assert.ok(!text.includes(OTHER_TOKEN), '响应体里不能出现错误 token');
  }
  return `捕获 ${captured.length} 条日志，0 处 token 泄漏`;
});

// --------------------------------------------------------------------------- 汇总

console.log('');
if (failures.length > 0) {
  console.error(`✘ ${failures.length} 条失败 / 共 ${passed + failures.length} 条`);
  for (const failure of failures) {
    console.error(`  - ${failure.name}\n    ${failure.error && failure.error.stack ? failure.error.stack.split('\n').slice(0, 4).join('\n    ') : failure.error}`);
  }
  process.exitCode = 1;
} else {
  console.log(`✔ 全部通过：${passed}/${passed}`);
}
