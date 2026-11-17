# Changelog

本插件是 DSH 插件（`dsh-sw-3d-preview`；早期版本曾用名 `@local/dsh-sw-3d-preview`），版本线很短。日期只写能核实的
（`snapshots.jsonl`、git 提交时间）；查不到的写「未标注」。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

> **行号引用说明**：`0.2.2` 起，本文的代码出处一律写**符号名 + 文件**（如 `weld_and_smooth()` @ `lib/step_mesh.py`），
> 不写行号——行号会随每次改动漂移，符号名不会。`0.2.1` 及更早的历史条目里的行号是**当时版本**的快照，
> 仅供考古，**不代表当前代码位置**。

---

## [0.2.2] — 2026-11-16

这一版与 `0.2.1` 的草图拾取/多选**没有继承关系**，是**另一批独立工作**：网格质量、Python 环境探测根因修复、
外部访问旁路、包改名与开源。`0.2.1` 只包含草图折线/端点拾取与 Ctrl/Cmd 多选；**`extToken` 等能力不在 `0.2.1` 里**。
之所以升到 `0.2.2` 而不是继续塞进 `0.2.1`：本版**改变了对外契约**（新增插件配置项、新增鉴权路径、分发许可变更），
且 `0.2.1` 的 tgz 已经流出，同名不同内容会给排障埋坑。

### 新增

- **`extToken` Bearer 旁路（新配置项，默认关闭）**：让外部进程（Codex CLI / curl / 脚本）用
  `Authorization: Bearer <token>` 访问 `/sw3d/*`。实现在 `lib/ext-token.js`，schema 由 `createExtConfigSchema()`
  @ `index.js` 生成并以 `Config` 导出，`cordis.patch.yml` 暴露两个键：`extToken`（空 = 关闭，**≥16 字符**否则按配置错误当作空）、
  `extTokenScopes`（默认 `['read']`）。**整段删掉 = 外部访问关闭**，行为与本插件没有该功能时完全一致。
  - scope **按「路由 + 方法」细分**，不是整条路由一刀切：`ROUTE_SCOPES` @ `index.js` 里
    `annotation` 是 `Object.freeze({ GET: 'read', POST: 'write' })`——GET 只列标注（纯读）、POST 的 `op:'upsert'` 会写盘。
    其余 `ping`/`resolve`/`mesh`/`three.js`/`sketches` 为 `read`，`handoff`（**整条含 GET**，因为 GET 会现场生成交接单并写盘）
    与 `snapshot` 为 `write`。未归类路由、以及已归类路由上未列出的方法，按 `FALLBACK_SCOPE = 'write'`（宁可拒绝不漏放）。
  - 比较是定长恒时的：两侧各 sha256 后 `timingSafeEqual`；重复的 `Authorization` 头一律当作没带 token。
  - **只影响外部 token 这条旁路**，浏览器 cookie 路径的权限不受影响。
- **`docs/external-api.md`**：对外接口契约（8 条路由的入参/返回/副作用/scope、S3DM v2 二进制格式、
  Bearer 旁路的配置与判定细节、已知未验证项）。
- **`docs/codex-human-parity.md`**：外部 agent 与人类操作能力对照（哪些事人类能做而 Codex 不能做及原因）。
- **`LICENSE`（MIT）、`CONTRIBUTING.md`、`SECURITY.md`、`.github/**`**（CI workflow、Issue/PR 模板），见「变更」。
- **`lib/ext-token.js`** 纳入随包清单，分发文件数 **15 → 16**。

### 变更

- **精度档与宿主对齐**：`PRECISION_TIERS` @ `client.js` 的 `deflection` 从 `high 0.1 / mid 0.2 / low 0.5`
  调整为 **`high 0.04 / mid 0.08 / low 0.2`**，与宿主真实来源 `PRECISION_TIERS` @ `lib/resolve.js` 完全一致
  （`maxTriangles` 仍为 `900000 / 300000 / 120000`）。分叉的后果是「工具栏文案显示错的毫米数」和
  「只带 `deflection` 的路径用错精度」，所以两边必须同时改。
- **细分网格参数打通**：`--deflection` / `--angular-deflection` / `--crease-angle` 三个参数现在**总是显式**传给
  `lib/step_mesh.py`（不再依赖 python 侧默认值），`client.js` 的 `cacheKeyFor()` 也把三者都写进缓存键
  （`…|deflection|ang:…|crease:…|max:…`）——否则改了细分参数会命中旧缓存、看到没变的模型。
