## 改了什么

<!-- 一两句话。写「行为变化」，不写「修改了某文件」 -->

## 为什么

<!-- 问题是什么？有没有关联 issue？ -->

## 测试

在插件根目录跑过（Node ≥ 22）：

- [ ] `node test/package.mjs` — 13/13
- [ ] `node test/client-smoke.mjs` — 86/86
- [ ] `node test/sketch-select.mjs` — 58/58
- [ ] `node test/sketch-only.mjs` — 14/14
- [ ] `node test/host.mjs` — 全部通过
- [ ] `node --check index.js` && `node --check client.js`

<details>
<summary>输出尾部（贴几行就够）</summary>

```
（粘贴处）
```
</details>

**新增/修改的断言：** <!-- 修 bug 请说明哪条断言在改之前是红的；纯视觉改动写「无自动化覆盖」 -->

## 涉及哪些已知限制

改了这个仓库的东西，通常会让 README 第 6 节某一条不再成立。请勾选并说明：

- [ ] 不涉及已知限制
- [ ] 涉及，编号：<!-- 例如 第 12 条（草图端点只认折线顶点） -->

<!-- 若涉及，README 里那一条同步改了吗？ -->

## 是否改动了这些红线文件

- [ ] `client.js`（构建产物形态的单文件）—— 改完已重跑 `client-smoke` **和** `sketch-select`
- [ ] `lib/step_mesh.py` —— 已用真实 STEP 手动验证过一次
- [ ] `package.json` 的 `files` —— 已跑 `node test/package.mjs` 确认打包自检仍绿
- [ ] 都不涉及

## 是否影响 `vendor/three.cjs` 重建

`client.js` 里的 `/* begin vendor/three.cjs */` … `/* end vendor/three.cjs */` 两个标记行是 CI
重建 `vendor/three.cjs` 的锚点（重建结果与原文件逐字节相同）。

- [ ] 没有动这两个标记行
- [ ] 动了（说明原因，并确认 `vendor/three.cjs` 重建后仍是预期内容）

## 文档

- [ ] 已更新 `CHANGELOG.md`
- [ ] 已按需更新 `README.md`（尤其第 6 节已知限制）
- [ ] 不需要文档改动

## 备注

<!-- 未验证的地方请明说，例如「视觉部分没在真浏览器看过」 -->
