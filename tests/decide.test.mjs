/**
 * decide 纯判定层离线单测（失败循环触发语义）
 * 运行：先 build（tsc）再 node --test tests/decide.test.mjs
 *
 * 判据对应 docs/semantic.md §7：
 *   A1 尸体样本：窗口内同工具失败 3 次且无成功 ⇒ 触发
 *   A2 反例：成功重置连败 ⇒ 不触发
 *   A3 对照组：无失败 ⇒ 零触发
 *   A4 窗口有界：连败跨越窗口 ⇒ 不触发
 *   A5 冷却：注入后冷却期内不重复触发
 *   A6 健壮性：畸形输入不抛异常
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REPAIR_DEFAULTS,
  appendEvent,
  decideRepair,
  renderRepairNotice,
} from '../lib/decide.js'

const STEP = 10 // 当前步

describe('decideRepair · 失败循环触发', () => {
  test('A1 尸体样本：同工具连续失败 3 次（窗口内）→ 触发', () => {
    const events = [
      { step: 8, isError: true },
      { step: 9, isError: true },
      { step: 10, isError: true },
    ]
    const hit = decideRepair('read', events, STEP, undefined)
    assert.ok(hit !== null, '3 连败应触发')
    assert.equal(hit.tool, 'read')
    assert.equal(hit.failures, 3)
  })

  test('A2 反例：中间有一次成功 → 成功重置连败，不触发', () => {
    const events = [
      { step: 7, isError: true },
      { step: 8, isError: true },
      { step: 9, isError: false }, // 成功重置
      { step: 10, isError: true },
    ]
    const hit = decideRepair('read', events, STEP, undefined)
    assert.equal(hit, null, '成功后的连败只有 1 次，不应触发')
  })

  test('A2b 反例边界：成功之后恰好又有 3 连败 → 重新触发', () => {
    const events = [
      { step: 5, isError: true },
      { step: 6, isError: true },
      { step: 7, isError: false },
      { step: 8, isError: true },
      { step: 9, isError: true },
      { step: 10, isError: true },
    ]
    const hit = decideRepair('read', events, STEP, undefined)
    assert.ok(hit !== null, '重置后的 3 连败应触发')
    assert.equal(hit.failures, 3)
  })

  test('A3 对照组：只有失败 2 次 → 不触发（未达阈值）', () => {
    const events = [
      { step: 9, isError: true },
      { step: 10, isError: true },
    ]
    assert.equal(decideRepair('read', events, STEP, undefined), null)
  })

  test('A3b 对照组：零事件 / 全成功 → 不触发', () => {
    assert.equal(decideRepair('read', [], STEP, undefined), null)
    const ok = [
      { step: 9, isError: false },
      { step: 10, isError: false },
    ]
    assert.equal(decideRepair('read', ok, STEP, undefined), null)
  })

  test('A4 窗口有界：3 连败但最早的已滑出窗口 → 不触发', () => {
    // windowSteps=5 ⇒ 窗口 = [6, 10]；step 3/4 在窗口外
    const events = [
      { step: 3, isError: true },
      { step: 4, isError: true },
      { step: 6, isError: true },
      { step: 7, isError: true },
    ]
    // 窗口内只有 step 6/7 两次失败 ⇒ 不触发
    assert.equal(decideRepair('read', events, STEP, undefined), null)
  })

  test('A5 冷却：上次注入后未满 cooldownSteps → 不重复触发', () => {
    const events = [
      { step: 8, isError: true },
      { step: 9, isError: true },
      { step: 10, isError: true },
    ]
    // 冷却缺省 8 步：上次注入在 step 9 ⇒ 差距 1 < 8
    assert.equal(decideRepair('read', events, STEP, 9), null)
    // 超过冷却 ⇒ 恢复触发
    assert.ok(decideRepair('read', events, STEP, 2) !== null)
  })

  test('A6 健壮性：畸形输入不抛异常', () => {
    assert.equal(decideRepair('read', [], Number.NaN, undefined), null)
    assert.equal(decideRepair('read', [{ step: Number.NaN, isError: true }], STEP, undefined), null)
    assert.doesNotThrow(() => decideRepair('read', [{ step: 9, isError: true }], STEP, undefined))
  })

  test('自定义策略：阈值 2 / 窗口 3 生效', () => {
    const policy = { failureThreshold: 2, windowSteps: 3, cooldownSteps: 5 }
    const events = [
      { step: 9, isError: true },
      { step: 10, isError: true },
    ]
    const hit = decideRepair('bash', events, STEP, undefined, policy)
    assert.ok(hit !== null)
    assert.equal(hit.windowSteps, 3)
  })
})

describe('appendEvent · 有界历史', () => {
  test('超过上限时丢最旧', () => {
    let events = []
    for (let i = 0; i < 5; i += 1) events = appendEvent(events, { step: i, isError: true }, 3)
    assert.equal(events.length, 3)
    assert.deepEqual(events.map((e) => e.step), [2, 3, 4])
  })

  test('不修改输入数组', () => {
    const base = [{ step: 1, isError: false }]
    const next = appendEvent(base, { step: 2, isError: true }, 32)
    assert.equal(base.length, 1)
    assert.equal(next.length, 2)
  })
})

describe('renderRepairNotice · 注入文本', () => {
  test('含工具名、失败数与"非指令"标注', () => {
    const text = renderRepairNotice({ tool: 'read', failures: 3, windowSteps: 5 })
    assert.match(text, /read/)
    assert.match(text, /3/)
    assert.match(text, /不是指令/)
    assert.match(text, /^<system-reminder>/)
  })
})
