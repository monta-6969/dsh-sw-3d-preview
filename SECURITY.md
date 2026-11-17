# 安全策略

这个文档只讲**这个插件真实的攻击面**，不写通用模板。字段实测自当前版本（`0.2.2`）。

---

## 1. 安装本插件 = 在本机以你自己的权限运行第三方代码

先把最重要的一条说清楚：

- DSH 插件是**普通 Node 代码**，跑在 **Host 进程内**，拥有和 DSH 进程相同的文件系统与进程权限。
- **工具审批（tool approval）不沙箱化插件代码。** 你批准的是「agent 调用某个工具」，不是「插件里的每行代码」。
  插件在 `apply(ctx)` 时注册路由、在请求到达时读写文件，这些都不经过审批弹窗。
- 因此：**只安装你信任来源的插件**。安装前自己看一眼 `index.js`、`lib/`、`client.js`。
  这个仓库当前是 `license: "MIT"`（见 `LICENSE`），可自由分发——正因如此，拿到来源不明的副本时更该自己核一遍。

---

## 2. 真实的执行面

以下是这个插件**实际会做**的事，按风险从高到低排列。**注意第一条是唯一会执行外部代码的路径。**

### 2.1 启动 Python 子进程（读 STEP 等格式）

`lib/mesh.js` 用 `node:child_process` 的 `spawn()` 启动本机 Python（`lib/mesh.js:14` 引入、`:897` 调用），
执行仓库内的 `lib/step_mesh.py` 来把 STEP 三角化：

```
spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
```

解释器候选顺序（`lib/mesh.js:283` `pythonCandidates()`）：

1. 环境变量 `SW_3D_PREVIEW_PYTHON` 指定的路径；
2. sw-mcp 的 venv（`%LOCALAPPDATA%\sw-mcp\.venv\Scripts\python.exe`，或通过 `SW_MCP_DATA` 覆盖的数据根）；
3. 同级/仓库 venv；
4. `py -3` → `python` → `python3`（走 `PATH`）。

**风险点**：最终执行的是「找到的那个 Python 解释器」，脚本是本仓库的 `lib/step_mesh.py`。
所以 `SW_3D_PREVIEW_PYTHON` 指向哪里、`PATH` 里 `python` 是谁，就执行谁——这是本插件**最实质的代码执行面**。
`lib/step_mesh.py` 自身只做几何解析与 S3DM 写出（`import` 里没有网络库，仅 `argparse/json/math/os/shutil/struct/sys/tempfile/time/traceback` +
OCP），但**能改写 `SW_3D_PREVIEW_PYTHON` 的攻击者等于能指定任意解释器**。

另外每次探测/调用的超时受控（`runStepMesh` 默认 `timeoutMs = 120000`），但子进程不会因为超时被沙箱化。

### 2.2 在本机 `127.0.0.1` 上注册 HTTP 路由

插件通过 `ctx.webServer.register(...)` 把 **8 条** 路由挂到 DSH 的 **本机 Web 服务器**
（默认 `http://127.0.0.1:<端口>`，`index.js:65-72`）：

```
/sw3d/ping  /sw3d/resolve  /sw3d/mesh  /sw3d/three.js
/sw3d/annotation  /sw3d/handoff  /sw3d/snapshot  /sw3d/sketches
```

这些路由接受**绝对文件路径**作为参数（`?path=`、`POST {path}`），服务端按路径去读文件、算网格、写缓存/标注/截图/交接单。
也就是说：**任何能向本机 DSH 端口发请求的东西，都能让插件去读它指定路径的文件**。

缓解措施（当前的实现，务必知道其边界）：

- 每条路由**自己做信任栅栏**：`allowTrusted()` → `ctx.connection.requestRejection(req)`
  （`index.js:322`）。未登录/不被信任的请求应拿到 `401` 而不是 `404`。
  **边界**：这是「DSH 认为的已认证请求」级别的控制。同机其它本地进程若能通过这层校验，插件不再有二级鉴权。
- 方法校验（`allowMethods`，405）、`content-type` 校验（415）、整数/体积上限；
- `/sw3d/snapshot` 要求 `path` 是绝对路径、扩展名在白名单内（`.step/.stp/.stl/.obj/.sldprt/.sldasm`），
  且对图片做**魔数**校验（只收 PNG/JPEG），单张 8 MB 上限，写入文件名是 `sha1(路径小写)-时间戳.png`，
  不接受调用方指定写入路径；
- 读文件的路径来自请求方，**没有**「只能读某个目录」的根目录限制。这是设计使然（预览任意位置的模型），
  但意味着信任栅栏是唯一的边界。

### 2.3 读写本机数据目录