- **包重命名**：`@local/dsh-sw-3d-preview` → **`dsh-sw-3d-preview`**（去掉 scope）。只改包名会让
  `dsh.profile.bundles` 里的名字与 npm 包名对不上、装不上，所以 `README`/`CONTRIBUTING`/CI 里的安装命令、
  junction 路径、`bundles` 条目已一并同步。
- **开源**：移除 `package.json` 的 `private`，`license` 改为 **MIT**，新增 `LICENSE`。此前文档写的是
  `UNLICENSED` / 未授权分发，**那些说法已随本版作废**。
- **打包清单**：`collectLibFiles()` @ `scripts/package.mjs` 改为**递归**收集 `lib/`（此前漏子目录），
  并新增 lib 完整性自检——磁盘上 `lib/` 的文件数与清单不一致就红，防止「新增了 lib 文件但忘了打包」。

### 修复

- **`PYTHON_MISSING` 根因**：`DSH_PROFILE_DIR` 是 `dsh-shell-env` 注入给 **shell 工具子进程**的，
  **宿主进程里没有这个变量**，于是插件在宿主内探测 Python 时永远找不到 profile 下的 sw-mcp venv，
  误报「没有找到能 import OCP 的 Python」。改成四级回退链（`resolveProfileDirs()` @ `lib/mesh.js`）：
  ① `DSH_PROFILE_DIR` → ② `DSH_HOME` + `DSH_PROFILE` → ③ `~/.dsh/profiles/<DSH_PROFILE>` →
  ④ 枚举 `~/.dsh/profiles/*` 里**每一个**含 `package.json` 的子目录。失败时把「读 profiles 目录的真实错误」
  与「确实没有 venv」区分开，提示里说明是哪一种。
- **网格质量**：新增 `weld_and_smooth()` @ `lib/step_mesh.py`——焊接重复顶点后按**面积加权**累加法线，
  并按**贪心聚类**处理折痕角（相邻三角形法线夹角 ≤ `CREASE_ANGLE_DEG = 35°` 才参与平均，超过则保留锐边），
  去掉 OCC 三角化直接产出的硬边接缝。默认 `DEFAULT_DEFLECTION = 0.08`、`ANGULAR_DEFLECTION = 0.12` 弧度（≈6.9°）。

### 测试

- 新增 **`test/ext-token.mjs`（31 项）**：逐条钉死 `(路由, 方法) → scope` 归类表、恒时比较、重复
  `Authorization` 头、日志与响应体不出现 token 明文、放行/拒绝各路径都带 `Cache-Control: no-store`。
- 新增 **`test/python-candidates.mjs`（11 项）**：Python 候选探测顺序与失败原因汇总。
- 新增 **`test/package.mjs`（16 项，原 13 项）**：新增 lib 完整性自检及其「不是永真」的反向断言（`12b`/`12c`）。
- `test/host.mjs` 新增 python 常量解析断言（客户端 `PRECISION_TIERS` 与宿主同名表必须一致）。
- 打包自检从 13 项涨到 **16 项**；`npm test` 从 3 套变为 **7 套**串行。

### 文档

- `README.md` / `README.en.md`：包名、许可、安装命令同步；新增「`index.js` 导出 `Config`」的更正
  （此前误写「没有 `Config`、插件页没有配置项」）、缓存键补 `ang:`/`crease:`、随包文件数 15 → 16、
  测试套数与依赖更正（`client-smoke` **不**依赖 `vendor/three.cjs`；`npm test` 是 7 套不是 3 套）。
- `CONTRIBUTING.md`：更正「`vendor/three.cjs` 被 `.gitignore` 排除、不在 git 里」——那条排除规则**已被删除**
  （`npm install github:…` 时 `files` 字段不生效，vendor 不进 git 就装不上），CI 里的重建步骤相应降级为
  **一致性校验**（证明内联段与 vendor 文件没有分叉），不再是「凭空造出文件」。
- `.github/workflows/ci.yml`：vendor 相关注释按上述事实重写；套件项数更正（`client-smoke` 87、
  `sketch-select` 61、`package` 16）。

---

## [0.2.1] — 2026-11-15

这一版加**草图折线与端点拾取**和 **Ctrl/Cmd 多选**，并修掉多选路径上的 5 个缺陷 + 1 处错误文案。
`0.2.0` 的「能看 STEP → 能把标注交回给 agent」不受影响，纯增量。

