# DeepSeek Harness Desktop — 重新评估报告（v3）

评估日期：2026-08-14（第三轮；v2 之后按产品决策移除代码签名与 Linux/macOS 跨平台范围）
评估对象：`C:\Users\jin\Desktop\deepseek\deepseek_harness_desktop` v0.1.0（**Windows 单平台产品**）
评估方式：全量源码静态审读 + 历史实证数据（三连 smoke、单元测试、可移植性复制验证、无 Node 实测）

---

## 1. 结论摘要

**Windows 桌面端已达到"可用的自包含交付"状态**：安装包（NSIS 159.9MB / 便携 159.7MB）内嵌完整 harness 闭包（280MB），在无 Node、无外部 checkout 的全新环境实测可用；v1 审计的 22 项问题与 3 项实测新发现**全部关闭并验证**；验证体系（单测 + 六步验证链 + 三种 smoke 断言）完整且本地全绿。产品范围已明确为 Windows 单平台、不签名分发（见 §2 范围决策）。

**综合评分：4.0 / 5**。单机使用就绪；唯一未闭环的验证项是自动更新端到端实测（`--smoke-update` 代码存在但未接入入口）。

## 2. 产品范围决策（本轮更新）

| 决策 | 影响 |
|------|------|
| 不做代码签名（含自签名与 CA） | 删除自签名证书（build/）、签名相关文档与计划条目；分发者自行承担 SmartScreen 提示 |
| 不做 Linux/macOS | 删除 main.js 的 darwin/activate 分支、server.js 的 POSIX kill 分支、build-closure 的 symlink 分支与 ETIMEDOUT/SIGTERM 双判定，Windows-only 路径简化 |
| 不做 CI | 删除 .github/workflows；本地验证链 scripts/verify.ps1 保留为唯一验证入口 |

## 3. 项目快照

| 维度 | 状态 |
|------|------|
| 运行时 | Electron **43.4.0**（Chromium 150 / Node 24.18.1） |
| 构建 | electron-builder 26.15.3（NSIS + portable + generic publish） |
| 更新 | electron-updater 6.8.9（可选启用，latest.yml 已生成） |
| 内置 harness | checkout rc.5 快照，280MB / 38,045 文件，hoisted+flatten 布局，零 reparse point |
| 源码规模 | main.js / server.js / store / preload / 2 个 UI 页 / 5 个构建脚本 |
| 测试 | tests/server.test.js 8 例（node:test，注入假子进程） |
| 产物 | NSIS 159.9MB、portable 159.7MB、latest.yml、blockmap |

## 4. v1 审计闭环（25 项全部关闭）

| 类别 | 项数 | 状态 | 关键验证 |
|------|------|------|----------|
| P0 阻断级（junction 可移植性 / 打包丢依赖树 / 冒烟假阳性 / 错误页失效） | 4 | ✅ 全修 | 复制目录后 boot 通过；`SMOKE_OK harnessSource=bundled`；`SMOKE_ERROR_OK` |
| P1 核心缺陷（伪 ready / 托盘恢复 / stopped UI / Node 门槛 / fd 泄漏 / 日志轮转 / 日志停采） | 7 | ✅ 全修 | 单测覆盖伪 ready；裁剪 PATH 实测 ELECTRON_RUN_AS_NODE |
| 实测新发现（profiles symlink EPERM / 显式路径静默回退 / config BOM） | 3 | ✅ 全修 | 全新 DSH_HOME 冒烟通过；SMOKE_ERROR_OK errText 正确；store 读回正确值 |
| P2 工程卫生 | 11 | ✅ 全修 | 闭包 1,547MB→280MB；`bundle validation passed` |
| 阶段 3 基建（单测） | 单测 8/8 ✅ | | |

## 5. 未接线清单（已清零）

> 2026-08-14 修复轮：U1 与 N1–N3 全部关闭（见 [AUDIT-v2.md](./AUDIT-v2.md) 附录修复记录）；本清单仅保留历史结论。

| # | 项 | 状态 | 说明 |
|---|----|------|------|
| U1 | `--smoke-update` 自动更新实测 | ✅ 已接线 | `SMOKE_UPDATE` 短路入口 + `scripts/update-feed.mjs` 本地 feed + verify.ps1 第 7 步；实测 `SMOKE_UPDATE_OK version=0.2.0` |

## 6. 已知问题（已修复）

- ~~N1 冒烟退出清理竞态~~ → **已修复**：stopChild 的 taskkill 改为同步 spawnSync，dispose 返回时进程树已死。
- ~~N2 --smoke-update 未接入~~ → 同 U1，已接线。
- ~~N3 preHeal 真实目录边缘~~ → **已修复**：真实目录先 rename 到 `.dsh-bak` 再建 junction（单测 2 例覆盖）。
- N4（P3）electron-updater 打包体积：接受，维持现状。

## 7. 架构与质量评估

| 维度 | 评分 | 评语 |
|------|------|------|
| 模块边界 | 4.5/5 | main/server/store/preload/UI/scripts 分层清晰，server 状态机可注入测试 |
| 稳定性 | 4.5/5 | 重启竞态已修复（身份守卫 + 同步杀树）、崩溃重启、超时、日志轮转、fd 管理齐全 |
| 可验证性 | 5/5 | 单测 13 例 + 七步验证链 + 四种 smoke（来源断言/错误页 DOM 断言/无 Node 回退/更新发现） |
| 安全 | 4/5 | 渲染层 sandbox、contextIsolation、无 node 集成、127.0.0.1 绑定、IPC 面最小；`--expose-internals` 仅用于受控子进程 |
| 打包/分发 | 4/5 | 自包含可移植（实测复制验证）；无签名（范围决策，分发时 SmartScreen 提示） |
| 更新机制 | 4/5 | 发现链路端到端实测（SMOKE_UPDATE_OK）；下载+安装动作待真实 release 验证 |
| 可维护性 | 4/5 | 构建脚本注释详尽；范围裁剪后平台分支更少、更简单 |
| **综合** | **4.3/5** | Windows 单机可用，验证体系完整；仅剩真实发布环境的下载/安装环节未实测 |

## 8. 建议路线（建议，未执行）

**短期（发布前）**
1. 接线 `--smoke-update` 入口 + verify.ps1 增加本地 feed 步骤（fake latest.yml → 断言发现新版）——关闭 U1；
2. 修复 N1 竞态（smoke 退出同步清理）；
3. N3 preHeal 加固（预修复时检测真实目录并替换为链接）。

**中期**
4. 真实 generic feed 部署 + 全链更新实测（下载+sha512 校验）；
5. harness 版本联动自动化（上游 release 触发重打包）。

**长期**
6. 更新+发布的自动化流水线。

## 9. 结论

项目从"骨架正确但交付物不可用"（v1 审计时的判断）演进到 **Windows 交付物真实自包含可用**，两轮修复的每一项都有可复现的验证凭证（bundled 来源断言、错误页 DOM 断言、目录移动复制 boot、无 Node 裁剪 PATH 实测）。产品范围明确为 Windows 单平台、不签名分发、无 CI 后，代码路径更简单；剩余待办（更新实测接线、N1 竞态）都有明确的执行路径，无技术未知数。
