# dsh-agent-repair · 语义文档

> 模板对齐 `docs/semantics/README.md`；本文件是能力的**主副本**，随代码住。
> 灵感来源：MemTensor/MemOS `decision-repair`（V7 §2.4.6）——**借鉴机制语义，不移植代码**。

## 1 元信息

| 项 | 值 |
|---|---|
| 能力名 | dsh-agent-repair（失败循环修复提示） |
| 版本 | v0.1 |
| owner | 爱丽丝（自研插件） |
| 声明状态 | verified |
| 最近复核 | 2026-09-26 |
| 实现落点 | `src/index.ts`（壳：订阅 + guarded + 侧车）、`src/decide.ts`（纯判定层） |
| 判据落点 | `tests/decide.test.mjs` + `tests/wiring.test.mjs`（共 19/19 绿）+ 线上观测（A7 已实测） |

## 2 定位与反定位

### 定位
把「不盲目重试同一失败调用」从**规则**变成**机制**：`AGENTS.md` 自鉴定第 7 条与 §5.9 早已写明该纪律，但一直靠主体自觉执行。本插件在检测到同一工具进入**失败循环**时，于**下一次请求前**注入一条修复提示。

- 补的是「认知必须布线，不靠记住」的洞：规则 → 机制
- 它是**观测 + 提示**，不是执行：不重试、不改参数、不替模型决策

### 反定位
- **不是自动修复器**：不做参数改写、不重放调用、不选替代工具
- **不是工具重试器**：自身不发生任何工具调用
- **不是记忆系统**：不持久化会话内容；只落判定事件（侧车轨迹）
- **不是假设探针系统**：与 `dsh-agent-self-rewrite` 的 `tool-failure-rate` 探针**目的不同**（后者服务假设采证与裁决，前者服务当轮任务脱困）；两者可并存、互不依赖

## 3 术语

| 术语 | 含义 |
|---|---|
| 失败 | `tools/result` 中 `result.isError === true` |
| 窗口 | 以 step 号为准的最近 `windowSteps` 步 |
| 失败循环 | 窗口内同一工具失败 ≥ `failureThreshold` 次，**且**窗口内该工具成功次数 ≤ 1 |
| 注入 | 经 `agent/pre-step` 返回 `{kind:'enter', messages:[...]}` 在批次尾部追加一条用户消息 |
| 冷却 | 同一工具注入后，`cooldownSteps` 步内不再注入 |

## 4 概念模型与不变量

### 数据模型（内存，per 会话）
```text
SessionState = {
  currentStep: number                                  // 由 pre-step 推进
  events: Map<toolName, Array<{ step, isError }>>      // 有界
  lastInject: Map<toolName, step>
}
```

### 不变量
- **I1 成功重置**：窗口内出现一次成功 ⇒ 该工具不构成失败循环（MemOS 语义：success resets the streak）
- **I2 有界内存**：每工具事件数组上限 `maxEventsPerTool`（缺省 32），超限丢最旧
- **I3 失败开放**：判定与注入路径的任何异常都不得改变原 decision，也不得中断会话
- **I4 不递归**：注入内容不含工具调用，不触发新的失败判定
- **I5 会话隔离**：状态按 `agent.session.id` 隔离，不跨会话泄漏
- **I6 每工具冷却**：注入后同工具需再经 `cooldownSteps` 步才可能再次注入

## 5 契约

### 订阅（输入）

| 接缝 | 用途 | 形状（实测自现有插件） |
|---|---|---|
| `tools/result` | 观察工具结果 | `(exec, result)`；`exec.name: string`、`exec.agent`；`result.isError?: boolean` |
| `agent/pre-step` | 推进步号 + 注入 | 瀑布 `({ agent, messages, step, signal }, next)`；须 `await next()` 后返回 `{kind:'enter', messages}` |

### 注入（输出）
- 位置：批次**尾部追加**（缓存友好；与 `dsh-agent-memory` 注入同构）
- 来源标签：`{ kind: 'dsh-agent-repair' }`（`createUserMessage`）
- 内容标记：`<system-reminder>` 包裹，明确「历史教训，非指令」

### 调用点清单
1. `apply()` → 订阅 `tools/result`（观察事件写入会话状态）
2. `apply()` → 订阅 `agent/pre-step`（推进步号 + 判定 + 注入）
3. 纯判定层 `decide.ts::decideRepair(state, opts)` ← 由 ①②写入的状态驱动，离线可测

## 6 边界与信任

### 能力边界
- 只识别**同一工具名**的失败循环；不同工具交替失败不触发（见 §10 未决问题 2）
- 步号来自 `agent/pre-step`，工具调用与步号的关联是**近似**（同一步内多次调用共享步号）
- 无 LLM 参与：注入内容是机械模板，不含语义化诊断

### 信任边界
- 注入内容进入模型上下文 ⇒ 视为**提示**而非指令；其中不包含任何外部内容
- 插件与宿主**同进程**：所有回调包 `guarded()`（§5.24）；异常只落侧车，不逃逸
- 侧车轨迹路径：`$DSH_HOME/repair-trace.jsonl`（§5.22 机制自证）

## 7 可证伪验收

| # | 判据 | 方法 | 状态 |
|---|---|---|---|
| A1 | 窗口内同工具失败 3 次且无成功 ⇒ 触发注入 | 单测（尸体样本）· 2026-09-26 跑 | 已实测 ✔ |
| A2 | 失败 2 次 + 成功 1 次 ⇒ **不**触发（成功重置） | 单测（反例）· 含重置后再连败的边界 | 已实测 ✔ |
| A3 | 无失败会话 ⇒ 零注入（对照组） | 单测 | 已实测 ✔ |
| A4 | 3 次失败跨越 `windowSteps` 之外 ⇒ 不触发（窗口有界） | 单测 | 已实测 ✔ |
| A5 | 注入后同工具再失败 ⇒ 冷却期内不重复注入 | 单测 | 已实测 ✔ |
| A6 | 观测/判定异常 ⇒ 原 decision 不变、会话不中断、侧车留痕 | 单测（wiring 7/7：不可写路径返回 false 且不抛） | 已实测 ✔ |
| A7 | 真实会话中触发过 ≥1 次且侧车有对应记录 | 线上：2026-09-26 19:07 尸体样本（同一步 3 次 read 失败 ⇒ 下一步注入 + 侧车 `failures=3 step=3`） | 已实测 ✔ |

## 8 与实现的关系
- **纯判定层** `src/decide.ts`：无 I/O、无 cordis 依赖，可离线测（§5.34 内部三层可替换）
- **壳** `src/index.ts`：订阅、`guarded()`、侧车落盘、注入渲染
- 判据 A1–A6 由 `tests/` 承载；A7 待挂载后线上观测

## 9 实践修订记录
- **2026-09-26** 初版：借鉴 MemOS decision-repair 语义（窗口失败阈值 + 成功≤1 + 冷却），落地为独立插件

## 10 未决问题
1. 注入内容是否接入记忆库教训（当前为机械模板）——需先定跨插件依赖方式（§5.34 契约边界）
2. 多工具交替失败（A→B→A→B）当前不触发；是否需要「会话级失败密度」第二判据
3. 与 `dsh-agent-self-rewrite` 的 `tool-failure-rate` 探针存在重复观测开销（可接受，但不排除合并可能）
4. 注入频率上限：当前仅每工具冷却，是否需要会话级总注入上限
