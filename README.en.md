# dsh-sw-3d-preview · 3D result preview (DSH plugin)

Look at 3D models directly inside the **DSH file preview panel**: STEP / STL / OBJ are parsed into meshes, native SolidWorks files automatically look for a same-name STEP next to them,
plus face/edge/point picking, Alt three-point sampling, section cut with caps, a sketch overlay layer, double-click markers, annotations written to disk, and a "handoff sheet" —
the point is to turn "the problem I see" into "coordinates an agent can act on".

- Package name: `dsh-sw-3d-preview`
- Version: `0.2.2` (changes in [CHANGELOG.md](./CHANGELOG.md))
- License: `MIT` (see [LICENSE](./LICENSE)) — free to use, modify, and distribute
- Supported platform: DSH Desktop (Web UI), Windows

> Where screenshots end up: this plugin ships no sample images itself. The user-viewpoint screenshots generated when the user clicks "Fill into dialog / Save annotation" are written to
> `%LOCALAPPDATA%\sw-3d-preview\shots\` (file name = `<sha1(lowercase model path)>-<timestamp>.png|.jpg`).
> Opening that directory gives you real artifacts; this document embeds no large images.

---

## Table of contents

1. [What this is / what problem it solves](#1-what-this-is--what-problem-it-solves)
2. [Installation (from zero)](#2-installation-from-zero)
3. [Dependencies: required and optional](#3-dependencies-required-and-optional)
4. [Supported file formats and the four-level degradation](#4-supported-file-formats-and-the-four-level-degradation)
5. [Optional features](#5-optional-features)
6. [Known limitations](#6-known-limitations)
7. [Notes for using it on another computer](#7-notes-for-using-it-on-another-computer)
8. [Troubleshooting](#8-troubleshooting)
9. [Development and testing](#9-development-and-testing)
10. [Data directory and file inventory](#10-data-directory-and-file-inventory)

---

## 1. What this is / what problem it solves

In one sentence: **put a SolidWorks/STEP 3D model inside the DSH file preview panel, and let annotations map back precisely to a face/edge/point.**

The concrete problems it solves:

- DSH can preview images and text, but opening `.step` / `.sldprt` gives only hex or "not supported";
- Describing "the fillet next to that boss" in words to an agent is extremely unreliable — the human and the model do not agree on the location;
- A screenshot shows what it looks like but not dimensions/face numbers, so the agent cannot change the model from it;
- Wanting to review a STEP otherwise means starting SOLIDWORKS (several GB, tens of seconds, and possibly tying up a license).

This plugin replaces all of that: the preview panel shows the solid directly, lets you pick faces/edges/points, record coordinates, and generate a handoff sheet for the agent in one click.

**What it does not do**: it does not modify models, does not do CAD modelling, and does not need (nor start) SOLIDWORKS. The right-click menu entries
"Add sketch / Edit defining sketch / Fillet / Use as datum / Set as datum point" only **generate natural-language instructions** for the input box; they do not actually change geometry (see [Known limitations](#6-known-limitations)).

---

## 2. Installation (from zero)

### 2.1 Prerequisites

| Item | Requirement | How to check |
| --- | --- | --- |
| DSH | Desktop edition, `>= 0.2.1-rc.3 < 0.3.0-0` (see `engines.dsh` in `package.json`) | `dsh --version` |
| Node | `>= 22` (`engines.node`); the DSH on this machine bundles Node 24.21.0 | `node --version` |
| Python + OCP | **Required**; without it STEP/STL/OBJ all produce no solid (see 3.1) | `npm run verify:python` |

### 2.2 Install into the profile (choose one)

**Option A: directory link (common for development/this machine; code changes take effect immediately)**

```powershell
# 1) put the plugin directory anywhere, e.g. D:\tools\dsh-sw-3d-preview
# 2) register it in the profile's package.json (link: points at the plugin directory)
$profileDir = "$env:USERPROFILE\.dsh\profiles\desktop"
notepad "$profileDir\package.json"
```

Add one line to `dependencies` and one entry to `dsh.profile.bundles`:

```jsonc
{
  "dependencies": {
    "dsh-sw-3d-preview": "link:D:/tools/dsh-sw-3d-preview"
  },
  "dsh": { "profile": { "bundles": [ /* …existing entries… */ "dsh-sw-3d-preview" ] } }
}
```

Then create the junction (`link:` requires the directory to actually exist at that location):

```powershell
New-Item -ItemType Junction `
  -Path   "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-sw-3d-preview" `
  -Target "D:\tools\dsh-sw-3d-preview"
