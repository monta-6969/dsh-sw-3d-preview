# Codex 与人类操作等价：接口契约

目标：让 Codex 在同一个会话里做到人类在 DSH 桌面端能做到的六件事，并且人类在 GUI 里能看到同一份对话与实时进度。

本文只写契约、路径、行号与副作用。标记约定：`[推断]` = 我推断而非从代码读到；`[未验证]` = 未做端到端验证。

> **行号基线**：本文代码出处一律写**符号名为主、行号为辅**（`allowTrusted()` @ `index.js:491`）——
> 符号名不会漂，行号会。行号对应 `index.js` = SHA256 前 8 位 **`98D1DC89`** / **1,243 行** / 49,775 B。
> **`index.js` 一旦变动，行号即失效**：重跑 `node scripts/check-refs.mjs --strict` 重算，
> 别凭记忆手改数字（这条毛病已经犯过两次：`DBF49AD6` 那版全量失效过一次，现在又失效过一次）。
> 规矩出处见 `CHANGELOG.md:8-10`。

## 基线事实（已核对源码）

| 事实 | 出处 |
| --- | --- |
| 宿主插件 `inject = ['webServer', 'connection']` | `index.js:69` |
| 8 条 `/sw3d/*` 路由在 `apply()` 里注册 | 路径表 `ROUTES` @ `index.js:89-98`；8 个 `register(ROUTES.*)` @ `index.js:1235-1242` |
| 每条路由自带信任栅栏 `allowTrusted()` | `allowTrusted()` @ `index.js:491-522` |
| `path` 只来自 HTTP query，没有目录监听 | `url.searchParams.get('path')` @ `index.js:572`、`744`、`935`、`1020`、`1181` |
| 客户端地址只来自 `props.resourceAddress` | `client.js:7798`、`7931`、`9061` |
| 客户端插件 `inject = ['documentPreviews', 'slots']` | `client.js:9201` |
| `ctx.agents.get(id)` 返回 `Agent`，`inbox.followup()` 为同步 `void` | `dsh-agent/src/runtime-types.ts:191-272` |
| `MessageSourceMap` 合法 `kind` 只有 `user`/`model`/`tool`/`system-prompt` | `dsh-llm/src/message.ts:110-115` |
| `ctx.attachments.admitPromptContent()` 把编码图片换成持久引用 | `dsh-attachment/src/index.ts` |
| `WebRoute.handler` 可持有响应不结束（可做 SSE） | `dsh-host-webserver/src/index.ts:56-57` |

**会话必须已 live** 才能注入。冷会话 `resume()` 会拿写租约，人类随后打开同一会话撞 `session/writer-held`。因此所有注入类接口用 `SESSION_NOT_LIVE` 拒绝，不做自动 resume。

**`inject` 的连带风险**：`inject` 未满足时 fiber 停在 INACTIVE，`apply()` 不执行 → 8 条路由全部消失、3D 预览整体罢工。注意 Cordis 为每个 Service 声明了**可选访问表达式**（`ctx.get("agents")`，`requiresUndefinedCheck: true`），因此把 `'agents'` / `'attachments'` 写进顶层 `inject` **不是唯一途径**，也不是推荐途径。推荐：`inject` 保持不变，处理器内 `ctx.get('agents')` / `ctx.get('attachments')` 取服务，缺失时返回 `503 CAPABILITY_UNAVAILABLE`，路由与预览不受影响。若坚持写 `inject`，必须把注入能力拆成独立插件。

**鉴权前提（本文所有新增路由共用）**：`allowTrusted()` @ `index.js:491-522` 现为「先跑原有 `requestRejection()`，通过即返回；失败才尝试外部旁路 `checkExternal(req, routePath, method)`」。旁路基座在 `lib/ext-token.js`，配置项 `extToken` / `extTokenScopes`（该文件与旁路**由另一路并行改动引入，不在本文范围内**，本文不定义其契约）。这意味着本文新增的 `/sw3d/inject`、`/sw3d/messages`、`/sw3d/attachment/{id}`、`/sw3d/stream`、`/sw3d/stream/poll`、`/sw3d/notify`、`/sw3d/events`、`/sw3d/session/attached` 都必须把 `routePath` 传给 `allowTrusted()`，否则 Bearer 旁路不生效、Codex 一律拿到 403。`[未验证]`：旁路在 SSE 长连接上是否只在建连时判定一次。

