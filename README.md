# dsh-sw-3d-preview · 3D 成果预览（DSH 插件）

在 **DSH 的文件预览面板**里直接看 3D 模型：STEP / STL / OBJ 解析成网格，SolidWorks 原生件自动找同名 STEP，
配上面/边/点拾取、Alt 三点法取样、剖切封盖、草图叠加层、双击标记、标注落盘与「交接单」——
用来把「我看到的问题」变成「agent 能照着改的坐标」。

- 插件包名：`dsh-sw-3d-preview`
- 版本：`0.2.2`（变更见 [CHANGELOG.md](./CHANGELOG.md)）
- 许可：`MIT`（见 [LICENSE](./LICENSE)）—— 可自由使用、修改、分发
- 支持平台：DSH Desktop（Web 界面），Windows

> 截图产物位置：本插件自己不存示例图，用户点「填入对话框 / 保存标注」时生成的用户视角截图在
> `%LOCALAPPDATA%\sw-3d-preview\shots\`（文件名 = `<sha1(模型路径小写)>-<时间戳>.png|.jpg`）。
> 打开这个目录就有真实产物，本文档不内嵌大图。

---

## 目录

1. [这是什么 / 解决什么问题](#1-这是什么--解决什么问题)
2. [安装（从零开始）](#2-安装从零开始)
3. [依赖：必须的与可选的](#3-依赖必须的与可选的)
4. [支持的文件格式与四级降级](#4-支持的文件格式与四级降级)
5. [可选功能清单](#5-可选功能清单)
6. [已知限制](#6-已知限制)
7. [跨电脑注意事项](#7-跨电脑注意事项)
8. [故障排查](#8-故障排查)
9. [开发与测试](#9-开发与测试)
10. [数据目录与文件清单](#10-数据目录与文件清单)

---

## 1. 这是什么 / 解决什么问题

一句话：**把 SolidWorks/STEP 的 3D 模型塞进 DSH 的文件预览面板，并让标注能精确回到面/边/点。**

解决的具体问题：

- DSH 能预览图片和文本，但 `.step` / `.sldprt` 打开只有十六进制或「不支持」；
- 靠文字描述「那个凸台旁边的圆角」给 agent 极不可靠，人和模型对不上位置；
- 截图能看出样子但看不出尺寸/面号，agent 无法据此改模型；
- 想复核一个 STEP 却要开 SOLIDWORKS（几 GB、几十秒、还可能占授权）。

本插件把这些替掉：预览面板里直接出实体、能拾取面/边/点、能记录坐标、能一键生成给 agent 的交接单。

**它不做的事**：不改模型、不做 CAD 建模、不需要（也不启动）SOLIDWORKS。右键菜单里
「添加草图 / 编辑成型草图 / 倒圆角 / 作为基准 / 设为基准点」只**生成自然语言指令**填进输入框，不会真的改几何（见[已知限制](#6-已知限制)）。

---

## 2. 安装（从零开始）

### 2.1 前置

| 项 | 要求 | 怎么确认 |
| --- | --- | --- |
| DSH | Desktop 版，`>= 0.2.1-rc.3 < 0.3.0-0`（见 `package.json` 的 `engines.dsh`） | `dsh --version` |
| Node | `>= 22`（`engines.node`）；本机 DSH 自带 Node 24.21.0 | `node --version` |
| Python + OCP | **必须**，否则 STEP/STL/OBJ 全都不出实体（见 3.1） | `npm run verify:python` |

### 2.2 装进 profile（二选一）

**方式 A：目录链接（开发/本机常用，改代码立即生效）**

```powershell
# 1) 把插件目录放到任意位置，例如 D:\tools\dsh-sw-3d-preview
# 2) 在 profile 的 package.json 里登记（link: 指向插件目录）
$profileDir = "$env:USERPROFILE\.dsh\profiles\desktop"
notepad "$profileDir\package.json"
```

在 `dependencies` 加一行、在 `dsh.profile.bundles` 加一项：

```jsonc
{
  "dependencies": {
    "dsh-sw-3d-preview": "link:D:/tools/dsh-sw-3d-preview"
  },
  "dsh": { "profile": { "bundles": [ /* …原有项… */ "dsh-sw-3d-preview" ] } }
}
```

然后建 junction（`link:` 需要目录真的在那个位置）：

```powershell
New-Item -ItemType Junction `
  -Path   "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-sw-3d-preview" `
  -Target "D:\tools\dsh-sw-3d-preview"