> **本版范围（勿误读）**：这里只有草图拾取/多选与相关修复。**网格精度调整、`weld_and_smooth`、
> `PYTHON_MISSING` 修复、`extToken` 旁路、包改名、MIT 开源都不在 `0.2.1` 里**——它们是 `0.2.2` 的内容。
> 如果你手上有一份自称 `0.2.1` 但带 `extToken` 配置项或 `lib/ext-token.js` 的包，那不是本条目描述的版本。

### 新增

- **草图折线与端点拾取**：以前一条草图只能整体选中（`buildSketchEntry` 把所有折线合并成一个 `LineSegments`）；
  现在能单独拾取**折线**与**端点**。草图内部优先级 **端点 > 折线 > 整条草图 > 空白**（`pickSubjectByPriority`）；
  **实体拾取（顶点/边/面）永远压过草图**。端点阈值 `SKETCH_POINT_PICK_RATIO = 0.018`
  比折线 `SKETCH_PICK_RATIO = 0.012` 宽（都乘包围盒对角线），否则端点永远抢不到优先级
  （0.018 = 0.012 × 1.5）。「段下标 → 折线下标」走 `buildSketchSegmentIndex` 的映射表，不靠猜。
- **Ctrl/Cmd 多选**：Ctrl（macOS 为 Cmd）+ 左键**切换**选中（已选 → 取消、未选 → 加入）；
  不按修饰键点击 = **替换**选中；Esc 或点空白清空；可同时选线与点。
  信息条汇总成一行 `已选 N 条线、M 个点（合计 X.X mm）`（`sketchSelectionSummaryText`）。
  右键菜单多出「全选本草图」「把所选填进对话框」（后者生成可复制的指令文本，
  见 `buildSketchSelectionInstruction`）。**全选只放右键菜单，不抢浏览器/宿主的 Ctrl+A**。
  Shift+左键仍是平移、Ctrl+拖动仍是旋转——**只有没拖动的 Ctrl 单击才触发多选**。

### 修复

1. **右键菜单摧毁多选。** `showContextMenu` 里 `select(pick)` 是非 additive 的，会先把 Ctrl 多选清空；
   于是「多选 2 条 → 右键其中一条 → 把所选填进对话框」只拿到 1 条。
   现在 `isPickInSketchSelection`（`client.js:5647`）先判断命中项是否已在选中集合里，是就不动选择；
   菜单计数取**动完之后的**集合。
2. **Ctrl 取消同一条被误判成双击。** 普通点线 A 后 300 ms 内 Ctrl 点 A（意图 = 取消），
   `pickTargetKey` 相同 → 被 `isDoubleClickGesture` 判成双击 → 走非 additive 分支重选 A + 凭空 `addMarker`。
   用户想取消，结果仍选中且画面上多一个标记球。现在 `additive` 分支**前置**、完全不进双击判定，
   并清掉 `lastClick`（`client.js:6161` 起）——Ctrl 点击既不给双击计时续命，也不会被下一次普通点击当成双击前半。
3. **双击草图折线生成「面 #-1」标记。** `MARKER_SUBJECT_LABELS`（`client.js:1812`）缺草图三档，
   `index` 恒 -1 且 label 回落到「面」，产出 `标记 #1（面 #-1 @ …）`。这行字会经 `buildMarkersText`
   直接进用户输入框发给模型。现已补 `草图折线 / 草图端点 / 草图` 三档 + 正确下标。
4. **跨草图多选串味。** `buildSketchSelectionInstruction` 只取一个 sketch 对象、每行只用 `polylineIndex` 编号；
   两条草图各有 `#0` 时坐标完全错、都记到第一条草图名下。现在 `groupSketchSelectionBySketch`
   （`client.js:2431`）按 `sketchIndex` 分组，组名取每条自己的 `sketchName`。
5. **`clearSketches()` 不清上层选择。** 关掉工具栏「草图」开关后画布高亮没了，信息条还挂着「已选 N 条线…」，
   「把所选填进对话框」还能点。现在有选择时补一次 `cb.onSelect(null)`
   （`client.js:5140` 判断、`:5157` 回调）；没有选择时不回调，避免 `setSketches()` 每次多刷一次 null。
6. **`SKETCH_ONLY_DISABLED` 的 `marker` 条目与真实行为相反。** 原文案说草图视图不能双击标记，
   实际可以放（草图折线与端点上都能放）。已改为「实体面/边/点上的标记」，`reason` 也说清草图上的标记仍可放。