---

## 1. 发一条文字消息

**人类**：在 GUI 输入框打字回车 → 客户端 `session prompt` RPC → 宿主构造 `source = {kind:'user', rpcId: requestId}`（`dsh-api-session-controller/src/index.ts:467-491`）→ 进入 inbox → 开新一轮。

**Codex**：`POST /sw3d/inject`（**待新增**）。

```json
{
  "sessionId": "9a954a71-...",
  "content": [{ "type": "text", "text": "[Codex] 零件画完了，缺口朝上。" }],
  "mode": "queue",
  "clientTag": "codex-bridge/0.1"
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `sessionId` | 是 | 目标会话。宿主**拿不到**「人类正在看哪个会话」，必须由调用方给出（见 §1.4） |
| `content` | 是 | 非空数组；`text` 去空白后不得为空 |
| `mode` | 否 | `queue`（默认，走 `followup`）或 `steer`（走 `steer`） |
| `clientTag` | 否 | 写进 `source.clientTag`，仅供程序判别，UI 不渲染 |

响应 `200`：

```json
{ "ok": true, "accepted": true, "sessionId": "...", "messageId": "6f1c...", "mode": "queue", "queued": true }
```

`messageId` 是宿主自己 `createUserMessage()` 时生成的 `message.id`（`dsh-llm/src/message.ts:221-253`），不是从 `followup()` 的返回值拿的——`followup` 返回 `void`。

实现要点（宿主侧）：`ctx.agents.get(sessionId)` → `agent.inbox.followup(createUserMessage({ content, source }))`。`followup` 是同步 `void`，**不要 `await whenIdle()`**（可能长期不 resolve）。空闲时它立即开新一轮；正在跑时排队不打断（`dsh-agent/src/runtime-types.ts:247-261`）。`UserMessage.id` 必填，必须用 `createUserMessage()` 造，不能手写对象。

### 错误码

| HTTP | code | 触发 |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | 缺 `sessionId`、`content` 非数组、`content` 全空 |
| 403 | `FORBIDDEN` | `requestRejection()` @ `index.js:494` 拒绝；403 回退在 `index.js:497` |
| 404 | `SESSION_NOT_LIVE` | `ctx.agents.get()` 返回 `undefined`；**不自动 resume** |
| 405 | `METHOD_NOT_ALLOWED` | 非 POST |
| 413 | `UNSUPPORTED` | 请求体超 `MAX_ANNOTATION_BODY`（256 KB，`index.js:83`） |
| 415 | `UNSUPPORTED` | `content-type` 非 `application/json` |
| 422 | `UNSUPPORTED` | `content[].type` 不在白名单 |
| 503 | `CAPABILITY_UNAVAILABLE` | `ctx.get('agents')` 为空 |

### 1.4 「当前会话」怎么拿

宿主侧**不存在**「人类正在看哪个会话」的服务。必须由 client 半边上报：`POST /sw3d/session/attached {sessionId}`，client 在 tab 挂载时注册、卸载时清空，宿主维护 `mountedSessionId`。未上报时 `sessionId` 必须显式给出。

### 1.5 注入的消息在人类界面上长什么样（关键设计点）

**无法区分，人类会看到和自己发的消息一样。**

理由（已核对源码）：

- `MessageSourceMap` 是 merge-extensible 联合，合法 `kind` 只有 `'user' | 'model' | 'tool' | 'system-prompt'`，**没有 `'plugin'`**（`dsh-llm/src/message.ts:110-115`）。
- `source` 确实随消息传到 UI，但对话区对 user 消息**不渲染任何来源标记**：`dsh-client-ui-conversation` 的浏览器包内，`source.kind` / `rpcId` 只出现在队列去重逻辑里（`source.kind !== 'user'`、`'rpcId' in source`），正文渲染路径上没有来源徽标；包内也没有 author 渲染（唯一 `author` 命中是 locale 文案 `autoReviewReasonFallback` 之类的无关词）。
- 结论：用 `{kind:'user'}` 注入，人类界面与手动输入**完全无法区分**。

可行的三层缓解：

1. **固定前缀（今天就能做）**：文本前置 `[Codex] `。零内核改动，人类一眼可分，代价是脏化文本。
2. **`source` 加判别字段（今天就能做）**：`source = {kind:'user', clientTag:'codex'}`。UI 不显示，但程序可判别；GUI 消息带 `rpcId`、我们不带，二者天然互斥，可用来做「这条是不是注入的」判定。
3. **自定义 `source.kind`（需改 DSH 内核）**：`declare module '@deepseek-ai/dsh-llm'` 扩展 `MessageSourceMap`，同时改对话区渲染。跨包类型扩展 + UI 改动，不建议在一阶段做。

`[推断]` 自定义 kind 会不会被 `deriveMessages()` 或持久化校验拒绝，未验证——这条只是类型层 merge-extensible，运行时是否有白名单未确认。

---

## 2. 传图片给会话

**人类**：粘贴 / 拖拽 / 点附件 → 客户端上传 → `ctx.attachments.admitPromptContent()` 换成持久引用 → 消息里是 `{type:'image', attachment}` 块。

**Codex（正路）**：`POST /sw3d/inject`，`content` 里带图片块。

```json
{
  "sessionId": "...",
  "content": [
    { "type": "text", "text": "[Codex] 这是新零件的三视图" },
    { "type": "image", "mediaType": "image/png", "data": "iVBORw0...", "name": "bracket-6_iso.png" }
  ]
}
```

宿主处理：`ctx.attachments.admitPromptContent(content)` → `AdmittedPromptContentPart[]`（`text` / `image{attachment}` / `file{attachment}`），形状兼容 `ImageBlock`，再 `createUserMessage`。

- **格式**：`data` 必须是 **canonical base64**（不带 `data:` 前缀）。也接受 `filePath`（宿主自己 `fs.readFile` 后 base64），用于本机大图。
- **支持的 mime**：`image/png`、`image/jpeg`、`image/webp`、`image/gif`（`ImageMediaType`，`dsh-attachment/src/types.ts:8`）。注意与插件已有 `/sw3d/snapshot` 区分：后者只按魔数收 PNG/JPEG（`sniffImageType()` @ `index.js:357`），两套契约不要混用。
- **大小上限**：运行时读 `ctx.attachments.imageLimits`，**不要硬编码**。`[未验证]` 本机实际生效值；`dsh-attachment-local` 的默认值是 `maxImageBytes` 50 MiB、`maxImagesPerMessage` 20、`maxMessageImageBytes` 200 MiB、`maxImagePixels` 64,000,000、`maxImageDimension` 65535 px；落盘归一化后 2048×2048 像素 / 长边 8192 / 4 MiB。

### 错误码（映射 `AttachmentError.code`）

| HTTP | code | 触发 |
| --- | --- | --- |
| 413 | `IMAGE_TOO_LARGE` / `IMAGES_TOO_LARGE` | 单图 / 单条消息图片总字节超限 |
| 413 | `IMAGE_TOO_MANY_PIXELS` / `IMAGE_DIMENSION_TOO_LARGE` | 解码像素或单边超限 |
| 415 | `UNSUPPORTED_IMAGE_TYPE` | mime 不在四值内 |
| 422 | `IMAGE_TYPE_MISMATCH` / `INVALID_IMAGE` | 声明 mime 与字节不符 / 解码失败 |
| 400 | `INVALID_IMAGE_BASE64` | base64 不合法 |
| 422 | `TOO_MANY_IMAGES` | 单条消息图片数超限 |
| 404 | `SESSION_NOT_LIVE` | 同 §1 |

### 退化路（共享目录）

不走上表时：宿主把图片写到工作区内固定目录（建议 `<workspace>/.dsh-sw3d/inbox/<sha1>.<ext>`），消息文本里只放路径，由 Codex 用文件工具自行读取。适用于超过 `imageLimits` 的大图，或 `attachments` 服务缺失。

注意：插件已有的 `%LOCALAPPDATA%\sw-3d-preview\shots`（`snapshotDir()` @ `index.js:352-354`）在**工作区之外**，它是插件自己的数据目录、由插件运行时写入，不应作为 agent 的投递通道。

---

## 3. 看会话里的图片（含助手产出的截图）

**人类**：对话区直接渲染助手消息里的 `ImageBlock`。

**Codex**：需要取回字节。两条只读路由（**待新增**）。

`GET /sw3d/messages?sessionId=<id>&limit=50&before=<seq>`：

```json
{
  "ok": true,
  "sessionId": "...",
  "messages": [
    { "seq": 42, "role": "assistant", "time": 1763000000000,
      "text": "已生成三视图",
      "images": [
        { "attachmentId": "9f2c...", "mediaType": "image/png",
          "bytes": 100835, "width": 1280, "height": 720, "name": "iso.png",
          "url": "/sw3d/attachment/9f2c...?sessionId=..." }
      ] }
  ],
  "nextBefore": 40
}
```

宿主实现：`ctx.sessions.get(sessionId).snapshotEvents()` → 取 `user/message`、`assistant/message`、`tool/result` → `message.content` 里挑 `type === 'image'` → 输出 `block.attachment` 的元数据。冷会话改用 `ctx.sessionQuery.listEvents(sessionId)`。

`GET /sw3d/attachment/{attachmentId}?sessionId=`：`ctx.attachments.readImage(ref)` → `Uint8Array`，按 `ref.mediaType` 写 `content-type`，`content-length` 用 `ref.bytes`。`readImage` 会校验 id / 格式 / 字节数 / 尺寸。**字节只从 attachment 服务取，不落路径、不拼文件名**。

现有替代通道（未新增路由即可用）：`session attachment` Remote 返回 base64（`SessionAttachmentValue.data`），但那是对浏览器的 Remote，不是 HTTP 路由。

**人类可见性**：纯只读，不改 UI、不产生消息。

---

## 4. 看模型（最难）

**现状**：3D 预览**必须人类手动开文件**。路径只从 `?path=` 来（`index.js:511`、`683`、`1120`），客户端只从 `props.resourceAddress` 来（`client.js:7798`、`7931`、`9061`）；没有目录监听，没有自动打开。Codex 让 SW 画完零件后，人类桌面端**不会**自动出现模型。

**目标体验**：Codex 说「画完了」→ 人类桌面端的预览面板自动打开/刷新到新模型。

### 已确认的 API（从源码读到）

- `ctx.sidebarRight.openResource(address, options)`：`dsh-client-ui-sidebar-right/src/client/service.ts:243`，由该包 `ctx.reflect.provide('sidebarRight', controller)` 提供（`index.ts:182-183`）。
- `SidebarRightTabActions.openResource(address, options)`：`.../contract/slots.ts:170`，在 tab 内经 `useTabInfo().tab.actions` 拿到。
- 资源地址格式：`dsh-resource://file/session/<sessionId>/<encoded path>`；解析规则见 `parseFileAddress`，与 `client.js:164-180` 的 `parseAddress` 一致。
- 宿主可长连接推流：`WebRoute.handler` 「may hold the response open, e.g. SSE」（`dsh-host-webserver/src/index.ts:56-57`）。
- 预览体按扩展名派发：`DocumentPreviewRegistry.register()` 只登记 `{id, extensions, binaryExtensions, priority, title, loading, wrap}`，**没有 `canOpen`**；tab 类型由本包以 `fallback` 优先级、`canOpen: scope === 'session'` 声明（`.../documentpreview/src/client/definition.ts`），3D 插件只在 keyed slot `sidebar.right.tab.document` 上登记自己的 `ViewerBody`（`client.js:9168-9187`）。
- 推论（重要）：**只有扩展名命中 `EXTENSIONS`（`client.js:9171`，即 `.step/.stp/.stl/.obj/.sldprt/.sldasm`）才会落到我们的 body**；否则落到文本预览。

