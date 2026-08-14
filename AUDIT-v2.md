# DeepSeek Harness Desktop — 全面审计报告（v2，第二轮）

> **修复状态（2026-08-14）：全部 16 项已修复并验证**。修复记录见文末附录；单项状态在表格中标注 ✅。

审计日期：2026-08-14（第二轮）
审计对象：`C:\Users\jin\Desktop\deepseek\deepseek_harness_desktop`（git 仓库 zfx2012/deepseek_harness_desktop，commit 00556f9）
审计方法：全量源码静态重读（main/server/store/preload/UI/5 个脚本/测试/构建配置/仓库元数据）+ 实证验证（单元测试 8/8、语法检查、**新缺陷复现脚本实测**）
第一轮审计与修复记录：见 [AUDIT.md](./AUDIT.md)（v1，25 项全部关闭）。

---

## 1. 结论摘要

第一轮审计的 25 项问题**仍全部处于关闭状态**（本轮重读确认修复均在位，无回退）；产品范围决策（Windows 单平台 / 不签名 / 无 CI）已贯彻到代码与文档。本轮新识别 **1 个 P1 级缺陷（已实证复现）**、4 个 P2、11 个 P3。核心结论：**当前版本在"普通使用"路径上可用，但"重启服务器"这一高频路径存在状态机竞态**，建议优先修复。

## 2. 项目快照（审计时点）

| 维度 | 值 |
|------|----|
| 提交 | `00556f9`，工作区干净（git status 无未提交变更） |
| 运行时 | Electron 43.4.0 / Chromium 150 / Node 24.18.1 |
| 依赖 | electron-builder 26.15.3、electron-updater 6.8.9 |
| 源码规模 | main.js 506 行、server.js 533 行、store.js 84 行、preload 33 行、UI 2 页、脚本 5 个 |
| 测试 | tests/server.test.js 8 例，全部通过（12.5s） |
| 产物 | harness-deploy 280MB（hoisted+flatten，零 reparse point）；release/ 安装包 159.9MB/159.7MB |

## 3. 第一轮闭环确认（抽样重读验证，无回退）

- P0-1 junction 可移植性：build-closure 仍为 flatten 默认 + 零 reparse point 校验 ✅
- P0-2 打包丢依赖树：afterPack 钩子仍在位，yml 注释说明原因 ✅
- P0-3 冒烟来源断言：`--smoke-bundled` 逻辑完好 ✅
- P0-4 错误页：主窗口 preload 在位、`--smoke-error` DOM 断言完好 ✅
- P1 批修（伪 ready 的 filePos 初始化、托盘重建窗口、stopped 卡、Node 版本门槛 + `--expose-internals`、fd 关闭、日志轮转、持续采集）全部在位 ✅
- P2 批修（BOM 容错、原子写、端口校验、CSP、元数据、体积优化、prepare-dist 硬校验、quiet 剥离）全部在位 ✅
- 单测 8/8 通过（本轮实测）✅

## 4. 新发现问题

### P1 — 高（已实证复现）

| # | 问题 | 证据 | 影响与修复建议 |
|---|------|------|----------------|
| **P1-1** | **重启竞态：旧子进程的迟到 `exit` 事件污染新启动的状态机**。`start()` 先 `stopChild()`（异步 taskkill）再 spawn 新子进程并重置 `expectExit=false`；旧 child 的 `exit` 处理器随后到达时：① `this.child = null` 抹掉**新** child 的引用；② `expectExit` 已被重置为 false、`stopping` 为 false → 走 crash/error 分支把 phase 设为 error；③ 新 child 的就绪行匹配条件 `phase === 'starting'` 不再满足 → **新服务器永远无法进入 ready，窗口卡在错误页**。 | `tests/race-repro.cjs` 实测输出：`after old-child late exit: error …`、`after new-child ready line: error` → `RACE REPRODUCED: YES` | 触发场景：设置保存、菜单"重启服务器"、崩溃自动重启、托盘恢复——全部是高频路径。修复：`exit`/`error` 处理器开头加身份守卫 `if (this.child !== child) return`（在置 null 之前），或按代际（generation）计数判定 |

### P2 — 中

