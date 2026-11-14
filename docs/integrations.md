# 接入说明

本文记录 CCW 各项接入使用的来源和命令。界面操作见 [README](../README.md)，执行过程见[产品与执行合同](specs/operation-state-machine.md)。

## Claude Code

CCW 通过 npm 查询并安装当次 `@anthropic-ai/claude-code@stable`，根据包清单选择 JavaScript 或原生入口。准备计划时会固定 npm 的安装范围和程序身份，执行前再次核对。

Claude 域负责模型连接、语言、输出风格和默认设置。安装时将 `autoUpdatesChannel` 设为 `stable`；`permissions.defaultMode` 和 `skipDangerousModePermissionPrompt` 只在缺失时分别设为 `bypassPermissions` 和 `true`。危险模式确认使用 Claude 的[公开设置](https://code.claude.com/docs/en/settings-reference#skipdangerousmodepermissionprompt)，不会修改私有 API 密钥确认缓存或默认开启 `IS_DEMO`。

## Plugins

插件统一使用 [Claude 官方插件命令](https://code.claude.com/docs/en/plugins/cli-reference)。安装、更新和启用时使用计划绑定的 Claude 入口；停用时只修改用户设置中的 `enabledPlugins`，保留插件文件和市场记录。插件清单见 [management-catalog.ts](../packages/ccw/src/management-catalog.ts)。

Context7 自带[远程 MCP 配置](https://github.com/anthropics/claude-plugins-official/blob/main/external_plugins/context7/.mcp.json)；Serena 的[插件配置](https://github.com/anthropics/claude-plugins-official/blob/main/external_plugins/serena/.mcp.json)使用 `uvx` 启动服务。CCW 不另行注册 MCP，也不检测或安装独立的 Serena 和 uvx。插件状态反映安装和启用情况，不表示 MCP 已连接；服务登录由 Claude 处理。

## Skills

CCW 固定使用 `skills@1.8.1`。准备远程来源时先解析提交，预检和安装使用同一提交；AMIRC Research Skill 使用随包资源。主要调用如下，`SOURCE` 和 `NAMES` 分别代表来源和待移除的技能名：

```text
npm exec --yes --package=skills@1.8.1 -- skills a SOURCE --list
npm exec --yes --package=skills@1.8.1 -- skills remove NAMES --global --agent claude-code --yes
npm exec --yes --package=skills@1.8.1 -- skills a SOURCE --skill * --agent claude-code --global --yes --copy --json
```

这些命令以参数数组执行，`*` 不经过 shell 展开。远程套件默认全选。刷新时先确认旧入口的来源与内容，再移除同来源的旧成员并安装当前成员；手写、其他来源和本地修改不会被覆盖。

CLI 使用当前 `CLAUDE_CONFIG_DIR` 和 CCW 私有的 `XDG_STATE_HOME`。移除命令另用私有的 `HOME` 和 `USERPROFILE`，以保留用户目录中的共享源。共享锁只核对当前来源和本次目标，避免同批其他来源的更新造成冲突。

CLI 回执需要与实际文件共同核对。移除部分成功后，即使后续操作失败，也会记录已完成的部分，供下次重试时使用。升级 CLI 时，应对照[固定版本源码](https://github.com/vercel-labs/skills/tree/e781cb4d07433dfe1d19e924ed45cc61738c55ec)重新核对列表、JSON 回执、路径和复制行为。

## 额外工具

OfficeCLI 自行管理原生程序和与程序版本匹配的 Skill。CCometixLine 自行管理 npm 程序、主状态栏和首次外观配置；已有外观和子代理状态栏会保留。
