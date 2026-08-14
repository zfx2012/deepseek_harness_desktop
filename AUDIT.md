# DeepSeek Harness Desktop — 审计报告与优化计划

审计对象：`C:\Users\jin\Desktop\deepseek\deepseek_harness_desktop`（2026-08-14，v0.1.0）
审计方式：全量源码静态审读 + 运行时实证（junction 断链、打包产物完整性、闭包启动）。

---

## 一、审计结论

**当前状态：源码骨架正确，但交付物不可用。** 两个 P0 缺陷叠加导致：已打包的安装包不是自包含的
（依赖树在打包时被丢弃），且项目目录一经移动/改名/复制即损坏（junction 绝对路径）。此前
"打包产物冒烟通过"是假阳性——打包版静默回退到了本机 `F:\Program Files (x86)\deepseek-harness`
外部 checkout。另有错误页 JS 全灭、托盘窗口无法恢复等影响基本体验的缺陷。

## 二、问题清单

### P0 — 阻断级（交付物不可用）

| # | 问题 | 证据 | 影响 |
|---|------|------|------|
| P0-1 | **junction 绝对路径，项目不可移动**。`build-closure.mjs` 用 `symlinkSync(..., 'junction')` 建依赖链接，Node 在 Windows 把 junction 目标规范化为绝对路径。 | 实测 `harness-deploy\node_modules\@deepseek-ai\dsh-web-app` 的目标 = 旧路径 `C:\Users\jin\Desktop\deepseek\harness-deploy\...`；移动后启动报 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-app-boot'` | 目录改名/移动/跨机拷贝即坏；**当前 `harness-deploy` 已失效** |
| P0-2 | **electron-builder 打包时丢弃整个 junction 树**。`extraResources` 复制未保留 junction。 | `release\win-unpacked\resources\harness\` 下只有 `apps\`，`node_modules` 不存在 | 安装包不含依赖树，用户机器上必然报"找不到 DeepSeek Harness" |
| P0-3 | **打包产物冒烟验证是假阳性**。打包版 `isHarness(resources/harness)` 因缺 node_modules 判 false，静默回退到外部 checkout；`runSmoke` 不校验 harnessRoot 来源。 | `server.js:78-84` 候选顺序 + 此前 SMOKE_OK 时本机 checkout 存在 | 验证流程不可信，需以"断言 bundled 来源"重建 |
| P0-4 | **主窗口缺 preload，错误路径形同虚设**。mainWindow 的 webPreferences 无 preload，`shell.js` 依赖的 `window.dsh` 不存在；错误卡片默认 `hidden` 靠 JS 渲染。 | `main.js:217-221`（对比 settings 窗口 `main.js:98` 有 preload） | 启动失败时用户看到永转圈，无错误信息；"重试/打开设置"按钮全部失效 |

### P1 — 高（核心路径缺陷）

| # | 问题 | 证据 | 影响 |
|---|------|------|------|
| P1-1 | **重启时旧日志导致伪 ready**：`startPolling()` 每次 `filePos` 重置为 0，`server.log` 是 append 的，历史就绪行被再次匹配。 | `server.js:283-284` | 新实例未起即报 ready，窗口加载旧端口死链 |
| P1-2 | **托盘"显示主窗口"在窗口关闭后失效**：`mainWindow=null` 时 `showMainWindow()` 为 no-op；`second-instance` 同理。 | `main.js:176-182` | 关闭窗口后应用只活在托盘，永远无法再打开主窗口 |
| P1-3 | **"停止服务器"后主窗口永久转圈**：`stop()` → phase `idle`，`navigateMain()` 只处理 ready/error，idle 落入 loading 页。 | `server.js:392-397` + `main.js:69-80` | 停止后无 UI 出口 |
| P1-4 | **Node 探测不校验版本、只探测一次**；`ELECTRON_RUN_AS_NODE` 回退路径从未实测。 | `server.js:106-119` | 装有旧版 Node（<22.19）的机器会用旧 Node 启动失败；无 Node 的机器走 Electron 内置 Node 22.16（低于 engines 下限，且 `node-addon-require-builtin` 原生模块 ABI 不匹配可能静默降级） |
| P1-5 | **fd 泄漏**：spawn 成功后父进程侧的 `fdOut/fdErr` 从不关闭。 | `server.js:211-235` | 每次重启泄漏 2 个句柄 |
| P1-6 | **server.log 永不轮转**；"打开服务器日志目录"打开的是 `os.homedir()` 而非 userData（server.log 所在）。 | `main.js:127` | 长期运行磁盘膨胀；菜单项误导 |
| P1-7 | **ready 后日志采集停止**：就绪即 `stopPolling()`。 | `server.js:313-318` | 设置页日志只见启动段，运行期错误不可见 |

### P2 — 中（健壮性/体验/工程卫生）

| # | 问题 | 位置 |
|---|------|------|
| P2-1 | 端口无输入校验（>65535/负数直接透传，dsh 报 usage error 后用户看到原始失败） | `settings.js:26` |
| P2-2 | `config.json` 非原子写，崩溃可能损坏（load 有兜底但配置丢失） | `store.js:44-51` |
| P2-3 | 发布版菜单保留"开发者工具" | `main.js:134` |
| P2-4 | package.json 缺 author/repository（builder 已告警 "author is missed"） | `package.json` |
| P2-5 | closure 复制所有平台 optionalDependencies（12 个 koffi 平台包、sharp 各平台 @img 等）与 workspace 包完整 src/，体积膨胀 | `build-closure.mjs:147-154, 46` |
| P2-6 | `prepare-dist` "already bundled" 只查 bin.js 存在——junction 已断仍会静默打包残缺产物 | `prepare-dist.mjs:34-35` |
| P2-7 | CSP 未显式声明 `script-src 'self'`（file:// 下 'self' 语义依实现而定，应显式化并实测） | `app/index.html:5`、`settings/index.html` |
| P2-8 | `setState()` 被传入无关 `quiet` 属性污染实例 | `server.js:157-160, 177` |
| P2-9 | `--smoke` 无错误路径/托盘生命周期/设置页用例 | `main.js:313-341` |
| P2-10 | `.dist-out.txt` 等调试文件未 gitignore；harnessCandidates 硬编码开发机路径 | `.gitignore`、`server.js:37` |

### P3 — 低（发布级差距，历史记录；现状见 EVALUATION.md v3）

- ~~无代码签名~~ → 已做**产品范围决策：不签名分发**（自签名/CA 均移除，见 EVALUATION.md §2）
- ~~无自动更新~~ → 已集成 electron-updater（可选启用）；端到端实测待接线（EVALUATION U1）
- ~~仅 Windows 打包验证过；POSIX 分支未实测~~ → 已做**产品范围决策：Windows 单平台**，POSIX 分支代码已删除
- ~~无单元测试~~ → 已落地 tests/server.test.js（8 例，全部通过）
- ~~内置 harness 无版本清单~~ → 已落地 bundle manifest + 设置页展示

### 安全面小结（总体良好）

✅ GUI 页无 preload、无 node 集成、sandbox 开启；服务器绑定 127.0.0.1；`openExternal` 仅 http(s)。
⚠️ 子进程继承全部环境变量（含 API key——设计使然，文档应注明）；修复 P0-4 后 shell 页为本地受控文件，IPC 面可控；`will-navigate` 放行所有 localhost 导航（当前单源，风险低）。

---

## 三、修复记录（2026-08-14 执行）

| 问题 | 修复 | 验证 |
|------|------|------|
| P0-1 junction 绝对路径 | build-closure 改为 hoisted+flatten：唯一版本顶层真实副本、冲突版本进 store，全树零 reparse point | 复制到新目录后 CLI 正常 boot（`dsh web: http://127.0.0.1:52394`） |
| P0-2 打包丢 node_modules | 弃用 extraResources（其过滤器无条件丢弃顶层 node_modules，app-builder-lib util/filter.js:43），改 afterPack 钩子 fs.cpSync | win-unpacked/resources/harness 完整（38,045 文件 / 280MB） |
| P0-3 冒烟假阳性 | state 增加 harnessSource（setting/bundled/env/detected）；`--smoke-bundled` 强制断言 bundled，否则 FAIL | 打包版 `SMOKE_OK harnessSource=bundled` |
| P0-4 主窗口缺 preload | mainWindow 补 preload；新增 `--smoke-error` 用 executeJavaScript 断言错误卡渲染与按钮 | `SMOKE_ERROR_OK`（无效路径场景） |
| P1-1 伪 ready | filePos 初始化为 spawn 时日志大小；新增单测覆盖 | 单测 `stale readiness lines…` 通过 |
| P1-2 托盘无法恢复窗口 | 窗口创建抽为 createMainWindow()，showMainWindow 在 null 时重建 | 代码路径修复 |
| P1-3 停止后永久转圈 | shell 页新增 stopped 卡 + 启动按钮；navigateMain 处理 idle | 代码路径修复 |
| P1-4 Node 版本门槛/回退 | 版本解析（^22.19\|\|>=24）不满足即回退；`ELECTRON_RUN_AS_NODE` 实测 | 裁剪 PATH 后打包版 `SMOKE_OK harnessSource=bundled`（启动命令为 electron.exe 自身） |
| P1-5 fd 泄漏 | spawn 成功后关闭父进程侧 fd | 代码审查 |
| P1-6 日志轮转/目录 | 5MB 轮转保留 2 份；菜单改 shell.showItemInFolder(server.log) | 代码审查 |
| P1-7 就绪后日志停采 | 轮询持续转发日志（就绪匹配仅在 starting 阶段） | 代码审查 |
| **新 P0（实测发现）** | 全新 DSH_HOME 首次启动时 dsh 的 profiles 回退要建 symlink，普通用户无权限（EPERM）→ 启动前用 junction 预修复 | build-closure 冒烟与打包版 smoke 均通过（全新 home） |
| **新 P1（实测发现）** | 显式 harnessPath 无效时静默回退检测 → 改为显式路径无效即报错 | `SMOKE_ERROR_OK errText=设置的 harness 路径无效…` |
| **新 P1（实测发现）** | config.json 带 UTF-8 BOM 时 JSON.parse 失败 → 配置静默重置 → load 剥离 BOM | store 读回正确值 |
| P2-1 端口校验 | 设置页 0–65535 整数校验 | 代码审查 |
| P2-2 配置原子写 | tmp+rename | 代码审查 |
| P2-3 devTools 保留 | 按 app.isPackaged 裁剪 | 代码审查 |
| P2-4 元数据 | package.json 补 author/homepage | 构建日志不再告警 |
| P2-5 体积 | 平台过滤 optionalDeps、剔 @types 与 workspace src；hoisted 布局 | 闭包 1,547MB → 280MB；安装包 152MB |
| P2-6 prepare-dist 静默打包 | 硬校验（依赖树/manifest 存在 + 无 reparse point），失败即中止 | `bundle validation passed` |
| P2-7 CSP | 显式 `script-src 'self'` | 代码审查 |
| P2-8 quiet 污染 | setState 剥离非状态键 | 代码审查 |
| P2-9 smoke 覆盖 | --smoke-bundled / --smoke-error 模式 | 全部实测通过 |
| P2-10 gitignore | 补调试产物 | 代码审查 |
| 单测/CI | tests/server.test.js（8 例，node:test）；.github/workflows/build.yml（install→test→bundle→dist→bundled smoke 强制断言） | 8/8 通过；CI 待接入真实 runner |