7. **草图拾取被双击判定吃掉。** `pickTargetKey` 对草图拾取返回 `'none'`，于是「点折线 A → 点折线 B」
   会被 `isDoubleClickGesture` 判成「双击空白」，第二次点击被当成双击吃掉、多选直接失效。
   现在折线/端点各有独立键（`client.js:1793` `sketchLine#草图:折线`、`:1796` `sketchPoint#草图:折线:点`）。

### 变更

- `README.md` **新增「视觉表现未经真机验证」整段**：全部测试跑的是 `getContext() → null` 的假渲染器，
  高亮对比度、线宽、端点球大小、信息条遮挡、`renderOrder` 层叠、标记遮挡这**六项零覆盖**。
  另补六条草图拾取限制（圆弧弦长和偏小 0.071%/0.64%、端点只认折线顶点、不可撤销、
  不做跨草图几何推理、悬停与选中同色且草图视图悬停不节流、`SKETCH_ONLY_DISABLED` 与工具栏禁用态两个真理源）。
- `README.md` 全部 `文件:行号` 按内容重新核对（`client.js` 本轮长了 11,164 字节，19 处引用里 9 处偏移）。
- `README.md` 里 `client.js` 字节数 2,468,420 → **2,479,584**；第 10 节随包文件的字节数逐个实测更新。
- `package.json`：`version` 0.2.0 → **0.2.1**（`engines.dsh` 的 `>=0.2.1-rc.3` 是 DSH 版本约束，不动）。

### 修复（第二批 · 审计复查）

上一轮之后又做了一轮逐条读代码的审计。下面 **7 条**（6 处产品缺陷 + 1 处测试缺陷）
都是**审计发现、逐条读代码核实**过的问题。

8. **单草图指令文本回退。** 上一轮为支持跨草图分组引入的 `anyNamed` 判据是**恒真**的
   （`sketchLineInfo` 总是填 `sketchName`），于是 legacy 分支变成死代码、**用户最常用的单草图场景
   反而走了新格式**，丢掉「（属于特征「X」，绘制在 Y）」和「折线：#N …」的行格式——这是一次真实的回退。
   现在改为按**组数**分流：`client.js:2501` `var grouped = groups.length > 1;`，
   `groups.length === 1` 走旧格式（`client.js:2509` 起），单草图路径逐字节恢复旧输出。
9. **「草图 草图 #1」双前缀。** 组名回退值自带「草图」前缀（旧写法 `'草图 #' + idx`），
   而模板（`client.js:2543` `'草图 ' + group.sketchName + '（'`）又前置「草图」，拼出「草图 草图 #1」。
   回退名改为**不带前缀**的 `'#' + idx`（`client.js:2442`）。
10. **Ctrl+点空白导致状态与回调不同步。** `select(null, {additive:true})` 会发 `cb.onSelect(null)`
    （右下角信息条消失）但**不执行** `clearSketchSelection`（画布高亮还在、集合还在、
    「把所选填进对话框」还拿得到数据），三处不一致。现在改为**什么都不做**：
    `client.js:5899` `if (additive && !picked) return;`。Ctrl 是**累积选择**语义，点空白不该意外清空；
    真正的清空仍由「不按修饰键点空白」和 Esc 走同一条 `clearSketchSelection` 路径。
11. **同名草图不可区分。** 两条同名草图的组名是两行完全相同的文本，只能靠坐标猜哪行是哪条。
    新增 `sketchGroupIdentity`（`client.js:2562`），组名带「第 N 条 / 基准面名」
    （`第 2 条 / 基准面-前视`；没有基准面名时只有「第 N 条」）。
12. **悬停与选中同色。** 两者共用 `COLORS.sketchPick = 0xffe479` 且合进**同一个** `LineSegments`，
    画面上物理分不出「鼠标扫过」和「已选中」。现在悬停用独立颜色 `0xa8903f`
    （`SKETCH_HOVER_LINE_COLOR`，`client.js:1980`）/ 透明度 `0.7`（`client.js:1982`）/
    `renderOrder` 4（`client.js:4747`），选中保持 `0xffe479`（`client.js:4028`）/ `renderOrder` 5（`client.js:4735`）。
