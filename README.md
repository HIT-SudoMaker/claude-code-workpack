# CCW 0.5.1

CCW 是一个管理 Claude Code 及其常用扩展的终端工具。安装、更新和移除前，CCW 会先展示变更预览，确认后再执行。

## 安装与启动

CCW 需要 Node.js 22.20 或更高版本，支持 Windows、macOS 和 Linux。安装程序与扩展时需要网络连接。

```bash
npm install -g @hit-sudomaker/ccw
ccw
```

上面的命令安装 npm 上已发布的版本。如需使用当前源码，请参考[本地构建与更新](#本地构建与更新)。

## 使用菜单

| 菜单     | 用途                                   |
| -------- | -------------------------------------- |
| 安装配置 | 安装或更新所选项目，编辑模型和偏好设置 |
| 检查状态 | 查看安装状态和配置路径                 |
| 移除程序 | 移除受管程序或解除所选接入             |
| 清理数据 | 按类别清理 Claude 数据                 |
| 退出程序 | 关闭 CCW                               |

在“安装配置”中勾选已安装的项目，即可更新。已有的有效模型连接、语言和输出风格会直接复用；需要修改时，可以在列表中进入对应的设置项。检查状态是只读操作。

方向键移动，空格勾选，`A` 全选或取消全选，`Enter` 确认，`Esc` 返回。长页面可用 `PgUp` 和 `PgDn` 翻页。执行过程中按 `Ctrl+C` 会停止后续操作，已经发生的变更不会回滚。

## 管理内容

- **Claude Code**：通过 npm 安装当次 `stable` 版本，并配置模型连接、语言和输出风格。
- **Plugins**：管理 Code Simplifier、Frontend Design、GitHub、Context7、MCP Server Dev、Skill Creator 和 Serena。
- **Skills**：管理 Matt Pocock/Skills、HIT-SudoMaker/SSRE2 和随包提供的 AMIRC Research Skill。
- **额外工具**：管理 OfficeCLI 及其配套 Skill，以及 CCometixLine 和主状态栏。

GitHub、Context7 和 Serena 使用 Claude 的插件安装流程，CCW 不要求填写插件访问令牌。Context7 和 Serena 的 MCP 配置由插件提供；Serena 通过插件声明的 `uvx` 启动。插件显示已安装只表示插件就绪，服务是否连接仍需在 Claude 中检查。

安装或更新 Claude Code 时，CCW 始终选择当次 `stable` 版本，即使已安装版本更高也不例外。CCW 会将自动更新通道设为 `stable`，并在缺少对应设置时补入 `bypassPermissions` 和 `skipDangerousModePermissionPrompt`。已有的明确权限选择会保留；API 密钥确认及其他首次使用提示仍由 Claude 处理。

## 移除与数据清理

“移除程序”只处理所选的受管程序或接入。停用插件会保留插件文件；移除受管 Skill 会将入口移至 `~/.ccw/disabled`。解除模型连接时，相关的 API 凭据和凭据助手也会被移除。

更新 Skill 来源时，CCW 会先核对归属和内容，再替换该来源的旧入口。手写 Skills、其他来源和本地修改会保留。

“清理数据”可以选择缓存与日志、会话与历史记录、项目记忆、备份文件或运行数据。预览会列出路径、文件数、目录数和大小。**确认后，所选数据会被永久删除**；程序、配置、凭据、插件和 Skills 不在清理范围内。清理前请先关闭 Claude Code。

## 命令行

```bash
ccw                     # 打开菜单
ccw --inspect           # 检查状态
ccw --details           # 在菜单中显示诊断代码
ccw --inspect --details # 显示检查详情
ccw --version           # 查看 CCW 版本
ccw --help              # 查看帮助
```

## 本地构建与更新

在仓库根目录运行：

```bash
npm ci
npm run build
npm start
```

本机如果使用 pnpm 安装了 CCW，可以用 PowerShell 将当前源码重新打包并安装：

```powershell
New-Item -ItemType Directory -Force .scratch | Out-Null
npm pack ./packages/ccw --pack-destination .scratch
pnpm add --global --force ./.scratch/hit-sudomaker-ccw-0.5.1.tgz
```

重新打包后再安装，关闭旧的 CCW 窗口并运行 `ccw`，即可使用新版本。如果原来使用 npm 全局安装，可将最后一行换成 `npm install -g`，并指定同一个安装包。打包和本地安装不会发布版本。

开发检查使用 `npm run check`；独立运行包可用 `npm run package:runtime` 构建，并用 `npm run test:runtime` 验证。Windows 终端交互使用 ConPTY 测试；macOS 和 Linux 目前主要通过平台模拟覆盖。

开发资料：[接入说明](https://github.com/HIT-SudoMaker/claude-code-workpack/blob/main/docs/integrations.md) · [产品与执行合同](https://github.com/HIT-SudoMaker/claude-code-workpack/blob/main/docs/specs/operation-state-machine.md) · [CSU 编码规范](https://github.com/HIT-SudoMaker/claude-code-workpack/blob/main/docs/standards/typescript-csu.md)

交互设计参考了 [ZCF](https://github.com/UfoMiao/zcf)。本项目集成的工具与扩展归各自作者所有。

[MIT](https://github.com/HIT-SudoMaker/claude-code-workpack/blob/main/LICENSE) © HIT-SudoMaker
