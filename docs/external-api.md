# dsh-sw-3d-preview 外部接入规格（Host HTTP API）

写给**外部 agent / 脚本**（Codex、PowerShell、Node）看：这个插件对外暴露了什么、返回什么字节、
调一次有什么副作用、以及怎么才能调通。

- 版本基线 `package.json` 的 `0.2.2`。
- **行号基线**：本文代码出处一律写**符号名为主、行号为辅**（`allowTrusted()` @ `index.js:491`）——
  符号名不会漂，行号会。行号对应 `index.js` = SHA256 前 8 位 **`98D1DC89`** / **1,243 行** / 49,775 B。
  **`index.js` 一旦变动，行号即失效**：重跑 `node scripts/check-refs.mjs --strict` 重算，
  别凭记忆手改数字（这毛病已经犯过两次：`DBF49AD6` 那版全量失效过一次，现在又失效过一次）。
- **裸写 `@NNN` 的行号，除另有说明外均指 `index.js`**（例如 `handlePing()` @549）。
  这类写法**同样受 `node scripts/check-refs.mjs` 校验**：脚本按「显式写明文件名 > 同行最近文件名 >
  本段落文件名 > 默认 `index.js`」四级降级确定归属，规矩见脚本里 `scanRefs()` 的注释。
  想避开歧义就直接写成 `handlePing()` @ `index.js:549` 这种带文件名的形式。
- 本文**不涉及** SOLIDWORKS：插件侧全程不启动、不连接 SOLIDWORKS。

---

## 0. 先明确边界（否则一定会误用）

这个插件**不是建模接口**，**不负责画图**：

| 它做什么 | 它不做什么 |
| --- | --- |
| 把**磁盘上已有**的 `.step/.stp/.stl/.obj`（以及带同名 STEP 的 `.sldprt/.sldasm`）三角化成 S3DM 网格 | 不创建/修改/导出模型，不改任何被预览的原始文件 |
| 把 sw-mcp 已记录下来的**草图轮廓**读出来摊平（只读） | 不驱动 SOLIDWORKS，不执行 `deliver` |
| 把**用户标注**（面/边/点/草图 + 三点取样 + 截图路径）落盘、回传给 agent | 不是「发给模型去建模」的指令通道，它只存事实 |
| 把标注汇总成一份 Markdown 交接单 | 不做几何推理、不做跨文件比对 |

**画图是客户端（浏览器侧 `client.js`）和 sw-mcp 的事**，本插件 Host 半边只吐数据——要「生成一张图」
这里没有这样的路由。建模由 sw-mcp 负责，本插件只在它的 project 记录里**只读**取草图与 designId
（`lib/paths.js:34-36`、`lib/sketches.js:714-758`）。一句话定位：**读图 + 标注回传**接口。

---

## 1. 路由清点

8 条路由全部以 `kind:'exact'` 注册在 DSH 自己的 Web 端口上（`apply()` 内的 8 个 `register(ROUTES.*)`，
`index.js:1235-1242`；路径表 `ROUTES` 在 `index.js:89-98`）。**没有 CORS 头**，所有响应带
`cache-control: no-store`。每条路由第一件事是信任栅栏 `allowTrusted(req,res,route)`
（`index.js:491`），第二件是方法校验 `allowMethods()`（`index.js:524`，405 带 `Allow` 头）。

