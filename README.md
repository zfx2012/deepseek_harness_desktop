# DeepSeek Harness Desktop

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web GUI 打包成 Windows 桌面应用。

- 主进程自动拉起内置 `dsh web` 服务器，就绪后原生窗口加载 GUI；无 Node、无外部 harness 也能运行
- 生命周期管理：退出杀进程树、崩溃自动重启、单实例、托盘常驻（关闭窗口不退出）
- 设置页：harness 路径 / `DSH_HOME` / 端口 / 工作目录 / 内置版本信息 / **内核更新检测**
- 状态页：加载中 / 启动失败（日志尾部 + 重试）/ 已停止
- 可选自动更新（壳更新）：设置 `DSH_DESKTOP_UPDATE_URL` 后启用，菜单"检查更新…"
- 打包：NSIS 安装包 + 便携 exe，内置 harness 完全自包含（约 160MB）

## 快速开始

```bash
pnpm install --ignore-scripts          # 依赖
node node_modules/electron/install.js  # 恢复 Electron 二进制
npm start                              # 开发运行
npm run dist                           # 打包（release/ 产出安装包 + latest.yml）
```

`npm run dist` 会自动解析 harness 来源：`--harness <已构建checkout>` > `DSH_DESKTOP_HARNESS` 环境变量 > 本地常见路径 > **自动浅克隆官方仓库并构建**（缓存于 `.harness-checkout/`，`--update` 更新，`--no-auto-fetch` 离线）。

## 验证

```bash
npm test                     # 单元测试（16 例）
powershell -File scripts/verify.ps1   # 完整验证链：单测 → 闭包校验 → 打包 →
                              # bundled/error/no-node/update-feed 四种 smoke
```

## 发布 Release

```bash
npm run dist
git tag -a v0.2.0 -m "..." && git push origin v0.2.0
node scripts/publish-release.mjs --tag v0.2.0            # 创建 Release 并上传全部资产
node scripts/publish-release.mjs --tag v0.2.0 --upload-only   # 已有 Release 时仅补传
```

发布脚本复用 git 凭据管理器缓存的 token（与 push 同一凭据），自动跳过已存在的资产。

## 目录

```
src/
  main.js        Electron 主进程（窗口/托盘/菜单/IPC/生命周期/smoke 模式）
  server.js      服务管理器（spawn dsh web、就绪检测、日志轮转、进程树杀灭）
  store.js       设置持久化（原子写、BOM 容错）
  preload.js     contextBridge IPC
  harness-update.js  内核更新检测（官方发布渠道，地址不显示）
  app/、settings/    主窗口状态页、设置窗口
scripts/
  build-closure.mjs   从 checkout 物化自包含生产闭包（hoisted+flatten，零链接）
  bundle-harness.mjs  打包闭包到 harness-deploy/
  harness-resolve.mjs harness 来源解析（本地优先，自动获取官方仓库）
  prepare-dist.mjs    dist 前闭包硬校验
  after-pack.cjs      electron-builder 钩子：复制闭包进 resources/harness
  verify.ps1          完整验证链（单测+打包+四种 smoke）
  update-feed.mjs     本地更新源（update smoke 用）
  publish-release.mjs GitHub Release 发布
tests/          单元测试
assets/         图标
```

## 内核更新检测（设置页）

按钮触发主进程查询官方发布渠道（npm registry `@deepseek-ai/dsh` 的 dist-tags），
与内置版本比较后提示结果。检测地址硬编码在主进程，不显示在界面。

## 自动更新（可选）

1. 把 `electron-builder.yml` 的 `publish.url` 换成真实托管地址（如 GitHub Releases 下载目录）
2. 发布时上传安装包与 `latest.yml`（发布脚本已自动做）
3. 用户侧设置 `DSH_DESKTOP_UPDATE_URL=<同一地址>` 后，启动时静默检查、菜单手动检查下载；
   未配置时应用不联网检查更新

## 服务器细节

- 启动命令等价于 `node <harness>/apps/cli/lib/bin.js web --port <port>`；总是显式传端口（0=系统分配），避免默认 3080 冲突
- 就绪信号为 stdout 的 `dsh web: http://127.0.0.1:<port>` 行；检测从本次启动的日志位置开始
- `server.log` 超 5MB 自动轮转（保留 2 份）；日志在 `%APPDATA%/DeepSeek Harness Desktop/`
- 系统 Node 满足 engines（^22.19 || >=24）时使用，否则回退 Electron 内置运行时（Node 24）
- 全新 `DSH_HOME` 首次启动前用 junction 预修复 profiles 回退链接（无需管理员权限）