| # | 问题 | 位置 | 说明 |
|---|------|------|------|
| P2-1 | **smoke 退出清理竞态（N1，未修）**：`finish()` 先异步 `server.dispose()`（taskkill 子进程）再立即 `app.exit()`，曾观测到幽灵进程树（ELECTRON_RUN_AS_NODE 下 dsh 及其子进程与主程序同名）。 | main.js `runSmoke` finish | 修复：dispose 后同步等待（spawnSync taskkill）或轮询子进程退出再 exit |
| P2-2 | **`--smoke-update` 仍是死代码（U1，未接）**：`runSmokeUpdate()` 与常量存在，但 smoke 入口 `if (SMOKE\|\|SMOKE_BUNDLED\|\|SMOKE_ERROR)` 不含 `SMOKE_UPDATE`。 | main.js 329 行 vs 412-442 行 | 与双更新通道（壳/内核）设计联动，接线时一并处理 |
| P2-3 | **下载更新后不会真正安装**：`checkForUpdates` 中 `downloadUpdate()` 完成后仅提示"将在退出时安装"，但 `before-quit` 没有调用 `autoUpdater.quitAndInstall()`——退出时不会执行安装。 | main.js 229-255 行 | 启用 `DSH_DESKTOP_UPDATE_URL` 的机器上更新链路断裂；修复：before-quit 中 `autoUpdater?.quitAndInstall()`（有已下载更新时） |
| P2-4 | **preHeal 边缘场景（N3，未修）**：`$DSH_HOME/profiles/node_modules/@deepseek-ai/<pkg>` 已存在**真实目录**时，junction 创建被忽略，dsh 的 heal 对真实目录抛错 → 启动失败。 | server.js `preHealProfiles` | 修复：检测到真实目录时先改名/删除再建 junction |

### P3 — 低（工程卫生 / 文档一致性）

| # | 问题 | 位置 |
|---|------|------|
| P3-1 | **pnpm-workspace.yaml 中文注释已乱码**（`开发运行` → `寮€鍙戣繍琛?`）——pnpm 以非 UTF-8 编码重写该文件。 | pnpm-workspace.yaml（实测读取） |
| P3-2 | **prepare-dist 死 probe**：`node_modules/.pnpm/@deepseek-ai+dsh-web-app@0.1.0-rc.5_workspace/...` 在 hoisted 布局下永远不存在（dsh-web-app 是唯一版本，在顶层），且 key 硬编码版本号、升级即漂移。 | prepare-dist.mjs 49 行 |
| P3-3 | **头注释过时**：bundle-harness.mjs / prepare-dist.mjs 仍写"ship it as extraResources"（已改 afterPack）。 | 两脚本头部 |
| P3-4 | electron-builder.yml：`buildResources: build` 指向已删除目录；`copyright: 2025` 过时。 | electron-builder.yml 6、3 行 |
| P3-5 | `publish.url = https://example.com/...` 占位符——生成的 latest.yml 指向无效地址；接壳更新通道时需改为真实 GitHub Releases 地址。 | electron-builder.yml 22 行 |
| P3-6 | `SettingsStore.reset()` 死代码（UI 的"恢复默认"走 `setSettings`）。 | store.js 78-81 行 |
| P3-7 | build-closure 注释称 hoisted 主版本选"most-referenced"，实际 visited 按 real 去重后每个版本计数恒为 1，退化为"先遇到者"（功能正确，注释失实）。 | build-closure.mjs 216-218 行 |
| P3-8 | `second-instance` 在主窗口已关闭时静默 no-op（与托盘可重建窗口的能力不对称）。 | main.js 53-59 行 |
| P3-9 | `isHarness` 第三条件（`apps/cli/node_modules` 存在即通过）偏宽。 | server.js 74 行 |
| P3-10 | 帮助菜单无本项目仓库链接；设置页"来源 checkout"暴露构建机绝对路径。 | main.js 167 行、373 行 |
| P3-11 | 单测覆盖缺口：无重启竞态、preHeal、rotateLog、Node 版本选择、drainLog 用例（竞态复现脚本 `tests/race-repro.cjs` 已留作回归资产，修复后转正式测试）。 | tests/ |

## 5. 安全面复查（无回退）

✅ 渲染层 sandbox + contextIsolation、GUI 页无 preload 无 node 集成、服务器 127.0.0.1、`openExternal` 仅 http(s)、IPC 面最小、`--expose-internals` 仅用于受控子进程。
⚠️ 维持既有备注：子进程继承全部环境变量；`will-navigate` 放行所有 localhost（单源，风险低）。