13. **草图视图悬停无节流。** 节流判据只看 `triangleCount > 100000`，而草图视图 `triangleCount` **恒为 0**，
    于是**永不节流**；50000 点实测 2.5 ms/次 ≈ 15% 帧预算。现在判据加上草图规模
    （`hoverThrottleNeeded`，`client.js:76`：点数 + 段数 > 8000 即限帧到 `33 ms` ≈ 30 fps，
    `setHover` 里真的用上，`client.js:5865`），并给端点扫描加了空间索引
    （`buildSketchPointIndex`，`client.js:2113`）。
    **实测**（50000 点 / 49900 段，同一进程同一份数据，各 3 轮取平均）：旧热路径
    （`c0aeeeb` 的 `setFromCamera` + `intersectObject`，只返回 `subject:'sketch'`）
    1.655 / 1.754 / 1.716 ms → 平均 **1.708 ms**；新实现（真 `pointermove` → `setHover` →
    `pickSketchCandidates`）0.350 / 0.359 / 0.335 ms → 平均 **0.348 ms**，**同口径加速 4.91x**。
    索引缓存单独的贡献（同样新功能，只切 `entry.pointIndex` → `entry.polylines`）：
    不缓存 0.900 / 0.902 / 0.953 ms → 缓存 0.350 / 0.370 / 0.351 ms = **2.57x**。
    纯 JS 时间（假渲染器 + Node 24），**不含 WebGL 提交与合成**，真机绝对毫秒数会不同、比例未必一致。
    > **口径更正（第三批）**：本条以前写的是「2.501 ms → 0.273 ms（9.16x）」。那个对比**不可比**——
    > 两个数字测的不是同一条路径（旧的只走到 `subject:'sketch'` 兜底档），开发者已撤回，改用上面的
    > 同口径数据。详见下方「变更（第三批）」第 1 条。
14. **`test\host.mjs` 的版本断言写死 `'0.2.0'`。** 每次升版本必红。改为从 `package.json` 读
    （`test\host.mjs:25` `const PKG = JSON.parse(...)`，`test\host.mjs:734` 用 `PKG.version` 断言）。

### 变更（第二批）

- `test\sketch-select.mjs` 从 **41 项**增到 **51 项**，新增 12 个变异测试全部被杀——其中包括此前
  **漏网**的「只改真实阈值、不改常量」那条：把点击半径从屏幕 7px 量级塌到 1px 时，旧 41 项套件
  曾**毫无反应**。现在有一条（`test\sketch-select.mjs:1530`）只走真实拾取路径量出「第一次点不中的距离」，
  改实现里的阈值会让它当场红。
- `test\host.mjs` 的版本断言改为从 `package.json` 读（原来写死 `'0.2.0'`，升版本必红）。
- `README.md` 全部 `文件:行号` 按内容重新核对（`client.js` 本轮又长了 15,734 字节：2,479,584 → 2,495,318）。
  上一轮已有的 **66 处**可独立定位的引用里 **29 处偏移**、37 处未变；`README.md` 现在共
  **83 处** `文件:行号` 引用（80 个不同目标），逐条按内容核对过。
  偏移最大的是 `client.js` 里 three.js 内联段之后的内容（+248 行）、标记/边线相关段（+124 行）、
  草图组名分组之后的段（+121 行）；`lib\*`、`index.js`、`cordis.patch.yml`、`test\client-smoke.mjs`
  的引用**一处都没动**（这些文件本轮没改）。
- `README.md` 里 `client.js` 字节数 2,479,584 → **2,495,318**；第 10 节随包文件的字节数逐个实测重测
  （本轮 `lib\*`、`index.js`、`vendor\three.cjs` 均未变，数字未动）；明确**不写「产物总字节数」**
  （把本文件自己算进去，文档一改就自我指涉、必然过期）。
- `README.md` 第 6 节限制清单：两条旧限制（悬停同色、草图视图悬停无节流）改为「已修」并附实测数字；
  新增三条诚实限制（`subject:'sketch'` 那一档实际不可达、节流测试的时间窗依赖 `Date.now()`、
  `sketchPlane` 的真实产出未验证）；`sketch-select` 的项数 41 → **51**。

### 修复（第三批 · 终审复查）

终审又抓了 **4 个阻断项 + 3 个必改**。其中第 1 条是**功能回归**（上一批弄丢了一个已有功能），
第 3 条是**假测试**（断言恒真、变异杀不掉），其余 5 条是产品/测试缺陷。

