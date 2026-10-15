<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 同工具连续失败检测 → 下一步注入修复提示（借鉴 MemOS decision-repair）：观察 tools/result 滑动窗口，触发后经 agent/pre-step 尾部注入，fail-open 不阻塞会话
  inject: 'tools','agents'
  tools: （无工具 —— 纯行为插件）
  runtime: host-only
  envDeps: 无
  boundary: **失败开放**——判定与注入路径的任何异常都不得改变原 decision，也不得中断会话；注入内容不含工具调用（不递归）
  compat: cordis ^4.0.1 / dsh-tools >=0.1.0-rc.6
-->
# dsh-agent-repair

<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-repair"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-19%20passed-brightgreen" alt="tests">
</p>

**一句话**：盯着「**同一个工具连续失败**」这件事，一旦成立就在下一步注入一条修复提示——让 agent 从失败循环里自己跳出来。

**为什么值得用**：agent 卡在失败循环里时（同一个工具、同样的错、连着几次），**它自己往往察觉不到**——每次调用看起来都是一次独立的新尝试。本插件把「连续失败」变成可观测状态，并在**下一步之前**把提示送进视野（经 `agent/pre-step` 尾部注入）。⚠ 它**只送信号，不改决策**：注入是提示不是拦截（fail-open，任何异常都不影响原流程）。

## 能力

**行为侧（无工具）**：

- 观察 `tools/result` 滑动窗口，按 `agent.session.id` **会话隔离**统计
- 同一工具连续失败达阈值 ⇒ 经 `agent/pre-step` 尾部注入修复提示
- **成功即重置**（MemOS 语义：success resets the streak）

## 快速开始

**1) 装依赖**：

```jsonc
"dsh-agent-repair": "link:E:/alice/self-plugins/dsh-agent-repair"
```

**2) 挂组合**：

```yaml
- id: repair
  name: dsh-agent-repair
  config:
    threshold: 3            # 连续失败几次触发（见源码 Config 默认值）
    maxEventsPerTool: 32    # 每工具事件上限（有界内存）
```

**3) 30 秒验证**：故意让同一个工具连续失败 N 次 → 下一步的上下文尾部应出现修复提示；然后让它成功一次 → 计数应重置（再失败不会立刻触发）。

## 配置

| 项 | 默认 | 说明 |
|---|---|---|
| `threshold` | 见源码 `Config` | 连续失败几次触发注入 |
| `maxEventsPerTool` | `32` | 每工具事件数组上限，**超限丢最旧**（有界内存） |

## 落盘与自证

| 文件 | 何时写 | 内容 |
|---|---|---|
| `$DSH_HOME/repair-trace.jsonl` | 每次判定与注入 | 会话 id / 工具名 / 连续失败计数 / 是否触发注入（§5.22 机制自证） |

**一条命令答五问**：

```bash
tail -5 "$DSH_HOME/repair-trace.jsonl"
# ① 跑的是哪个构建 → 见 package.json version 与 lib mtime
# ② 谁发起        → 该行的 session id
# ③ 断在哪一段    → 有行无注入 = 未达阈值；无行 = 没发生失败
# ④ 结果质量      → 连续失败计数与是否触发
# ⑤ 耗时与预算    → 每工具事件数（受 maxEventsPerTool 约束）
```

## 生效判据与回退

**判据**：行为级——让同一工具连失败 N 次，看下一步是否出现提示；辅助——`repair-trace.jsonl` 尾部有对应行。
**回退**：① `git revert` + 重建 + 预检重启；② patch 行 `disabled: true`；③ 本插件**无持久状态**（窗口在内存里），停用即完全静默。

## 测试

```bash
cd self-plugins/dsh-agent-repair && npm test
```

**19 条用例**（跑一次得到）：覆盖触发阈值边界 · **成功重置**（I1）· **有界内存**（超限丢最旧）· **失败开放**（异常不改原 decision）· **不递归**（注入内容不含工具调用）· **会话隔离**（不跨会话泄漏）。无需网络。

## 设计要点

- **I1 成功重置**：窗口内出现一次成功 ⇒ 该工具不构成失败循环（MemOS 语义）。
- **I2 有界内存**：每工具事件数组上限 `maxEventsPerTool`（缺省 32），超限丢最旧——**不随会话长度无界增长**。
- **I3 失败开放**：判定与注入路径的任何异常都**不得改变原 decision**，也不得中断会话。
- **I4 不递归**：注入内容不含工具调用，不触发新的失败判定。
- **I5 会话隔离**：状态按 `agent.session.id` 隔离，不跨会话泄漏。
- **为什么是「注入提示」而不是「拦截」**：拦截在本机已被证伪（自锁事故）；可移植的是「**强制取证 / 送信号**」的形状，不是「拒绝」的手段。

## 相关文档

- [`docs/semantic.md`](docs/semantic.md) —— **权威契约**（定位/反定位 · 5 条不变量 · 验收表）
- 中心仓：[alice-digital-life](https://github.com/jonah791/alice-digital-life)（本插件归 **认知层**）
- 相关论文锚：MemOS decision-repair

## License

MIT © jonah791

---

本插件属于**爱丽丝 DSH 自研插件生态**（[alice-digital-life](https://github.com/jonah791/alice-digital-life) · 73 个插件 · 8 个模块）：单一职责、独立仓库、独立可用。