```

**Option B: install the packaged tgz (use this when handing it to someone else)**

```powershell
npm run package
# output: dist\dsh-sw-3d-preview-0.2.2.tgz
npm install --prefix "$env:USERPROFILE\.dsh\profiles\desktop" "<plugin dir>\dist\dsh-sw-3d-preview-0.2.2.tgz"
```

After installing, add `dsh-sw-3d-preview` to `dsh.profile.bundles` in the profile `package.json` (`dependencies` is written by npm).

### 2.3 Reload

- **Host half** (the 8 `/sw3d/*` routes): after changing `index.js`/`lib\*`, restarting DSH is the reliable option (HMR in the Loader is not guaranteed for routes added later).
- **Client half** (the preview panel itself): `client.js` is served by the `/plugins/...` route keyed by rev; change it, then refresh the page.
  Do **not** count on "turning off that one line on the plugin page hot-swaps it" — both halves are bound to a single patch, see below.

### 2.4 How to confirm the install worked (copy-paste ready)

**① Are the routes registered** — an unauthenticated request should return `401` (the trust fence is active), not `404` (route does not exist):

```powershell
$base = "http://127.0.0.1:56946"   # replace with the actual port your DSH is on
foreach ($p in "/sw3d/ping","/sw3d/resolve","/sw3d/mesh","/sw3d/three.js","/sw3d/annotation","/sw3d/handoff","/sw3d/snapshot","/sw3d/sketches") {
  try { $null = Invoke-WebRequest "$base$p" -UseBasicParsing -ErrorAction Stop; "$p -> 200" }
  catch { "$p -> $([int]$_.Exception.Response.StatusCode)" }
}
```

How to read it: **all 8 returning 401 = the routes are all there**; any one `404` = that route is not registered (the plugin is not mounted, or the version is wrong).
Measured on this machine (2026-11-15, DSH 0.2.2-rc.3): `ping / resolve / mesh / three.js / annotation` and the others all returned `401`.

**② Can Python be found**

```powershell
Set-Location <plugin dir>
npm run verify:python
```

Only when the output has `"ok": true` and `"ocp": true` is STEP usable; on failure it lists the failure reason for **each candidate**.

**③ Did the client load** — check in the browser developer tools whether `client.js` was fetched:

```powershell
# The page opens normally and the panel lets you select a .step file and shows the model = the client loaded
# Stronger evidence: a 200 response for /plugins/...client.js in the browser Network tab,
# or running the following line in the DevTools Console should return true
#   !!document.querySelector('canvas')  (after opening a STEP preview)
```

> Note: the `rev` in `/plugins/??<package>/client.js&rev=<rev>` is a short hash DSH computes from the content of the client artifact;
> it is **not a fixed value**, and building a URL with `rev=0` by hand returns `404`. To confirm the client, use "the preview panel
> renders the model" or the browser Network tab, not a hand-built URL. Measured on this machine: every hand-built `rev` returned `404`.

---

## 3. Dependencies: required and optional

### 3.1 Required

| Dependency | Purpose | What happens without it |
| --- | --- | --- |
| **Node ≥ 22** | Runtime for the Host half | The plugin does not load at all |
| **Python + `cadquery-ocp`** (OCP 8.x) | Triangulation for STEP/STL/OBJ (`lib\step_mesh.py`) | `PYTHON_MISSING`: only `.stl`/`.obj` can still limp along on the built-in parser, **`.step/.stp/.sldprt/.sldasm` all fail** |
| A writable `%LOCALAPPDATA%` | Cache, annotations, screenshots, handoff sheets | Cache cannot be written → recomputed every time; annotations return `INTERNAL` |

Installing OCP:

```powershell
py -3 -m pip install cadquery-ocp      # or whichever python you installed OCP into
python -m pip install cadquery-ocp
```

**How this plugin finds Python** (`lib\mesh.js:139 pythonCandidates()`; the order is the priority, and a failure of any candidate records its reason):

1. The `SW_3D_PREVIEW_PYTHON` environment variable (explicit, highest priority)
2. A venv under the sw-mcp data root: `%LOCALAPPDATA%\sw-mcp\.venv` (the data root can be overridden with `SW_MCP_DATA`)
3. An sw-mcp checkout referenced from the DSH profile `package.json` via `link:` / `file:` and carrying a `.venv`
4. `sw-mcp\.venv` as a sibling of the plugin directory (some people put the two side by side)
5. `py -3`
6. `python`
7. `python3`

> **The source contains no absolute path from any machine.** To set it explicitly, do this (then **reopen DSH**; the environment variable is read by the host process):
>
> ```powershell
> [Environment]::SetEnvironmentVariable('SW_3D_PREVIEW_PYTHON','C:\Python312\python.exe','User')
> ```

### 3.2 Optional

| Dependency | Purpose | What happens without it (what it degrades to) |
| --- | --- | --- |
| **sw-mcp** (`%LOCALAPPDATA%\sw-mcp\projects\*.json`, **read-only**) | ① Look up sketch data from a `designId`; ② expand a file name (relative path) into an absolute path | The sketch overlay is unavailable; when only a file name is given it may return `NOT_FOUND`. The solid preview is unaffected |
| `vendor\three.cjs` (2.1 MB) | Served as-is by the `/sw3d/three.js` route | That route returns 404 and `ping.three=false`. **It does not affect previewing**: three.js r187 is already inlined in `client.js` |
| Browser WebGL | Rendering | The panel shows a failure card (canvas errors such as `SNAPSHOT_DRAW_FAILED` also come from here) |
| The session input box (`inputActions`) | The "Fill into dialog" / "with screenshot" channel A | Automatic degradation: text goes through the clipboard, the screenshot goes through channel B (write to disk + path) |

---

## 4. Supported file formats and the four-level degradation

| Extension | How it is handled | Result |
| --- | --- | --- |
| `.step` / `.stp` | `lib\step_mesh.py` (OCP) triangulation → S3DM v2 | Complete: faces, edges, points, section cut, and precision tiers all work |
| `.stl` (binary / ASCII) | Built-in parser (`parseStl` in `lib\mesh.js`) | Triangle faces only, **no B-rep topology**: faces are merged by planar normal, and the edge wireframe is empty (`warnings` says so) |
| `.obj` | Built-in parser (`parseObj`, supports `f a/b/c`, negative indices, fan triangulation of polygons) | Same as above |
| `.sldprt` / `.sldasm` | Four-level degradation, see below | Depends on which level it degrades to |

**The four-level degradation for native SolidWorks files** (`lib\resolve.js:311` onward, `resolveSource`):

| Level | Condition | `meshSource` | What the user sees |
| --- | --- | --- | --- |
| ① Same-name STEP | A same-name `.step/.stp` exists in the same directory | `sibling-step` | A normal solid; hints explain "SLDPRT itself cannot be parsed, a same-name STEP was used" |
| ② Similar-name STEP | No same-name STEP, but a STEP with the closest name + the newest modification time exists | `fallback-step` | A normal solid + the warning "this was guessed from file-name similarity and may not be the same part" + a similarity percentage |
| ③ Sketch-only view | No usable STEP, but sw-mcp has a sketch record for that design | `sketch-only` | Only sketch outlines are drawn, **zero solid**; the info bar lists the disabled capabilities |
| ④ Error | Not even the sketch can be read | — | `NO_MESH_SOURCE` + a copy-pasteable next step (`deliver kind="step" designId=…`) + the native file's time/size |

### 4.1 What the sketch-only view actually is

**What it is**: it reads the sketch/dimension records from `%LOCALAPPDATA%\sw-mcp\projects\<designId>.json` (read-only)
and draws every sketch polyline as a 3D wireframe. It exists for cases where "this part only has sketches and will never export a STEP"
(for example `fracture-section-01`), to avoid giving the **dead-loop hint** "go export a STEP".

**What you can do**: rotate/zoom/pan the view, see how the sketch outlines run, see the number of sketches and polylines, see the designId, take screenshots,
and **click sketch polylines and endpoints** (inside a sketch the priority is endpoint > polyline > whole sketch, see section 5, table item 12).

**What you cannot do** (`client.js:4318 SKETCH_ONLY_DISABLED`; UI and wording share one source; note that item 1 only disables picking on the **solid** —
sketch polylines/endpoints can still be clicked):

| Capability | Why it is unavailable |
| --- | --- |
| Solid face/edge/point picking | There is no solid, so there is no B-rep geometry to pick (sketch polylines and endpoints can still be clicked) |
| Section cut / cap | A section cut is applied to a solid |
| Alt+three-point sampling | Sampling takes points on solid faces |
| Shaded/wireframe toggle | There are no triangle faces to shade |
| Edges | There are no B-rep edges of any kind |
| Precision tiers | A sketch has no triangulation step |
| Double-click markers | A marker attaches to a face/edge/point (**solid** faces/edges/points; markers on sketch polylines and endpoints can still be placed, by double-click or right-click "Mark here") |

---

## 5. Optional features

Every entry covers "how to turn it on / what it is for / what dependency is missing / what happens on failure". All are **available by default**; there is no global switch.

| # | Feature | How to turn it on | What it is for | When a dependency is missing |
| --- | --- | --- | --- | --- |
| 1 | **Section cut and cap** | Toolbar section control: pick an axis + drag the percentage; the "Cap" checkbox | To see internal structure: cut along X/Y/Z; the cap is a **real section face** computed geometrically (not a stencil fake face); with the cap off, the inner walls use a two-sided mesh darkened by 40% | Unavailable in the sketch view; when the section loop cannot be computed (open loops discarded / no closed contour / no section triangles) the cap is skipped and `[sw3d] section cap skipped` is printed to the Console |
| 2 | **Three precision tiers** | Toolbar "Precision": high / medium (default) / low | High `deflection 0.04 / limit 900k triangles`, medium `0.08 / 300k`, low `0.2 / 120k`; the tier is part of the cache key, so the same file is stored once per tier | Requires Python+OCP (goes through STEP triangulation). Without it → `PYTHON_MISSING`. Above 500k triangles a one-click suggestion to switch to low precision is shown |
| 3 | **Face / edge / point picking** | Hover to highlight, click to select | Picking priority **vertex > edge > face > sketch endpoint > sketch polyline > whole sketch** (a solid always overrides a sketch); the card shows face number/area/normal, edge number/length/endpoints, point coordinates; objects clipped away by the section cut cannot be selected | Sketch view: no solid, only sketches can be clicked; STL/OBJ: faces exist (merged by normal), edges are empty |
| 4 | **Three-point annotation** | **Alt + click 3 times on the same face** | To re-locate the same face in SOLIDWORKS: 3 points in model coordinates are written into the annotation and the handoff sheet | Needs a solid face. Beyond 3 points nothing is added (`MAX_SAMPLE_POINTS=3`) |
| 5 | **Double-click markers** | Double-click a face/edge/point | Places a numbered marker point on that object ("persistent intent"); each double-click adds another one (the code does not deduplicate by object) | Sketch view: markers can only be placed on sketch polylines and endpoints (double-click or right-click "Mark here"); markers on **solid** faces/edges/points are unavailable. **Markers live in memory and are lost on page refresh** (see limitations) |
| 6 | **Right-click menu** | Right-click a face/edge/point (right-clicking empty space also works) | On an object: "Mark here" + generated modelling instructions (face: add sketch / edit defining sketch; edge: fillet/chamfer / use as datum; point: set as datum point). **On sketch objects there are also** "Edit this sketch", "Select all in this sketch", "Put the selection into the dialog". On empty space: "Fit", "Reset view", "Copy current screenshot to dialog" | The dropdown items only **generate instruction text**; they do not change the model |
| 7 | **Sketch overlay** | Toolbar "Sketch" toggle | A read-only overlay: draws this design's sketch outlines from sw-mcp beside/inside the solid, to compare "what the sketch behind the model looks like" | Needs sw-mcp records + a designId. Without them → `NO_DESIGN` / `NO_SKETCH_DATA`, the toolbar shows a hint, and the solid preview is unaffected |
| 8 | **Sketch-view degradation** | Automatic | See 4.1 | See 4.1 |
| 9 | **User-viewpoint screenshots (the "with screenshot" checkbox + the two channels)** | "With screenshot" is **checked** by default; a screenshot is taken automatically when "Fill into dialog" or "Save annotation" is clicked | Hands the current screen (including the bottom info strip: viewpoint/section/precision/time) to the agent for image reading | **Channel A** (draft attachment, `conversation.createDrafts`) → on failure it automatically degrades to **channel B** (POST `/sw3d/snapshot` writes to disk, returns `shotPath`, the path is written into the text box). If both fail: the text is still filled in and the button does not stop working |
| 10 | **Annotation handoff sheet (handoff)** | Save a few annotations, then click generate handoff sheet | Aggregates all annotations of that file into one Markdown document (`%LOCALAPPDATA%\sw-3d-preview\handoff\<sha1>.md`); the user hands the **path** to the agent instead of stuffing dozens of annotations into the input box | Requires at least one annotation; on failure → `HANDOFF_FAILED`/`INTERNAL` (`lib\handoff.js:117`) |
| 11 | **Annotation persistence (`annotations.jsonl`)** | "Save annotation" appends automatically | One JSON object per line (`id / at / file / fileHash / annotation`), attributed by the file's sha1; reopening the panel reads them back and marks already-annotated edges on the card | Write failure → `INTERNAL` "the annotation was not written" (`index.js:1000`) |
| 12 | **Sketch polyline and endpoint picking + Ctrl/Cmd multi-select** | In the sketch view or the overlay, click a polyline/endpoint directly; **Ctrl (Cmd on macOS) + left click** toggles the selection; Esc clears it | Picking priority **sketch endpoint > sketch polyline > whole sketch** (ray thresholds: polyline `diagonal × 0.012`, endpoint `diagonal × 0.018`, so the endpoint tolerance is wider). **Note: the last tier, "whole sketch", is unreachable on the real mouse path** (see limitation 18); the live entry point for the whole sketch is the right-click "Edit this sketch". **Solid picking (vertex/edge/face) always overrides sketches**. Clicking without a modifier = **replace** the selection; holding Ctrl/Cmd and clicking = **toggle** on that object (selected → deselect, not selected → add); lines and points of different types can be selected together; clicking empty space **without a modifier** or pressing Esc clears the selection; **Ctrl/Cmd + click on empty space does nothing** (Ctrl is cumulative semantics, a slip of the hand should not clear the selection). **Shift+left-drag still pans and Ctrl+drag still rotates** — only a Ctrl click that did not drag counts as multi-select. The info bar summarizes into one line: `N lines and M points selected (X.X mm total)`; the right-click menu gains "Select all in this sketch", "Put the selection into the dialog" (the latter generates copy-pasteable instruction text), and "Edit this sketch" (the same generation function as the panel button, `sketchEditInstructionFor`, `client.js:6005`, so the two texts are always identical). Select-all is deliberately only in the right-click menu, so it **does not steal the browser/host Ctrl+A** | Needs sketch data (sketch view or overlay). Without sketches these entry points do not appear |

**Screenshot channel details**: a PNG larger than 1.5 MB is automatically re-encoded as JPEG(0.9) (`client.js:1008`); the host-side limit is 8 MB and
the text size limit is 12 MB (`index.js:86` `MAX_SNAPSHOT_TEXT_BODY`); the host only trusts the PNG/JPEG **magic number** — the extension and the declared mediaType do not count (`index.js:357` `sniffImageType`).

---

## 6. Known limitations

An honest list. **These are the current state, not promises of work to come.**

### Visual presentation has never been verified on real hardware

**Nothing in this whole area has been verified — not one item.** All automated tests run a **fake WebGL renderer**: the
`HeadlessRenderer` in `test\sketch-select.mjs` (`test\sketch-select.mjs:703`), whose `getContext()` **returns `null`**
(`getContext()` at `test\sketch-select.mjs:64`, `:686`), and whose `render()` is an empty function (`render() {}` at `test\sketch-select.mjs:711`).
In other words, the tests only verify "the code path runs and the data is computed correctly"; they **never produce a single pixel**.

So the following six items have **zero coverage** and have not been looked at once in a real browser:

1. **Whether the three sketch-view colors are actually distinguishable** — there are three colors in total (see item 15):
   the selected amber **`0xffe479`**, the hover overlay dark amber **`0xa8903f`** (opacity 0.7), and the whole-sketch emphasis **`0x9af5d6`** (a brightened version of the sketch's own color).
   Whether they are readable on dark models, light models, and white backgrounds, and whether they are **actually distinguishable from each other** (the colors were split apart, but the appearance was never checked — unverified);
2. **Whether the line width is visible** — whether sketch polylines and selected polylines get as thin as a hair on a large model;
3. **Whether the endpoint sphere size is appropriate** — the sphere radius is `diagonal * 0.0075`, and how different it looks on a 30 mm part versus a 3 m assembly;
4. **Whether the info bar covers the model** — how much the "N lines and M points selected" text in the bottom-right corner occludes the part;
5. **The stacking effect of `renderOrder` / `depthTest:false`** — with highlights forced to draw on top of the solid (`depthTest:false`),
   polylines/endpoints hidden by the model "show through"; whether they show through correctly and whether they flicker; when hover (`renderOrder` 4) and
   selected (`renderOrder` 5) overlap on the same line, whether the override order really looks like "selected overrides hover";
6. **Whether marker spheres are occluded by the model** — whether a marker in the background shows through at all.

Conclusion: **the code and the data are correct, but "does it look good, does it occlude, can you see it" has no answer.**
The first thing to do after installing on a real machine should be to take one real STEP and go through these six items one by one, not to assume they are fine.

### Other limitations

1. **The right-click menu does not change the model.** "Add sketch / Edit defining sketch / Fillet·Chamfer / Use as datum / Set as datum point" only generate a natural-language instruction into the input box
   (`client.js:2198 CONTEXT_MENU_DEFS`, `behavior: 'draft'`); whether it is actually done in SOLIDWORKS is up to the agent.
2. **Marker points exist only in memory.** Markers placed by double-click (`var markers = [];` from `client.js:5007` onward) are neither persisted nor written into `annotations.jsonl`,
   so **refreshing the page / reopening the preview loses them**. To keep them you must click "Save annotation" (which writes the current object's annotation to disk) or use "Write markers into the input box".
   Also note: `addMarker` (`client.js:5123`) does nothing but `markers.push`, with **no deduplication by object** — double-clicking the same spot stacks up several markers.
3. **Screenshot channel A relies on an API inside the DSH package and may break on upgrade.** Channel A goes through `ctx.get('conversation').createDrafts(...)` +
   `inputActions.addAttachments(...)` (`client.js:1869 attachSnapshotToDraft`), which is an **in-package interface**, not a public contract.
   If the signature changes after a DSH upgrade, the symptom is that screenshots automatically degrade to channel B (a `shotPath` path appears in the text); **it does not error and does not crash**.
   Channel B (`/sw3d/snapshot`) only depends on this plugin's own routes and is far more stable.
4. **The `/sw3d/three.js` route is a historical leftover.** The evidence checked:
   - From `client.js:9220` on, three.js r187 is already **inlined** (`begin vendor/three.cjs`; the inlined section runs to `end vendor/three.cjs` at `client.js:90595`),
     so the preview does not need to request this route;
   - There is **no** fetch of `/sw3d/three.js` anywhere in `client.js` (the string cannot be found in the whole file; it only requests
     `/sw3d/ping|resolve|mesh|annotation|handoff|snapshot|sketches`);
   - `test\host.mjs:740` still asserts on it: it expects 200 while `vendor\three.cjs` exists, and `ping.three` is asserted to be `true` at `test\host.mjs:1154`.

   Conclusion: **it is not required for previewing, but tests assert on it and `ping.three` also reports its existence, so it cannot be deleted.** The status quo is kept
   (`index.js:860 handleThree` returns it as-is). Packaging must include these 2.1 MB, otherwise `ping.three` becomes `false` and the route returns 404.
5. **The dead-loop hint for a native file with no solid in sw-mcp (fixed).** Early on, a native file that "only has sketches and will never export a STEP" was repeatedly told "go export a STEP".
   Now `lib\resolve.js:376` onward probes the sketch record first; if there is one it returns `sketch-only` and says plainly "this design has only sketches (zero solid) and cannot export a STEP". **No fix date is recorded.**
6. **The sketch view has no solid, so it cannot do solid picking / section cut / sampling / precision, nor markers on "solid" faces/edges/points** (markers on sketch polylines and endpoints can still be placed, by double-click or right-click "Mark here"; see the 4.1 table). **Sketch polylines and endpoints can still be clicked** (see section 5, item 12).
   This is by design, not a bug.
7. **`index.js` exports `Config`, so the plugin page has configuration items (but only one group).** `Config` is generated by `createExtConfigSchema()` (`index.js:78`) and currently exposes just the two Bearer-bypass keys: `extToken` (empty = disabled) and `extTokenScopes` (default `['read']`), see `cordis.patch.yml`.
   Every other knob is still an environment variable (`SW_3D_PREVIEW_PYTHON` / `SW_MCP_DATA` / `LOCALAPPDATA`); changing the port or a limit requires changing code.
8. **`test\host.mjs` hard-codes a sample path from this machine** (around `test\host.mjs:26`, `C:\Users\<user>\Desktop\工程自动化`).
   This is a this-machine assumption of a **test script** and does not enter the packaged artifact; running the tests on another machine will `skip` it (not fail). The packaging self-check does not depend on it.
9. **Concurrent annotation writes** are serialized by an in-process Promise chain (`withAnnotationLock` in `index.js`); **multiple DSH instances writing the same
   `annotations.jsonl` at the same time is not guaranteed safe** (the risk of a later write overwriting an earlier one is very low but non-zero).
10. **Units** are treated as mm (both STEP and bbox are interpreted as mm). If the source model is in inches/meters, the dimension display will be wrong, but nothing crashes.

### Limitations of sketch polyline/endpoint picking and multi-select

11. **Arc/circle lengths are the sum of chord lengths, not the analytic arc length, so they come out short.** Arcs/circles in a sketch are approximated by polylines
    (`lib\sketches.js:36` `CIRCLE_SEGMENTS = 48`, `:38` `ARC_SEGMENTS = 16`), and the "X.X mm total" in the info bar
    adds up those chord lengths directly. The number is **smaller** than the true arc length:
    - A full circle as a 48-gon → about **0.071%** short (`48·sin(π/48)/π = 0.999286…`);
    - An arc with the default 16 segments → about **0.64%** short (`16·sin(π/16)/π = 0.993587…`).

    Both figures are computed from the formula, not estimated. More segments get closer to the true value, but it is **always less than the true value** (a chord is shorter than an arc).
    Do not trust this total for fine verification work.
12. **Sketch endpoints only recognize polyline vertices.** The "endpoints" you can click are only the vertex coordinates inside the polyline. Arcs/circles are polyline approximations,
    so **the real circle center, tangent point, and constrained endpoints are not available** — the upstream sw-mcp sketch data has no such concepts at all.
    For a circle point, the "endpoint" it gives you is actually a sample point on the 48-gon.
13. **No undo.** Clicking empty space **without a modifier** or pressing Esc clears the selection outright; there is no selection history and no undo stack (Ctrl+Z does not restore the previous selection).
    A stray click on empty space means selecting everything again one by one. (Ctrl/Cmd + click on empty space already "does nothing", so a slip of the hand while holding Ctrl does not clear the selection.)
14. **Multi-select does not do geometric reasoning across sketches.** You can select lines and points on several sketches at once, and they are displayed grouped by sketch
    (`groupSketchSelectionBySketch`, `client.js:2793`), with group names carrying "sketch N / datum plane name"
    (`sketchGroupIdentity`, `client.js:3042`) — **even two sketches with the same name can be told apart**.
    But there is **no** reasoning such as "intersection / collinearity / distance across sketches".
    "Put the selection into the dialog" only lists each object's data grouped; geometric relations must be inferred by the model itself.
    Also note: selecting inside a single sketch still uses the **old format** (branched by group count, `var grouped = groups.length > 1;` at `client.js:2954`),
    so the grouping feature does not drop the "（belongs to feature "X", drawn on Y）" sentences.
15. **Hover and selection used to share a color (fixed twice; three distinct colors are used now).** The **three colors** here must be stated separately, or it is very easy to break it again:

    | Purpose | Constant / value | Location | `renderOrder` |
    | --- | --- | --- | --- |
    | **Hover overlay** (the polyline the mouse sweeps over) | `SKETCH_HOVER_LINE_COLOR = 0xa8903f`, opacity `0.7` | `client.js:2342` / `client.js:2344` | 4 (`client.js:5236`) |
    | **Selected** (a polyline in the Ctrl multi-select) | `COLORS.sketchPick = 0xffe479`, opacity `1` | `client.js:4517` | 5 (`client.js:5224`) |
    | **Whole-sketch emphasis** (hover/whole-sketch selection brightens the whole line) | `SKETCH_EMPHASIS_COLOR = 0x9af5d6` | `client.js:2347` / used at `client.js:5252` | — |

    History: the first fix changed the **hover overlay** from `0xffe479` to `0xa8903f` (at the time the problem was thought to be only in the overlay).
    Only the second time was the real root cause found, in the **whole-sketch emphasis color**: `SKETCH_LINE_STYLE_ON.color` was also equal to
    `COLORS.sketchPick`'s `0xffe479`, so when the mouse swept over a whole sketch, "selected" and "not selected in the same sketch" had
    ΔE76 = **0.00** (exactly the same color, so the multi-select highlight disappeared outright) — the previous round's "fixed" conclusion was **incomplete**.
    Now the whole sketch uses the brightened sketch color `0x9af5d6`, selection is still `0xffe479`, and the two are no longer equal.
    **But the on-hardware appearance is still unverified**: the actual contrast of these three colors on dark/light models has not been looked at in any browser (see the six zero-coverage items in the previous subsection).
16. **Sketch-view hover throttling used to be missing (fixed).** The previous round's text said "the throttle predicate only looks at `triangleCount > 100000`, and the sketch view is always 0, so it never throttles".
    The predicate is now `hoverThrottleNeeded(model.stats, sketchStats)` (`client.js:79`): if the triangle count exceeds the threshold **or** the sketch's "point count + segment count"
    is `> 8000` (`HOVER_THROTTLE_SKETCH_ITEMS`, `client.js:61`), it is frame-limited to `33 ms` (≈30 fps,
    `HOVER_THROTTLE_MS`, `client.js:63`), and `setHover` actually uses it (`client.js:6364`).
    Endpoint scanning is also no longer a linear per-point scan; it goes through the spatial index `buildSketchPointIndex` (`client.js:2475`).
    **Measured** (50000 points / 49900 segments, same process and same data, 3 runs each, averaged):

    | Comparison | Number |
    | --- | --- |
    | Old hot path (`setFromCamera` + `intersectObject` from `c0aeeeb`, which only returns `subject:'sketch'`) | 1.655 / 1.754 / 1.716 ms → average **1.708 ms** |
    | New implementation (real `pointermove` → `setHover` → `pickSketchCandidates`, with endpoint index + segment index + segment location) | 0.350 / 0.359 / 0.335 ms → average **0.348 ms** |
    | **Same-metric speedup** | **4.91x** |
    | Contribution of the index cache alone (same new feature, only switching `entry.pointIndex` → `entry.polylines`) | uncached 0.900 / 0.902 / 0.953 ms → cached 0.350 / 0.370 / 0.351 ms = **2.57x** |

    > **Same-metric correction**: this used to say "2.501 ms → 0.273 ms (9.16x)". That number **is not comparable** — the two measurements were
    > not the same path (the old number came from an old hot path that only reached the `subject:'sketch'` fallback tier, the new number comes from the full three-tier
    > picking), and the developer has withdrawn it. The 4.91x in the table above is a **same-metric** re-measurement: both the old path and the new path are counted as "one real hover".
    > The index cache's separate contribution is **2.57x**; the two are not the same thing.

    This is **pure JS time** (fake renderer + Node 24) and **excludes WebGL submission and compositing**; the absolute milliseconds on real hardware will differ,
    and the ratio may not be exactly the same either. The drag feel of a 10000+ point sketch on real hardware is still unverified.
17. **`SKETCH_ONLY_DISABLED` and the toolbar disabled state are two sources of truth.** The array at `client.js:4318` only feeds the **hint text**;
    whether a toolbar button is actually disabled is decided independently by the `isSketchOnly` literal (`client.js:8753`).
    The two currently happen to agree, but changing one does not move the other. The comments have been corrected to be truthful, but **it has not been unified into one source**.
18. **The `subject:'sketch'` (whole sketch) tier of the picking path is unreachable.** Sampling **13,400** screen points on an 800×600 grid at 6px
    hit `sketchPoint` **21** times, `sketchLine` **69** times, and `sketch` **0** times (the numbers were measured and asserted by the check at
    `test\sketch-select.mjs:1731`). The reason is that tier 3 (whole sketch) and tier 2 (polyline)
    use the **same threshold and the same geometry**, so tier 2 necessarily hits first and tier 3 never gets in.
    **Corollary: clicking can never select "the whole sketch".** The only live entry point for the whole-sketch concept is the right-click menu's
    "Edit this sketch" (plus the public API `selectSketch`). This is a design trade-off, not a bug, but maintainers must know:
    the `picked.subject === 'sketch'` branch in `select()` (`client.js:6436`) is **dead code** — it is kept because at the contract level tests still exist
    (`pickSubjectByPriority` passing a sketch object in directly), and it could become reachable again if the polyline tolerance is relaxed in the future,
    but **do not** take it as evidence that "the whole sketch can be clicked".
19. **The determinism of hover throttling is guaranteed by an injected clock (this one is fixed).** The previous round's text said "the time window depends on `Date.now()`,
    the test retries up to 6 times, and a slow machine may exhaust them". The test now injects a fake clock via `setHoverClock` (`client.js:7166`),
    with **no retries at all**: from `test\sketch-select.mjs:1657` onward it advances the clock from 1000 ms by +10 / +40 ms manually,
    deterministically constructing both "within the same 33 ms window" and "the window has passed". Changing `HOVER_THROTTLE_MS` to 3000
    (hover completely stuck) now **must fail**, whereas the old approach stayed green. The drag feel of a 10000+ point sketch on real hardware is still unverified.
20. **The real output of `sketchPlane` is unverified.** In `lib\sketches.js:639` the field name is `plane`, and the client reads
    `entry.data.plane` (`client.js:5859`, `client.js:5883`). But **a payload has never been captured once from a real SOLIDWORKS to
    confirm that this field is non-empty** — the existing tests all use fixtures from the repository. If it is empty, the group name degrades to only "sketch N",
    which **still distinguishes sketches with the same name**, only without the datum-plane half of the information.
21. **Right-click does not select (this is deliberate).** When the sketch multi-select set is **non-empty**, right-clicking **any** sketch object (polyline/endpoint/whole sketch)
    **does not change the selection** — the `keepSelection` predicate is "the set is non-empty + the hit item is a sketch object" (`client.js:6186`),
    regardless of whether the hit item is already in the set. Rationale: this way "Put the selection into the dialog" is guaranteed to receive the group you actually selected,
    and right-clicking a neighboring line will not turn 2 selected into 1. The **cost** is that "right-click a line to single-select it" does not work —
    you have to first click it with the **left button**, replacing the multi-select with a single item, and then right-click. When the set is empty, right-click still selects that object (the old path is unchanged).
    Right-clicking a **solid** object (face/edge/point) is not covered by this rule; it still single-selects and clears the sketch multi-select.
22. **Double-clicking clears the multi-select.** After selecting 2 items, double-clicking one of them to place a marker turns the multi-select into **only that 1 item**.
    Because double-click goes through the non-additive `select(picked)` (`client.js:6667`), and the first thing `select` does is
    `clearSketchSelection({silent:true})` (`client.js:6397`). This is the necessary consequence of the "double-click = select this and do something" semantics
    (see section 5, item 5), but it does make people think "the marker was added and the selection is still there". To keep the multi-select, select multiple items
    first → right-click "Mark here"; do not double-click.
23. **`test\sketch-only.mjs:316` hard-codes the `client.js` path.** That line is
    `fs.readFileSync(path.join(PLUGIN_DIR, 'client.js'), 'utf8')` and **does not read the `SW3D_CLIENT` environment variable**
    (`test\sketch-select.mjs` and `test\client-smoke.mjs` both do). The consequence is that those **14 items cannot be run against a mutant**:
    when you want to verify "would breaking client.js be caught by these 14 items", you modify the real `client.js` and the run still uses it —
    in effect it can only self-test, and mutation testing is impossible. This is an **inconsistency between suites**, and it is not fixed.

---

## 7. Notes for using it on another computer

**When installing on another computer, these are environment-dependent and must be confirmed on site:**

1. **Paths and drive letters**: the plugin itself **contains no absolute path from this machine** (`npm run test:package` scans the artifact; 0 hits is a pass).
   But the `link:D:/…` line in the profile's `package.json` is **that machine's path** and must be changed to the actual location.
2. **`%LOCALAPPDATA%` must be writable**: the cache `/cache`, annotations `/annotations`, screenshots `/shots`, handoff sheets `/handoff`, and `recent.json` are all written here.
   A read-only environment or corporate policy locking AppData causes: the cache misses every time (slow but usable), annotations return `INTERNAL`, and all screenshots fail their degradation.
3. **Where Python is installed**: it does not need to be on PATH and does not need to be called `python`. The most reliable way is to set it explicitly:
   ```powershell
   [Environment]::SetEnvironmentVariable('SW_3D_PREVIEW_PYTHON','C:\Python312\python.exe','User')
   ```
   After setting it, **reopen DSH** (the host process reads the environment variable at startup). A wrong value does not hang: it keeps trying the later candidates, and `ping`/error messages show the failure reason for each candidate.
4. **Firewall / loopback**: all `/sw3d/*` access is **local loopback** (`http://127.0.0.1:<port>`); do not expose it to the intranet.
   Every route goes through the `ctx.connection.requestRejection` trust fence (`index.js:12` documents this constraint; the actual call sits at the top of each `handleXxx`, e.g. `allowTrusted` at `index.js:550`), and unauthenticated requests get `401`.
5. **The port changes**: `/sw3d/*` is mounted on DSH's own Web port (it is `56946` in this session and may be different on each start).
   The plugin internally uses relative paths `/sw3d/...`, so **no configuration change is needed**; but your **manual verification script** must use the current port (see 2.4).
6. **Multiple DSH instances**: each instance is an independent host process, probing Python on its own and writing `%LOCALAPPDATA%\sw-3d-preview` on its own.
   The cache is keyed by "model path + mtime + size + precision", and multiple instances share the same cache files — **concurrent writes to the same cache key** could in theory overwrite each other,
   but in practice it writes a temporary file and then renames it (`buildS3dm` in `index.js` uses `.tmp` then renames), so a half-written file is never read.
7. **sw-mcp is optional**: when another machine has no sw-mcp, the solid preview (STEP/STL/OBJ, same-name STEP degradation) is **completely unaffected**;
   only the sketch overlay and "path completion when only a file name is given" are unavailable. The sw-mcp data root can be overridden with `SW_MCP_DATA`.
8. **Do not commit `dist\` to git**: it is already in `.gitignore`. The artifact changes (timestamps, content hashes), and committing it only creates noise.
9. **`vendor\three.cjs` is in `.gitignore` but must be distributed with the package**: it is covered because `package.json`'s `files` lists it explicitly
   (`files: [..., "vendor/three.cjs"]`), and `npm pack --dry-run` measured that it is included (together with it, **16 files** in total).
   If you copy the directory by hand instead of going through npm, **remember to copy this 2.1 MB file separately**, otherwise `/sw3d/three.js` returns 404 and `ping.three=false`.

---

## 8. Troubleshooting

Look it up by symptom. Each row gives "symptom → cause → what to do" plus the **code reference** (file:line); the line numbers are valid for `0.2.2`.

| # | Symptom (error code / phenomenon) | Cause | What to do | Source |
| --- | --- | --- | --- | --- |
| 1 | `PYTHON_MISSING` "no Python found that can import OCP" | All candidates (env → sw-mcp venv → py -3 → python/python3) are unusable | Look at the failure reason for each candidate in `error` in the response; install `cadquery-ocp` or set `SW_3D_PREVIEW_PYTHON` | `index.js:657` (where `PYTHON_MISSING` is thrown), `lib\mesh.js:1056` (probe verdict), `lib\mesh.js:79` (start of the `SW_3D_PREVIEW_PYTHON` priority chain) |
| 2 | `NO_MESH_SOURCE` (HTTP 422) | There is no usable STEP next to the `.sldprt/.sldasm`, and sw-mcp has no sketch either | Put a same-name `.step` in the same directory; or follow the hint `deliver kind="step" designId=…` and have the agent export one | `lib\resolve.js:347` (where `NO_MESH_SOURCE` is thrown), `lib\resolve.js:323` (the generic fail) |
| 3 | `NOT_FOUND` (HTTP 404/400) | The path does not exist / is not a file; or only a file name was given and neither the sw-mcp records nor `recent.json` contain it | Confirm the absolute path in the resource panel; preview it successfully once so it lands in `recent.json`; check `%LOCALAPPDATA%\sw-mcp\projects\*.json` | `lib\resolve.js:247` (no path given), `lib\resolve.js:291` (still not found after completion) |
| 4 | `UNSUPPORTED` | The extension is not in `.step/.stp/.stl/.obj/.sldprt/.sldasm`; or STEP triangulation failed (OCCT cannot read it); or the request body is over the limit | Switch formats / re-export the STEP; look at `warnings`/`detail` in the response (tail of stderr) | `lib\resolve.js:332` (unsupported extension), `index.js:674` (triangulation failed), `index.js:695` (STL/OBJ parse failed) |
| 5 | `BAD_REQUEST` | Missing the `path` parameter, the body is not JSON, `path` is not absolute, `base64` missing, etc. | Fix the request per message/hint; wrap `path` with `encodeURIComponent` | `index.js:574` (`/sw3d/resolve` without path), `index.js:1132` (snapshot without base64), `lib\sketches.js:717` |
| 6 | `SNAPSHOT_*` (`SNAPSHOT_DRAW_FAILED` / `SNAPSHOT_NO_SOURCE` / `SNAPSHOT_ENCODE_FAILED` / `SNAPSHOT_EMPTY` / `SNAPSHOT_READ_FAILED`) | The canvas yields no pixels (the WebGL buffer was already discarded), the browser does not support encoding, the image is 0 bytes | Let the preview actually render a frame before taking the screenshot; try disabling hardware acceleration; these failures **do not affect filling in text** | `client.js:1507`, `client.js:1485`, `client.js:1650`, `client.js:1635`, `client.js:1691` |
| 7 | The screenshot was not attached, and `%LOCALAPPDATA%\sw-3d-preview\shots\…png` appears in the text | Channel A is unavailable (no session / subagent session / `createDrafts` signature changed) and it has degraded to channel B automatically | **A normal degradation, nothing to fix**: the model can `read_image` that path directly | `client.js:1869`, `client.js:1786`, `index.js:1157` (where `shotPath` is written) |
| 8 | `HANDOFF_FAILED` / "generating the handoff sheet failed" | Writing `handoff\<sha1>.md` failed (AppData not writable, disk full, path not absolute). Note: `HANDOFF_FAILED` is a **client-side fallback code**; the host returns `INTERNAL` / `BAD_REQUEST` | Check that `%LOCALAPPDATA%\sw-3d-preview\handoff` is writable; look at the `[sw-3d-preview]` stack in the DSH log | `client.js:8649` (fallback code), `lib\handoff.js:107`, `lib\handoff.js:117`, `index.js:1064` (`writeHandoffFile` call) |
| 9 | `PING_NOT_OK` "3D service status abnormal" | `/sw3d/ping` did not return `ok:true` (the route was taken over by another plugin, version mismatch, the plugin is not mounted) | Use the script in 2.4 to confirm the 8 routes; confirm that the entry really is in the profile's `bundles` | `client.js:4369` (this code is produced by the client; it does not exist in `index.js`), `index.js:549` (`handlePing`) |
| 10 | `NO_DESIGN` / `NO_SKETCH_DATA` / `PROJECT_UNREADABLE` | There is no designId for this file in sw-mcp, `<designId>.json` is not valid JSON, or it cannot be read | Have the agent build that design once in SOLIDWORKS; or pass the designId directly | `lib\sketches.js:736` (`NO_DESIGN`), `lib\sketches.js:750` (`PROJECT_UNREADABLE`), `lib\sketches.js:618` / `lib\sketches.js:655` (`NO_SKETCH_DATA`) |
| 11 | `METHOD_NOT_ALLOWED` (HTTP 405) + an `Allow` header | Wrong method (for example POST to `/sw3d/mesh`) | Follow the `Allow` header; `/sw3d/mesh|resolve|ping|three.js|sketches` are GET/HEAD, `/sw3d/snapshot` is POST, `/sw3d/annotation|handoff` are GET/POST | `index.js:524` (the 405 and the `Allow` header are in `allowMethods`), `index.js:1099` (the call site that permits only POST on `/sw3d/snapshot`) |
| 12 | The panel stays on "resolving path…" forever | The resource `stat` never goes live; when only a file name was given, the host-side completion fails | A hard timeout of 20 s turns it into a failure card (`PATH_HARD_TIMEOUT_MS`); reopen the file from the file list | `client.js:90` (`PATH_RESOLVE_GRACE_MS`), `client.js:92` (`PATH_HARD_TIMEOUT_MS`), (failure card) `client.js:9009` |
| 13 | After uninstalling, some endpoints return 404 while the UI is still there | **Splitting it into two patch lines** leaves the Host and the Client out of sync | Use a single patch only (exactly one insert line in `cordis.patch.yml`); see the comment at the top of the file | `cordis.patch.yml:1` |

> Unverified: the error code `INSTANCE_NOT_BOUND` **does not exist in this plugin's code**; it is a false rumor and should not be used for troubleshooting.

---

## 9. Development and testing

```powershell
npm test              # host + package + python-candidates + client-smoke + sketch-select + sketch-only + ext-token: seven suites (offline; host auto-skips when the STEP sample is missing)
npm run test:host     # S3DM round-trip / STEP triangulation / four-level degradation / STL+OBJ / routes / end-to-end http
npm run test:package  # packaging self-check, 16 items (required files, lib manifest completeness, vendor, local paths, tgz extractable, self-check is not always-true)
npm run test:client   # the 87 pure-function items in client.js (does not need vendor/three.cjs)
node test\sketch-select.mjs  # sketch polyline/endpoint picking + Ctrl multi-select, 61 items (27 of them are "regression / blocker / must-fix" assertions)
node test\sketch-only.mjs    # sketch-view degradation (disabled list / hints / screenshot info strip), 14 items
npm run package       # produces dist\dsh-sw-3d-preview-0.2.2\ and the .tgz, and prints the self-check result
npm run verify:python # prints the python probe result (including the failure reason for each candidate)
```

> `test\sketch-parse.mjs` has no standalone entry point: it exports `registerSketchParseTests(check)` and is registered by
> `test/client-smoke.mjs:2428` into those 87 items (6 of which are sketch parsing). Running `node test\sketch-parse.mjs` on its own
> exits with code 0 silently and **runs nothing** — do not mistake it for an independent test suite.

**Conventions**

- `index.js` (Host) and `client.js` (Client) are **artifact files** (`client.js` is about 2.5 MB and contains the inlined three.js),
  so changing them requires also running `test/client-smoke.mjs`.
- `lib\mesh.js` does not depend on the DSH runtime and can be imported by node directly (all `lib\*.js` follow this rule).
- `lib\step_mesh.py` can be run on its own: `python lib\step_mesh.py --in a.STEP --out a.s3dm --deflection 0.08`.

---

## 10. Data directory and file inventory

**What this plugin writes (only its own directory)**: `%LOCALAPPDATA%\sw-3d-preview\`

| Path | Contents |
| --- | --- |
| `cache\<sha1>.s3dm` | S3DM v2 mesh cache, key = `sha1(lowercase path|mtime|bytes|deflection|ang:angle|crease:creaseAngle|max:maxTriangles)` (`lib/mesh.js:451-456`) |
| `annotations\annotations.jsonl` | Annotations, appended line by line, one per line |
| `shots\<sha1>-<ts>.png\|.jpg` | User-viewpoint screenshots (channel B) |
| `handoff\<sha1>.md` | Annotation handoff sheet |
| `recent.json` | Recently resolved paths (used for file-name completion) |

**What this plugin only reads**: `%LOCALAPPDATA%\sw-mcp\projects\*.json` (sw-mcp design records; `SW_MCP_DATA` can override the data root).

**Files distributed with the package** (`files` in `package.json`; both `npm pack --dry-run` and `scripts\package.mjs` measured **16 files**,
and after extraction `vendor\three.cjs` alone accounts for 2.1 MB. Below, only the exact byte counts of files that **do not change when the documentation is edited** are listed;
the `README.md` / `CHANGELOG.md` lines carry no number — whoever edits the documentation once makes the byte count immediately stale, so anything written here would only become false.
**No "total artifact byte count" is written either**: it would include this file itself, making it self-referential and necessarily out of date as soon as the document changes.
**This table is generated by `node scripts/sizes.mjs`** — the number columns are computed by that script from the
shipped-file manifest in `scripts\package.mjs`; re-run it after changing code. In `--check` mode it fails CI whenever a number
drifts from what is on disk. The descriptions and row order are hand-written and the script never touches them.

<!-- sizes:begin -->
```
index.js            49,775       Host half: the 8 /sw3d/* routes
client.js        2,533,655       Browser half (contains the inlined three.js r187)
cordis.patch.yml     1,441       inserts exactly one plugin line
package.json         2,070
README.md                        this file (byte count changes with edits, not listed)
CHANGELOG.md                     byte count changes with edits, not listed
lib\mesh.js         45,600
lib\resolve.js      25,772
lib\sketches.js     34,457
lib\paths.js         8,943
lib\handoff.js       5,918
lib\ext-token.js     9,106       Bearer-bypass token parsing and scope resolution
lib\step_mesh.py    39,879
vendor\three.cjs 2,126,774       data source for /sw3d/three.js (previewing does not depend on it, but the tests and ping.three do)
```
<!-- sizes:end -->

**Not distributed**: `dist\`, `node_modules\`, `snapshots.jsonl`, `test\`, `tools\`, `scripts\` (the packaging script itself does not need to travel,
but is kept in the repository to make re-packaging easy).
