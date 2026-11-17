# 贡献指南

面向要改这个仓库的人。**先读第 2 节再动手**——`client.js` 是单文件构建产物形态，改错方式会很痛。

- 包名：`dsh-sw-3d-preview`
- 当前状态：`license: "MIT"`（见 `LICENSE`），**可自由使用、修改、分发**。贡献即按 MIT 授权；改许可证是单独的事，别在本仓库里顺手改。

---

## 1. 本地跑测试

在插件根目录（本文件所在目录）下用 **Node ≥ 22**（`package.json` 的 `engines.node`；本机实测 22.23.5 与 24.21.0 都全绿）：

```powershell
node test/package.mjs        # 打包自检 16 项
node test/client-smoke.mjs   # 客户端纯函数层 87 项
node test/sketch-select.mjs  # 草图折线/端点拾取 + Ctrl 多选 61 项
node test/sketch-only.mjs    # 草图视图降级 14 项
node test/host.mjs           # Host 离线测试（S3DM/STEP/STL/OBJ/路由/标注/快照）
node --check index.js
node --check client.js
```

或者走已定义的脚本：

```powershell
npm run test:package    # = node test/package.mjs
npm run test:client     # = node test/client-smoke.mjs
npm run test:host       # = node test/host.mjs
npm test                # host + package + python-candidates + client-smoke + sketch-select + sketch-only + ext-token 七套串行
```

### 不要跑的（会失败、会卡住、或根本不是一套测试）

| 文件 | 为什么别单跑 |
| --- | --- |
| `test/sketch-parse.mjs` | **不是独立套件。** 它只导出 `registerSketchParseTests(check)`，由 `test/client-smoke.mjs` 注册进那 87 项里。单独 `node test/sketch-parse.mjs` 会以退出码 0 静默结束、**什么都不跑**——别把它当绿。 |
| 任何 `*-live.mjs` | 需要真机 / 真服务。 |
| `deliver-gate.mjs` | 会启动 **SOLIDWORKS**。 |
| `suite.mjs` | 聚合入口，不在本仓库约定里。 |

### 想只跑一部分/对变异体跑

`test/client-smoke.mjs` 与 `test/sketch-select.mjs` 认 `SW3D_CLIENT` 环境变量，可以指向另一份 `client.js`（用来验证「改坏的构建会不会被抓住」）：

```powershell
$env:SW3D_CLIENT = "D:\tmp\mutant-client.js"
node test/sketch-select.mjs
```

**`test/sketch-only.mjs` 不认这个变量**（见第 3 节红线 3），别指望用它跑变异测试。

---

## 2. 代码结构