**遗留（阶段 3 / 长期）——状态已由 v3 重新评估报告接管，详见 [EVALUATION.md](./EVALUATION.md) §5/§6/§8**：
- ~~内置 Node 22.16 低于 engines 下限~~ → **已解决**：升级 Electron 37 → **43.4.0**（内置 Node 24.18.1 满足 engines）；升级还暴露并修复了 Node 24 下回退路径需要 `--expose-internals`（HMR 服务要求，`server.js` fallback args）
- 自动更新：electron-updater 已集成（可选启用，`DSH_DESKTOP_UPDATE_URL` + generic feed，`latest.yml` 已生成）；端到端未实测（`--smoke-update` 验证代码存在但未接入入口——EVALUATION U1）
- CI：workflow 已引用 `scripts/verify.ps1` 全量验证链；**待 GitHub runner 真实运行**（EVALUATION U2）
- ~~代码签名~~ → **已移除**（产品范围决策：不签名分发；自签名证书与 build/ 已删除）
- ~~macOS/Linux 打包~~ → **已移除**（产品范围决策：Windows 单平台；darwin/activate/POSIX kill/symlink 分支代码已删除）
- desktop 与 harness 版本联动：**已落地**——bundle manifest（版本/构建时间/包数）经 IPC 暴露，设置页"关于"展示
- **新识别**：smoke 退出清理竞态（app.exit 不等待异步 taskkill，曾致幽灵实例进程树）——EVALUATION N1；preHeal 对已存在真实目录的边缘场景——EVALUATION N3