1. **【功能回归】恢复了「编辑这条草图」入口。** 上一批把整条草图的拾取档（`subject:'sketch'`）
   让给了折线/端点档，结果 `selectSketch()` 的**唯一调用点变成不可达**、`onSketchEdit` 成了死代码——
   **「编辑这条草图」这个功能从 UI 上整个消失了，而上一批的文档完全没披露**。这是回归，不是新需求。
   现在补进右键菜单：`CONTEXT_MENU_DEFS.sketchLine` / `.sketchPoint` / `.sketch`
   （`client.js:1860` / `client.js:1866` / `client.js:1871`）都有 `{ id: 'edit-sketch', label: '编辑这条草图' }`，
   走 `editSketchFromMenu`（`client.js:5529`）→ `sketchEditInstructionFor`（`client.js:5516`）；
   面板里那个「编辑这条草图」按钮（`client.js:4861`）**复用同一个生成函数**，所以两处文本永远一致
   （有测试逐字符断言这一点）。
2. **【阻断】「全选本草图」不再保留已有选择。** 旧实现只清点、不清线：先选中草图 B 的 1 条，
   再对草图 A「全选」，会得到 `[B 那条, A 的 0, A 的 1]` 三条，信息条却显示「已全选 3 条」而 A 只有 2 条。
   现在 `selectAllSketchLines` 先 `selectedSketchLines.clear()` 再 `selectedSketchPoints.clear()`
   （`client.js:5486`、`client.js:5487`）——「全选本草图」的语义是**选择 = 本草图的全部折线**，不是追加。
3. **【阻断 · 假测试】`disposed` 断言曾是恒真的。** `getSketchHighlightState` 里那个 `disposed`
   来自一个**无条件置 true** 的布尔标记，与 `geometry.dispose()` 是否真的执行无关——
   变异测试证明：把 `client.js` 里那行 `dispose()` 注释掉，**51 项照样全绿**。
   现在改为监听 three 自己的 `'dispose'` 事件（`markDisposalOn`，`client.js:4714`；
   挂载点在 `client.js:4406` 等）：`BufferGeometry.dispose()` / `Material.dispose()` 唯一做的事就是
   `dispatchEvent({type:'dispose'})`，所以**事件到达 ⇔ dispose 真的跑了**。注释掉那行现在会红。
4. **【必改】右键未选中项会摧毁多选。** 旧规则只保住「命中项**已在**集合里」这一半：
   Ctrl 选中 2 条后右键旁边那条**未选中**的线，选择照样被替换成 1 条。
   现在规则改成：**草图多选集合非空时，右键任何草图对象都不动选择**（`client.js:5689`
   `var keepSelection = hasSketchSelection && isSketchPickSubject(pick);`）；集合为空时才 `select(pick)`，
   让「先右键再操作」的老路径仍然成立。右键**实体**对象不在此规则内（照旧单选并清掉草图多选）。
5. **【必改】悬停时整条草图被刷成选中色。** 上一批只把**悬停覆盖层**从 `0xffe479` 换成 `0xa8903f`，
   但 `SKETCH_LINE_STYLE_ON.color`（整条草图强调色）**仍然等于** `COLORS.sketchPick` 的 `0xffe479`——
   于是鼠标扫过整条草图时，「已选中」与「同草图未选中」的 ΔE76 = **0.00**（完全同色，多选高亮被淹没）。
   现在整条草图强调色改为 `SKETCH_EMPHASIS_COLOR = 0x9af5d6`（`client.js:1985`，
   用于 `client.js:4763` 的 `SKETCH_LINE_STYLE_ON`），选中仍是 `0xffe479`。
   三个颜色的分工见 README 第 6 节第 15 条。
6. **【必改】节流接线测试判别力不足。** 旧测试拿常量当边界，把 `HOVER_THROTTLE_MS` 改成 `3000`
   （悬停彻底卡死）**反而全绿**。现在用**注入式时钟**（`setHoverClock`，`client.js:6641`）：
   测试自己推进时钟，确定性地构造「同一个 33 ms 窗口内」（必须不更新）与「窗口已过」（必须更新），
   不再靠碰运气、也不再需要重试。小草图对照组保证「节流」没被写成「悬停永远不更新」。
7. **【必改】索引缓存零覆盖。** 旧性能测试直调纯函数、绕过 viewer，所以「生产代码到底有没有缓存索引」
   根本没被断言。现在用 `getSketchPointIndexBuilds`（`client.js:6643`）计数：
   真 `pointermove` 40 次之后，端点索引的构建次数**增量必须为 0**（把 `entry.pointIndex` 换回
   `entry.polylines` 会让这条当场红）。

### 变更（第三批）

