# CCW

**Inspect local state. Freeze the plan. Apply confirmed work.**

CCW 是面向当前用户环境的 Claude Code 管理终端。它用一个交互入口管理程序、设置、Plugins、MCP、Skills、OfficeCLI、CCometixLine 与 Claude 运行数据。

## Why CCW exists

Claude Code 相关内容来自不同安装渠道，也分散在程序、配置、注册和数据目录中。仅凭名称或命令退出码判断状态，容易覆盖用户设置、删除错误副本，或把读取失败误判成“不存在”。

CCW 把这些风险收敛为一条流程：

```text
local state -> inspect -> plan -> apply -> result
                         frozen          resume
```

- 检查只读取本地事实；证据不可读时保留未知
- 计划冻结版本、来源、目标与实际影响
- 程序卸载、解除 Claude 接入和数据清理保持独立
- 失败后只续办原计划中尚未完成且仍可安全执行的工作
- 身份证据不足时，可以发现对象，但不会授予破坏性操作资格

## Install

CCW 0.4.0 需要 Node.js 22.20 或更高版本。使用 pnpm 或 npm 安装：

```bash
pnpm add -g @hit-sudomaker/ccw
# or
npm install -g @hit-sudomaker/ccw
```

启动终端或执行只读检查：

```bash
ccw
ccw --inspect
```

## What CCW manages

| 类别 | 内容 |
|---|---|
| 程序 | Claude Code、OfficeCLI、CCometixLine |
| 扩展 | Plugins、MCP、Skills、AMIRC Research Skill |
| 设置 | 登录方式、模型、终端偏好与 CCW 管理的 Claude 设置 |
| 数据 | Claude 缓存、历史、自动记忆、备份与后台状态 |

用户数据默认保留。完整删除必须单独选择；来源、许可或身份处于未知状态时，相关破坏性操作会被阻断。

方向键移动，空格勾选，`A` 全选或取消，`R` 刷新，`Esc` 返回。卸载与清理在执行前显示实际影响。

## Trust and limits

- Windows 已完成真实终端与隔离目录验收
- macOS 和 Linux 当前以合同测试为主
- 测试覆盖本地状态与故障路径，不代替真实账号登录、远程 MCP 认证或第三方市场可用性
- 默认设置只补缺，不覆盖用户已经明确设置的值

## Development

```bash
npm ci
npm run check
npm start
```

组装并验证独立运行目录：

```bash
npm run package:runtime
npm run test:runtime
```

## Design lineage

CCW 的交互配置和“先计划、后应用”思路参考了 [ZCF](https://github.com/UfoMiao/zcf)。本项目针对多渠道程序管理、身份与来源证据、未知状态、计划冻结和失败续办重新建立了合同；这里表达的是设计启发，不表示代码派生或兼容承诺。

CCW 管理或集成的 Claude Code、OfficeCLI、CCometixLine、Serena、Context7、Matt Pocock/Skills 与 [SSRE2 Skills](https://github.com/HIT-SudoMaker/ssre2-skills) 仍分别属于其原作者和项目。

## License

[MIT](LICENSE) © HIT-SudoMaker
