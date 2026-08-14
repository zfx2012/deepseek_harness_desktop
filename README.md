# DeepSeek Harness Desktop

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web GUI 打包成 Windows 桌面应用。

- 安装即用：内置官方最新发布版内核（`resources\harness`，相对安装目录解析），无需系统 Node——满足 engines 时优先用系统 Node，否则自动回退 Electron 内置运行时
- 主界面为主：启动直达 Web 主界面；设置页为同窗口切换（菜单/托盘「设置…」，返回按钮回主界面）；关闭窗口即隐藏到托盘，托盘右键或菜单「退出」才真正退出（退出时杀进程树）；崩溃自动重启、单实例
- 打包：NSIS 安装包 + 便携 exe，完全自包含（约 160MB）

## 快速开始

```bash
pnpm install --ignore-scripts          # 依赖
node node_modules/electron/install.js  # 恢复 Electron 二进制
npm start                              # 开发运行
npm run dist                           # 打包（release/ 产出安装包 + latest.yml）
```

内置内核来源：默认 **官方 npm 渠道**——直接安装 `@deepseek-ai/dsh` 最新发布版（`--version <ver>` 指定版本）为自包含闭包，与应用内"立即更新"同一机制；`--harness <已构建checkout>` 改用 checkout 闭包，`--no-auto-fetch` 离线。

## 内核更新检测与一键更新（设置页）

「检测内核更新」查询官方发布渠道（npm registry `@deepseek-ai/dsh` 的 dist-tags），与当前生效内核版本比较；发现新版本后可直接点击「立即更新」：应用会先停止服务器，用 `npm install` 把官方包及其完整依赖闭包下载到内置内核目录（`resources\harness`，deploy 布局；源码 checkout 不支持一键更新），随后用新内核自动重启。检测与更新地址硬编码在主进程，不显示在界面。更新需要系统已安装 Node/npm。