1. **性能数字口径更正（重要）。** 上一批写的「50000 点 hover `2.501 ms` → `0.273 ms`（9.16x）」
   **口径是错的，开发者已撤回**：两个数字测的不是同一条路径，不可比。同口径重测（各 3 轮）见上文
   第 13 条——**同口径加速 = 4.91x**（1.708 ms → 0.348 ms），索引缓存单独的贡献 = 2.57x。
   两处（README 与本文）都已改，并写明这是**纯 JS 时间**（假渲染器 + Node 24，不含 WebGL 提交与合成），
   真机绝对毫秒数会不同、比例也未必完全一致。
2. `test\sketch-select.mjs` 从 **51 项**增到 **57 项**：新增「编辑这条草图」（右键/端点/面板同源）、
   「全选先清空」、「右键未选中项不摧毁多选」、「整条草图强调色 ≠ 选中色」等终审回归。
3. `client.js` 2,495,318 → **2,507,490** 字节（+12,172）。`README.md` + 本文全部 `文件:行号` 重新核对：
   现共 **135 处**引用、**114 个**不同目标（`README.md` 93 处 / 本文 42 处），逐个读那一行、
   断言内容与描述的符号相符（本轮 114/114 全部相符）。其中 `client.js` 侧改写了 **55 处**行号
   （涉及 **53 个**不同旧行号）、`test\sketch-select.mjs` 侧改写了 **5 处**（该套件 51 → 57 项后
   行号整体后移）；`lib\*` / `index.js` / `cordis.patch.yml` / `test\host.mjs` /
   `test\client-smoke.mjs` 的引用**一处都没动**（这些文件本轮没改）。第 10 节随包文件字节数逐个实测，
   只有 `client.js` 一行变了。
4. `README.md` 第 6 节限制章节重写：第 15 条改成**三个颜色分列**（悬停覆盖层 `0xa8903f` /
   选中 `0xffe479` / 整条草图强调 `0x9af5d6`）并写明「上一轮说已修是不完整的，第二次才修对」；
   第 18 条补上「点击永远选不到整条草图、`select()` 的 sketch 分支是死代码」的完整推论；
   第 19 条改为「注入式时钟已修、无重试」。新增三条诚实限制：**右键不会选中**、
   **双击会清掉多选**、`test\sketch-only.mjs:316` 硬编码 `client.js` 路径（不读 `SW3D_CLIENT`）。
5. **必须让维护者知道的一件事（也是新增限制第 18 条的核心）：**
   `subject:'sketch'`（整条草图）这一档的**拾取路径不可达**。`pickSketchCandidates` 第 3 档与第 2 档
   用同一阈值、同一批几何，必然被第 2 档抢先，所以**点击永远选不到「整条草图」**。
   整条草图这个概念的**活入口只剩右键菜单的「编辑这条草图」（以及公开 API `selectSketch`）**。
   这是设计取舍、不是 bug，但 `select()` 里 `picked.subject === 'sketch'` 那个分支（`client.js:5939`）
   是**死代码**——不要把它当成「整条草图能被点选」的证据。

---

## [0.2.0] — 2026-11-15

这一版把「能看 STEP」变成「能把标注交回给 agent 改模型」。

### 新增

- **草图叠加层（只读）**：把 sw-mcp 里该设计的草图轮廓叠加在实体预览上，看清「模型背后的草图」。
  数据来自 `GET /sw3d/sketches`，读 `%LOCALAPPDATA%\sw-mcp\projects\<designId>.json`（只读，不碰 SOLIDWORKS）。
- **草图视图降级（sketch-only）**：SolidWorks 原生件既没有同名 STEP、也没有相似名 STEP 时，
  若 sw-mcp 里有该设计的草图记录，则返回 `meshSource: 'sketch-only'` 画出草图线框，而不是甩一块失败卡片。
  信息条会列出被禁用的能力（实体面/边/点拾取、剖切、取样、着色、边线、精度、双击标记）。
- **剖切封盖改为几何法真断面**：按剖切平面把三角网格切出断面三角形，替掉早先的 stencil quad 假面
  （假面会出棕色碎块、裁掉的边线只剩一条弧）。关掉封盖时内壁用压暗 40% 的双网格补背面。
- **右键菜单**：面/边/点各有一组（「标记此处」+ 生成建模指令）；空白处右键有「适配 / 重置视角 / 复制当前截图到对话框」。
- **双击标记**：双击面/边/点放带序号的标记点；空白处双击 = 适配视角并取消选中。
- **标注交接单（handoff）**：`POST /sw3d/handoff` 把某文件的全部标注汇总成 Markdown，
  写到 `%LOCALAPPDATA%\sw-3d-preview\handoff\<sha1>.md`，返回 `mdPath`。