插件写入 `%LOCALAPPDATA%\sw-3d-preview\`（缓存 `.s3dm`、`annotations.jsonl`、`shots\`、`handoff\`、`recent.json`），
**只读** `%LOCALAPPDATA%\sw-mcp\projects\*.json`（`lib/paths.js:29`、`lib/sketches.js:696`）。

- 标注是**按行 append** 的 JSONL（`index.js:996` 的 `fs.appendFile`），进程内用 `withAnnotationLock`（`index.js:884`）串行化；
  **多 DSH 实例同时写同一个文件不保证安全**（后写覆盖风险低但非零，见 README 已知限制 9）。
- `%LOCALAPPDATA%` 可被环境变量重定向（`lib/mesh.js:227`）；测试正是靠这一点把数据写进临时沙箱。

### 2.4 浏览器端（`client.js`）

`client.js` 是约 2.5 MB 的单文件，含**内联的 three.js r187**（MIT）。它只向**同源**的 `/sw3d/*` 发请求
（`fetch('/sw3d/ping'|…)`），没有发现外联第三方域名的代码。
它在预览面板里创建 WebGL 上下文并渲染网格数据——网格数据来自本机文件，不是远程输入。

### 2.5 明确**不**做的事

- **不通过 COM 连接 SOLIDWORKS，也不启动 SOLIDWORKS。** 本仓库交付的代码里没有 COM / `winax` /
  `ActiveXObject` / `SldWorks` / `win32com` 调用。按
  `winax|ActiveXObject|SldWorks|CreateObject|win32com|Dispatch\(` 做过全仓扫描，命中项全是**误报**
  （`client.js` 里的 `URL.createObjectURL(...)`，以及测试里的 `dom.dispatch('pointermove', …)`），
  没有一处是 COM 调用。对 `.sldprt/.sldasm` 的处理是**找同名 `.step` 文件**读，
  或者降级到「草图视图」（读 sw-mcp 写好的 project JSON）。
  右键菜单里「添加草图 / 倒圆角 / 作为基准」之类**只生成自然语言指令填进输入框**，不会真的改模型
  （README 已知限制 1）。
  如果你看到的某个副本真的在起 SOLIDWORKS，那个副本和本仓库不一致，应当怀疑它。
- **不联网**：Host 侧没有出站 HTTP 客户端；Python 侧不 import 网络库。
- **不修改模型文件**：只读源模型，产物写在自己的数据目录。
- **不上传任何东西**。

---

## 3. 已知的、不视为漏洞的行为

提交报告前请先排除这些（避免白费力气）：

| 行为 | 说明 |
| --- | --- |
| 插件能读你给的任意绝对路径 | 设计使然：预览功能就是把任意位置的模型读进来。信任栅栏是唯一边界。 |
| 标注/截图写到 `%LOCALAPPDATA%` | 设计使然，不写别人的目录，但也没做额外的目录隔离。 |
| 多 DSH 实例并发写 `annotations.jsonl` | 已知，未修（README 已知限制 9）。 |
| 视觉/渲染相关的观感问题 | 不是安全项。所有视觉断言都在假渲染器上跑过，真浏览器未验证。 |
| 缺 Python 时的降级与错误文案 | 功能问题，不是安全问题。 |

---

## 4. 报告漏洞

**请私下报告，不要先开公开 issue。**

- 首选：在本仓库的 **GitHub Security Advisory**（仓库设置里的 *Private vulnerability reporting*）
  提交——**该通道在仓库启用此功能之后生效**；如果那里还看不到 `Report a vulnerability` 按钮，
  说明尚未启用，请按下面的兜底方式处理。
- 兜底：用 GitHub 上的**私信/其它私下渠道**联系维护者，不要贴在公开 issue、PR 或讨论区里。
  （本仓库**没有**公开的安全邮箱，本文件不编造邮箱地址。）

一个有用的报告请包含：

1. 受影响的版本（`package.json` 的 `version`，当前 `0.2.2`）与 DSH 版本；
2. 触发路径：哪条 `/sw3d/*` 路由、什么请求、什么参数；
3. 你认为越过的是哪一层边界（信任栅栏？路径白名单？图片魔数校验？写入路径？）；
4. 最小复现（curl / PowerShell 均可）与观察到的结果；
5. 是否已在本机实测（**未验证的推测请标明**）。

### 我们的处理预期

本仓库是内部使用的小项目，没有专职安全响应。我们尽量做到：**收到后 7 天内给一个初步答复**（是否复现、
是否需要修、大致时间），并在修复后于 `CHANGELOG.md` 里记一条。请不要因此把未修复的问题公开披露。

---

## 5. 针对使用者的加固建议

- 只从可信来源安装；安装前读 `index.js` 与 `lib/`。
- 不要在没有把握的机器上设置 `SW_3D_PREVIEW_PYTHON` 指向不受控的解释器。
- 不要把 DSH 的 Web 端口暴露到 `0.0.0.0` 或公网；本插件的路由按「本机已认证」的前提设计。
- 若不需要 STEP 解析，可以不装 `cadquery-ocp`——但注意这会让 `.step/.stp/.sldprt/.sldasm` 全部失败，
  而不是降低风险（Python 探测仍会跑）。
- 定期看一眼 `%LOCALAPPDATA%\sw-3d-preview\` 里有什么，确认没有你预期之外的产物。