| 方法 | 路径 | query / body | 成功返回 | Content-Type | 副作用 | scope | 依据（符号名 @ 行） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET/HEAD | `/sw3d/ping` | 无 | JSON `{ok,name,version,python{path,ok,ocp,version},cacheDir,three}` | `application/json` | 只读；但会触发 python 探测（成功缓存 5 分钟） | `read` | `handlePing()` @ `index.js:549` |
| GET/HEAD | `/sw3d/resolve` | `path`(必填)、`base`、`refresh`、`precision`、`deflection`、`maxTriangles`、`angularDeflection`、`creaseAngle` | JSON，见 §1.1 | `application/json` | **写** `%LOCALAPPDATA%\sw-3d-preview\recent.json`、创建 cache 目录 | `read` | `handleResolve()` @ `index.js:568` |
| GET/HEAD | `/sw3d/mesh` | 同 resolve | **二进制 S3DM**（`application/octet-stream`）；`sketch-only` 时是 **JSON** | 见 §2、§1.2 | **可能触发 STEP 三角化**（python 子进程，≤120 s）、写 `.s3dm` 缓存 | `read` | `handleMesh()` @ `index.js:740` |
| GET/HEAD | `/sw3d/three.js` | 无 | `vendor/three.cjs` 原样字节 | `text/javascript` | 只读 | `read` | `handleThree()` @ `index.js:860` |
| GET | `/sw3d/annotation` | `path`(必填) | JSON `{ok:true, items:[…]}` | `application/json` | 只读 | `read` | `handleAnnotation()` @ `index.js:928` |
| POST | `/sw3d/annotation` | body `{op:"list"\|"upsert", path, annotation?}` | JSON `{ok:true,items}` 或 `{ok:true,id,count}` | `application/json` | `upsert` **追加写** `annotations.jsonl` | `write` | 同上 |
| GET | `/sw3d/handoff` | `path`(必填) | **Markdown 文本** | `text/markdown` | 交接单不存在时**顺手生成并写盘**（GET 并非纯只读） | `write` | `handleHandoff()` @ `index.js:1012` |
| POST | `/sw3d/handoff` | body `{path}` | JSON `{ok,mdPath,count,bytes,designId,generatedAt}` | `application/json` | **写** `handoff\<sha1>.md` | `write` | 同上 |
| POST | `/sw3d/snapshot` | body `{path(绝对), base64, mediaType?}` | JSON `{ok,shotPath,bytes,mediaType}` | `application/json` | **写** PNG/JPEG 到 `shots\` 目录 | `write` | `handleSnapshot()` @ `index.js:1097` |
| GET/HEAD | `/sw3d/sketches` | `path`(必填) | JSON，见 §1.3 | `application/json` | 只读（读 sw-mcp project json） | `read` | `handleSketches()` @ `index.js:1177` |

`scope` 一列是 **Bearer 旁路**（§3.2）用的归类，来自 `ROUTE_SCOPES`（`index.js:121-135`）；
未归类的路由、以及已归类路由上未列出的方法，都按 `FALLBACK_SCOPE = 'write'` 处理（`index.js:138`）——宁可拒绝不漏放。

要点：

- `HEAD` 只在 `ping/resolve/mesh/three.js/sketches` 允许；`annotation`/`handoff` 只允许 `GET`+`POST`
  （对它们发 `HEAD` 得 **405**），`snapshot` 只允许 `POST`。三处的 `allowMethods` 调用分别在各 handler 顶部。
- 栅栏在方法校验**之前**，所以未认证时 `POST /sw3d/mesh` 得 **401 而不是 405**。
- `/sw3d/snapshot` 的 `path` 必须是**绝对路径**且扩展名在允许集内（`index.js:1121`、`index.js:1125`）；
  图片按**魔数**判定 PNG/JPEG，`mediaType` 与扩展名都不作数（`sniffImageType` @ `index.js:357`、调用点 `index.js:1150`）。
- 请求体上限：annotation `MAX_ANNOTATION_BODY = 256 KB`（`index.js:83`）；
  snapshot `MAX_SNAPSHOT_TEXT_BODY = 12 MB` / `MAX_SNAPSHOT_BYTES = 8 MB`（`index.js:86-87`、`index.js:1089`）。

### 1.1 `/sw3d/resolve` 成功响应

`handleResolve()` 里那个 `sendJson(req, res, 200, {…})`（`index.js:599`），字段：
`ok,path,format,meshSource,sibling,bytes,mtimeMs,designId,completed,fallback,sketch,deliver,
precision{tier,deflectionMm,angularDeflectionRad,creaseAngleDeg,maxTriangles},
cached{hit,key,path,bytes,mtimeMs},hints[]`。`meshSource` ∈ `step`/`stl`/`obj`/`sibling-step`/
`fallback-step`/`sketch-only`（`lib/resolve.js:305-306`、`:356-367`、`:381-393`、`:430-443`、`:491-512`）。
**`resolve` 失败也回 HTTP 200**（body `{ok:false,code,message,hint,…}`，`handleResolve` 里
`if (!resolved.ok) { sendJson(req, res, 200, resolved); return; }`），而 `mesh` 对同类失败回 **422**
（`handleMesh` 里 `sendJson(req, res, 422, resolved)`）——状态码不一致，按 `ok` 分流。
`precision` 档位见 `lib/resolve.js:589-593`：`high=0.04/900000`、`mid=0.08/300000`、`low=0.2/120000`。

### 1.2 `/sw3d/mesh` 的 `sketch-only` 分支（**返回 JSON，不是二进制**）

原生的 `.sldprt/.sldasm` 既没有 STEP、也没有可用草图时走 422；但当 sw-mcp 里有该设计的草图时，
`if (resolved.meshSource === 'sketch-only')` 分支返回 **HTTP 200 + `application/json`**
（`index.js:768` 起的分支，`sendJson` 在 `index.js:771`），body 形如
`{ok:true,mode:"sketch-only",meshSource:"sketch-only",path,format,designId,sketchUrl,deliver,sketch,hint,hints[]}`。
**坑**：只看状态码判断成功就会踩到——必须按 `content-type` 分流 `octet-stream` 与 `json`。

### 1.3 `/sw3d/sketches` 响应

`lib/sketches.js:606-677`。成功 `{ok:true,designId,designTitle,unit,schemaVersion,featureCount,sketches[],
warnings[],projectFile}`，每个 sketch 含 `{id,name,feature,plane,planeIndex,unit,polylines[{points:[[x,y,z]…],
closed,kind}],constructionSkipped,constructionPolylines,dimensions,bbox,stats}`。失败 `{ok:false,code,message,hint}`，
`code` ∈ `BAD_REQUEST`/`BAD_PATH`/`NO_DESIGN`/`PROJECT_UNREADABLE`/`NO_SKETCH_DATA`
（`lib/sketches.js:717`、`:721-726`、`:735-739`、`:749-753`、`:617-621`、`:653-658`）——**照样回 200**。

---

## 2. S3DM v2 二进制格式

写端两处**必须逐字节一致**：JS `writeS3dm`（`lib/mesh.js:511-546`）与 Python `write_s3dm`
（`lib/step_mesh.py:135-178`）；读端 `lib/mesh.js:550-559`、浏览器 `client.js:587-625`。

### 2.1 文件布局（小端）

| 偏移 | 内容 | 依据 |
| --- | --- | --- |
| 0..3 | ASCII 魔数 `S3DM`（4 字节） | `lib/mesh.js:21`、`:546`；`lib/step_mesh.py:167` |
| 4..7 | `u32` headerJsonLength | `lib/mesh.js:542`、`:547`；`lib/step_mesh.py:168` |
| 8 .. 8+len | header JSON（UTF-8，尾部可补空格） | `lib/mesh.js:543`、`:548` |
| 8+len .. EOF | 各 buffer 依次拼接，起点相对数据区 4 字节对齐 | `lib/mesh.js:8`、`:521-526` |

**两条对齐规则都要满足**：① header JSON 尾部补**空格 `0x20`** 使 `8 + len` 为 4 的倍数
（`pad = (4 - ((8 + len) % 4)) % 4`，`lib/mesh.js:542-543`；`lib/step_mesh.py:162-164`，JSON 尾部空白合法）；
② 每个 buffer 的 `offset` **相对数据区起点**（不是文件起点），前一 buffer 结束后也补齐
`cursor += byteLength; cursor += (4 - cursor % 4) % 4`（`lib/mesh.js:521-526`）。
浏览器有兜底 `resolveBufferStart`（相对+4 对齐 → 相对未对齐 → 绝对偏移，`client.js:431-448`），
**写端不要依赖它**。写入侧支持 `f32/u32/u16/u8/i32/f64`（`lib/mesh.js:37-44`），但浏览器
`parseS3DM` **只认 `f32`/`u32`**，其它静默跳过（`client.js:617-618`）。

### 2.2 header JSON 字段

`buffers[]` 由写端重算，元素固定 `{name,type,components,count,offset}`（`lib/mesh.js:530-536`、
`lib/step_mesh.py:146-152`）；`count` 是**元素个数**（总分量 / components），不是字节数。
其余字段随来源不同而不同，**不要假定都齐**：

- **STEP**（`step_mesh.py:834-867`）：`version,units("mm"),format("step"),source{path,bytes,mtimeMs},
  bbox[6],vertexCount,triangleCount,faceCount,edgeCount,faceEdgeCount,faces[],edges[],warnings[],
  deflectionMm,angularDeflectionRad,maxTriangles,creaseAngleDeg,welded{verticesBefore,verticesAfter,ratio},
  precision{deflectionMm,maxTriangles},generatedAt,retried`
- **STL/OBJ**（`meshFromParsed()`，`index.js:399-434`）：同上但 `edgeCount`/`faceEdgeCount` 恒 0、
  `edges` 恒空，无 `welded`/`retried`/顶层 `deflectionMm`；面按平面法向归并（见其 `warnings` @ `index.js:420-422`）。

`faces[]`（STEP `step_mesh.py:295-302`；STL/OBJ `lib/mesh.js:660-675`，`kind` 恒 `plane`）：
`{index,kind,areaMm2,normal[3],point[3],radiusMm|null}`。`edges[]` **仅 STEP 有**（`step_mesh.py:762-773`）：
`{index,isCircle,radiusMm,lengthMm,start[3],end[3],mid[3],faces[≤2],polylineStart,polylineCount}`。

### 2.3 buffer 清单

三处写端各有一份 buffer 清单，`name`/`type`/`components` 必须一致：

- JS 侧默认分量数 `DEFAULT_COMPONENTS` @ `lib/mesh.js:27-35`
- Python 侧 `build_mesh()` 里的 `buffers = [` @ `lib/step_mesh.py:868-900`
- 非 STEP（STL/OBJ）走 `meshFromParsed()` 里的 `buffers` 对象 @ `index.js:424-432`

| name | type | components | 含义 |
| --- | --- | --- | --- |
| `position` | f32 | 3 | 顶点坐标，mm |
| `normal` | f32 | 3 | 顶点法向 |
| `index` | u32 | 3 | 三角形顶点下标（每 3 个一三角形） |
| `faceOfTriangle` | u32 | 1 | 三角形 → 面号 |
| `edgePosition` | f32 | 3 | 边折线点（STL/OBJ 为空） |
| `edgeSegment` | u32 | 2 | 边折线线段（下标对） |
| `faceEdge` | u32 | 2 | 面↔边对（v2 可选；缺失时从 `edges[].faces` 反推） |

`version` 当前 **2**，`S3DM_VERSION_MIN = 1`，v1 数据仍可读（`lib/mesh.js:22-24`、`step_mesh.py:52`）。

`/sw3d/mesh` 还带一批比解析二进制更快的响应头（`handleMesh` 里 `res.writeHead(200, {…})`，`index.js:842`；
`x-sw3d-source` 在 `index.js:846`）：`x-sw3d-source`（meshSource）、`x-sw3d-cache`（`hit`/`miss`）、
`x-sw3d-version`、`x-sw3d-precision`（`<deflection>/<maxTriangles>`）、
`x-sw3d-tessellation`（`<deflection>mm/<angular>rad/<crease>deg`）、`x-sw3d-bbox`（6 个逗号分隔数）。

---

## 3. 鉴权：浏览器 cookie 栅栏 + 外部 Bearer 旁路

### 3.1 为什么外部进程原本调不通 —— 四条，逐条给依据

1. **每条路由都先过 DSH 的信任栅栏。** `allowTrusted()` @ `index.js:491` 调
   `ctx.connection.requestRejection(req)`；`rejection === undefined` 时直接放行（`index.js:499`）。
   栅栏内部先查 Host/Origin（不通过 → **403**），再查认证（不通过 → **401**）。
   实测（`http://127.0.0.1:58716`，2026-11-16）：8 条路由未带任何凭据全 `401`；
   `Host: evil.example:58716` → `403`；`Sec-Fetch-Site: cross-site` → `403`；
   `Origin: http://evil.example` → `403`；`404` 只在路径不存在时出现（如 `/sw3d/nope`）。
2. **栅栏只认 cookie，不读 `Authorization`。** DSH 的 `admit()` 依次试 `isAuthenticated`
   （v1 浏览器会话 cookie）与 `authenticateApi`（v2 API 操作员 cookie），都不成立即 `401`。
   cookie 名 `dsh-auth-<sha256(authority) base64url>`，属性 `HttpOnly; SameSite=Strict; Path=/`、
   HMAC-SHA256 签名，密钥在 `$DSH_HOME/.credentials.yaml` 的 `client-connection/browser-session`
   记录（`cookieMaxAgeDays` 默认 30 天）。外部进程拿不到、也不该伪造它 —— 这正是需要旁路的原因。
3. **launch token 不落盘，只活在进程内存里。** `processLaunchToken` 把 32 字节随机值存在 `WeakMap`，
   只出现在 `dsh web` 打印那条 URL 的 `?token=` 上，用于在 `/` 换 v1 cookie、在
   `/connect?token=…&interactions=…` 换 v2 cookie。实测乱填 token → `401`。
   **cookie 还绑定 authority（host:port）**，端口每次启动可能变 —— 重启后旧 cookie 不再被发送。
4. **所以旁路必须显式开启。** 默认 `extToken` 为空 ⇒ `enabled === false`，不存在任何新放行，
   行为与本插件加入旁路之前逐字节一致（`lib/ext-token.js:11`、`:147`；`index.js:1210` 的 `apply`
   里用 `resolveExternalAuth(config)` 算好后传给 `createHandlers`）。

### 3.2 Bearer 旁路（**已合入**，`index.js` / `lib/ext-token.js`）

**生效位置**：先走原栅栏；`rejection === undefined` 就立刻返回 `true`，旁路完全不参与
（`index.js:499`）。**只有栅栏失败后**才尝试 Bearer（`index.js:501-503`）；
两边都不放行时仍写回原状态码与空 body（`index.js:518-521`），失败原因不对外体现。

**配置**（`cordis.patch.yml:4-19`，全部可选；整段删掉 = 外部访问关闭）：

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `extToken` | string | `''`（关闭） | `Authorization: Bearer <token>` 的期望值。**≥16 字符**，否则按配置错误当作空（`lib/ext-token.js:21`、`:137-142`） |
| `extTokenScopes` | string[] | `['read']` | 允许的 scope。已知值只有 `read`/`write`；未知值丢弃；全丢光则回落 `read`（`lib/ext-token.js:24-27`、`:80-115`）。单个字符串也接受（`:85-87`） |

- `read` = `ping`/`resolve`/`mesh`/`three.js`/`sketches`，以及 **`GET /sw3d/annotation`**；
  `write` = `POST /sw3d/annotation`、`handoff`（整条，含 GET）、`snapshot`（`index.js:121-135`）。
  未归类路由、以及已归类路由上**未列出的方法**，都按 `FALLBACK_SCOPE='write'`（`index.js:138`）。
- **scope 是按「路由 + 方法」细分的，不是整条路由一刀切。** `annotation` 在 `ROUTE_SCOPES` 里是
  `Object.freeze({ GET: 'read', POST: 'write' })`（`index.js:129`）——GET 只是列出标注（纯读），
  POST 的 `op:'upsert'` 会追加写 `annotations.jsonl`。所以默认配置 `extTokenScopes:['read']` 的
  外部 token **可以**读人类批注（这正是这条旁路的核心场景），但不能 upsert。
  注意 `annotation` 上**不带方法**地取 scope 会落到最严的 `write`（方法缺省按 `FALLBACK_SCOPE`）。
- 反例（**别照旧文档改**）：`handoff` 整条是 `write`，**包括 GET**——GET 在交接单不存在时会现场
  生成并写盘（`handleHandoff`），所以它不是只读路由。
- 生成 token：`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`。
  **只填本机 profile 的 patch 层，不要提交进 git**（`cordis.patch.yml:13`）。

**判定细节**（三条都会影响你怎么调）：

1. 只认 `Authorization: Bearer <token>`；scheme 大小写不敏感、前后空白容忍
   （`lib/ext-token.js:65-72`）。**重复的 `Authorization` 头（数组或含逗号）一律当作没带 token**。
2. 比较是定长恒时的：两侧先各 sha256 成 32 字节再 `timingSafeEqual`，长度不同也走满一次比较
   （`lib/ext-token.js:31-53`）。空串永不相等。
3. **失败不可区分**：token 错、scope 不够、压根没带 token，对外统一回原来那个 `401`/`403`，
   响应体与加旁路之前一致；区别只写进 DSH 日志（`index.js:518-521`、`lib/ext-token.js:14-15`）。
   所以排查「为什么还是 401」只能看日志，不能看响应。

**实测（本次，`extToken` 未配置的默认状态）**：`GET /sw3d/ping` 在「无凭据 / 32 位假 token /
短 token `abc` / 无 `Bearer` 前缀」四种情况下**全部 401**。默认关闭时这几条必然都是 401，
它们只能证明「旁路没开时不会误放行」，**不能**证明配置了正确 token 后会放行（见 §6）。

**今天就能用的验证脚本**（确认 8 条路由都在：401 = 在，404 = 没注册）：

```powershell
# 只读、无副作用：期望每条都打印 401。403 说明 Host/Origin 不对，404 说明路由没挂上。
$base = 'http://127.0.0.1:58716'   # 换成当前 DSH Web 端口
'/sw3d/ping','/sw3d/resolve','/sw3d/mesh','/sw3d/three.js',
'/sw3d/annotation','/sw3d/handoff','/sw3d/snapshot','/sw3d/sketches' | ForEach-Object {
  "$_ -> $(& curl.exe -s -o NUL -w '%{http_code}' "$base$_")"
}
```

---

## 4. 给 Codex 的最小可用示例

前置条件：`extToken` 已配置且 `extTokenScopes` 含所需 scope（§3.2）；否则全部回 `401`（空 body）。
**下面的 `<EXT_TOKEN>` 都是占位符，不要写真实 token，也不要把它提交进仓库。**
**每条都标了副作用**——「只读」也可能摸磁盘，「可能重算」会起 python 子进程。

### 4.1 `curl.exe`（Windows PowerShell）

```powershell
$base  = 'http://127.0.0.1:58716'          # 当前 DSH Web 端口，每次启动可能不同
$token = '<EXT_TOKEN>'
$h     = @('-H', "Authorization: Bearer $token")

# (1) ping —— 只读（会触发 python 探测，首次最多约 15 s；成功结果缓存 5 分钟）
& curl.exe -s @h "$base/sw3d/ping"

# (2) 取网格 —— 可能触发重算 + 写缓存（STEP 三角化走 python 子进程，超时 120 s）
#     -o 落到你自己的文件夹；不要写盘符根、桌面、系统临时目录。先看 content-type 分流
$out = Join-Path (Get-Location) 'mesh.s3dm'
& curl.exe -s @h -D - -o $out "$base/sw3d/mesh?path=$([uri]::EscapeDataString('D:\work\bracket-6.STEP'))&precision=mid&refresh=0"

# (3) 提交一条标注 —— 改状态（追加写 annotations.jsonl，只增不改）
& curl.exe -s @h -H 'Content-Type: application/json' -X POST "$base/sw3d/annotation" `
  --data-binary '{"op":"upsert","path":"D:\\work\\bracket-6.STEP","annotation":{"subject":"face","faceIndex":3,"note":"这里加 1 mm 倒角"}}'
```

- PowerShell 里 `curl` 是 `Invoke-WebRequest` 的别名，**必须写 `curl.exe`**；URL 含 `&` 时整串加引号。
- 状态码用 `-w '%{http_code}'` 拿：401 的 body 是空的，看不出错在哪。

### 4.2 Node `fetch`（Node ≥ 22，脚本在 DSH 外部跑）

```js
const base = 'http://127.0.0.1:58716';           // 当前 DSH Web 端口
const token = '<EXT_TOKEN>';
const H = { Authorization: `Bearer ${token}` };

// (1) ping —— 只读（首次会探测 python）
const ping = await (await fetch(`${base}/sw3d/ping`, { headers: H })).json();
if (!ping.ok) throw new Error(`ping not ok: ${JSON.stringify(ping)}`);

// (2) 取网格 —— 可能触发重算 + 写缓存；必须按 content-type 分流
const url = `${base}/sw3d/mesh?path=${encodeURIComponent('D:\\work\\bracket-6.STEP')}&precision=mid`;
const res = await fetch(url, { headers: H });
const ct = res.headers.get('content-type') || '';
if (ct.includes('application/json')) {
  const info = await res.json();                 // sketch-only：200 + JSON，没有实体网格
  console.log('sketch-only', info.mode, info.sketchUrl);
} else {
  const buf = Buffer.from(await res.arrayBuffer());   // S3DM v2，见 §2
  console.log('s3dm', buf.length, res.headers.get('x-sw3d-bbox'));
}

// (3) 提交标注 —— 改状态（追加一行）；只读查询用 op:"list"
const saved = await (await fetch(`${base}/sw3d/annotation`, {
  method: 'POST',
  headers: { ...H, 'content-type': 'application/json' },
  body: JSON.stringify({ op: 'upsert', path: 'D:\\work\\bracket-6.STEP',
    annotation: { subject: 'edge', edgeIndex: 7, note: '这条圆边要保留' } }),
})).json();
console.log(saved.id, saved.count);              // {ok:true,id,count}
```

- Node 的 `fetch` 默认不带 `Origin`，Host 是回环地址 → 能过 Host/Origin 栅栏，只会卡在认证。
- 不要把 `base` 写成局域网 IP：栅栏对非回环 Host 直接 `403`。
- 拿到的 S3DM 若要自己解析，按 §2 的布局读；`content-length` 就是文件总长，没有分块流。

---

## 5. 边界与坑（按踩到概率排序）

1. **`/sw3d/mesh` 有两种成功响应。** `octet-stream` = S3DM 二进制；`application/json` + `mode:"sketch-only"` = 只有草图、没有实体（`handleMesh()` @ `index.js:740`；sketch-only 分支 `index.js:768-784`，octet 响应 `index.js:842-848`）。按 `content-type` 分流，别只看状态码。
2. **状态码约定不统一**：`resolve` 失败回 **200**（`index.js:580-583`，`if (!resolved.ok) { sendJson(req,res,200,resolved); }`）、`sketches` 失败也回 **200**、`mesh` 失败回 **422**（`index.js:753-756`）。判断成功一律看 `ok` 字段。
3. **`handoff` 的 GET 会写盘**：交接单不存在时现场生成 `handoff\<sha1>.md`（`index.js:1063-1069`）；要「一定重新生成」才用 POST。且 **GET 的错误响应是纯文本不是 JSON**（`handleHandoff()` 用 `sendText`，成功路径见 `index.js:1071`），按 JSON 解析会炸。
4. **`precision` 会盖掉 `deflection`/`maxTriangles`**：`precision=low` 等于 `deflection=0.2,maxTriangles=120000`，同传 `deflection=0.05` 被忽略（`meshParams()` @ `index.js:638`、`lib/resolve.js:589-597`）。`angularDeflection`/`creaseAngle` 不受档位影响只能显式传，且**四个参数全部进缓存键**（`lib/mesh.js:437-453`）。
5. **`mesh` 可能很慢且吃 CPU**：STEP 三角化是独立 python 子进程，超时 `STEP_TIMEOUT_MS = 120000`（`index.js:82`，用于 `buildS3dm()` @ `index.js:648`）。同缓存键并发请求合并为一次构建（`buildTask()` @ `index.js:724`）；不同精度档 = 不同键 = 真的重算。
6. **`annotation` 是追加日志，没有更新与删除**。`upsert` 名字有误导：它 `appendFile` 一行 `{id,at,file,fileHash,annotation}`（`record` @ `index.js:986`）；查询按 `fileHash = sha1(小写绝对路径)` 过滤（`listAnnotations()` @ `index.js:373`、`annotationHash()` @ `index.js:368`）。要「最新一条」需自己按 `at` 取最后；串行化只在同一进程内（`withAnnotationLock()` @ `index.js:884`）。`path` 必须是受支持扩展名的真实文件（相对路径会走补全，`validateAnnotationPath()` @ `index.js:897`）。
7. **`.sldprt/.sldasm` 自己不能解析**：只能靠同目录同名 STEP、同目录「名字最像」的 STEP 兜底（`lib/resolve.js:341-394`），或降级 `sketch-only`（`lib/resolve.js:396-404`）。**不会启动 SOLIDWORKS**。
8. **`.stl/.obj` 没有 B-rep 拓扑**：`faceCount` 是「按平面/`f` 语句归并」出来的，`edges` 恒为空（`index.js:413-417`、`lib/mesh.js:660-688`）。别指望在 STL 上拾取到「圆柱面」。
9. **端口每次启动可能变**，而 cookie 绑定 authority → 重启后旧 cookie 失效、脚本要改 `$base`。也**没有 CORS**：浏览器里从别的 origin 读这些路由一定失败；这是本机回环接口，不是内网服务。
10. **所有数据都在 `%LOCALAPPDATA%\sw-3d-preview`**：`cache\`、`annotations\annotations.jsonl`（`annotationFile()` @ `index.js:347`）、`shots\`（`snapshotDir()` @ `index.js:352`）、`handoff\`、`recent.json`。这几个目录函数都定义在 `localDataRoot()` @ `lib/mesh.js:403-407` 之后：`cacheDir()` @409、`annotationDir()` @413、`handoffDir()` @418，整簇在 `lib/mesh.js:402-421`。只读环境会让缓存恒 miss、标注 `INTERNAL`。**被预览的原始文件永不被修改**——写入都落在上面这个目录。
11. **Bearer 旁路只加「放行」，不改「拒绝」。** token 错、scope 不够、没带 token 三者响应完全一样（还是原来的 `401`/`403`）。区别只在 DSH 日志：`logExternal()` @ `index.js:210-212` 打的那行前缀是 `[sw-3d-preview] auth: external client …`（`logLine()` @ `index.js:180-182` 拼前缀）。拒绝分支本身在 `allowTrusted()` @ `index.js:491-522`，其中写回状态的 4 行是 `index.js:518-521`。排查只能看日志。

---

## 6. 未验证项

逐条列出本文**没能验证**的东西，不要当成已确认事实：

1. **Bearer 旁路的「成功放行」路径我没实测过。** 代码已合入（`allowTrusted()` @ `index.js:491`、`checkExternal()` @ `index.js:460`、
   `lib/ext-token.js`、`cordis.patch.yml:9-19`），但本机 `extToken` 仍是默认空值，所以我只验证了
   「关闭时不误放行」（4 条 401），**没有**验证「配置正确 token 后 200 / scope 不足时仍 401」。
   §4 的示例一次也没跑通。
2. **`extToken` 的部署位置我无法确认。** `cordis.patch.yml:13` 要求「只填本机 profile 的 patch 层」，但我在 `%LOCALAPPDATA%` 之外的 profile 目录（`C:\Users\mota\.dsh\profiles\desktop\cordis.patch.yml`）里没找到 `sw-3d-preview` 这一行，所以不清楚这个 profile 实际从哪层读 config。要落地必须由人确认。
3. **`Authorization` 头会不会被 DSH 更上层拦掉、或被别的插件先吃掉**：只验证了当前实例 + 默认关闭时返回 401，没验证 DSH 其它版本/其它 profile（含开了 token 之后的行为）。
4. **拿到有效 v2 cookie 之后的链路没跑**：没用真实 launch token 走 `/connect?token=…`，所以 8 条路由在「浏览器已认证」状态下的响应体、字节数、耗时全部未实测；`ping` 的 `python.ok/ocp` 真实取值同理（来自 `lib/mesh.js:965-981` 而非实测）。
5. **STEP 三角化的真实产物没在我这里生成过**：§2.2 的 STEP header 字段抄自 `step_mesh.py:834-867`；没跑过 `scripts/package.mjs`、`test/host.mjs`、`test/suite.mjs` 或任何 `*-live.mjs`，也没生成真实 `.s3dm` 逐字节比对 JS 写端与 Python 写端。STL/OBJ 头的 `format` 拼写同理未确认。
6. **`test/ext-token.mjs` 我没跑**（按任务约束不执行测试脚本），所以旁路本身的恒时比较 / scope 归一化只有代码依据，没有测试结果依据。
7. **浏览器端行为未验证**：`client.js` 走相对路径 `/sw3d/*` + cookie 能成功，是从 `README.md:109-120` 与 `client.js` 的 `fetch` 调用点读出来的；没在真浏览器里抓过 Network 面板。
8. **`/sw3d/three.js` 是否真有人调用**：`client.js` 全文没有该路由的 `fetch`（`README.md:294-298` 同说法），客户端 three.js 是内联的。这条路由是第三方在用还是空置，未验证。
9. **多 DSH 实例并发写同一缓存键**：`buildS3dm()`（`index.js:648`）是写 `.tmp` 再 `rename`，理论上原子，
   但没做并发压测；`snapshot` 的 8 MB / 12 MB 上限够不够用也没实测；
   `SW_MCP_DATA` 覆盖数据根后的行为同样未实测。
   **⚠️ 更正（曾写错）**：`SW_MCP_DATA` **不归 `lib/paths.js` 管** —— `swMcpDataRoot()`（`lib/paths.js:28-32`）
   只读 `LOCALAPPDATA` / `LOCAL_APP_DATA`，**完全不看 `SW_MCP_DATA`**。真正读这个变量的是
   `swMcpDataRootForPython()` @ `lib/mesh.js:125-132`（`lib/mesh.js:128` 处 `env.SW_MCP_DATA` 优先）。
   也就是说：**`SW_MCP_DATA` 只影响 python 侧探测 sw-mcp 的路径，不影响宿主侧 `projectsDir()` 的读取位置。**
   两处同语义但不同实现，别把它们的覆盖效果混为一谈。
10. **`index.js` 在我写文档期间被另一个代理改过两次**（40,299 → 46,175 → 46,394 字节，
    `extToken` 就是在此时合入的），所以本文行号只对 sha256 `DBF49AD6…` / 1,186 行这一版有效；
    `lib/mesh.js`、`lib/step_mesh.py`、`lib/resolve.js`、`lib/sketches.js` 期间未变。
11. **本文件写就时的仓库不是干净树**：`git status` 里 `index.js`/`client.js`/`cordis.patch.yml`/`lib/*`/`package.json`/`test/*` 已有未提交修改，另有 `lib/ext-token.js`/`test/ext-token.mjs`/`README.md`/`CHANGELOG.md`/`scripts/`/`vendor/` 等未跟踪项；`docs/codex-human-parity.md` 是**另一个代理**同时创建的。我**只新增了本文件**（`docs/external-api.md`）。