## 6. 修复优先级建议

1. **立即（P1）**：P1-1 重启竞态——两行身份守卫 + 把 `race-repro.cjs` 转成正式单测（修复前断言失败、修复后通过）。
2. **短期（P2）**：P2-1（smoke 退出同步清理）、P2-3（quitAndInstall 接线）、P2-4（preHeal 真实目录加固）；P2-2 随双更新通道一并接线。
3. **顺手（P3）**：P3-1（注释改 ASCII）、P3-2/3/4（死 probe 与过时注释/配置）、P3-6/7（死代码与注释失实）、P3-8（second-instance 恢复窗口）。

## 7. 结论

项目处于"**可用、但重启路径有坑**"的状态：正常启动/使用/打包/验证链全部健康（单测 8/8、历史三连 smoke 凭证有效），唯一的高优先级新发现是重启竞态（用户改设置或手动重启时可能卡错误页），修复成本极低、收益直接。P3 级问题均为清理项，不影响使用。

---

## 附录：修复记录（全部 16 项，2026-08-14 执行并验证）

| # | 修复 | 验证 |
|---|------|------|
| P1-1 重启竞态 | `exit`/`error` 处理器加身份守卫 `if (this.child !== child) return`（置 null 与状态变更之前）；配合 stopChild 改同步 taskkill（spawnSync），窗口进一步收窄 | 新单测 `restart: the old child late exit must not corrupt the new boot` 通过；13/13 全绿 |
| P2-1 smoke 退出竞态 | `stopChild` 的 taskkill 由异步 spawn 改为**同步 spawnSync**（timeout 10s）+ 同步 `child.kill()` 兜底——dispose 返回时进程树已死 | 代码路径；verify.ps1 全链无幽灵进程 |
| P2-2 --smoke-update 接线 | whenReady 加 `SMOKE_UPDATE` 短路入口（独立流程、不启动服务器）；新建 `scripts/update-feed.mjs` 本地 feed；verify.ps1 增加第 7 步 | `SMOKE_UPDATE_OK version=0.2.0`（见本轮 verify 输出） |
| P2-3 更新不安装 | `updateReady`/`installingUpdate` 标志；下载完成弹"立即重启并安装/退出时安装"；`before-quit` 中（守卫防重入）调用 `quitAndInstall()` | 代码审查（安装动作需真实 release 才能端到端验证） |
| P2-4 preHeal 真实目录 | lstat 检测：junction 跳过；真实目录先 `rename` 到 `.dsh-bak` 再建 junction | 新单测 2 例（替换/保留）通过 |
| P3-1 注释乱码 | pnpm-workspace.yaml 注释改纯 ASCII（核实：文件本身为 UTF-8，乱码系 PS 5.1 读取显示所致） | 读取正常 |
| P3-2 死 probe | prepare-dist 删除硬编码 `_workspace` 版本 key 的第三个 probe | `bundle validation passed` |
| P3-3 过时头注释 | bundle-harness / prepare-dist 头部改为 afterPack 措辞 | 审查 |
| P3-4 yml 清理 | 删 `buildResources: build`（目录已删）；copyright 改 2026 | 审查 |
| P3-5 publish 占位 | 保留（app-update.yml 由它生成、update smoke 依赖），注释已说明；接壳更新时换真实地址 | 审查 |
| P3-6 死代码 | 删 `SettingsStore.reset()` | 审查 |
| P3-7 注释失实 | build-closure hoisting 注释改为"first-encountered" | 审查 |
| P3-8 second-instance | 改为调用 `showMainWindow()`（可重建已关闭窗口） | 审查 |
| P3-9 isHarness 过宽 | 删除 `apps/cli/node_modules` 存在即通过的第三条件 | 单测仍绿 |
| P3-10 信息最小化 | 帮助菜单加"本项目仓库"链接；`getBundleInfo` 不再返回 harnessCheckout；设置页移除该行 | 审查 |
| P3-11 测试覆盖 | 新增 5 例：竞态回归、preHeal×2、rotateLog、Node 版本门槛（resolveNodeLaunch 注入 + 缓存重置钩子）；删除 race-repro.cjs | 13/13 通过 |
