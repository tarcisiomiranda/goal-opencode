import type { Plugin } from "@opencode/plugin"
import {
  CONTINUE_DESCRIPTION,
  CONTINUE_TEXT,
  GOAL_DONE_MARKER,
  METADATA_KEY,
  NO_GOAL,
  accounted,
  commandHints,
  formatElapsed,
  formatGoalSummary,
  interrupted,
  parseGoalCommand,
  readGoalMetadata,
  renderCompactionContext,
  renderContinuationPrompt,
  type ContinuationMode,
  type GoalNotice,
  type GoalPauseReason,
  type GoalState,
  type NoticeVariant,
} from "./core.js"

const START_DEBOUNCE_MS = 750
const RECOVERY_STAGNANT_CONTINUATIONS = 2
const STAGNANT_HARD_CAP = 3
const TOOL_NAME = "update_goal"

type Op = { kind: "set" | "append"; objective: string } | { kind: "clear" | "resume" | "complete" } | { kind: "pause"; reason?: GoalPauseReason }
type Result = { ok: true; message: string; goal: GoalState | null } | { ok: false; message: string }
type Run = { startedAt: number; tools: number }
type Delivery = "steer" | "queue"
type Event = { type?: string; data?: Record<string, any>; location?: { directory?: string; workspaceID?: string } }
type State = {
  goals: Map<string, GoalState | null>
  runs: Map<string, Run>
  stagnant: Map<string, number>
  halted: Set<string>
  lastStarted: Map<string, number>
}

const REGISTRY = Symbol.for("goal-opencode.state")
const STOP_WAIT_MS = 1000

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

const debug = process.env.GOAL_OPENCODE_DEBUG ? (...parts: unknown[]) => console.error("[goal-opencode]", ...parts) : () => undefined

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

const withSummary = (message: string, goal: GoalState | null) => (goal ? `${message}\n\n${formatGoalSummary(goal)}` : message)

function commandArguments(text: string): string {
  return text.replace(/^\s*\/goal\b/i, "").trim()
}

