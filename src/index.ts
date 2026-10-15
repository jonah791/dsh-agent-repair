/**
 * @module dsh-agent-repair
 * Failure-loop detection with a next-step repair notice, adapted from MemOS
 * `decision-repair` (V7 §2.4.6).
 *
 * Observes `tools/result`, keeps a per-session per-tool step window, and
 * appends at most one bounded notice on the next `agent/pre-step` when a tool
 * enters a failure streak. The notice never interrupts the in-flight step.
 *
 * Fail-open (§5.24): every host callback is wrapped, so no error here can
 * change the original pre-step decision or interrupt the session.
 */
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// 类型 merge：空导入即触发 Events 扩展——缺任一行，ctx.on 的事件名不被 Events 接受
// （tools/result ← dsh-tools；agent/pre-step ← dsh-agent，与 dsh-agent-emotion 同法）
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  MAX_EVENTS_PER_TOOL_DEFAULT,
  REPAIR_DEFAULTS,
  appendEvent,
  decideRepair,
  renderRepairNotice,
  type ToolEvent,
} from './decide.ts'

export const name = 'agent-repair'
export const inject = ['tools', 'agents'] as const

export interface Config {
  enabled: boolean
  failureThreshold: number
  windowSteps: number
  cooldownSteps: number
  maxEventsPerTool: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  failureThreshold: z.number().default(REPAIR_DEFAULTS.failureThreshold),
  windowSteps: z.number().default(REPAIR_DEFAULTS.windowSteps),
  cooldownSteps: z.number().default(REPAIR_DEFAULTS.cooldownSteps),
  maxEventsPerTool: z.number().default(MAX_EVENTS_PER_TOOL_DEFAULT),
})

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-agent-repair': { kind: 'dsh-agent-repair' }
  }
}

/** Per-session observation state (memory only; no conversation content is persisted). */
interface SessionState {
  currentStep: number
  events: Map<string, ToolEvent[]>
  lastInjectStep: Map<string, number>
}

/** Normalised shape of one `tools/result` delivery; `null` when unusable. */
export interface ToolOutcome {
  sessionId: string
  tool: string
  isError: boolean
}

/**
 * Normalise the host's `exec` / `result` pair without trusting its shape
 * (§5.24: external objects are shaped first, never indexed blindly).
 * @param exec - Tool execution record.
 * @param result - Tool result record.
 * @returns Normalised outcome, or `null` when the shapes are unusable.
 */
export function shapeOutcome(exec: unknown, result: unknown): ToolOutcome | null {
  const e = exec as { name?: unknown; agent?: { session?: { id?: unknown } } } | undefined
  const tool = e?.name
  const sessionId = e?.agent?.session?.id
  if (typeof tool !== 'string' || typeof sessionId !== 'string') return null
  const isError = (result as { isError?: unknown } | undefined)?.isError === true
  return { sessionId, tool, isError }
}

/** Sidecar trace path — mechanism self-evidence (§5.22), never a content store. */
export function resolveTracePath(env: NodeJS.ProcessEnv = process.env): string {
  const dshHome = env['DSH_HOME'] ?? join(homedir(), '.dsh')
  return join(dshHome, 'repair-trace.jsonl')
}

/**
 * Append one sidecar line. Observation must never bite back (§5.22 rule 3):
 * every failure is swallowed and reported as `false`, never rethrown.
 * @param path - Trace file path.
 * @param note - Short operational note.
 * @param now - Timestamp source (injectable for tests).
 * @returns `true` when the line was written.
 */
export function traceLine(path: string, note: string, now: Date = new Date()): boolean {
  try {
    appendFileSync(path, `${JSON.stringify({ at: now.toISOString(), plugin: 'agent-repair', note })}\n`)
    return true
  } catch (e: unknown) {
    // 观测不反噬：吞错并返回 false，绝不回抛（异常逃逸会杀死宿主进程，§5.24）
    void e
    return false
  }
}

/**
 * Mount the repair loop.
 * @param ctx - Plugin context.
 * @param config - Validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const log = ctx.logger('agent-repair')
  const sessions = new Map<string, SessionState>()
  const tracePath = resolveTracePath()

  const stateOf = (sessionId: string): SessionState => {
    const existing = sessions.get(sessionId)
    if (existing !== undefined) return existing
    const fresh: SessionState = { currentStep: 0, events: new Map(), lastInjectStep: new Map() }
    sessions.set(sessionId, fresh)
    return fresh
  }

  /** Guarded wrapper: a throwing callback must never escape into the host. */
  const guarded = (stage: string, fn: () => void): void => {
    try {
      fn()
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e)
      traceLine(tracePath, `error in ${stage}: ${reason}`)
      log.warn('[agent-repair] ' + stage + ' 失败：' + reason)
    }
  }

  ctx.on('tools/result', (exec: unknown, result: unknown) => {
    if (!config.enabled) return
    guarded('tools/result', () => {
      const outcome = shapeOutcome(exec, result)
      if (outcome === null) return
      const state = stateOf(outcome.sessionId)
      const history = state.events.get(outcome.tool) ?? []
      state.events.set(
        outcome.tool,
        appendEvent(history, { step: state.currentStep, isError: outcome.isError }, config.maxEventsPerTool),
      )
    })
  })

  // pre-step 瀑布：await next() 后仅在尾部追加（缓存友好，与 dsh-agent-memory 同构）。
  // 2026-09-04 类型漂移注记（同 dsh-life-core）：事件重载后 TS 无法匹配监听器签名，
  // 故此处按既有先例用宽松签名，行为由契约测试与线上观测覆盖。
  ctx.on('agent/pre-step', (async (payload: any, next: any) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (!config.enabled) return decision

    let notice: string | null = null
    let tool = ''
    guarded('agent/pre-step', () => {
      const agent = payload?.agent
      const sessionId = agent?.session?.id
      const step = payload?.step
      if (typeof sessionId !== 'string' || !Number.isFinite(step)) return
      const state = stateOf(sessionId)
      state.currentStep = step

      const policy = {
        failureThreshold: config.failureThreshold,
        windowSteps: config.windowSteps,
        cooldownSteps: config.cooldownSteps,
      }
      for (const [name, events] of state.events) {
        const hit = decideRepair(name, events, step, state.lastInjectStep.get(name), policy)
        if (hit === null) continue
        state.lastInjectStep.set(name, step)
        notice = renderRepairNotice(hit)
        tool = name
        traceLine(tracePath, `notice injected: tool=${name} failures=${hit.failures} step=${step}`)
        break // 每步最多一条提示，避免刷屏
      }
    })

    if (notice === null) return decision
    payload?.signal?.throwIfAborted?.()
    const message = createUserMessage({
      content: [{ type: 'text', text: notice }],
      source: { kind: 'dsh-agent-repair' },
    })
    log.info('[agent-repair] 注入失败循环提示：' + tool)
    return { kind: 'enter', messages: [...decision.messages, message] }
  }))
}
