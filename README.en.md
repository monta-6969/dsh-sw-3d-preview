# dsh-sw-3d-preview

**Look at 3D models right inside the DSH file preview panel — and turn "that spot right there" into a coordinate an agent can use.**

DSH cannot open `.step` / `.sldprt` files. This plugin parses STEP / STL / OBJ into meshes and draws them in the preview panel,
with section cuts and caps, face / edge / point picking, three-point sampling, annotations written to disk, and a Markdown handoff sheet —
so "the fillet next to that boss" becomes a set of coordinates you can hand straight to an agent.

- Package `dsh-sw-3d-preview`, version `0.2.2` ([CHANGELOG](./CHANGELOG.md)), MIT

---

## Installation

You need **Node ≥ 22** and **Python + `cadquery-ocp`** (all STEP triangulation goes through it).

```powershell
py -3 -m pip install cadquery-ocp
```

The Python that has OCP does not have to be on PATH. The plugin tries, in order: the `SW_3D_PREVIEW_PYTHON` environment variable →
`%LOCALAPPDATA%\sw-mcp\.venv` → a sw-mcp repo linked from the profile → a `sw-mcp\.venv` next to the plugin → `py -3` / `python` / `python3`.
To pin it, set the environment variable and **restart DSH**:

```powershell
[Environment]::SetEnvironmentVariable('SW_3D_PREVIEW_PYTHON','C:\Python312\python.exe','User')
```

**Install into a profile** (pick one):

```powershell
# A. For development: a directory link, code changes take effect immediately.
#    Add the dependency and bundle to the profile's package.json, then create the junction.
New-Item -ItemType Junction `
  -Path   "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-sw-3d-preview" `
  -Target "D:\tools\dsh-sw-3d-preview"

# B. To hand it to someone else: install the packaged tgz
npm run package
npm install --prefix "$env:USERPROFILE\.dsh\profiles\desktop" "<plugin dir>\dist\dsh-sw-3d-preview-0.2.2.tgz"
```

Either way, add `dsh-sw-3d-preview` to `dsh.profile.bundles` in the profile's `package.json`.

**Confirm it installed**: unauthenticated requests to all 8 `/sw3d/*` routes should return `401` (the route exists and the trust fence is working);
any `404` means the plugin is not loaded. Substitute your current DSH port:

```powershell
$base = "http://127.0.0.1:61489"
foreach ($p in "/sw3d/ping","/sw3d/resolve","/sw3d/mesh","/sw3d/three.js","/sw3d/annotation","/sw3d/handoff","/sw3d/snapshot","/sw3d/sketches") {
  try { $null = Invoke-WebRequest "$base$p" -UseBasicParsing -ErrorAction Stop; "$p -> 200" }
  catch { "$p -> $([int]$_.Exception.Response.StatusCode)" }
}
npm run verify:python   # STEP works only when this prints "ok": true and "ocp": true
```

---

## Usage

Open any model file and the preview panel draws it. Toolbar and context menu:

| What | How |
| --- | --- |
| Look inside | Toolbar "Section": pick an axis and drag; "Cap" computes the real cross-section with geometry (not a fake face) |
| Change precision | Toolbar "Precision": high / medium / low (default medium). Over-large meshes prompt you to drop a level |
| Select a face / edge / point | Hover to highlight, click to select; the card shows face id/area/normal, edge id/length/endpoints, point coordinates |
| Three-point sampling | **Alt + click the same face 3 times** → records 3 points in model coordinates, enough to re-locate that face in SOLIDWORKS |
| Drop a marker | Double-click a face/edge/point (sketch polylines and endpoints work too) |
| Compare with sketches | Toolbar "Sketch" toggles an overlay of the sketches sw-mcp has for this design |
| Multi-select sketches | Ctrl/Cmd + click to toggle; the status bar sums the total length; right-click → "Select all in this sketch", "Fill selection into the dialog" |
| Hand off to an agent | "Save annotation" writes to disk → "Generate handoff" produces a Markdown file; give the agent the **path** |
| Include a screenshot | "Include screenshot" is on by default; it attaches to the draft, and falls back to writing a file if that fails |

The right-click items ("Add sketch / Fillet / Set as datum point", …) only **generate a natural-language instruction** and put it in the input box;
whether it actually happens in SOLIDWORKS is up to the agent. **The plugin itself never modifies a model.**

---

## Supported formats

| Extension | How it is handled |
| --- | --- |
| `.step` / `.stp` | `lib\step_mesh.py` triangulates with OCP; faces, edges, points and section cuts all work |
| `.stl` / `.obj` | Built-in parsers. Triangles only, **no B-rep topology**: faces are merged by normal, the edge wireframe is empty |
| `.sldprt` / `.sldasm` | **Native format is not parsed.** Four-level degradation, below |

**How native SolidWorks files degrade** (`lib\resolve.js`):

1. A **same-name** `.step/.stp` sits next to it → use that, a normal solid
2. No same-name file, but a closest-name STEP exists → use it, with a warning that it is a filename-similarity guess and may not be the same part
3. No usable STEP, but sw-mcp has sketches for this design → draw the sketch outlines only, **zero solids**
4. Not even sketches → `NO_MESH_SOURCE`, with a copy-pasteable next step

> So the way to get a solid out of a SLDPRT is to **put a same-name STEP next to it**, or have the agent `deliver kind="step"` first.
> The plugin never drives SOLIDWORKS itself.

