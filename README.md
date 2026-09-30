# DeepSeek Harness Desktop

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web GUI 打包成 Windows 桌面应用。

- 安装即用：内置官方最新发布版内核（`resources\harness`，相对安装目录解析）**和一份官方 Node 运行时**（`resources\node`）。优先用系统 Node（满足 engines），没有系统 Node 时用内置运行时——内核 0.2.0 起的原生插件只认精确的 Electron 版本指纹，所以不再用 Electron 自身当运行时；内置 npm 让「一键更新内核」同样无需系统 Node
- 启动即时反馈：窗口先显示状态页（阶段、已等待秒数、日志尾行），内核就绪后自动切到 Web 主界面；内核启动期间不出现空白窗口。实测内置内核 **0.2.0-rc.2** 冷启动 3.6 秒 / 热启动 3.2 秒（该版本起不再建立 `profiles\node_modules` 模块链接）；若改用旧内核，首次启动需要建立这些链接（一次性，可能 10–60 秒），状态页会提示
- 主界面为主：设置页为同窗口切换（菜单/托盘「设置…」，返回按钮回主界面）；关闭窗口即隐藏到托盘，托盘右键或菜单「退出」才真正退出（退出时杀进程树）；崩溃自动重启、单实例
- 打包：NSIS 安装包，完全自包含。安装用 **zip/Deflate 单遍解压**（直接解到安装目录，不经临时目录再拷贝），并把内核里的**类型声明 `.d.ts` 与 source map `.map`**（约 1.15 万个文件、占文件数 45%）在打包/更新时剔除——两者都只影响开发调试，运行时不读取。实测静默安装：**~16 秒**（旧配置 ~103 秒）

## 快速开始

```bash
pnpm install --ignore-scripts          # 依赖
node node_modules/electron/install.js  # 恢复 Electron 二进制
npm start                              # 开发运行
npm run bundle:harness                 # 取官方 npm 渠道内核 -> harness-deploy/
npm run bundle:node                    # 取官方 Node 运行时 -> node-runtime/
npm run dist                           # 打包（release/ 产出安装包 + latest.yml）
```

内置内核来源：默认 **官方 npm 渠道**——直接安装 `@deepseek-ai/dsh` 最新发布版（`--version <ver>` 指定版本）为自包含闭包，与应用内"立即更新"同一机制；`--harness <已构建checkout>` 改用 checkout 闭包，`--no-auto-fetch` 离线。内置 Node 运行时来自 nodejs.org 官方发行包（`scripts/bundle-node.mjs`，下载后校验 `SHASUMS256.txt`），版本在 `package.json` 之外的 `scripts/bundle-node.mjs` 中固定。

## 内核更新检测与一键更新（设置页）

「检测内核更新」查询官方发布渠道（npm registry `@deepseek-ai/dsh` 的 dist-tags），与当前生效内核版本比较；发现新版本后可直接点击「立即更新」：应用会先停止服务器，用 `npm install` 把官方包及其完整依赖闭包下载到内置内核目录（`resources\harness`，deploy 布局；源码 checkout 不支持一键更新），随后用新内核自动重启。检测与更新地址硬编码在主进程，不显示在界面。npm 优先用系统的，没有系统 npm 时自动改用应用内置的 Node/npm。