### 方案 1：宿主侧事件推送 + 客户端 `openResource`（推荐）

宿主新增：`POST /sw3d/notify {path, sessionId, reason}` 写入会话级「最新产物」环形缓冲；`GET /sw3d/events?sessionId=`（SSE）顺带推送。client 半边订阅后调 `openResource(address, {revealIfOpened:true})`。

改动量：宿主 +120 行（路由 + 缓冲 + SSE），客户端 +80 行（订阅 + 地址拼接 + 开关）。风险：**抢焦点**。

`[未验证]`：由插件 client 半边（非 tab 上下文）调用 `ctx.sidebarRight.openResource` 能否正确落到我们的 `ViewerBody`。按 slot key 推断可以，未实测。

### 方案 2：只写文件，人类手动点开（退化）

Codex 写完 `.SLDPRT` / `.STEP` 就结束，人类自己点开预览。零风险、零改动，但不是「等价体验」。

### 方案 3：不抢焦点，给一个「打开」按钮（推荐与方案 1 并用）

宿主推送事件，客户端**不**直接 `openResource`，而是在对话区/预览区出一条可点的「Codex 画完了：打开 bracket-6.STEP」。人类点一下才开。保留人的控制权，规避抢焦点。

改动量：方案 1 的宿主部分 + 客户端加一个 slot 注册（约 +60 行）。风险最低。

