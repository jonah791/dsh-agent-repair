/**
 * @module dsh-agent-repair/decide
 * Pure decision layer for failure-loop detection — no I/O, no cordis imports,
 * fully unit-testable offline.
 *
 * Semantics are adapted from MemOS `decision-repair` (V7 §2.4.6): a failure
 * burst is reported when the same tool fails at least `failureThreshold`
 * times inside a bounded step window, where **a success resets the streak**.
 * We deliberately do not transport MemOS code — only the trigger semantics.
 */

/** One observed tool call: which step it happened on, and whether it failed. */
export interface ToolEvent {
  readonly step: number
  readonly isError: boolean
}

/** Trigger thresholds. Defaults mirror MemOS's burst policy, expressed in steps. */
export interface RepairPolicy {
  /** Failures in a streak required to report a loop. */
  readonly failureThreshold: number
  /** Width of the step window (inclusive of the current step). */
  readonly windowSteps: number
  /** Steps to wait before the same tool may be reported again. */
  readonly cooldownSteps: number
}

export const REPAIR_DEFAULTS: RepairPolicy = {
  failureThreshold: 3,
  windowSteps: 5,
  cooldownSteps: 8,
}

export const MAX_EVENTS_PER_TOOL_DEFAULT = 32

/** Outcome of a trigger evaluation: which tool, and the streak actually seen. */
export interface RepairDecision {
  readonly tool: string
  readonly failures: number
  readonly windowSteps: number
}

/**
 * Append one event, keeping the per-tool history bounded (oldest dropped first).
 * @param events - Existing history, oldest first.
 * @param event - Event to append.
 * @param maxEvents - Hard cap on retained events.
 * @returns New array; the input is never mutated.
 */
export function appendEvent(
  events: readonly ToolEvent[],
  event: ToolEvent,
  maxEvents: number = MAX_EVENTS_PER_TOOL_DEFAULT,
): ToolEvent[] {
  const next = [...events, event]
  return next.length > maxEvents ? next.slice(next.length - maxEvents) : next
}

/**
 * Decide whether one tool is in a failure loop at `currentStep`.
 *
 * A success inside the window resets the streak, so only failures after the
 * last success count. Events outside the window are ignored entirely.
 *
 * @param tool - Tool name, echoed back in the decision.
 * @param events - Recorded events for this tool (any order; window is filtered).
 * @param currentStep - Step being proposed now.
 * @param lastInjectStep - Step of the previous notice for this tool, if any.
 * @param policy - Thresholds.
 * @returns The decision when the loop is confirmed, otherwise `null`.
 */
export function decideRepair(
  tool: string,
  events: readonly ToolEvent[],
  currentStep: number,
  lastInjectStep: number | undefined,
  policy: RepairPolicy = REPAIR_DEFAULTS,
): RepairDecision | null {
  if (!Number.isFinite(currentStep)) return null
  if (lastInjectStep !== undefined && currentStep - lastInjectStep < policy.cooldownSteps) return null

  const windowStart = currentStep - policy.windowSteps + 1
  const inWindow: ToolEvent[] = []
  for (const event of events) {
    if (!Number.isFinite(event.step)) continue
    if (event.step >= windowStart && event.step <= currentStep) inWindow.push(event)
  }

  // Everything after the last success is the live streak; a success resets it.
  let lastSuccessIndex = -1
  for (let i = 0; i < inWindow.length; i += 1) {
    const event = inWindow[i]
    if (event !== undefined && !event.isError) lastSuccessIndex = i
  }
  const streak = inWindow.length - lastSuccessIndex - 1

  if (streak < policy.failureThreshold) return null
  return { tool, failures: streak, windowSteps: policy.windowSteps }
}

/**
 * Render the notice injected before the next request. Operational text (Chinese)
 * is deliberate: its readers are the current master and me, not upstream.
 * @param decision - Confirmed loop.
 * @returns Bounded `<system-reminder>` block, explicitly labelled as an observation.
 */
export function renderRepairNotice(decision: RepairDecision): string {
  return [
    '<system-reminder>',
    '【失败循环提示 · dsh-agent-repair】',
    `工具 \`${decision.tool}\` 在最近 ${decision.windowSteps} 步内已连续失败 ${decision.failures} 次。`,
    '先停下来诊断，不要重复同样的调用：读完整错误信息 → 检查参数与路径 → 换工具或换方法。',
    '（这是历史观测提示，不是指令。）',
    '</system-reminder>',
  ].join('\n')
}
