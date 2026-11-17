# dsh-sw-3d-preview

**SOLIDWORKS 建模自动化链路的「眼睛」：把 agent 刚建出来的零件画出来，好让你确认它到底建对不对。**

DSH 里 agent 通过 sw-mcp 驱动 SOLIDWORKS 建模，但建完只有一句文字结果——对不对、是不是那个形状，
人看不见，模型自己也看不见。这个插件补上这一环：把 `deliver` 出来的 STEP/STL/OBJ 解析成网格画进文件预览面板，
你看着它确认，再把「这个面不对」变成一组**面号+坐标**的标注交回给 agent 去改。

典型往返：

```
agent 建模 → deliver STEP → 插件出图 → 你看出问题 → 拾取面/边/点 + 三点取样 → 交接单（Markdown）
   ↑                                                                                    │
   └──────────────────── 把路径丢给 agent，它照坐标改模型 ←───────────────────────────────┘
```

它**不建模型、不改模型、不启动 SOLIDWORKS**——建模是 sw-mcp 的事，这里只负责「看见」和「说清哪里不对」。

- 包名 `dsh-sw-3d-preview`，版本 `0.2.2`（[CHANGELOG](./CHANGELOG.md)），MIT

---

## 安装

需要 **Node ≥ 22** 和 **Python + `cadquery-ocp`**（STEP 三角化全靠它）。

```powershell
py -3 -m pip install cadquery-ocp
```

装 OCP 的 Python 不必在 PATH 上。插件按顺序找：`SW_3D_PREVIEW_PYTHON` 环境变量 →
`%LOCALAPPDATA%\sw-mcp\.venv` → profile 里指向的 sw-mcp 仓库 → 插件同级的 `sw-mcp\.venv` →
`py -3` / `python` / `python3`。想指定就设环境变量，然后**重开 DSH**：

```powershell
[Environment]::SetEnvironmentVariable('SW_3D_PREVIEW_PYTHON','C:\Python312\python.exe','User')
```

**装进 profile**（二选一）：

```powershell
# A. 开发用：目录链接，改代码立即生效
#    profile 的 package.json 里加依赖和 bundle，然后建 junction
New-Item -ItemType Junction `
  -Path   "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-sw-3d-preview" `
  -Target "D:\tools\dsh-sw-3d-preview"

# B. 交给别人：装打包好的 tgz
npm run package
npm install --prefix "$env:USERPROFILE\.dsh\profiles\desktop" "<插件目录>\dist\dsh-sw-3d-preview-0.2.2.tgz"
```

两种方式都要把 `dsh-sw-3d-preview` 加进 profile `package.json` 的 `dsh.profile.bundles`。

**确认装好了**：未登录访问 8 条 `/sw3d/*` 路由应全部返回 `401`（路由在、信任栅栏生效）；
任何一条 `404` 说明插件没挂上。端口换成你当前 DSH 的：

```powershell
$base = "http://127.0.0.1:61489"
foreach ($p in "/sw3d/ping","/sw3d/resolve","/sw3d/mesh","/sw3d/three.js","/sw3d/annotation","/sw3d/handoff","/sw3d/snapshot","/sw3d/sketches") {
  try { $null = Invoke-WebRequest "$base$p" -UseBasicParsing -ErrorAction Stop; "$p -> 200" }
  catch { "$p -> $([int]$_.Exception.Response.StatusCode)" }
}
npm run verify:python   # 输出里 "ok": true 且 "ocp": true 才算 STEP 可用
```

---

## 用法

打开任意模型文件，预览面板就出图。工具栏和右键菜单里是这些：

| 做什么 | 怎么操作 |
| --- | --- |
| 看内部结构 | 工具栏「剖切」选轴拖动；「封盖」用几何法算真断面（不是假面） |
| 换精度 | 工具栏「精度」高/中/低（默认中）。三角形过多会提示切低档 |
| 选中面 / 边 / 点 | 悬停高亮、点击选中，卡片显示面号面积法向、边号长度端点、点坐标 |
| 三点取样 | **Alt + 同一个面上点 3 次** → 记下模型坐标系里的 3 个点，可在 SOLIDWORKS 里复位该面 |
| 放标记 | 双击面/边/点（草图折线与端点也可以） |
| 对照草图 | 工具栏「草图」开关，把 sw-mcp 里的草图轮廓叠上来 |
| 多选草图 | Ctrl/Cmd + 左键切换选中，信息条汇总总长；右键「全选本草图」「把所选填进对话框」 |
| 交给 agent | 「保存标注」落盘 → 「生成交接单」得到一份 Markdown，把**路径**丢给 agent |
| 带截图 | 「含截图」默认勾上，截图会附在草稿里；失败自动降级成落盘路径 |

右键菜单里的「添加草图 / 倒圆角 / 设为基准点」等只**生成自然语言指令**填进输入框，
由 agent 决定要不要真去 SOLIDWORKS 里做。**插件本身不改模型。**

---

## 支持的格式

| 扩展名 | 处理方式 |
| --- | --- |
| `.step` / `.stp` | `lib\step_mesh.py` 用 OCP 三角化，面/边/点/剖切全可用 |
| `.stl` / `.obj` | 内置解析器，只有三角面，**没有 B-rep 拓扑**：面按法向归并、边线框为空 |
| `.sldprt` / `.sldasm` | **不解析原生格式**，按四级降级处理，见下 |

**SolidWorks 原生件怎么降级**（`lib\resolve.js`）：