### 必须标清的待验证项

| 条目 | 状态 |
| --- | --- |
| `ctx.sidebarRight.openResource` 存在且签名如上 | 已确认（源码） |
| `tab.actions.openResource` 存在 | 已确认（`contract/slots.ts:170`） |
| 地址 `dsh-resource://file/session/<sid>/<path>` 格式 | 已确认（`client.js:164-180`） |
| 宿主 handler 可做 SSE | 已确认（`dsh-host-webserver/src/index.ts:56-57`） |
| 插件 client 半边直接调 `openResource` 能打开我们的预览体 | **`[未验证]`** |
| 自动打开时人类正在看别的 tab 会不会被切走 | **`[未验证]`** |

---

## 5. 制作批注 review

**人类**：在 3D 视图里点选草图层/线/点、Ctrl 多选、写「修改意见」、点「复制 / 保存标注」。选中几何会被 `buildSketchSelectionInstruction()` 拼成 `[3D标注]` 开头的 ①–⑤ 分节文本（`client.js:2946-3037`，`ANNOTATION_SCHEME` 定义在 `client.js:40`）；保存走 `buildAnnotationPayload()`（`client.js:8656-8700`）→ `POST /sw3d/annotation`。

### Codex 读批注（**今天就能做，无需新增路由**）

