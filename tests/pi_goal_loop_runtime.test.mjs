import assert from "node:assert/strict"
import test from "node:test"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  BRIDGE_SCHEMA_VERSION,
  DEFAULT_RETRY_MINUTES,
  createBindingStore,
  createGoalLoop,
  sanitizedKey,
  waitPlan,
} from "../loopx/pi_goal_mode/pi-goal-loop-runtime.mjs"


function memoryBindingStore() {
  const bindings = new Map()
  return {
    bindings,
    async read(key) {
      return bindings.get(key) || null
    },
    async write(key, changes) {
      const current = bindings.get(key) || {}
      const value = {
        schemaVersion: BRIDGE_SCHEMA_VERSION,
        sessionKey: key,
        directory: "/workspace",
        goalId: "",
        agentId: "",
        registryPath: "",
        availableCapabilities: [],
        taskBody: "",
        autoResume: true,
        terminal: false,
        schedulerToken: "",
        unchangedPolls: 0,
        lastInjectedPrompt: "",
        ...current,
        ...changes,
      }
      bindings.set(key, value)
      return value
    },
    async remove(key) {
      bindings.delete(key)
    },
  }
}


function terminalDecision() {
  return {
    should_run: false,
    effective_action: "terminal_no_followup",
    reason: "validated closure",
    goal_frontier_projection: {
      terminal_state: {
        schema_version: "goal_terminal_state_v0",
        kind: "no_followup",
        derived: true,
        source: "validated_goal_closure",
      },
      source_completeness: {
        schema_version: "goal_terminal_source_completeness_v0",
        user_todos: "valid",
        agent_todos: "valid",
      },
    },
  }
}


function backoffDecision() {
  return {
    should_run: false,
    scheduler_hint: {
      action: "backoff_waiting_for_user",
      reset_policy: { reset_token: "wait-1" },
      unchanged_poll: {
        local_scheduler: {
          recommended_interval_minutes: 3,
          example_progression_minutes: [3, 6, 12],
          unchanged_poll_limit: 3,
        },
      },
    },
  }
}


function harness(initialDecision) {
  const store = memoryBindingStore()
  const calls = { send: 0, quota: 0, notify: 0, messages: [] }
  const scheduled = []
  let decision = initialDecision
  const loop = createGoalLoop({
    quotaProbe: async () => {
      calls.quota += 1
      if (decision instanceof Error) throw decision
      return decision
    },
    sendMessage: (prompt) => {
      calls.send += 1
      calls.messages.push(prompt)
    },
    setTimer: (callback, delayMs) => {
      const timer = { callback, cleared: false, delayMs }
      scheduled.push(timer)
      return timer
    },
    clearTimer: (timer) => {
      timer.cleared = true
    },
  })
  const services = {
    store,
    isIdle: () => true,
    notify: () => {
      calls.notify += 1
    },
  }
  const activate = async (key, overrides = {}) =>
    loop.activate(key, {
      goalId: `goal-${key}`,
      taskBody: "LoopX task body",
      autoResume: true,
      terminal: false,
      ...overrides,
    })
  return {
    calls,
    loop,
    scheduled,
    services,
    store,
    activate,
    setDecision(value) {
      decision = value
    },
  }
}


test("run_now injects the heartbeat task body exactly once", async () => {
  const fixture = harness({ should_run: true, scheduler_hint: { action: "run_now" } })
  fixture.loop.bind("session-1", fixture.services)
  await fixture.activate("session-1")
  await fixture.loop.settle("session-1")

  assert.equal(fixture.calls.quota, 1)
  assert.equal(fixture.calls.send, 1)
  assert.equal(fixture.calls.messages[0], "LoopX task body")
  assert.equal(fixture.scheduled.length, 0)
  const binding = await fixture.store.read("session-1")
  assert.equal(binding.lastInjectedPrompt, "LoopX task body")
  assert.equal(binding.autoResume, true)
})