| 路径 | 是什么 | 改完要做什么 |
| --- | --- | --- |
| `index.js` | **Host 端**。注册 8 条 `/sw3d/*` 路由（`ping` / `resolve` / `mesh` / `three` / `annotation` / `handoff` / `snapshot` / `sketches`），每条自己做信任栅栏（`ctx.connection.requestRejection`）与方法校验。 | 改完 `node --check index.js` + `node test/host.mjs`；重载 DSH（新增路由 HMR 不保证）。 |
| `client.js` | **浏览器端**，约 2.5 MB **单文件**。通过 `window.__ModuleLoader__.load(spec)` 交付；WebGL/three.js 场景、拾取、标注、右键菜单、截图都在这里。 | 改完必须重跑 `node test/client-smoke.mjs` **和** `node test/sketch-select.mjs`（见红线 1）。刷新页面生效。 |
| `lib/mesh.js` | S3DM v2 读写、STL/OBJ 解析、Python 探测与 `step_mesh.py` 调用、缓存路径。不 import DSH 运行时，可被 node 直接 import。 | `node test/host.mjs`。 |
| `lib/resolve.js` | 四级降级：同名 STEP → 兜底 STEP（带过期警告）→ 草图视图（`sketch-only`）→ `NO_MESH_SOURCE`。 | `node test/host.mjs`、`node test/sketch-only.mjs`。 |
| `lib/paths.js` | 路径归一、`%LOCALAPPDATA%\sw-mcp` 数据根、project 记录扫描。 | 注意 `isAbsoluteFsPath()` 只认盘符/UNC（Windows 语义），见第 4 节。 |
| `lib/sketches.js` | 草图折线/端点几何、按基准面投影、`tessellateSketch`。 | `node test/sketch-select.mjs`、`node test/sketch-only.mjs`。 |
| `lib/handoff.js` | 标注交接单 Markdown 生成。 | `node test/host.mjs`。 |
| `lib/step_mesh.py` | 独立可跑：`python lib/step_mesh.py --in a.STEP --out a.s3dm --deflection 0.08`。依赖 OCP。 | 无自动化套件；改完手动跑一次真 STEP。 |
| `scripts/package.mjs` | 打包 + 自检，产出 `dist\`。 | `node test/package.mjs`。 |
| `vendor/three.cjs` | three.js r187 的 CJS 副本，**2.1 MB，`.gitignore` 已不再排除它，应随仓库一起提交**（本仓库当前尚未 `git add`，见第 5 节）。 | 见第 5 节。 |

`client.js` 里已**内联**同一份 three.js（`/* begin vendor/three.cjs */` … `/* end vendor/three.cjs */`，当前在 9220–90595 行）。
**预览本身不读 `vendor/three.cjs`，不要在 `client.js` 里 `require` 它。** 保留那个文件只是因为 `/sw3d/three.js` 路由、
`ping.three` 和 `test/host.mjs` 还在断言它的存在（见 README 已知限制 4）。

---

## 3. 红线

### 1) `client.js` 是构建产物形态的单文件

它不是「很多小模块拼起来」的源码树，而是一个整体交付的 bundle。**任何改动之后至少重跑这两套**：

```powershell
node test/client-smoke.mjs    # 87 项：纯函数层
node test/sketch-select.mjs   # 61 项：拾取/多选/悬停节流
```

只跑其中一套是不够的：`client-smoke` 覆盖文本与数据构造，`sketch-select` 覆盖拾取与交互状态机，两者交集很小。

### 2) 别把内联段改坏

`client.js` 的 9220–90595 行是 vendor 内联块。改 `client.js` 的其它部分时不要动这两个标记行；
CI 会按这两个标记**重建** `vendor/three.cjs` 并做一致性校验（重建结果与原文件逐字节相同，2126774 字节）。
标记被改名或删掉，CI 会直接失败。

### 3) `test/sketch-only.mjs:316` 硬编码 `client.js` 路径 —— 已知缺陷

那一行是：

```js
const clientSource = fs.readFileSync(path.join(PLUGIN_DIR, 'client.js'), 'utf8');
```

它**不读 `SW3D_CLIENT` 环境变量**，而 `test/client-smoke.mjs:15` 与 `test/sketch-select.mjs:21` 都读。
后果：这 14 项**无法对变异体运行**——想验证「改坏 client.js 会不会被抓住」时，改的是真实文件、跑的也是真实文件，
等于只能自测，做不了变异测试。

这是套件之间的不一致，**未修**。欢迎修（改成和另两套一样的 `process.env.SW3D_CLIENT` 回退逻辑即可），
修的时候顺手确认 `node test/sketch-only.mjs` 仍然 14/14。

### 4) 不要碰的东西

- `.gitattributes` 里的 `* -text`：仓库是「字节级回滚保险」，禁止行尾/编码转换。别删。
- `.gitignore`：`vendor/three.cjs` 那条**已被删除**（现在 vendor 应进 git，`git check-ignore` 对它是退出码 1）。别再把它加回去。
- `package.json` 的 `files`：漏项会让打包产物缺文件，`package.mjs` 的自检会红（那是好事）。

---

## 4. 平台与路径语义（改 Host 代码前必看）

`lib/paths.js:42` 的 `isAbsoluteFsPath()` 只认 **`X:\` 盘符**和 **`\\` UNC**：

```js
return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
```

也就是说 **POSIX 绝对路径（`/tmp/...`、`/home/runner/...`）会被判成非法**，`resolveSource()` 对它们
一律返回 `NOT_FOUND`。这是 Windows-only 插件的既定取舍，不是 bug；但它意味着：

- Host 侧的路径断言**只能在 Windows 上跑**；
- 想做跨平台 CI 之前，得先决定要不要放宽这个判据（会牵动 `lib/resolve.js:54`、`index.js:910` 等多处）。

`%LOCALAPPDATA%` 同理（`lib/paths.js:29`、`lib/mesh.js:227`），Linux 上没有这个变量，会退回 `~/AppData/Local`。

---

## 5. `vendor/three.cjs` 现在必须进 git

`.gitignore` 里原来那条排除规则**已被删除**（`git check-ignore vendor/three.cjs` 现在退出码 1），
因为它和「从 GitHub 源码安装」冲突：`npm install github:…` 时 `package.json` 的 `files` 字段不生效，
git 里没有的文件就装不上，`/sw3d/three.js` 会 404、`/sw3d/ping` 的 `three` 字段变 `false`。

> ⚠️ 本仓库当前**尚未**把它 `git add`（`git status` 里还是 `?? vendor/`）。提交时记得带上它。

它是 three.js r187 的 CJS 副本（2.1 MB、MIT），**必须随包分发**，所以：

- 手工拷贝目录分发时**要单独把这个文件拷过去**，否则 `/sw3d/three.js` 会 404、`/sw3d/ping` 的 `three` 字段为 `false`；
- `node scripts/package.mjs` 会自己带上它并断言字节数；
- 丢了也能从 `client.js` 的内联段原样重建（两者逐字节相同，CI 就是用它做**一致性校验**）：

```powershell
node -e "const fs=require('node:fs');const L=fs.readFileSync('client.js','utf8').split('\n');const b=L.findIndex(l=>l.includes('begin vendor/three.cjs'));const e=L.findIndex(l=>l.includes('end vendor/three.cjs'));fs.mkdirSync('vendor',{recursive:true});fs.writeFileSync('vendor/three.cjs',L.slice(b+2,e-2).join('\n')+'\n','utf8');"
```

---

## 6. PR 要求

1. **带测试。** 修 bug 就加一条能复现它的断言（对着改之前的代码应该红、改之后应该绿）。
   没有测试覆盖的纯视觉改动，在描述里写明「未在真浏览器验证」。
2. **说明改了哪几条已知限制。** README 第 6 节是一份带编号的诚实清单（视觉未验证、草图端点只认折线顶点、
   圆弧长度偏小、`sketch-only` 不能做实体拾取……）。如果你的改动让其中某条不再成立，
   **同步改 README 那一条**，并在 PR 里指出编号；不要让文档和代码分叉。
3. **更新 `CHANGELOG.md`。** 按 Keep a Changelog 风格写「新增 / 修复 / 变更」，日期只写能核实的。
4. **跑一遍全套**（第 1 节的 5 条命令 + 两条 `node --check`），把输出尾部贴进 PR。
5. **不要顺手改**无关文件的行尾/编码/大段格式。

### 特别欢迎的 PR

- 触发 `sketch-only` 那个 `SW3D_CLIENT` 缺陷的修复（见红线 3）；
- 让 `test/host.mjs` 不再依赖 `C:\Users\<user>\Desktop\工程自动化` 这种本机样例
  （`test/host.mjs:26`），改成仓库内 fixture —— 现在它导致干净机器上 `host.mjs` 会**失败**而不是跳过。

---

## 7. 提交信息的写法

没有强制格式。但请让标题能独立说清「改了什么行为」，正文写「为什么」。
涉及已知限制编号的，写进正文（例如 `README 第 6 节第 12 条`）。
