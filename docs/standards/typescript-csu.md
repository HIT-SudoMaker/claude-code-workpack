# CCW TypeScript 编码规范

本文参考 [CSU 编程规范](https://github.com/HIT-SudoMaker/code-style-unifier/blob/963bb84e9e9d5015a458ea2016d83de0db2f458e/docs/coding_standards.md)，用于 CCW 的 TypeScript 源码。JavaScript 脚本和测试沿用其中适用的命名与表达要求。

上游 CSU 当前检查 Python、Rust、C 和 C++，不检查 TypeScript。本文借鉴其命名、注释和接口文档要求，并结合 TypeScript 的惯例及 CCW 的实际代码作适配。

## 1. 规则依据

按以下顺序处理冲突：

1. 用户对当前任务的明确要求
2. [产品与执行合同](../specs/operation-state-machine.md)及已有公开接口
3. 本规范
4. 当前实现和工具默认行为

本文约束作者如何编写和审查代码。TypeScript 编译器、ESLint 和 Prettier 能检查的范围见[作者核验](#7-作者核验)；其余要求需要人工审查。

## 2. 源码结构与注释

### 2.1 注释布局

普通注释独占一行，放在相关代码之前。需要保留的工具指令遵循工具要求，不用普通行末注释替代接口文档。

普通注释、docstring 和 TSDoc 的自然语言正文不使用中文句号或英文句末点号。URL、路径、版本号、小数和代码标识符中的点保留；工具指令和明确的代码内容按原语法书写。

注释中的圆括号应确认是否必要。技术名称、公式或代码需要括号时可以保留，不为消除括号损失含义。

### 2.2 表达方式

- 只写代码本身不能清楚表达的目的、原因或约束
- 默认使用“行为＋对象”，需要时补充条件；类型和字段可使用名词短语
- 一行说明一件事，同一要点可以换行，不靠堆长句省行数
- 不逐行复述实现，不写夸赞、战报、历史流水账或装饰性分隔线
- 说明放在使用处；删除失效注释，长篇设计取舍写入相应文档

例如，`读取配置`、`验证来源`和`保留用户数据`比“执行配置处理逻辑”更容易理解。

## 3. 语义命名

### 3.1 名称形式

| 声明                             | 形式                         | 示例                                    |
| -------------------------------- | ---------------------------- | --------------------------------------- |
| 变量、参数、函数、方法和内部属性 | `camelCase`                  | `planId`、`readSettings`                |
| 类型、接口、类和枚举             | `PascalCase`                 | `RunResult`、`ReadMachine`              |
| React 组件和 Hook                | `PascalCase`、`useCamelCase` | `RunScreen`、`useSelection`             |
| 固定策略和配置常量               | `UPPER_SNAKE_CASE`           | `READ_COMMAND_TIMEOUT_MS`               |
| 源文件与测试文件                 | `kebab-case`                 | `read-machine.ts`、`full-flow.test.mjs` |
| 错误码与事件码                   | `kebab-case`                 | `target-changed`、`program-ready`       |

普通标识符不使用 `snake_case`。`const` 表示绑定不可重新赋值，局部计算结果仍使用小驼峰。接口不加 `I` 前缀，私有成员不用前后下划线标记。

### 3.2 名称含义

名称应说明对象或动作，同一概念保持同名，不同概念不要都叫 `data`、`info` 或 `result`。函数名优先使用“行为＋对象”，如 `verifyInstallation`。

| 前缀     | 含义                     | 示例               |
| -------- | ------------------------ | ------------------ |
| `is`     | 是否处于某状态           | `isRunning`        |
| `has`    | 是否具有某对象或事实     | `hasCredential`    |
| `can`    | 是否具备执行能力         | `canInstall`       |
| `should` | 是否按策略执行           | `shouldKeepBinary` |
| `needs`  | 当前是否需要某对象或动作 | `needsCommand`     |

区间端点使用 `lower`、`upper`，计算或观察到的极值使用 `minimum`、`maximum`。选择前缀时先确认实际含义，不根据布尔类型自动猜测。

单字符名称和无法独立说明含义的缩写应先核对上下文，优先改成完整名称。例如，测试环境使用 `workspace`，组合场景使用 `scenario`，测试上下文使用 `testContext`。`T` 和局部索引 `i` 等惯用名称，在含义明确时可以保留。

内部名称不使用 `legacy`、`V1`、`V2` 等历史标签，也不用 `new` 区分新旧实现；发布、依赖、协议或外部数据中有实际版本含义的名称可以保留版本号。

### 3.3 单位与外部名称

量值需要区分单位或编码时，在名称中写明表示方式，如 `timeoutMs`、`sizeBytes`、`textUtf8`。固定常量使用对应的大写形式，如 `READ_COMMAND_TIMEOUT_MS`。单位后缀不能代替范围校验或数值转换。

外部协议字段、环境变量和第三方文件名保留原拼写，如 `tag_name`、`enabledPlugins` 和 `CLAUDE_CONFIG_DIR`。读取后可以映射为内部名称，写回时仍使用协议字段。

## 4. 接口文档

公开或跨模块调用的函数、方法和接口使用紧邻声明的 TSDoc，说明职责及调用者需要知道的限制、结果、失败方式、副作用和取消行为。内部函数以简短摘要说明职责；名称和类型已充分表达的小型回调无需复制一遍。

`@param`、`@returns` 补充类型未表达的信息，`@throws` 说明失败，`@remarks` 补充约束。没有相关内容时不添加空章节；Promise 的正常失败结果与拒绝应分别说明。实现处只补充自身约束，不复制接口合同。

```ts
/**
 * 读取毫秒时限
 *
 * @param value - 可转换为数字的文本
 * @returns 大于零的安全整数
 * @throws Error - 输入无效时抛出 invalid-timeout
 */
export function parseTimeoutMs(value: string): number {
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('invalid-timeout');
  return timeoutMs;
}
```

README 说明使用和更新，接入说明记录来源与命令，产品合同定义行为。代码旁保留修改当前逻辑必须知道的原因和约束，不能只留远端文档链接。普通 Markdown 正文使用正常标点，不受注释句号规则限制。

## 5. 类型与依赖

- 保持 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` 和未使用声明检查
- 外部 JSON、命令输出与网络数据先按 `unknown` 接收，再校验需要的字段
- 用可辨识联合表达互斥状态，区分字段缺失、`undefined` 和 `null`
- 只读输入使用 `readonly`，优先使用类型收窄、`satisfies` 和必要的 `as const`；不用 `any`、非空断言或双重断言掩盖缺失的校验
- 使用 ESM 和 NodeNext，本地 TypeScript 模块导入使用 `.js` 后缀，纯类型导入使用 `import type`
- 直接从所属模块导入，优先复用现有依赖；重排导入时保留副作用和初始化顺序
- 参数、泛型、导出和公共抽象由实际调用需要决定；合并重复代码前先核对职责与前置条件

## 6. 行为与测试

风格整理不能削弱产品行为。文件与进程操作通过 `machine.ts` 管理；检查与计划准备不写入受管目标；取消后仍需核验已发生的效果。路径、版本、来源和字段的必要核对，以及失败原因和凭据保护，都应保留。

测试按使用流程和模块职责组织：先看完整流程，再看各项预期行为，最后看冲突、失败恢复与边界。夹具集中重复准备和清理，场景差异、操作与断言留在测试中；预期值独立于生产规则。

## 7. 作者核验

| 检查内容                                                            | 方式         |
| ------------------------------------------------------------------- | ------------ |
| 类型、索引访问、可选属性、未使用声明                                | TypeScript   |
| TypeScript 变量、函数和类型的基本命名、类型导入、Promise 和受限导入 | ESLint       |
| 源码格式                                                            | Prettier     |
| 名称含义、注释标点、文档合同和表达                                  | 人工审查     |
| 取消、来源、文件保护等产品行为                                      | 对应行为测试 |

常用命令：

```bash
npm run typecheck
npm run lint
npm run format:check
npm run check
```

涉及独立运行包时，另运行 `npm run test:runtime`。工具配置见 [TypeScript](../../packages/ccw/tsconfig.json)、[ESLint](../../eslint.config.mjs)、[Prettier](../../.prettierrc.json) 和[开发脚本](../../package.json)。Markdown 未纳入默认格式检查，修改后单独核对排版与链接。

报告时区分自动检查、人工审查和未覆盖的范围。TypeScript 的本地检查通过，不表示上游 CSU 已完成 TypeScript 扫描，也不能据此报告 CSU `Clean`。
