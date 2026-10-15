# dsh-agent-repair

同工具连续失败检测 → 下一步注入修复提示（借鉴 MemOS decision-repair）：观察 tools/result 滑动窗口，触发后经 agent/pre-step 尾部注入，fail-open 不阻塞会话