```

**方式 B：装打包好的 tgz（交给别人时用这个）**

```powershell
npm run package
# 产物：dist\dsh-sw-3d-preview-0.2.2.tgz
npm install --prefix "$env:USERPROFILE\.dsh\profiles\desktop" "<插件目录>\dist\dsh-sw-3d-preview-0.2.2.tgz"
```

装完把 `dsh-sw-3d-preview` 加进 profile `package.json` 的 `dsh.profile.bundles`（`dependencies` 由 npm 写）。

### 2.3 重载

- **Host 半边**（8 条 `/sw3d/*` 路由）：改 `index.js`/`lib\*` 后重启 DSH 最稳（Loader 里 HMR 对新增路由不保证）。
- **Client 半边**（预览面板本体）：`client.js` 由 `/plugins/...` 路由按 rev 提供；改完刷新页面。
  **不要**指望「关掉插件页那一行就能热切换」——两半绑在一条 patch 上，见下。

### 2.4 装完怎么确认（可复制）

**① 路由注册了吗** —— 未登录访问应该得到 `401`（信任栅栏生效），而不是 `404`（路由不存在）：

```powershell
$base = "http://127.0.0.1:56946"   # 换成你当前 DSH 的实际端口
foreach ($p in "/sw3d/ping","/sw3d/resolve","/sw3d/mesh","/sw3d/three.js","/sw3d/annotation","/sw3d/handoff","/sw3d/snapshot","/sw3d/sketches") {
  try { $null = Invoke-WebRequest "$base$p" -UseBasicParsing -ErrorAction Stop; "$p -> 200" }
  catch { "$p -> $([int]$_.Exception.Response.StatusCode)" }
}
```

判定：**8 条全是 401 = 路由都在**；任何一条 `404` = 该路由没注册（插件没挂上或版本不对）。
本机实测（2026-11-15，DSH 0.2.2-rc.3）：`ping / resolve / mesh / three.js / annotation` 等均返回 `401`。

**② Python 找得到吗**

```powershell
Set-Location <插件目录>
npm run verify:python
```

输出里 `"ok": true` 且 `"ocp": true` 才算 STEP 可用；失败会列出**每个候选**的失败原因。

**③ 客户端加载了吗** —— 在浏览器开发者工具里看有没有拉 `client.js`：

```powershell
# 页面正常打开、面板里能选中 .step 文件并出图 = 客户端已加载
# 更强的证据：浏览器 Network 里存在 /plugins/...client.js 的 200 响应，
# 或 DevTools Console 里执行下面这行应返回 true
#   !!document.querySelector('canvas')  （打开一个 STEP 预览后）
```

> 说明：`/plugins/??<package>/client.js&rev=<rev>` 里的 `rev` 是 DSH 按客户端产物内容算出的短哈希，
> **不是固定值**，从 URL 里直接拼一个 `rev=0` 会拿到 `404`。要确认客户端，用「预览面板能出图」
> 或浏览器 Network 面板，而不是手工构造 URL。本机实测：手工构造的 `rev` 一律 `404`。

---

## 3. 依赖：必须的与可选的

### 3.1 必须

| 依赖 | 用途 | 缺了会怎样 |
| --- | --- | --- |
| **Node ≥ 22** | Host 半边运行环境 | 插件完全不加载 |
| **Python + `cadquery-ocp`**（OCP 8.x） | STEP/STL/OBJ 的三角化（`lib\step_mesh.py`） | `PYTHON_MISSING`：只有 `.stl`/`.obj` 能勉强走内置解析器，**`.step/.stp/.sldprt/.sldasm` 全部失败** |
| 可写的 `%LOCALAPPDATA%` | 缓存、标注、截图、交接单 | 缓存写不进去 → 每次都重算；标注 `INTERNAL` |

装 OCP：

```powershell
py -3 -m pip install cadquery-ocp      # 或用你装 OCP 的那个 python
python -m pip install cadquery-ocp
```

**本插件怎么找 Python**（`lib\mesh.js:139 pythonCandidates()`，顺序即优先级，任一条失败都会记录原因）：

1. 环境变量 `SW_3D_PREVIEW_PYTHON`（显式指定，最高优先）
2. sw-mcp 数据根下的 venv：`%LOCALAPPDATA%\sw-mcp\.venv`（数据根可用 `SW_MCP_DATA` 覆盖）
3. DSH profile `package.json` 里以 `link:` / `file:` 指向的、且带 `.venv` 的 sw-mcp 仓库
4. 插件目录同级的 `sw-mcp\.venv`（有人把两者平级放）
5. `py -3`
6. `python`
7. `python3`

> **源码里不含任何一台机器的绝对路径**。想显式指定就这样设（然后**重开 DSH**，环境变量是宿主进程读的）：
>
> ```powershell
> [Environment]::SetEnvironmentVariable('SW_3D_PREVIEW_PYTHON','C:\Python312\python.exe','User')
> ```

### 3.2 可选

| 依赖 | 用途 | 缺了会怎样（降级到哪） |
| --- | --- | --- |
| **sw-mcp**（`%LOCALAPPDATA%\sw-mcp\projects\*.json`，**只读**） | ① 由 `designId` 反查草图数据；② 文件名（相对路径）补全成绝对路径 | 草图叠加层不可用；只给文件名时可能 `NOT_FOUND`。实体预览不受影响 |
| `vendor\three.cjs`（2.1 MB） | `/sw3d/three.js` 路由的原样返回 | 该路由 404、`ping.three=false`。**不影响预览**：three.js r187 已内联在 `client.js` 里 |
| 浏览器 WebGL | 渲染 | 面板显示失败卡片（`SNAPSHOT_DRAW_FAILED` 一类的画布错误也来自这里） |
| 会话输入框（`inputActions`） | 「填入对话框」「含截图」通道 A | 自动降级：文本走剪贴板、截图走通道 B（落盘 + 路径） |

---

## 4. 支持的文件格式与四级降级

| 扩展名 | 处理方式 | 结果 |
| --- | --- | --- |
| `.step` / `.stp` | `lib\step_mesh.py`（OCP）三角化 → S3DM v2 | 完整：面、边、点、剖切、精度档全可用 |
| `.stl`（binary / ASCII） | 内置解析器（`lib\mesh.js` `parseStl`） | 只有三角面，**没有 B-rep 拓扑**：面按平面法向归并、边线框为空（`warnings` 会写明） |
| `.obj` | 内置解析器（`parseObj`，支持 `f a/b/c`、负索引、多边形扇形三角化） | 同上 |
| `.sldprt` / `.sldasm` | 四级降级，见下 | 看降级到哪一级 |

**SolidWorks 原生件的四级降级**（`lib\resolve.js:311` 起，`resolveSource`）：

| 级 | 条件 | `meshSource` | 用户看到什么 |
| --- | --- | --- | --- |
| ① 同名 STEP | 同目录存在同名 `.step/.stp` | `sibling-step` | 正常实体；hints 说明「SLDPRT 本身不能解析，已用同名 STEP」 |
| ② 相似名 STEP | 没有同名，但有名字最像 + 修改时间最新的 STEP | `fallback-step` | 正常实体 + 警告「这是按文件名相似度猜的，可能不是同一个零件」+ 相似度百分比 |
| ③ 草图视图（sketch-only） | 没有可用 STEP，但 sw-mcp 里有该设计的草图记录 | `sketch-only` | 只画草图轮廓，**零实体**；信息条列出被禁用的能力 |
| ④ 报错 | 连草图都读不到 | — | `NO_MESH_SOURCE` + 可直接复制的下一步（`deliver kind="step" designId=…`）+ 原生件的时间/大小 |

### 4.1 草图视图（sketch-only）到底是什么

**是什么**：读 `%LOCALAPPDATA%\sw-mcp\projects\<designId>.json` 里的草图/尺寸记录（只读），
把每条草图折线画成 3D 线框。用于「这个零件只有草图、永远导不出 STEP」的场景
（例如 `fracture-section-01`），避免对它推「去导出 STEP」这种**死循环提示**。

**能做什么**：旋转/缩放/平移视角、看草图轮廓走向、看草图条数与折线数、看 designId、截图，
以及**点选草图的折线与端点**（草图内部优先级 端点 > 折线 > 整条草图，见第 5 节表格第 12 项）。

**不能做什么**（`client.js:4318 SKETCH_ONLY_DISABLED`，UI 与文案同源；注意第 1 项只禁「实体的」拾取，
草图折线/端点仍可点选）：

| 能力 | 为什么不可用 |
| --- | --- |
| 实体面/边/点拾取 | 没有实体，没有可拾取的 B-rep 几何（草图折线与端点仍可点选） |
| 剖切/封盖 | 剖切是对实体做的 |
| Alt+三点取样 | 取样取的是实体面上的点 |
| 着色/线框切换 | 没有三角面可着色 |
| 边线 | 没有任何 B-rep 边 |
| 精度档 | 草图没有三角化过程 |
| 双击标记 | 标记要挂在面/边/点上（**实体**面/边/点；草图折线与端点上的标记仍然可以放，双击或右键「标记此处」） |

---

## 5. 可选功能清单

每项都是「怎么开 / 有什么用 / 缺什么依赖 / 失败会怎样」。全部**默认可用**，没有总开关。

| # | 功能 | 怎么开 | 有什么用 | 缺依赖时 |
| --- | --- | --- | --- | --- |
| 1 | **剖切与封盖** | 工具栏剖切控件选轴 + 拖动百分比；「封盖」勾选框 | 看内部结构：沿 X/Y/Z 切开，封盖用几何法算**真断面**（不是 stencil 假面），关掉封盖则内壁用压暗 40% 的双网格 | 草图视图下不可用；断面闭环算不出来时（开口环被丢弃 / 没有闭合轮廓 / 没有断面三角形）封盖会跳过并在 Console 打 `[sw3d] 剖切封盖跳过` |
| 2 | **精度三档** | 工具栏「精度」：高 / 中（默认）/ 低 | 高 `deflection 0.04 / 上限 900k 三角`、中 `0.08 / 300k`、低 `0.2 / 120k`；档位进缓存键，同文件不同档各存一份 | 需要 Python+OCP（走 STEP 三角化）。缺了 → `PYTHON_MISSING`。三角形 > 500k 会提示可一键切低精度 |
| 3 | **面 / 边 / 点拾取** | 鼠标悬停高亮，点击选中 | 拾取优先级 **顶点 > 边 > 面 > 草图端点 > 草图折线 > 整条草图**（实体永远压住草图）；卡片显示面号/面积/法向、边号/长度/端点、点坐标；被剖切裁掉的对象不可选 | 草图视图：没有实体，只能点草图；STL/OBJ：面有（按法向归并）、边为空 |
| 4 | **三点法标注** | **Alt + 在同一个面上点 3 次** | 在 SOLIDWORKS 里重新定位同一个面：模型坐标系下的 3 个点写进标注与交接单 | 需实体面。超过 3 点不再增加（`MAX_SAMPLE_POINTS=3`） |
| 5 | **双击标记** | 双击面/边/点 | 在该对象上放一个带序号的标记点（「持久意图」）；每次双击都会新增一个（代码里没有按对象去重） | 草图视图：只能放草图折线与端点上的标记（双击或右键「标记此处」），**实体**面/边/点上的标记不可用。**标记活在内存里，刷新页面即丢**（见限制） |
| 6 | **右键菜单** | 在面/边/点上右键（空白处右键也有） | 对象上：「标记此处」+ 生成建模指令（面：添加草图/编辑成型草图；边：倒圆角倒角/作为基准；点：设为基准点）。**草图对象上另有**「编辑这条草图」「全选本草图」「把所选填进对话框」。空白：「适配」「重置视角」「复制当前截图到对话框」 | 下拉项只**生成指令文本**，不改模型 |
| 7 | **草图叠加层** | 工具栏「草图」开关 | 只读叠加：把 sw-mcp 里这个设计的草图轮廓画在实体旁边/里面，对照「模型背后的草图长什么样」 | 需要 sw-mcp 记录 + designId。没有 → `NO_DESIGN` / `NO_SKETCH_DATA`，工具栏给出提示，不影响实体预览 |
| 8 | **草图视图降级** | 自动 | 见 4.1 | 见 4.1 |
| 9 | **用户视角截图（含「含截图」勾选 + 两条通道）** | 「含截图」默认**勾上**；点「填入对话框」或「保存标注」时自动截图 | 把用户当前这一屏（含底部信息带：视角/剖切/精度/时间）交给 agent 读图 | **通道 A**（草稿附件，`conversation.createDrafts`）→ 失败自动降级 **通道 B**（POST `/sw3d/snapshot` 落盘，返回 `shotPath`，路径写进文本框）。两条都失败：文本照填、按钮不失效 |
| 10 | **标注交接单（handoff）** | 保存若干标注后点生成交接单 | 把该文件全部标注汇总成一份 Markdown（`%LOCALAPPDATA%\sw-3d-preview\handoff\<sha1>.md`），用户把**路径**丢给 agent，不用把几十条标注塞进输入框 | 需要至少一条标注；失败 → `HANDOFF_FAILED`/`INTERNAL`（`lib\handoff.js:117`） |
| 11 | **标注持久化（`annotations.jsonl`）** | 「保存标注」自动追加 | 每行一条 JSON（`id / at / file / fileHash / annotation`），按文件 sha1 归属；重开面板会读回来并在卡片上标出已标注的边 | 写失败 → `INTERNAL`「标注没写进去」（`index.js:1000`） |
| 12 | **草图折线与端点拾取 + Ctrl/Cmd 多选** | 在草图视图或叠加层里直接点折线/端点；**Ctrl（macOS 为 Cmd）+ 左键**切换选中；Esc 清空 | 拾取优先级 **草图端点 > 草图折线 > 整条草图**（射线阈值：折线 `diagonal × 0.012`、端点 `diagonal × 0.018`，端点容差更宽）。**注意：最后那一档「整条草图」在真实鼠标路径上不可达**（见限制第 18 条），整条草图的活入口是右键「编辑这条草图」。**实体拾取（顶点/边/面）永远压过草图**。不按修饰键点击 = **替换**选中，按住 Ctrl/Cmd 点击 = 在该对象上**切换**（已选 → 取消，未选 → 加入）；跨类型可同时选线与点；**不按修饰键**点空白或 Esc 清空；**Ctrl/Cmd + 点空白什么都不做**（Ctrl 是累积语义，手滑不该清空）。**Shift+左键仍是平移、Ctrl+拖动仍是旋转**——只有「没拖动」的 Ctrl 单击才算多选。信息条汇总成一行 `已选 N 条线、M 个点（合计 X.X mm）`；右键菜单多出「全选本草图」「把所选填进对话框」（后者生成可复制的指令文本）以及「编辑这条草图」（与面板里那个按钮走同一个生成函数 `sketchEditInstructionFor`，`client.js:6005`，两处文本永远一致）。全选只放在右键菜单里，**不抢浏览器/宿主的 Ctrl+A** | 需要草图数据（草图视图或叠加层）。没有草图时这些入口不出现 |

**截图通道细节**：PNG 超过 1.5 MB 会自动重编成 JPEG(0.9)（`client.js:1008`）；宿主侧上限 8 MB、
文本体积上限 12 MB（`index.js:86` `MAX_SNAPSHOT_TEXT_BODY`）；宿主只认 PNG/JPEG **魔数**，扩展名与声明的 mediaType 不算数（`index.js:357` `sniffImageType`）。

---

## 6. 已知限制

诚实清单。**这些是现状，不是待办承诺。**

### 视觉表现未经真机验证

**这一整块没有任何验证，一项都没有。** 全部自动化测试跑的是**假 WebGL 渲染器**：`test\sketch-select.mjs`
里的 `HeadlessRenderer`（`test\sketch-select.mjs:703`），它的 `getContext()` **返回 `null`**
（`getContext()` 见 `test\sketch-select.mjs:64`、`:686`），`render()` 是空函数（`test\sketch-select.mjs:711` 的 `render() {}`）。
也就是说测试只验证「代码路径跑得通、数据算得对」，**从不产出一个像素**。

因此下面六项**零覆盖**，全部没有在真实浏览器里看过一眼：

1. **三种草图画面的颜色是否真的分得开**——现在一共三个颜色（见第 15 条）：
   选中琥珀 **`0xffe479`**、悬停覆盖层暗琥珀 **`0xa8903f`**（透明度 0.7）、整条草图强调 **`0x9af5d6`**（提亮的草图本色）。
   在深色模型、浅色模型、白色背景上分别看不看得清，两两**是否真的分得开**（颜色改开了，观感没验过）；
2. **线宽是否看得清**——草图折线、选中折线在大模型上会不会细成一根头发；
3. **端点小球大小是否合适**——球半径是 `diagonal * 0.0075`，在 30 mm 零件和 3 m 装配体上观感差多少；
4. **信息条会不会挡住模型**——右下角「已选 N 条线、M 个点」压在零件上的遮挡程度；
5. **`renderOrder` / `depthTest:false` 的层叠效果**——高亮强制画在实体之上（`depthTest:false`）后，
   被模型挡住的折线/端点会「穿透」显示，穿得对不对、有没有闪烁；悬停（`renderOrder` 4）与
   选中（`renderOrder` 5）叠在同一条线上时，压制顺序是否真的看上去是「选中压住悬停」；
6. **标记小球是否被模型遮挡**——标记点在后景时到底露不露出来。

结论：**代码和数据是对的，但「好不好看、挡不挡、看不看得见」没有答案。**
装到真机上第一件事应该是拿一个真实 STEP 把这六项逐条看一遍，而不是假设它们没问题。

### 其它限制

1. **右键菜单不会改模型。** 「添加草图 / 编辑成型草图 / 倒圆角·倒角 / 作为基准 / 设为基准点」只生成一段自然语言指令填进输入框
   （`client.js:2198 CONTEXT_MENU_DEFS`，`behavior: 'draft'`），由 agent 决定要不要真的在 SOLIDWORKS 里做。
2. **标记点只在内存。** 双击放下的标记（`client.js:5007` 起 `var markers = [];`）不落盘、不写进 `annotations.jsonl`，
   **刷新页面/重开预览就丢**。要留存必须点「保存标注」（把当前对象的标注写盘）或用「把标记写入输入框」。
   另注：`addMarker`（`client.js:5123`）直接 `markers.push`，**没有按对象去重**——双击同一处会叠出多个标记。
3. **截图通道 A 依赖 DSH 包内 API，升级可能失效。** 通道 A 走 `ctx.get('conversation').createDrafts(...)` +
   `inputActions.addAttachments(...)`（`client.js:1869 attachSnapshotToDraft`），这是**包内接口**，不是公开契约。
   DSH 升级后若签名变化，表现是截图自动降级到通道 B（文本里出现 `shotPath` 路径），**不会报错也不会崩**。
   通道 B（`/sw3d/snapshot`）只依赖本插件自己的路由，稳定性好得多。
4. **`/sw3d/three.js` 这条路由是历史遗留。** 核实的证据：
   - `client.js:9220` 起已**内联** three.js r187（`begin vendor/three.cjs`；内联段一直到 `client.js:90595` 的
     `end vendor/three.cjs`），预览不需要请求这条路由；
   - `client.js` 里**没有任何** `/sw3d/three.js` 的 fetch（全文搜不到该字符串；只请求
     `/sw3d/ping|resolve|mesh|annotation|handoff|snapshot|sketches`）；
   - `test\host.mjs:740` 仍然断言它：`vendor\three.cjs` 存在时期望 200，`ping.three` 在 `test\host.mjs:1154` 断言为 `true`。

   结论：**它对预览不是必需的，但有测试断言、`ping.three` 也在报它的存在性，所以不能删**。保留现状
   （`index.js:860 handleThree` 原样返回）。打包时必须带上这 2.1 MB，否则 `ping.three` 变 `false` 且该路由 404。
5. **sw-mcp 没实体时的死循环提示（已修）。** 早期对「只有草图、永远导不出 STEP」的原生件会一直提示「去导出 STEP」。
   现在 `lib\resolve.js:376` 起先探测草图记录，有就返回 `sketch-only` 并明说「这个设计只有草图（零实体），导不出 STEP」。**未标注修复日期**。
6. **草图视图没有实体，不能做实体拾取/剖切/取样/标精度，也不能做「实体」面/边/点上的标记**（草图折线与端点上的标记仍可放，双击或右键「标记此处」；见 4.1 表）。**草图折线与端点仍可点选**（见第 5 节第 12 项）。
   这是设计使然，不是 bug。
7. **`index.js` 导出 `Config`，插件页里有配置项（但只有一个）。** `Config` 由 `createExtConfigSchema()` 生成（`index.js:78`），目前只暴露 Bearer 旁路两项：`extToken`（空 = 关闭）与 `extTokenScopes`（默认 `['read']`），见 `cordis.patch.yml`。
   其余旋钮仍是环境变量（`SW_3D_PREVIEW_PYTHON` / `SW_MCP_DATA` / `LOCALAPPDATA`）；改端口、改上限必须改代码。
8. **`test\host.mjs` 内部写死了本机样例路径**（`test\host.mjs:26` 附近 `C:\Users\<user>\Desktop\工程自动化`）。
   这是**测试脚本**的本机假设，不进打包产物；换机器跑测试时会 `skip`（不是失败）。打包自检不依赖它。
9. **标注的并发写**由进程内 Promise 串行化保证（`index.js` `withAnnotationLock`），**多 DSH 实例同时写同一个
   `annotations.jsonl` 不保证安全**（后写覆盖风险极低但非零）。
10. **单位**按 mm 处理（STEP 与 bbox 都按 mm 解释）。若源模型是英寸/米，尺寸显示会不对，但不会崩。

### 草图折线/端点拾取与多选的限制

11. **圆弧/圆的长度是弦长和，不是解析弧长，会偏小。** 草图里的圆弧/圆是用折线逼近的
    （`lib\sketches.js:36` `CIRCLE_SEGMENTS = 48`、`:38` `ARC_SEGMENTS = 16`），信息条里的「合计 X.X mm」
    是把这些弦长直接相加。数字比真实弧长**小**：
    - 整圆按 48 边形 → 偏小约 **0.071%**（`48·sin(π/48)/π = 0.999286…`）；
    - 圆弧默认 16 段 → 偏小约 **0.64%**（`16·sin(π/16)/π = 0.993587…`）。

    这两条是拿公式算出来的，不是估的。段数越多越接近真值，但**永远小于真值**（弦短于弧）。
    做精细校核别信这个汇总值。
12. **草图端点只认折线顶点。** 能点到的「端点」就是折线里的顶点坐标。圆弧/圆是折线逼近，
    所以**拿不到真正的圆心、切点、约束端点**——上游 sw-mcp 草图数据里就没有这些概念。
    对圆点它给出的「端点」其实是 48 边形上的采样点。
13. **不可撤销。** **不按修饰键**点空白或按 Esc 就直接清空选择，没有选择历史、没有撤销栈（Ctrl+Z 不会恢复上一组选中）。
    误点空白只能重新一个个选回来。（Ctrl/Cmd + 点空白已经是「什么都不做」，所以按住 Ctrl 时手滑不会清空。）
14. **多选不做跨草图几何推理。** 能同时选多条草图上的线、点，也按草图分组显示了
    （`groupSketchSelectionBySketch`，`client.js:2793`），组名带「第 N 条 / 基准面名」
    （`sketchGroupIdentity`，`client.js:3042`）——**两条同名草图也能区分**。
    但**没有**做「跨草图求交 / 共线 / 距离」这类推理。
    「把所选填进对话框」只是把每个对象的数据按组列出来，几何关系要模型自己推。
    另注：只在一张草图里选时仍走**旧格式**（按组数分流，`client.js:2954` `var grouped = groups.length > 1;`），
    不会因为分组功能而丢掉「（属于特征「X」，绘制在 Y）」这几句。
15. **悬停与选中同色（修过两次，现在用三个不同颜色）。** 这条的**三个颜色**必须分开说，否则很容易又改错：

    | 用途 | 常量 / 值 | 位置 | `renderOrder` |
    | --- | --- | --- | --- |
    | **悬停覆盖层**（鼠标扫过的那条折线） | `SKETCH_HOVER_LINE_COLOR = 0xa8903f`，透明度 `0.7` | `client.js:2342` / `client.js:2344` | 4（`client.js:5236`） |
    | **选中**（Ctrl 多选里的折线） | `COLORS.sketchPick = 0xffe479`，透明度 `1` | `client.js:4517` | 5（`client.js:5224`） |
    | **整条草图强调**（悬停/整条选中把整条线染亮） | `SKETCH_EMPHASIS_COLOR = 0x9af5d6` | `client.js:2347` / 用于 `client.js:5252` | — |

    历史：第一次修是把**悬停覆盖层**从 `0xffe479` 换成 `0xa8903f`（那时以为问题只在覆盖层）。
    第二次才发现真正的病根在**整条草图强调色**：`SKETCH_LINE_STYLE_ON.color` 当时也等于
    `COLORS.sketchPick` 的 `0xffe479`，于是鼠标扫过整条草图时，画面上「已选中」与「同草图未选中」的
    ΔE76 = **0.00**（完全同色，多选高亮直接消失）——上一轮「已修」的结论是**不完整**的。
    现在整条草图改用提亮的草图本色 `0x9af5d6`，选中仍是 `0xffe479`，两者不再相等。
    **但真机观感仍未验证**：这三种颜色在深色/浅色模型上的实际对比度没有在任何浏览器里看过一眼（见上一节六项零覆盖）。
16. **草图视图悬停没有节流（已修）。** 上一轮这条写的是「节流判据只看 `triangleCount > 100000`，草图视图恒为 0，永不节流」。
    现在判据是 `hoverThrottleNeeded(model.stats, sketchStats)`（`client.js:79`）：三角面超阈值**或**
    草图「点数 + 段数」`> 8000`（`HOVER_THROTTLE_SKETCH_ITEMS`，`client.js:61`）就限帧到 `33 ms`（≈30 fps，
    `HOVER_THROTTLE_MS`，`client.js:63`），`setHover` 里真的用上了（`client.js:6364`）。
    端点扫描也不再逐点线性扫，而是走空间索引 `buildSketchPointIndex`（`client.js:2475`）。
    **实测**（50000 点 / 49900 段，同一进程同一份数据，各测 3 轮取平均）：

    | 对比项 | 数字 |
    | --- | --- |
    | 旧热路径（`c0aeeeb` 的 `setFromCamera` + `intersectObject`，只返回 `subject:'sketch'`） | 1.655 / 1.754 / 1.716 ms → 平均 **1.708 ms** |
    | 新实现（真 `pointermove` → `setHover` → `pickSketchCandidates`，含端点索引 + 段索引 + 段定位） | 0.350 / 0.359 / 0.335 ms → 平均 **0.348 ms** |
    | **同口径加速** | **4.91x** |
    | 索引缓存本身的贡献（同样新功能，只切 `entry.pointIndex` → `entry.polylines`） | 不缓存 0.900 / 0.902 / 0.953 ms → 缓存 0.350 / 0.370 / 0.351 ms = **2.57x** |

    > **口径更正**：这里以前写的是「2.501 ms → 0.273 ms（9.16x）」，那个数字**不可比**——两次测的
    > 不是同一条路径（旧数字拿的是一个只走到 `subject:'sketch'` 兜底档的旧热路径，新数字是完整的三档
    > 拾取），开发者已撤回。上表的 4.91x 是**同口径**重测：旧路径与新路径都按「一次真实悬停」计。
    > 索引缓存单独的贡献是 **2.57x**，两者不是一回事。

    这是**纯 JS 时间**（假渲染器 + Node 24），**不含 WebGL 提交与合成**；真机上的绝对毫秒数会不同，
    比例也未必完全一致。10000+ 点草图的拖影手感仍未在真机验证。
17. **`SKETCH_ONLY_DISABLED` 与工具栏禁用态是两个真理源。** `client.js:4318` 这个数组只喂**提示文案**，
    工具栏按钮到底禁不禁用，由 `isSketchOnly` 字面量（`client.js:8753`）独立决定。
    两处目前结论碰巧一致，但改一处不会带动另一处。注释已经改成实话，**但没有统一成一个来源**。
18. **`subject:'sketch'`（整条草图）那一档拾取路径不可达。** 800×600 按 6px 网格采 **13,400** 个屏幕点，
    命中 `sketchPoint` **21** 次、`sketchLine` **69** 次、`sketch` **0** 次（数字由
    `test\sketch-select.mjs:1731` 那条检查实测并断言）。原因是第 3 档（整条草图）与第 2 档（折线）
    用的是**同一阈值、同一批几何**，第 2 档必然抢先命中，第 3 档进不去。
    **推论：点击永远选不到「整条草图」。** 整条草图这个概念的**活入口只剩右键菜单的
    「编辑这条草图」（以及公开 API `selectSketch`）**。这是设计取舍、不是 bug，但维护者必须知道：
    `select()` 里 `picked.subject === 'sketch'` 那个分支（`client.js:6436`）是**死代码**——
    保留它是因为契约层面仍有测试（`pickSubjectByPriority` 直接传入 sketch 对象那一档）、
    未来若放宽折线容差也可能重新可达，但**不要**把它当成「整条草图能被点选」的证据。
19. **悬停节流的确定性由注入式时钟保证（这条已修）。** 上一轮这条写的是「时间窗依赖 `Date.now()`，
    测试最多重试 6 次，机器慢可能耗尽」。现在测试用 `setHoverClock`（`client.js:7166`）注入假时钟，
    **完全没有重试**：`test\sketch-select.mjs:1657` 起把时钟从 1000 ms 手动推进 +10 / +40 ms，
    确定性地构造「同一个 33 ms 窗口内」与「窗口已过」两种情形。把 `HOVER_THROTTLE_MS` 改成 3000
    （悬停彻底卡死）现在**必红**，旧写法反而全绿。真机上 10000+ 点草图的拖影手感仍未验证。
20. **`sketchPlane` 的真实产出未验证。** `lib\sketches.js:639` 里字段名是 `plane`，客户端读的是
    `entry.data.plane`（`client.js:5859`、`client.js:5883`）。但**没有跑过一次真实 SOLIDWORKS 取一份 payload
    确认这个字段非空**——现有测试用的都是仓库里的 fixture。若它为空，组名会退化成只有「第 N 条」，
    **仍可区分同名草图**，只是少了基准面那半截信息。
21. **右键不会选中（这是刻意的）。** 草图多选集合**非空**时，右键**任何**草图对象（折线/端点/整条草图）
    都**不改变选择**——`keepSelection` 的判据是「集合非空 + 命中项是草图对象」（`client.js:6186`），
    与「命中项是否已在集合里」无关。理由：这样「把所选填进对话框」拿到的一定是你真正选的那一组，
    不会因为右键了旁边那条线就把 2 条换成 1 条。**代价**是「右键某条线想单选它」不会生效——
    得先用**左键**点它、把多选替换成单条，再右键。集合为空时右键照旧选中该对象（老路径不变）。
    右键**实体**对象（面/边/点）不在此规则内，照旧单选并清掉草图多选。
22. **双击会清掉多选。** 多选 2 条后双击其中一条放标记，多选会**变成只有那 1 条**。
    因为双击走的是非 additive 的 `select(picked)`（`client.js:6667`），而 `select` 第一件事就是
    `clearSketchSelection({silent:true})`（`client.js:6397`）。这是「双击 = 选中这个并做点什么」这条
    语义的必然结果（见第 5 节第 5 项），但确实会让人以为「标记加上了、选择还在」。要保住多选就先
    多选 → 右键「标记此处」，别双击。
23. **`test\sketch-only.mjs:316` 硬编码 `client.js` 路径。** 那行是
    `fs.readFileSync(path.join(PLUGIN_DIR, 'client.js'), 'utf8')`，**不读 `SW3D_CLIENT` 环境变量**
    （`test\sketch-select.mjs` 与 `test\client-smoke.mjs` 都读）。后果是那 **14 项无法对变异体运行**：
    想验证「改坏 client.js 会不会被这 14 项抓住」时，改的是真实 `client.js`，跑的还是它——
    等于只能自测、不能做变异测试。这是**套件之间的不一致**，未修。

---

## 7. 跨电脑注意事项

**装到另一台电脑时，这些是环境相关、必须现场确认的：**

1. **路径与盘符**：插件本身**不含任何本机绝对路径**（`npm run test:package` 会扫产物，0 命中才算过）。
   但 profile 的 `package.json` 里那条 `link:D:/…` 是**那台机器的路径**，必须改成实际位置。
2. **`%LOCALAPPDATA%` 必须可写**：缓存 `/cache`、标注 `/annotations`、截图 `/shots`、交接单 `/handoff`、`recent.json` 都写在这里。
   只读环境或企业策略锁了 AppData 会导致：缓存每次都 miss（慢但能用）、标注 `INTERNAL`、截图全部降级失败。
3. **Python 装哪**：不要求在 PATH 上，也不要求叫 `python`。最稳的是显式指定：
   ```powershell
   [Environment]::SetEnvironmentVariable('SW_3D_PREVIEW_PYTHON','C:\Python312\python.exe','User')
   ```
   设完**重开 DSH**（宿主进程启动时读环境变量）。设错了不会卡死：会继续试后面的候选，`ping`/错误信息里能看到每个候选的失败原因。
4. **防火墙 / 回环**：所有 `/sw3d/*` 都是**本机回环**访问（`http://127.0.0.1:<port>`），不要对内网开放。
   每个路由都过 `ctx.connection.requestRejection` 信任栅栏（`index.js:12` 是这条约束的说明；具体调用在各 `handleXxx` 开头，如 `index.js:550` 的 `allowTrusted`），未认证请求得 `401`。
5. **端口会变**：`/sw3d/*` 挂在 DSH 自己的 Web 端口上（本次会话是 `56946`，每次启动可能不同）。
   插件内部用相对路径 `/sw3d/...`，**不需要改配置**；但你的**手工验证脚本**要换成当前端口（见 2.4）。
6. **多个 DSH 实例**：每个实例是独立宿主进程，各自探测 Python、各自写 `%LOCALAPPDATA%\sw-3d-preview`。
   缓存按「模型路径 + mtime + 大小 + 精度」做键，多实例共享同一份缓存文件——**并发写同一缓存键**理论上可能互相覆盖，
   实际是写临时文件再 rename（`index.js` `buildS3dm` 用 `.tmp` 后改名），不会读到半个文件。
7. **sw-mcp 是可选的**：换机器没有 sw-mcp 时，实体预览（STEP/STL/OBJ、同名 STEP 降级）**完全不受影响**，
   只是草图叠加层与「只给文件名时的路径补全」不可用。sw-mcp 数据根可用 `SW_MCP_DATA` 覆盖。
8. **不要把 `dist\` 提交进 git**：已在 `.gitignore` 里。产物会变（时间戳、内容哈希），提交进去只会制造噪声。
9. **`vendor\three.cjs` 在 `.gitignore` 里但必须随包分发**：它由 `package.json` 的 `files` 显式列名兜底
   （`files: [..., "vendor/three.cjs"]`），`npm pack --dry-run` 实测会带上它（连同它共 **16 个文件**）。
   如果手工拷贝目录而不走 npm，**记得单独拷这个 2.1 MB 文件**，否则 `/sw3d/three.js` 会 404、`ping.three=false`。

---

## 8. 故障排查

按症状查。每条都给「症状 → 原因 → 处理」，以及**代码出处**（文件:行号），行号对 `0.2.2` 有效。

| # | 症状（错误码/现象） | 原因 | 处理 | 出处 |
| --- | --- | --- | --- | --- |
| 1 | `PYTHON_MISSING`「没有找到能 import OCP 的 Python」 | 所有候选（env → sw-mcp venv → py -3 → python/python3）都不可用 | 看返回里 `error` 列出的每个候选失败原因；装 `cadquery-ocp` 或设 `SW_3D_PREVIEW_PYTHON` | `index.js:657`（`PYTHON_MISSING` 抛出点）、`lib\mesh.js:1056`（探测结论）、`lib\mesh.js:79`（`SW_3D_PREVIEW_PYTHON` 优先级起点） |
| 2 | `NO_MESH_SOURCE`（HTTP 422） | `.sldprt/.sldasm` 同目录没有可用 STEP，sw-mcp 里也没有草图 | 把同名 `.step` 放到同目录；或按 hint 里的 `deliver kind="step" designId=…` 让 agent 导出 | `lib\resolve.js:347`（`NO_MESH_SOURCE` 抛出处）、`lib\resolve.js:323`（通用 fail） |
| 3 | `NOT_FOUND`（HTTP 404/400） | 路径不存在/不是文件；或只给了文件名且 sw-mcp 记录与 `recent.json` 里都找不到 | 用资源面板确认绝对路径；先成功预览一次让它进 `recent.json`；检查 `%LOCALAPPDATA%\sw-mcp\projects\*.json` | `lib\resolve.js:247`（没给路径）、`lib\resolve.js:291`（补全后仍找不到） |
| 4 | `UNSUPPORTED` | 扩展名不在 `.step/.stp/.stl/.obj/.sldprt/.sldasm`；或 STEP 三角化失败（OCCT 读不进）；或请求体超限 | 换格式/重导出 STEP；看响应里的 `warnings`/`detail`（stderr 尾部） | `lib\resolve.js:332`（扩展名不支持）、`index.js:674`（三角化失败）、`index.js:695`（STL/OBJ 解析失败） |
| 5 | `BAD_REQUEST` | 缺 `path` 参数、body 不是 JSON、`path` 不是绝对路径、缺 `base64` 等 | 按 message/hint 改请求；`path` 用 `encodeURIComponent` 包 | `index.js:574`（`/sw3d/resolve` 缺 path）、`index.js:1132`（快照缺 base64）、`lib\sketches.js:717` |
| 6 | `SNAPSHOT_*`（`SNAPSHOT_DRAW_FAILED` / `SNAPSHOT_NO_SOURCE` / `SNAPSHOT_ENCODE_FAILED` / `SNAPSHOT_EMPTY` / `SNAPSHOT_READ_FAILED`） | 画布取不到像素（WebGL 缓冲区已丢弃）、浏览器不支持编码、图片 0 字节 | 先让预览真的渲染出一帧再截图；关掉硬件加速试试；这类失败**不影响文本填入** | `client.js:1507`、`client.js:1485`、`client.js:1650`、`client.js:1635`、`client.js:1691` |
| 7 | 截图没挂成附件，文本里出现 `%LOCALAPPDATA%\sw-3d-preview\shots\…png` | 通道 A 不可用（无会话 / 子代理会话 / `createDrafts` 签名变了），已自动降级通道 B | **正常降级，不用处理**：模型可以直接 `read_image` 那个路径 | `client.js:1869`、`client.js:1786`、`index.js:1157`（`shotPath` 写出） |
| 8 | `HANDOFF_FAILED` / 「生成交接单失败」 | 写 `handoff\<sha1>.md` 失败（AppData 不可写、磁盘满、路径不是绝对路径）。注意：`HANDOFF_FAILED` 是**客户端兜底码**，宿主回的是 `INTERNAL` / `BAD_REQUEST` | 检查 `%LOCALAPPDATA%\sw-3d-preview\handoff` 可写；看 DSH 日志 `[sw-3d-preview]` 堆栈 | `client.js:8649`（兜底码）、`lib\handoff.js:107`、`lib\handoff.js:117`、`index.js:1064`（`writeHandoffFile` 调用） |
| 9 | `PING_NOT_OK`「3D 服务状态异常」 | `/sw3d/ping` 没返回 `ok:true`（路由被别的插件占了、版本不匹配、插件没挂上） | 用 2.4 的脚本确认 8 条路由；确认 profile 的 `bundles` 里真有这一项 | `client.js:4369`（该码由客户端产生，`index.js` 里没有）、`index.js:549`（`handlePing`） |
| 10 | `NO_DESIGN` / `NO_SKETCH_DATA` / `PROJECT_UNREADABLE` | sw-mcp 里没有这个文件的 designId、`<designId>.json` 不是合法 JSON、或读不出来 | 让 agent 在 SOLIDWORKS 里 build 一次该设计；或直接传 designId | `lib\sketches.js:736`（`NO_DESIGN`）、`lib\sketches.js:750`（`PROJECT_UNREADABLE`）、`lib\sketches.js:618` / `lib\sketches.js:655`（`NO_SKETCH_DATA`） |
| 11 | `METHOD_NOT_ALLOWED`（HTTP 405）+ `Allow` 头 | 用错方法（例如对 `/sw3d/mesh` 用 POST） | 按 `Allow` 头改；`/sw3d/mesh|resolve|ping|three.js|sketches` 是 GET/HEAD，`/sw3d/snapshot` 是 POST，`/sw3d/annotation|handoff` 是 GET/POST | `index.js:524`（405 与 `Allow` 头在 `allowMethods` 里）、`index.js:1099`（`/sw3d/snapshot` 只允许 POST 的调用点） |
| 12 | 面板一直「正在解析路径…」 | 资源 stat 迟迟不 live；只给文件名时宿主补全失败 | 硬超时 20 s 会转失败卡片（`PATH_HARD_TIMEOUT_MS`）；重新从文件列表打开该文件 | `client.js:90`（`PATH_RESOLVE_GRACE_MS`）、`client.js:92`（`PATH_HARD_TIMEOUT_MS`）、（失败卡片）`client.js:9009` |
| 13 | 卸载后某些接口 404、界面还在 | **拆成两行 patch** 会让 Host 与 Client 不同步 | 只用一条 patch（`cordis.patch.yml` 里只 insert 一行），见文件头注释 | `cordis.patch.yml:1` |

> 未核实：`INSTANCE_NOT_BOUND` 这个错误码**在本插件代码里不存在**，属误传；不要按它排查。

---

## 9. 开发与测试

```powershell
npm test              # host + package + python-candidates + client-smoke + sketch-select + sketch-only + ext-token 七套（离线；host 里 STEP 样例缺失时自动 skip）
npm run test:host     # S3DM 往返 / STEP 三角化 / 四级降级 / STL+OBJ / 路由 / 端到端 http
npm run test:package  # 打包自检 16 项（必需文件、lib 清单完整性、vendor、本机路径、tgz 可解、自检不是永真）
npm run test:client   # client.js 纯函数层 87 项（不依赖 vendor/three.cjs）
node test\sketch-select.mjs  # 草图折线/端点拾取 + Ctrl 多选 61 项（其中 27 项是「回归 / 阻断项 / 必改」断言）
node test\sketch-only.mjs    # 草图视图降级（禁用清单/提示/截图信息带）14 项
npm run package       # 产出 dist\dsh-sw-3d-preview-0.2.2\ 与 .tgz，并打印自检结果
npm run verify:python # 打印 python 探测结果（含每个候选的失败原因）
```

> `test\sketch-parse.mjs` 没有独立入口：它导出 `registerSketchParseTests(check)`，由
> `test/client-smoke.mjs:2428` 注册进那 87 项里（其中草图解析 6 项）。单独 `node test\sketch-parse.mjs`
> 会以退出码 0 静默结束、**什么都不跑**——别把它当成一套独立测试。

**约定**

- `index.js`（Host）与 `client.js`（Client）是**产物文件**（`client.js` 约 2.5 MB，内含内联 three.js），
  改它们要同步跑 `test/client-smoke.mjs`。
- `lib\mesh.js` 不依赖 DSH 运行时，可被 node 直接 import（所有 `lib\*.js` 都遵守这一点）。
- `lib\step_mesh.py` 单独可跑：`python lib\step_mesh.py --in a.STEP --out a.s3dm --deflection 0.08`。

---

## 10. 数据目录与文件清单

**本插件写入（只写自己的目录）**：`%LOCALAPPDATA%\sw-3d-preview\`

| 路径 | 内容 |
| --- | --- |
| `cache\<sha1>.s3dm` | S3DM v2 网格缓存，键 = `sha1(路径小写|mtime|字节|deflection|ang:夹角|crease:折痕角|max:maxTriangles)`（`lib/mesh.js:451-456`） |
| `annotations\annotations.jsonl` | 标注，按行 append，一行一条 |
| `shots\<sha1>-<ts>.png\|.jpg` | 用户视角截图（通道 B） |
| `handoff\<sha1>.md` | 标注交接单 |
| `recent.json` | 最近成功解析的路径（用于文件名补全） |

**本插件只读**：`%LOCALAPPDATA%\sw-mcp\projects\*.json`（sw-mcp 设计记录，`SW_MCP_DATA` 可覆盖数据根）。

**随包分发的文件**（`package.json` 的 `files`；`npm pack --dry-run` 与 `scripts\package.mjs` 都实测 **16 个文件**，
解包后仅 `vendor\three.cjs` 一项就有 2.1 MB。下面只列**不随文档编辑变化**的那些文件的精确字节数；
`README.md` / `CHANGELOG.md` 两行不写数字——无论谁改一次文档，字节数立刻失效，写在这里的只会变成假的。
也**不写「产物总字节数」**：它把本文件自己算进去，文档一改就自我指涉、必然过期。
**本表由 `node scripts/sizes.mjs` 生成**——数字那几列由脚本从 `scripts\package.mjs` 的随包清单算出，
改完代码跑一次即可；`--check` 模式会在数字与磁盘不一致时让 CI 红。说明文字与行序是手写的，脚本不动。

<!-- sizes:begin -->
```
index.js            49,775       Host 半边：8 条 /sw3d/* 路由
client.js        2,533,655       浏览器半边（含内联 three.js r187）
cordis.patch.yml     1,441       只 insert 一行插件
package.json         2,070
README.md                         本文件（字节数随编辑变化，不列）
CHANGELOG.md                      字节数随编辑变化，不列
lib\mesh.js         45,600
lib\resolve.js      25,772
lib\sketches.js     34,457
lib\paths.js         8,943
lib\handoff.js       5,918
lib\ext-token.js     9,106       Bearer 旁路的 token 解析与 scope 判定
lib\step_mesh.py    39,879
vendor\three.cjs 2,126,774       /sw3d/three.js 的数据源（预览不依赖，但测试与 ping.three 依赖）
```
<!-- sizes:end -->

**不随包**：`dist\`、`node_modules\`、`snapshots.jsonl`、`test\`、`tools\`、`scripts\`（打包脚本自己不需要跟着走，
但留在仓库里方便重新打包）。