---

## 四、后续优化计划

### 阶段 1 —— 修复（让交付物真正可用，优先级最高）

1. **依赖树扁平化（修 P0-1/2）**：`build-closure.mjs` 增加 `--flatten` 模式（默认开启）：别名与依赖链接改为真实目录副本（cpSync dereference），产出完全自包含、无任何 reparse point 的树；先做一次 `mklink /J` 相对目标试验，不可行即扁平。dev 构建可保留 junction 模式加速。
2. **打包完整性校验（修 P0-2/6）**：`prepare-dist` 增加硬校验（`node_modules/@deepseek-ai/dsh-web-app`、前端 dist 存在 + 内置 CLI 冒烟 boot），失败即中止构建。
3. **主窗口补 preload（修 P0-4）**；新增错误路径冒烟用例（指向不存在 harness，用 `webContents.executeJavaScript` 断言错误卡片渲染、按钮可点）。
4. **冒烟断言来源（修 P0-3）**：`runSmoke` 打印并断言 `harnessRoot` 来源（bundled/external），打包验证强制 bundled。
5. **核心缺陷批修（P1 全部）**：伪 ready（filePos 取 spawn 时文件长度）、stopped 状态 UI 卡片、托盘重建窗口、fd 关闭、日志轮转 + 正确日志目录、ready 后持续采集日志。

