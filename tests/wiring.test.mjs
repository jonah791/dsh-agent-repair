/**
 * 壳层契约测试（不启动宿主，直接 import 编译产物）
 * 运行：先 build（tsc）再 node --test tests/wiring.test.mjs
 *
 * 覆盖 docs/semantic.md §7 的 A6（观测不反噬）与 §5 契约的归一化要求：
 *   - shapeOutcome：宿主形状不可信，畸形输入一律 null 且不抛（§5.24）
 *   - traceLine：落盘失败返回 false，绝不回抛（§5.22 规则 3）
 *   - resolveTracePath：DSH_HOME 优先
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveTracePath, shapeOutcome, traceLine } from '../lib/index.js'

describe('shapeOutcome · 宿主形状归一', () => {
  test('完整形状 → 归一成功', () => {
    const r = shapeOutcome({ name: 'read', agent: { session: { id: 's1' } } }, { isError: true })
    assert.deepEqual(r, { sessionId: 's1', tool: 'read', isError: true })
  })

  test('缺 name / 缺 session / 空值 → null 且不抛', () => {
    assert.equal(shapeOutcome({}, {}), null)
    assert.equal(shapeOutcome(undefined, undefined), null)
    assert.equal(shapeOutcome({ name: 'read' }, {}), null)
    assert.equal(shapeOutcome({ agent: { session: { id: 's' } } }, {}), null)
    assert.doesNotThrow(() => shapeOutcome(null, null))
  })

  test('isError 非布尔 true 一律视为成功', () => {
    const exec = { name: 'read', agent: { session: { id: 's' } } }
    assert.equal(shapeOutcome(exec, { isError: 'yes' })?.isError, false)
    assert.equal(shapeOutcome(exec, {})?.isError, false)
  })
})

describe('traceLine · 观测不反噬（A6）', () => {
  test('不可写路径 → 返回 false 且不抛', () => {
    const bad = join(tmpdir(), 'no-such-dir-' + Date.now(), 'x.jsonl')
    let ok = null
    assert.doesNotThrow(() => {
      ok = traceLine(bad, 'probe')
    })
    assert.equal(ok, false)
  })

  test('可写路径 → true 且落一行可解析 JSON', () => {
    const path = join(tmpdir(), `repair-trace-${Date.now()}.jsonl`)
    assert.equal(traceLine(path, 'notice injected: tool=read failures=3 step=10'), true)
    const line = readFileSync(path, 'utf8').trim()
    const obj = JSON.parse(line)
    assert.equal(obj.plugin, 'agent-repair')
    assert.match(obj.note, /failures=3/)
    assert.match(obj.at, /^\d{4}-\d{2}-\d{2}T/)
    rmSync(path, { force: true })
  })
})

describe('resolveTracePath · 路径解析', () => {
  test('DSH_HOME 优先', () => {
    const home = '/tmp/dsh-home-probe'
    assert.equal(resolveTracePath({ DSH_HOME: home }), join(home, 'repair-trace.jsonl'))
  })

  test('无 DSH_HOME → 回退 ~/.dsh', () => {
    const p = resolveTracePath({})
    assert.match(p, /\.dsh[\\/]repair-trace\.jsonl$/)
  })
})