---

## Known limitations

**Visual behaviour has never been verified on real hardware.** Every automated test runs against a fake WebGL renderer (`getContext()` returns `null`)
that validates code paths and data, and **never produces a single pixel**. These six items have zero coverage — the first thing to do on a real machine
is open a real STEP and check them one by one:

1. Whether the three sketch colours (selected `0xffe479` / hover `0xa8903f` / whole-sketch emphasis `0x9af5d6`) are actually distinguishable on dark and light models
2. Whether line widths thin out to a hair on large models
3. How the endpoint sphere radius `diagonal * 0.0075` feels on a 30 mm part versus a 3 m assembly
4. How much the status bar in the bottom-right corner occludes the model
5. Whether forcing highlights above solids (`depthTest:false`) produces correct see-through, and whether it flickers
6. Whether markers are visible when they sit behind the model

Other:

- **Markers live in memory only** and are lost on refresh. Use "Save annotation" to persist them. Double-clicking the same spot stacks duplicate markers (no de-duplication).
- **Readings are biased**: sketch arcs are polyline approximations (a full circle at 48 segments is ~0.071% short, an arc at 16 segments ~0.64% short), so the "total X.X mm" in the status bar is a sum of chord lengths and is **always less than the true value**. Do not trust it for fine inspection.
- **Sketch endpoints are polyline vertices only** — you cannot get true centres or tangent points.
- **No undo**: clicking empty space or pressing Esc clears the selection outright; there is no undo stack.
- **Also**: clicking can never select a "whole sketch" (the only live entry point for that is the right-click "Edit this sketch"); multi-selection does no cross-sketch geometric reasoning; screenshot channel A goes through a DSH-internal API and may break on upgrade, but degrades silently to channel B; units are assumed to be mm.
- **`/sw3d/three.js` is a legacy route**: three.js is already inlined in `client.js` and the preview does not use this route, but tests and `ping.three` assert it, so the 2.1 MB `vendor\three.cjs` must still ship.

---

## Troubleshooting

| Error | Cause | What to do |
| --- | --- | --- |
| `PYTHON_MISSING` | No Python candidate could import OCP | Read the per-candidate failure reasons in the response; install `cadquery-ocp` or set `SW_3D_PREVIEW_PYTHON` |
| `NO_MESH_SOURCE` | No usable STEP next to the SLDPRT and no sketches in sw-mcp | Put a same-name STEP there, or have the agent `deliver kind="step"` |
| `NOT_FOUND` | The path does not exist; or only a filename was given and completion failed | Open it from the file list; preview it successfully once so it enters `recent.json` |
| `UNSUPPORTED` | Extension not in the supported list; or STEP triangulation failed | Read `warnings` / `detail` in the response; re-export the STEP |
| `PING_NOT_OK` | `/sw3d/ping` did not return `ok:true` | Run the route script above; check the plugin is in the profile's `bundles` |
| `NO_DESIGN` / `NO_SKETCH_DATA` | sw-mcp has no sketch record for this file | Have the agent build that design in SOLIDWORKS once; or pass a designId |
| Screenshot not attached, a `shots\...png` path appears in the text | Channel A unavailable, already fell back to channel B | **Normal degradation** — the model can read that path directly |
| Panel stuck on "resolving path…" | Filename completion failed; a 20 s hard timeout turns it into a failure card | Re-open the file from the file list |

---

## Development

```powershell
npm test              # seven offline suites (host auto-skips when its STEP fixtures are absent)
npm run test:package  # package self-check: required files, lib inventory, vendor, local paths, tgz unpacks
npm run package       # produce dist\ and the .tgz
npm run verify:python # print the Python probe results
node scripts/check-refs.mjs --strict   # verify client.js:NNN style references in the docs have not gone stale
```

- `index.js` (Host, 8 routes) and `client.js` (Client, with three.js inlined) are build artifacts — run the tests after changing them.
- Every `lib\*.js` is free of DSH runtime dependencies and can be imported by plain node.

**Writes** (this plugin's own directory only): `%LOCALAPPDATA%\sw-3d-preview\` — `cache\` mesh cache, `annotations\`, `shots\`, `handoff\`, `recent.json`.
**Reads only**: `%LOCALAPPDATA%\sw-mcp\projects\*.json` (`SW_MCP_DATA` overrides the data root).

---

## Shipped files

<!-- sizes:begin -->
```
index.js            49,775       Host half: 8 /sw3d/* routes
client.js        2,533,655       Browser half (with three.js r187 inlined)
cordis.patch.yml     1,441       Inserts exactly one plugin row
package.json         2,070
README.md                         This file (byte count changes with edits, not listed)
CHANGELOG.md                      Byte count changes with edits, not listed
lib\mesh.js         45,600
lib\resolve.js      25,772
lib\sketches.js     34,457
lib\paths.js         8,943
lib\handoff.js       5,918
lib\ext-token.js     9,106       Bearer bypass token parsing and scope resolution
lib\step_mesh.py    39,879
vendor\three.cjs 2,126,774       Data source for /sw3d/three.js (preview does not need it; tests and ping.three do)
```
<!-- sizes:end -->

> This table is generated by `node scripts/sizes.mjs`; `--check` turns CI red when the numbers disagree with disk.
> Not shipped: `dist\`, `node_modules\`, `test\`, `tools\`, `scripts\`, `snapshots.jsonl`.