### 阶段 2 —— 健壮性与体验

6. `resolveNodeLaunch` 版本门槛（>=22.19 否则走 fallback）；在无 node 的 PATH 下实测 `ELECTRON_RUN_AS_NODE` 路径（含原生模块行为）。
7. 设置页输入校验（端口 0-65535、路径存在性）与友好报错；显示运行状态（URL、PID、复制按钮）。
8. 配置原子写（tmp+rename）；菜单按 `isPackaged` 裁剪 devTools；补 author/repository 元数据；CSP 显式 `script-src 'self'` 并实测。
9. **体积优化**：optionalDependencies 按目标平台过滤、workspace 包剔除 src/tests、重复大包去重评估；以安装包体积回归对比验收。
10. bundle manifest：记录内置 harness 的 checkout 版本/commit/构建时间，设置页展示。

### 阶段 3 —— 发布级（已按产品范围决策裁剪）

11. ~~代码签名 + 自动更新~~ → 签名已移除（范围决策）；自动更新已集成待实测（EVALUATION U1）。
12. 单元测试（server.js 状态机 mock）+ CI（build-closure → dist → bundled smoke 强制断言）——**已落地**。
13. ~~多平台评估~~ → 已移除（范围决策：Windows 单平台）。
14. 版本联动策略：桌面端 release 与 harness 版本对应关系固化（当前内置为 checkout rc.5 快照）——manifest 已落地，自动化触发待做（EVALUATION §8-6）。