test("validated terminal no-follow-up stops and notifies without a message", async () => {
  const fixture = harness(terminalDecision())
  fixture.loop.bind("session-terminal", fixture.services)
  await fixture.activate("session-terminal")
  const notifyAfterActivate = fixture.calls.notify
  await fixture.loop.settle("session-terminal")

  assert.equal(fixture.calls.quota, 1)
  assert.equal(fixture.calls.send, 0)
  assert.equal(fixture.calls.notify, notifyAfterActivate + 1)
  assert.equal(fixture.scheduled.length, 0)
  const binding = await fixture.store.read("session-terminal")
  assert.equal(binding.terminal, true)
  assert.equal(binding.autoResume, false)
})


test("backoff schedules a timer from the scheduler hint", async () => {
  const fixture = harness(backoffDecision())
  fixture.loop.bind("session-backoff", fixture.services)
  await fixture.activate("session-backoff")
  await fixture.loop.settle("session-backoff")

  assert.equal(fixture.calls.send, 0)
  assert.equal(fixture.scheduled.length, 1)
  assert.equal(fixture.scheduled[0].delayMs, 180_000)
  assert.equal(fixture.scheduled[0].cleared, false)
})


test("fails closed with a bounded retry after a quota probe failure", async () => {
  const fixture = harness(new Error("network timeout"))
  fixture.loop.bind("session-timeout", fixture.services)
  await fixture.activate("session-timeout")
  await fixture.loop.settle("session-timeout")

  assert.equal(fixture.calls.quota, 1)
  assert.equal(fixture.calls.send, 0)
  assert.equal(fixture.scheduled.length, 1)
  assert.equal(fixture.scheduled[0].delayMs, DEFAULT_RETRY_MINUTES * 60_000)
  assert.equal(fixture.scheduled[0].cleared, false)
})


test("a user-driven prompt pauses auto-resume and cancels the scheduled timer", async () => {
  const fixture = harness(backoffDecision())
  fixture.loop.bind("session-pause", fixture.services)
  await fixture.activate("session-pause")
  await fixture.loop.settle("session-pause")
  assert.equal(fixture.scheduled.length, 1)

  await fixture.loop.userPrompt("session-pause", "change direction")

  const binding = await fixture.store.read("session-pause")
  assert.equal(binding.autoResume, false)
  assert.equal(fixture.scheduled[0].cleared, true)

  const probesBefore = fixture.calls.quota
  await fixture.loop.settle("session-pause")
  assert.equal(fixture.calls.quota, probesBefore)
})


test("an injected follow-up prompt keeps auto-resume armed", async () => {
  const fixture = harness({ should_run: true, scheduler_hint: { action: "run_now" } })
  fixture.loop.bind("session-injected", fixture.services)
  await fixture.activate("session-injected")
  await fixture.loop.settle("session-injected")
  assert.equal(fixture.calls.send, 1)

  await fixture.loop.userPrompt("session-injected", "LoopX task body")

  const binding = await fixture.store.read("session-injected")
  assert.equal(binding.autoResume, true)
})


test("session_shutdown during an in-flight probe stops the old session", async () => {
  let releaseDecision
  const pendingDecision = new Promise((resolve) => {
    releaseDecision = resolve
  })
  const fixture = harness(pendingDecision)
  fixture.loop.bind("session-shutdown-in-flight", fixture.services)
  await fixture.activate("session-shutdown-in-flight")

  const settled = fixture.loop.settle("session-shutdown-in-flight")
  for (let index = 0; index < 5 && fixture.calls.quota === 0; index += 1) {
    await Promise.resolve()
  }
  assert.equal(fixture.calls.quota, 1)

  // session_shutdown atomically disposes the extension instance.
  fixture.loop.dispose()
  releaseDecision({ should_run: true, scheduler_hint: { action: "run_now" } })
  await settled

  // The in-flight probe returns to the disposed guard: no old task body is
  // sent and no timer is rescheduled past the boundary.
  assert.equal(fixture.calls.send, 0)
  assert.equal(fixture.scheduled.length, 0)
})


