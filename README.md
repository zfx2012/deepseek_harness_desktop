# DeepSeek Harness Desktop

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web GUI 打包成 Windows 桌面应用。

> 项目状态与发布就绪度详见 [EVALUATION.md](./EVALUATION.md)（重新评估报告 v3）；历史问题清单与修复记录见 [AUDIT.md](./AUDIT.md)。

- 主进程自动 spawn `dsh web` 服务器（子进程），就绪后原生窗口加载 GUI
- 生命周期管理：退出时杀进程树（`taskkill /T /F`）、崩溃自动重启（可关闭）、单实例锁
- 系统托盘 + 应用菜单（重启/停止服务器、设置、日志文件）；主窗口关闭后可从托盘恢复
- 设置页：harness 路径（自动检测/显式校验）、`DSH_HOME` 数据目录、端口（0=自动分配）、工作目录、内置 Harness 版本信息
- 服务器状态页：加载中 / 启动失败（日志尾部 + 重试）/ 已停止（重新启动）
- 打包：electron-builder 产出 NSIS 安装包 + 便携 exe；harness 整包内置，完全自包含可移植
- 自动更新（可选）：设置 `DSH_DESKTOP_UPDATE_URL` 后启用 generic feed 更新检查（菜单"检查更新…"）

## 目录结构

```
src/
  main.js        Electron 主进程（窗口/托盘/菜单/IPC/生命周期/smoke 模式）
  server.js      服务管理器（spawn dsh web、就绪检测、日志轮转、重启、杀进程树、profile 预修复）
  store.js       设置持久化（userData/config.json，原子写 + BOM 容错）
  preload.js     contextBridge IPC
  app/           主窗口加载页/错误页/停止页
  settings/      设置窗口
scripts/
  build-closure.mjs    从 checkout 物化自包含生产闭包（hoisted+flatten，无 reparse point）
  bundle-harness.mjs   打包 harness 到 harness-deploy/（build-closure 的封装）
  prepare-dist.mjs     dist 前校验闭包完整性（缺依赖树/含链接即中止）
  after-pack.cjs       electron-builder 钩子：绕过其 node_modules 过滤，复制闭包进 resources/
  verify.ps1          本地统一验证链：单测 → 闭包校验 → 打包 → 三种 smoke
tests/
  server.test.js       ServerManager 状态机单元测试（node:test + 注入假子进程）
assets/          应用图标（icon.png / icon.ico）
```

## 开发运行

```bash
pnpm install --ignore-scripts     # 依赖（electron 二进制见下）
node node_modules/electron/install.js   # 或手动解压 electron zip 到 dist/
npm start                          # 启动桌面应用（自动检测 F:\Program Files (x86)\deepseek-harness）
npm test                           # 单元测试（8 例：就绪/伪就绪/崩溃重启/停止/spawn 错误/版本门槛…）
powershell -File scripts/verify.ps1  # 全量验证链（打包 + 三种 smoke，约 3 分钟）
```

验证模式（`--smoke` 系列，均带 90s 超时与子进程清理）：

| 命令 | 断言 |
|------|------|
| `npm run smoke` | GUI 加载成功 → `SMOKE_OK <url> harnessSource=<source>` |
| `npm run smoke:bundled` | **必须**使用打包内置 harness（`harnessSource=bundled`），否则 FAIL |
| `npm run smoke:error` | 显式无效 harness 路径 → 错误页渲染且按钮可用 → `SMOKE_ERROR_OK` |

`DSH_DESKTOP_HARNESS` 环境变量可覆盖 harness 路径（也可在设置页里改）。

## 打包发布

```bash
npm run bundle:harness   # 从 checkout 物化生产依赖闭包到 harness-deploy/（~280MB，自包含）
npm run dist             # electron-builder：release/ 下产出安装包 + 便携 exe
npm run dist:dir         # 仅产出 win-unpacked/（打包版冒烟用）
```

- 闭包由 `scripts/build-closure.mjs` 物化：按 Node 解析语义遍历生产依赖（含平台过滤的
  optionalDependencies 原生二进制，如 sharp/koffi），唯一版本包 hoisted 到顶层、
  冲突版本进虚拟 store，所有别名/依赖链接以**真实目录副本**落地（flatten）——产出
  **零 reparse point** 的树，目录可移动、可跨机拷贝（Windows junction 的绝对路径
  问题已消除）。
- 打包通过 `afterPack` 钩子复制闭包：electron-builder 的 `extraResources` 过滤器会
  无条件丢弃顶层 `node_modules`（app-builder-lib util/filter.js），曾导致安装包缺失
  整个依赖树。
- 内置 harness 后，安装包**不依赖任何外部安装**即可独立运行：
  - 无 Node 机器自动回退 `ELECTRON_RUN_AS_NODE`（Electron 43 内置 Node 24.18，
    满足 harness engines；回退时自动附加 `--expose-internals`——HMR 服务在
    Electron 内置 Node 下需要它）；
  - 系统 Node 需满足 engines（^22.19 \|\| >=24），否则回退内置运行时；
  - 全新 `DSH_HOME` 首次启动前用 junction 预修复 `profiles/node_modules` 回退链接
    （Windows symlink 需要开发者模式/管理员权限，junction 不需要）。
- 便携版同理：`DeepSeek Harness Desktop-<ver>-portable-x64.exe` 解压即用。
- 若本机没有 checkout，`prepare-dist.mjs` 会跳过内置，打包出的应用在设置页指定
  harness 路径后使用。

## 自动更新（可选）

1. 把 `electron-builder.yml` 里 `publish.url` 换成真实的静态托管地址
   （如 GitHub Releases / 任意静态服务器）。
2. 部署时把 `release/` 下的安装包、`latest.yml`（electron-builder 自动生成）上传到该地址。
3. 用户侧设置环境变量 `DSH_DESKTOP_UPDATE_URL=<同一地址>` 后，应用启动时静默检查更新，
   菜单"帮助 → 检查更新…"可手动检查并下载安装。未配置该变量时应用完全不联网检查更新。

## 服务器细节

- 启动命令等价于：`node <harness>/apps/cli/lib/bin.js web --port <port>`
  （deploy 布局为 `<harness>/lib/bin.js`）；总是显式传 `--port`（0=系统分配），
  避免与默认 3080 端口冲突。
- 就绪信号是 stdout 的 `dsh web: http://127.0.0.1:<port>` 行；就绪检测从本次启动的
  日志位置开始，历史就绪行不会误触发。
- `server.log` 超过 5MB 自动轮转（保留 2 份），菜单可直接定位日志文件。
- 默认 `DSH_HOME=~/.dsh`（与 CLI 共享数据）；设置页可改为独立目录。