- `GET /sw3d/annotation?path=<urlencoded>` → `{ok:true, items:[...]}`（`handleAnnotation()` @ `index.js:928`，GET 分支 `index.js:928-948`）。
- 记录形状：`{id, at, file, fileHash, annotation}`（`record` @ `index.js:986-992`），落在 `%LOCALAPPDATA%\sw-3d-preview\annotations\annotations.jsonl`（`annotationFile()` @ `index.js:347-349`，落盘实现 `annotationDir()` @ `lib/mesh.js:413-415`）。`annotation` 内含 `subject/index/note/text/samples/shotPath/faceIndex/edgeIndex/pointIndex` 等。
- 汇总交接单：`GET /sw3d/handoff?path=` 直接返回 `text/markdown`（`handleHandoff()` @ `index.js:1012-1071`）；文件在 `%LOCALAPPDATA%\sw-3d-preview\handoff\<sha1(小写路径)>.md`（`lib/handoff.js:15-18`）。

新增 `GET /sw3d/annotations?sessionId=&since=` 只是便利封装（会话→当前文件映射），不是必需。

### Codex **能不能反过来造批注**

能，且**不需要新增路由**：`POST /sw3d/annotation {op:'upsert', path, annotation}`（`handleAnnotation()` @ `index.js:928`，upsert 分支 `index.js:965-1004`）。`annotation` 是任意 JSON。