test("session_shutdown clears every scheduled timer", async () => {
  const fixture = harness(backoffDecision())
  for (const key of ["session-dispose-a", "session-dispose-b"]) {
    fixture.loop.bind(key, fixture.services)
    await fixture.activate(key)
    await fixture.loop.settle(key)
  }
  assert.equal(fixture.scheduled.length, 2)
  assert.equal(fixture.scheduled.every((timer) => timer.cleared), false)

  fixture.loop.dispose()

  assert.equal(fixture.scheduled.every((timer) => timer.cleared), true)
})


test("user intervention during an in-flight probe stops continuation", async () => {
  let releaseDecision
  const pendingDecision = new Promise((resolve) => {
    releaseDecision = resolve
  })
  const fixture = harness(pendingDecision)
  fixture.loop.bind("session-intervention", fixture.services)
  await fixture.activate("session-intervention")
  const settled = fixture.loop.settle("session-intervention")
  for (let index = 0; index < 5 && fixture.calls.quota === 0; index += 1) {
    await Promise.resolve()
  }
  assert.equal(fixture.calls.quota, 1)

  await fixture.loop.userPrompt("session-intervention", "change direction")
  releaseDecision({ should_run: true, scheduler_hint: { action: "run_now" } })
  await settled

  assert.equal(fixture.calls.send, 0)
  assert.equal((await fixture.store.read("session-intervention")).autoResume, false)
})


test("coalesces concurrent settles into one quota decision", async () => {
  let releaseDecision
  const pendingDecision = new Promise((resolve) => {
    releaseDecision = resolve
  })
  const fixture = harness(pendingDecision)
  fixture.loop.bind("session-coalesced", fixture.services)
  await fixture.activate("session-coalesced")
  const first = fixture.loop.settle("session-coalesced")
  const second = fixture.loop.settle("session-coalesced")
  releaseDecision({ should_run: true, scheduler_hint: { action: "run_now" } })
  await Promise.all([first, second])

  assert.equal(fixture.calls.quota, 1)
  assert.equal(fixture.calls.send, 1)
})


test("wait plan stops at the unchanged-poll limit", () => {
  const binding = {
    schedulerToken: "wait-1",
    unchangedPolls: 3,
  }
  const plan = waitPlan(backoffDecision(), binding)
  assert.equal(plan.stop, true)
  assert.equal(plan.minutes, DEFAULT_RETRY_MINUTES)
})


test("wait plan advances the progression while under the limit", () => {
  const binding = {
    schedulerToken: "wait-1",
    unchangedPolls: 1,
  }
  const plan = waitPlan(backoffDecision(), binding)
  assert.equal(plan.stop, false)
  assert.equal(plan.unchangedPolls, 2)
  assert.equal(plan.minutes, 6)
})


test("wait plan resets the unchanged count when the scheduler token changes", () => {
  const binding = {
    schedulerToken: "stale-token",
    unchangedPolls: 2,
  }
  const plan = waitPlan(backoffDecision(), binding)
  assert.equal(plan.stop, false)
  assert.equal(plan.unchangedPolls, 1)
})


test("binding store round-trips through the filesystem and retires cleanly", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-goal-loop-store-"))
  try {
    const store = createBindingStore(root)
    const key = sanitizedKey("session / weird*name")

    assert.equal(await store.read(key), null)
    const written = await store.write(key, { goalId: "goal-store", taskBody: "body" })
    assert.equal(written.schemaVersion, BRIDGE_SCHEMA_VERSION)
    assert.equal(written.sessionKey, key)
    assert.equal(written.goalId, "goal-store")
    assert.equal(written.autoResume, true)

    const read = await store.read(key)
    assert.equal(read.taskBody, "body")
    assert.equal(read.directory, root)

    await store.remove(key)
    assert.equal(await store.read(key), null)
    await store.remove(key)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})


test("sanitized key is stable and bounded", () => {
  assert.equal(sanitizedKey("simple"), "simple")
  assert.equal(sanitizedKey(null), "session")
  assert.equal(sanitizedKey("a/b:c d"), "a_b_c_d")
  assert.equal(sanitizedKey("x".repeat(400)).length, 160)
})