1. 同目录有**同名** `.step/.stp` → 直接用，正常实体
2. 没有同名，但有名字最像的 STEP → 用，并警告「按文件名相似度猜的，可能不是同一个零件」
3. 没有可用 STEP，但 sw-mcp 里有这个设计的草图 → 只画草图轮廓，**零实体**
4. 连草图都读不到 → `NO_MESH_SOURCE`，并给出可复制的下一步

> 所以想让 SLDPRT 出实体，正解是**把同名 STEP 放在一起**，或者让 agent 先 `deliver kind="step"` 导一份。
> 插件自己不会调 SOLIDWORKS。

---

## 已知限制

**视觉表现未经真机验证。** 所有自动化测试跑的是假 WebGL 渲染器（`getContext()` 返回 `null`），
只验证代码路径和数据，**从不产出一个像素**。以下六项零覆盖，装上真机第一件事应该是拿真实 STEP 逐条看：

1. 草图画面的三种颜色（选中 `0xffe479` / 悬停 `0xa8903f` / 整条强调 `0x9af5d6`）在深色浅色模型上是否真能分开
2. 线宽在大模型上会不会细成一根头发
3. 端点小球半径 `diagonal * 0.0075`，在 30 mm 零件和 3 m 装配体上观感差多少
4. 右下角信息条会不会挡住模型
5. 高亮强制画在实体之上（`depthTest:false`）后的穿透显示对不对、有没有闪烁
6. 标记小球在后景时露不露得出来

其它：

- **标记点只在内存**，刷新页面就丢。要留存必须点「保存标注」。双击同一处会叠出多个标记（没有去重）。
- **读数有偏差**：草图圆弧是用折线逼近的（圆 48 段偏小 0.071%、弧 16 段偏小 0.64%），信息条里那个「合计 X.X mm」是弦长和，**永远小于真值**。做精细校核别信它。
- **草图端点只认折线顶点**，拿不到真正的圆心和切点。
- **不可撤销**：误点空白或按 Esc 就直接清空选择，没有撤销栈。
- **其它限制**：点击永远选不到「整条草图」（整条草图的活入口只剩右键「编辑这条草图」）；多选不做跨草图几何推理；截图通道 A 走的是 DSH 包内 API，升级可能失效但会静默降级到通道 B；单位按 mm 处理。
- **`/sw3d/three.js` 是历史遗留路由**：three.js 已内联在 `client.js` 里，预览不依赖它，但有测试和 `ping.three` 断言它，所以那 2.1 MB 的 `vendor\three.cjs` 必须随包分发。

---

## 故障排查

| 错误码 | 原因 | 处理 |
| --- | --- | --- |
| `PYTHON_MISSING` | 所有 Python 候选都 import 不了 OCP | 看响应里每个候选的失败原因；装 `cadquery-ocp` 或设 `SW_3D_PREVIEW_PYTHON` |
| `NO_MESH_SOURCE` | SLDPRT 同目录没有可用 STEP，sw-mcp 里也没草图 | 放同名 STEP，或让 agent `deliver kind="step"` |
| `NOT_FOUND` | 路径不存在；或只给文件名且补全失败 | 从文件列表点开；先成功预览一次进 `recent.json` |
| `UNSUPPORTED` | 扩展名不在支持列表；或 STEP 三角化失败 | 看响应里的 `warnings` / `detail`；重导出 STEP |
| `PING_NOT_OK` | `/sw3d/ping` 没返回 `ok:true` | 用上面的脚本确认 8 条路由；确认 profile `bundles` 里有这一项 |
| `NO_DESIGN` / `NO_SKETCH_DATA` | sw-mcp 里没有这个文件的草图记录 | 让 agent 在 SOLIDWORKS 里 build 一次；或直接传 designId |
| 截图没挂成附件，文本里出现 `shots\...png` | 通道 A 不可用，已自动降级通道 B | **正常降级**，模型可以直接读那个路径 |
| 面板一直「正在解析路径…」 | 只给文件名时补全失败，20 s 后转失败卡片 | 重新从文件列表打开该文件 |

---

## 开发

```powershell
npm test              # 七套离线测试（host 里 STEP 样例缺失时自动 skip）
npm run test:package  # 打包自检：必需文件、lib 清单、vendor、本机路径、tgz 可解
npm run package       # 产出 dist\ 与 .tgz
npm run verify:python # 打印 Python 探测结果
node scripts/check-refs.mjs --strict   # 校验文档里 client.js:NNN 这类引用没失效
```

- `index.js`（Host，8 条路由）与 `client.js`（Client，含内联 three.js）是产物文件，改完要跑测试。
- `lib\*.js` 都不依赖 DSH 运行时，可被 node 直接 import。

**写入**（只写自己的目录）：`%LOCALAPPDATA%\sw-3d-preview\` —— `cache\` 网格缓存、`annotations\` 标注、
`shots\` 截图、`handoff\` 交接单、`recent.json`。
**只读**：`%LOCALAPPDATA%\sw-mcp\projects\*.json`（`SW_MCP_DATA` 可覆盖数据根）。

---

## 随包文件

<!-- sizes:begin -->
```
index.js            49,775       Host 半边：8 条 /sw3d/* 路由
client.js        2,533,655       浏览器半边（含内联 three.js r187）
cordis.patch.yml     1,441       只 insert 一行插件
package.json         2,106
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

> 本表由 `node scripts/sizes.mjs` 生成，数字与磁盘不符时 `--check` 会让 CI 红。
> 不随包：`dist\`、`node_modules\`、`test\`、`tools\`、`scripts\`、`snapshots.jsonl`。