所有权约定（新增字段，向后兼容）：

```json
{ "op": "upsert", "path": "C:\\\\...\\bracket-6.STEP",
  "annotation": { "author": "codex", "subject": "face", "faceIndex": 12,
                  "note": "这个面有倒扣", "kindLabel": "倒扣面" } }
```

- `author` 缺省视为 `"human"`（既有记录全部没有该字段，语义不变）。
- 人类标注：`"human"`；Codex 标注：`"codex"`。
- **区分现状**：`client.js` 的 `extractAnnotationIndexes()` 只读 `edgeIndex` 做「已标注」高亮（`client.js:7427-7438`），**不渲染 author**。要让人类在 UI 上看到「这是 Codex 标的」，需改客户端（约 +30 行：卡片加作者徽标 + 高亮分色）。在改之前，人类看到的 Codex 批注与自己的一模一样。
- `[推断]` Codex 造批注不会触发人类的界面刷新（无推送），人类需重开预览；若要实时可见，复用 §4 的方案 1 事件流。
- `[推断]` `buildHandoffMarkdown()`（`lib/handoff.js:45-98`）目前只摊平 `subject/index/note/samples/kindLabel`，**不输出 `author`**；若要让交接单里也能区分作者，需给 `lib/handoff.js` 加一行（约 3 行）。

---

## 6. 实时进度

**人类**：看着助手一行行输出。

**Codex**：需要流式，而不是等最终结果。

宿主已具备流式源（**已确认**）：`'agent/assistant-stream'` 是 emit 事件，payload `{agent, frame}`，`frame.type` 为 `start` / `chunk` / `end`，`chunk.chunk` 是 `StreamChunk`（`text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end` / `usage` / `finish`）；`end` 带 `committed` 的 `seq` 或 `abandoned`。另有 `'session/event'`（提交后逐条）与 `'agent/status'`（idle⇄running）。

### `GET /sw3d/stream?sessionId=<id>&since=<seq>`（SSE，**待新增**）

响应头：`content-type: text/event-stream`、`cache-control: no-store`、`connection: keep-alive`。信任栅栏只在**建连时**跑一次 `allowTrusted()`，不要逐块跑。

事件（`event:` 名字 + `data:` JSON，`id:` 用 seq）：

| event | data |
| --- | --- |
| `hello` | `{sessionId, lastSeq}` |
| `agent.status` | `{status:"idle"\|"running"}` |
| `user.message` | `{seq, text, images:[attachmentId]}` |
| `assistant.start` | `{attemptId, turn, step}` |
| `assistant.delta` | `{attemptId, index, text}`（文本增量，自动合并 ≤50 ms） |
| `assistant.end` | `{attemptId, seq}` 或 `{attemptId, abandoned:true}` |
| `tool.call` | `{seq, callId, name}` |
| `tool.result` | `{seq, callId, isError}` |
| `heartbeat` | `{time}` —— 无消息时每 15 s 一条；也接受 `: ping` 注释行 |
| `reset` | `{reason:"gap"}` —— 断线过久、缓冲已丢 |
| `error` | `{code, message}` |

**断线重连**：客户端带 `Last-Event-ID: <seq>` 重连，服务端从 `seq+1` 补发；补不上（超出环形缓冲）先发 `reset` 再从现在续发。客户端收到 `reset` 必须丢弃本地增量、重拉 §3 的 `messages`。

**背压**：`text-delta` 按 50 ms 或 512 字节合并；单连接写缓冲超 1 MB 时丢掉合并后再发，不阻塞 agent。

**失败模式**：`404 SESSION_NOT_LIVE`（`ctx.agents.get()` 为空，宿主拿不到 `agent/assistant-stream`）→ 客户端退化到轮询。`503 CAPABILITY_UNAVAILABLE`（`agents` 服务缺失）。

### 轮询退化契约（**今天就能做**）