- **用户视角截图两条通道**：「含截图」默认勾上，通道 A（`conversation.createDrafts` 草稿附件）
  失败自动降级通道 B（`POST /sw3d/snapshot` 落盘 + 路径）；PNG > 1.5 MB 自动重编 JPEG(0.9)。
- **打包**：`npm run package` → `dist\dsh-sw-3d-preview-<version>\` + `.tgz`，带自检
  （必需文件、`vendor\three.cjs` 是否真的在包里、产物不含本机绝对路径、`dsh.bundle.patch` 指向是否存在）；
  `npm run test:package` 13 项离线断言。
- **README / CHANGELOG / `.gitignore` 补 `dist\`**：让插件能交给别人装。

### 变更

- **跨机修复：去掉写死的 Python 路径。** `lib\mesh.js` 早先只认一条本机绝对路径
  （`<某台机器的>\sw-mcp\.venv\Scripts\python.exe`），到别人机器上前两个候选必然失败、只剩 `py -3`，
  而 `py -3` 通常没装 `cadquery-ocp`，于是 STEP 一律 `PYTHON_MISSING`。
  现在候选顺序由可移植来源推导：`SW_3D_PREVIEW_PYTHON` → sw-mcp 数据根（`SW_MCP_DATA` / `%LOCALAPPDATA%\sw-mcp`）的 venv
  → DSH profile 里 `link:` 指向的 sw-mcp 仓库的 venv → 插件同级 `sw-mcp\.venv` → `py -3` → `python` → `python3`，
  每条失败都留在探测结果的 `error` 里。
- `PYTHON_MISSING_HINT` 改为跨机可读（不再只说「确认某条本机路径存在」）。
- `package.json`：补 `scripts`（test / package / verify:python 等）、`license: UNLICENSED`、
  `engines.dsh`（`>=0.2.1-rc.3 <0.3.0-0`，与同 profile 里 `dsh-win-pwsh7` 的写法一致）、
  `files` 里把 `vendor` 明确成 `vendor/three.cjs`（它被 `.gitignore` 排除，靠 `files` 兜底）。

### 修复

- **草图解析 bug**：草图记录里折线点/尺寸表达式的解析修正（`lib\sketches.js`）。
- **路径补全卡死**：「正在解析路径…」的自锁死循环（宽限计时器复位写在「phase 变非 pending」的分支里，
  而 phase 恰恰是被它改成非 pending 的，于是每 1.5 s 降级一次、立刻又回 pending）——
  改成计时器只依赖资源地址，同一地址只等一次。
- **对「只有草图、零实体」的零件不再推「去导出 STEP」的死循环提示**：先探测草图记录，
  能读就降级成草图视图并明说「这个零件只有草图，导不出 STEP」。

### 未标注日期

- 面/边/点拾取（优先级 点 > 边 > 面）与 Alt 三点法取样：早于 `0.2.0` 就有，具体引入日期未标注。
- 标注持久化 `annotations.jsonl`（按行 append、按文件 sha1 归属）：引入日期未标注。
- 精度三档（高 0.1/900k、中 0.2/300k、低 0.5/120k，档位进缓存键）：引入日期未标注。
- STL（binary+ASCII）/ OBJ 内置解析器与「STL/OBJ 没有 B-rep 拓扑」的 warnings：引入日期未标注。

---

## [0.1.0] — 未标注

初版：文件预览面板里的 3D 预览。

- `GET /sw3d/ping|resolve|mesh|three.js|annotation` 五条路由 + 信任栅栏（`ctx.connection.requestRejection`）。
- STEP → S3DM v2 网格（`lib\step_mesh.py`，OCP 三角化）；STL/OBJ 内置解析。
- S3DM v2 容器：多 buffer（position/normal/index/faceOfTriangle/edgePosition/edgeSegment/faceEdge）、4 字节对齐。
- SolidWorks 原生件降级：同名 STEP → 相似名 STEP → `NO_MESH_SOURCE`（**当时还没有草图视图这一级**）。
- 标注 upsert/list 写 `annotations.jsonl`；`/sw3d/three.js` 原样返回 `vendor\three.cjs`。
- three.js r187 **内联进 `client.js`**（无 CDN、无外部请求）。

> 说明：仓库 git 历史只有一个基线提交 `c0aeeeb`（2026-11-15 12:16:38 +0800），
> 早于此的 `0.1.0 → 0.2.0` 过程没有逐条提交记录，因此上面凡是「未标注」都是从
> 代码现状与 `snapshots.jsonl` 能核出来的边界，不编日期。