async function setup(ctx: Plugin.Context) {
  debug("setup", ctx.location?.directory, ctx.location?.workspaceID ?? "")
  const registry: Map<string, State> = ((globalThis as any)[REGISTRY] ??= new Map())
  const key = `${ctx.location?.directory ?? ""}\0${ctx.location?.workspaceID ?? ""}`
  const state: State = registry.get(key) ?? {
    goals: new Map(),
    runs: new Map(),
    stagnant: new Map(),
    halted: new Set(),
    lastStarted: new Map(),
  }
  registry.set(key, state)
  const { goals, runs, stagnant, halted, lastStarted } = state
  const writes = new Map<string, Promise<void>>()
  let noticeSeq = 0

  const notice = (message: string, variant: NoticeVariant): GoalNotice => ({
    id: `${Date.now().toString(36)}-${(noticeSeq++).toString(36)}`,
    message,
    variant,
  })

  const persist = (sessionID: string, goal: GoalState | null, note?: GoalNotice) => {
    const previous = writes.get(sessionID) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const info = await ctx.session.get({ sessionID })
        const current = isRecord(info.metadata) ? info.metadata : {}
        const entry = note ? { goal, notice: note } : { goal }
        await ctx.session.update({ sessionID, metadata: { ...current, [METADATA_KEY]: entry } as any })
      })
    writes.set(sessionID, next)
    return next.catch((error) => console.error(`[goal-opencode] could not save goal for ${sessionID}: ${errorText(error)}`))
  }

  const notify = (sessionID: string, message: string, variant: NoticeVariant = "info") =>
    persist(sessionID, goals.get(sessionID) ?? null, notice(message, variant))

  const load = async (sessionID: string): Promise<GoalState | null> => {
    if (goals.has(sessionID)) return goals.get(sessionID) ?? null
    const info = await ctx.session.get({ sessionID }).catch(() => undefined)
    const stored = readGoalMetadata(info?.metadata).goal
    if (goals.has(sessionID)) return goals.get(sessionID) ?? null
    if (stored?.status === "active") {
      const demoted = interrupted(stored)
      goals.set(sessionID, demoted)
      await persist(sessionID, demoted)
      return demoted
    }
    goals.set(sessionID, stored)
    return stored
  }

  const resetLoop = (sessionID: string) => {
    runs.delete(sessionID)
    stagnant.delete(sessionID)
    halted.delete(sessionID)
  }

  const mutate = async (sessionID: string, op: Op, now = Date.now()): Promise<Result> => {
    const goal = await load(sessionID)
    const fail = (message: string): Result => ({ ok: false, message })
    const save = (message: string, next: GoalState | null): Result => {
      goals.set(sessionID, next)
      return { ok: true, message, goal: next }
    }
    const activate = (current: GoalState, objective = current.objective): GoalState => {
      const next: GoalState = {
        ...current,
        objective,
        status: "active",
        activeStartedAt: current.status === "active" ? current.activeStartedAt : now,
        updatedAt: now,
      }
      delete next.pauseReason
      return next
    }

    switch (op.kind) {
      case "set": {
        const objective = op.objective.trim()
        if (!objective) return fail("Usage: /goal <objective>")
        const fresh = !goal || goal.status === "complete"
        return save(
          goal ? "Goal updated" : "Goal active",
          fresh ? { objective, status: "active", createdAt: now, updatedAt: now, activeStartedAt: now, timeUsedSeconds: 0 } : activate(goal, objective),
        )
      }
      case "append": {
        const addition = op.objective.trim()
        if (!addition) return fail("Usage: /goal append <text>")
        if (!goal) return fail("No goal to append")
        return save("Goal appended", activate(goal, `${goal.objective}\n${addition}`))
      }
      case "clear":
        if (!goal) return fail("No goal to clear")
        return save("Goal cleared", null)
      case "pause":
        if (!goal) return fail("No goal to pause")
        if (goal.status !== "active") return fail(`Goal is ${goal.status}`)
        return save("Goal paused", { ...accounted(goal, now), status: "paused", activeStartedAt: null, updatedAt: now, pauseReason: op.reason ?? "command" })
      case "resume":
        if (!goal) return fail("No goal to resume")
        if (goal.status === "active") return fail("Goal is active")
        return save("Goal active", activate(goal))
      case "complete": {
        if (!goal) return fail("No active goal to complete")
        if (goal.status === "complete") return save("Goal already complete", goal)
        const next: GoalState = { ...accounted(goal, now), status: "complete", activeStartedAt: null, updatedAt: now }
        delete next.pauseReason
        return save("Goal complete", next)
      }
    }
  }

  const continueGoal = async (sessionID: string, options: { force?: boolean; delivery?: Delivery; description?: string } = {}) => {
    const now = Date.now()
    if (runs.has(sessionID)) return
    if (!options.force && now - (lastStarted.get(sessionID) ?? 0) < START_DEBOUNCE_MS) return
    const goal = await load(sessionID)
    if (!goal || goal.status !== "active") return
    const info = await ctx.session.get({ sessionID }).catch(() => undefined)
    if (typeof info?.agent === "string" && info.agent.toLowerCase() === "plan") {
      await notify(sessionID, "Goal continuation skipped in plan mode")
      return
    }
    if (runs.has(sessionID)) return
    debug("continue", sessionID, options.description ?? CONTINUE_DESCRIPTION)
    runs.set(sessionID, { startedAt: now, tools: 0 })
    lastStarted.set(sessionID, now)
    await ctx.session
      .synthetic({
        sessionID,
        text: CONTINUE_TEXT,
        description: options.description ?? CONTINUE_DESCRIPTION,
        metadata: { [METADATA_KEY]: "continuation" },
        ...(options.delivery ? { delivery: options.delivery } : {}),
        resume: true,
      })
      .catch(async (error) => {
        runs.delete(sessionID)
        await notify(sessionID, `Goal continuation failed: ${errorText(error)}`, "error")
      })
  }

  const pauseForInterrupt = async (sessionID: string, message: string, variant: NoticeVariant) => {
    const goal = await load(sessionID)
    if (goal?.status !== "active") return
    const result = await mutate(sessionID, { kind: "pause", reason: "interrupt" })
    if (result.ok) await persist(sessionID, result.goal, notice(withSummary(message, result.goal), variant))
  }

  const onIdle = async (sessionID: string) => {
    const run = runs.get(sessionID)
    runs.delete(sessionID)
    if (halted.has(sessionID)) return debug("idle skipped: halted", sessionID)
    const goal = await load(sessionID)
    debug("idle", sessionID, goal?.status, run ? `run tools=${run.tools}` : "no run")
    if (!goal || goal.status !== "active") return
    if (run) {
      if (run.tools > 0) stagnant.delete(sessionID)
      else {
        const stops = (stagnant.get(sessionID) ?? 0) + 1
        stagnant.set(sessionID, stops)
        if (stops >= STAGNANT_HARD_CAP) {
          stagnant.delete(sessionID)
          const result = await mutate(sessionID, { kind: "pause", reason: "command" })
          if (result.ok) {
            await persist(sessionID, result.goal, notice(`Goal stalled after ${STAGNANT_HARD_CAP} idle continuations, paused. Use /goal resume to retry.`, "warning"))
          }
          return
        }
      }
    }
    await continueGoal(sessionID, { force: !!run })
  }

  const onTextEnded = async (sessionID: string, text: unknown) => {
    if (typeof text !== "string" || !text.includes(GOAL_DONE_MARKER)) return
    const goal = await load(sessionID)
    if (goal?.status !== "complete") return
    const result = await mutate(sessionID, { kind: "clear" })
    resetLoop(sessionID)
    if (result.ok) await persist(sessionID, null, notice("Goal cleared (GOAL_DONE detected)", "success"))
  }

  const ownsLocation = (event: Event) => {
    const here = ctx.location
    const there = event.location
    if (!here?.directory || !there?.directory) return true
    if (there.directory !== here.directory) return false
    return !here.workspaceID || !there.workspaceID || here.workspaceID === there.workspaceID
  }

  const onEvent = (event: Event) => {
    const data = isRecord(event.data) ? event.data : undefined
    const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined
    if (!sessionID || !ownsLocation(event)) return
    if (event.type?.startsWith("session.") && !event.type.includes("delta")) debug("event", event.type, sessionID)

    switch (event.type) {
      case "session.tool.called": {
        const run = runs.get(sessionID)
        if (run) run.tools++
        return
      }
      case "session.execution.succeeded":
        return onIdle(sessionID)
      case "session.text.ended":
        return onTextEnded(sessionID, data?.text)
      case "session.execution.interrupted": {
        const reason = data?.reason
        if (reason === "superseded") return
        runs.delete(sessionID)
        halted.add(sessionID)
        return pauseForInterrupt(sessionID, "Goal paused after interrupt (next user message resumes)", "info")
      }
      case "session.execution.failed": {
        runs.delete(sessionID)
        halted.add(sessionID)
        const error = isRecord(data?.error) && typeof data.error.message === "string" ? data.error.message : "execution failed"
        return pauseForInterrupt(sessionID, `Goal paused: ${error} (next user message resumes)`, "error")
      }
      case "session.deleted":
        goals.delete(sessionID)
        resetLoop(sessionID)
        writes.delete(sessionID)
        lastStarted.delete(sessionID)
        return
    }
  }

  const abort = new AbortController()
  const listening = (async () => {
    for await (const event of ctx.event.subscribe({ signal: abort.signal }) as AsyncIterable<Event>) {
      if (abort.signal.aborted) break
      Promise.resolve(onEvent(event)).catch((error) => console.error(`[goal-opencode] event ${event?.type} failed: ${errorText(error)}`))
    }
  })().catch((error) => {
    if (!abort.signal.aborted) console.error(`[goal-opencode] event stream stopped: ${errorText(error)}`)
  })

  const registrations = await Promise.all([
    ctx.command.transform((editor) => {
      editor.add({
        name: "goal",
        description: "set or view the goal for a long-running task",
        execute: async ({ sessionID, prompt, delivery }) => {
          const op = parseGoalCommand(commandArguments(prompt?.text ?? ""))
          if (op.kind === "show") {
            const goal = await load(sessionID)
            await notify(sessionID, goal ? formatGoalSummary(goal) : NO_GOAL)
            return
          }
          const result = await mutate(sessionID, op)
          if (!result.ok) {
            await notify(sessionID, result.message, "error")
            return
          }
          resetLoop(sessionID)
          const message = op.kind === "clear" ? `${result.message}\n${NO_GOAL}` : withSummary(result.message, result.goal)
          await persist(sessionID, result.goal, notice(message, "info"))
          if (op.kind === "set" || op.kind === "append" || op.kind === "resume") {
            await continueGoal(sessionID, { force: true, delivery, description: `Goal: ${result.goal?.objective.split("\n")[0].slice(0, 80)}` })
          }
        },
      })
    }),

    ctx.tool.transform((editor) => {
      editor.add({
        name: TOOL_NAME,
        description: "Mark the active /goal objective complete after verifying every requirement is satisfied.",
        input: {
          type: "object",
          properties: { status: { type: "string", enum: ["complete"] } },
          required: ["status"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (_input, context) => {
          const result = await mutate(context.sessionID, { kind: "complete" })
          if (!result.ok || !result.goal) return { content: result.message }
          runs.delete(context.sessionID)
          stagnant.delete(context.sessionID)
          await persist(context.sessionID, result.goal, notice(result.message, "success"))
          return {
            content: `${result.message}. Final elapsed time: ${formatElapsed(result.goal.timeUsedSeconds)}. ${commandHints(result.goal.status)}`,
          }
        },
      })
    }),

    ctx.session.hook("prompt", async (event) => {
      const sessionID = event.sessionID
      resetLoop(sessionID)
      const goal = await load(sessionID)
      if (goal?.status !== "paused" || goal.pauseReason !== "interrupt") return
      const result = await mutate(sessionID, { kind: "resume" })
      if (result.ok) await persist(sessionID, result.goal, notice("Goal resumed (next user message)", "info"))
    }),

    ctx.session.hook("context", async (event) => {
      const goal = await load(event.sessionID)
      if (!goal || goal.status !== "active") {
        delete event.tools[TOOL_NAME]
        return
      }
      const mode: ContinuationMode = (stagnant.get(event.sessionID) ?? 0) >= RECOVERY_STAGNANT_CONTINUATIONS ? "recovery" : "normal"
      const current = accounted(goal)
      event.system.push({ type: "text", text: renderContinuationPrompt({ objective: current.objective, timeUsedSeconds: current.timeUsedSeconds, mode }) } as any)
    }),

    ctx.session.hook("compaction", async (event) => {
      const goal = await load(event.sessionID)
      if (!goal || goal.status !== "active") return
      event.system.push({ type: "text", text: renderCompactionContext(goal) } as any)
    }),
  ])

  return async () => {
    abort.abort()
    await Promise.all(registrations.map((registration) => registration.dispose().catch(() => undefined)))
    await Promise.race([listening, new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS))])
    await Promise.all([...writes.values()].map((write) => write.catch(() => undefined)))
  }
}

export default {
  id: "goal-opencode",
  setup,
} satisfies Plugin.Plugin