`GET /sw3d/stream/poll?sessionId=&afterSeq=&limit=100` →

```json
{ "ok": true, "events": [{ "seq": 43, "type": "assistant/delta", "data": { "text": "画" } }],
  "nextSeq": 43, "running": true }
```

数据源：`ctx.sessionQuery.listEvents(sessionId)` 或 `session.snapshotEvents(afterSeq)`。建议间隔 ≥500 ms，`running:false` 时可停。

---

## 实现优先级与边界

| 能力 | 现有代码能做 | 需新增宿主路由 | 需新增客户端 | 需改 DSH 内核 | 预估改动量 |
| --- | --- | --- | --- | --- | --- |
| §1 发文字消息 | 否（无注入路由） | `POST /sw3d/inject` | 否 | 否 | 宿主 ~150 行 |
| §1.5 来源可区分（前缀/`clientTag`） | 否 | 随 §1 | 否 | 否 | +10 行 |
| §1.5 来源可区分（自定义 `source.kind`） | 否 | — | 对话区渲染 | 是 | 大，不建议一阶段 |
| §1.4 当前会话上报 | 否 | `POST /sw3d/session/attached` | tab 挂载时上报 | 否 | 宿主 40 + 客户端 30 行 |
| §2 传图片 | 否 | `POST /sw3d/inject`（复用） | 否 | 否 | 宿主 +80 行 |
| §3 读图片 | 部分（attachment 服务在） | `GET /sw3d/messages`、`GET /sw3d/attachment/{id}` | 否 | 否 | 宿主 ~180 行 |
| §4 方案 2（只写文件） | **是** | 0 | 否 | 否 | 0 |
| §4 方案 1（事件推送 + 自动开） | 否 | `POST /sw3d/notify`、`GET /sw3d/events` | `openResource` 调用 | 否 | 宿主 120 + 客户端 80 行 |
| §4 方案 3（推事件 + 按钮） | 否 | 同方案 1 | slot 注册 | 否 | 宿主 120 + 客户端 140 行 |
| §5 读批注 | **是**（`GET /sw3d/annotation`、`/sw3d/handoff`） | 0 | 否 | 否 | 0 |
| §5 Codex 造批注 | **是**（`POST /sw3d/annotation` upsert + `author`） | 0 | 加作者徽标（可选） | 否 | 0（或客户端 30 行） |
| §6 轮询进度 | **是**（`sessionQuery.listEvents`） | `GET /sw3d/stream/poll` | 否 | 否 | 宿主 ~90 行 |
| §6 SSE 流式 | 部分（源在，路由不在） | `GET /sw3d/stream` | 否 | 否 | 宿主 ~200 行 |
| 鉴权（全部新增路由） | 部分（`allowTrusted` 已支持旁路） | 各路由须传 `routePath` | 否 | 否 | 每路由 +1 行 |

**今天就能做（0 或极小改动）**：§4 方案 2、§5 读批注、§5 Codex 造批注、§6 轮询（仅需一条薄路由）。

**必须先验证某个未知再做**：

1. §4 方案 1/3 —— 必须先验证「插件 client 半边调用 `openResource` 能把我们的 `ViewerBody` 打开并刷新」，以及会不会抢走人类正在看的 tab。
2. §1.5 自定义 `source.kind` —— 必须先验证扩展后的 kind 能通过 `deriveMessages()` 与持久化校验。
3. §2 图片上限 —— 必须先实测 `ctx.attachments.imageLimits` 的真实数值，不能按默认值写死。
4. §6 SSE —— 必须先验证 `ctx.connection.requestRejection()` 在长连接下只在建连时判定、不会中途踢连接。

**风险登记**：把 `'agents'` / `'attachments'` 写进 `index.js:69` 的 `inject` 会让整个插件在服务缺失时 INACTIVE，8 条 `/sw3d/*` 路由一起消失、3D 预览罢工。推荐用 `ctx.get('agents')` 可选访问 + `503 CAPABILITY_UNAVAILABLE`，保持 `inject` 不变。
