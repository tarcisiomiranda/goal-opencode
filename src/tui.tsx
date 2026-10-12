import type { Plugin } from "@opencode/plugin/tui"
import { createSignal, onCleanup, Show } from "solid-js"
import { formatGoalSummary, liveSeconds, readGoalMetadata, statusLine, type GoalState } from "./core.js"

type Context = Plugin.Context

const OBJECTIVE_PREVIEW = 200

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
  return `${m}:${String(s).padStart(2, "0")}`
}

const goalOf = (ctx: Context, sessionID: string): GoalState | null => readGoalMetadata(ctx.data.session.get(sessionID)?.metadata).goal

function statusColor(ctx: Context, goal: GoalState) {
  const feedback = ctx.theme.text.feedback
  if (goal.status === "complete") return feedback.success.muted
  if (goal.status === "paused") return goal.pauseReason === "interrupt" ? feedback.info.base : feedback.warning.base
  return feedback.success.base
}

function GoalSidebar(props: { ctx: Context; sessionID: string }) {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))

  const goal = () => {
    now()
    return goalOf(props.ctx, props.sessionID)
  }

  return (
    <Show when={goal()}>
      {(current) => (
        <box flexDirection="column" marginTop={1}>
          <text fg={props.ctx.theme.text.base}>
            <b>🎯 Goal</b>
          </text>
          <text fg={props.ctx.theme.text.muted}>
            {current().objective.slice(0, OBJECTIVE_PREVIEW)}
            {current().objective.length > OBJECTIVE_PREVIEW ? "…" : ""}
          </text>
          <text fg={statusColor(props.ctx, current())}>● {statusLine(current())}</text>
          <text fg={props.ctx.theme.text.muted}>⏱ {formatDuration(liveSeconds(current(), now()))}</text>
        </box>
      )}
    </Show>
  )
}

function setup(ctx: Context) {
  const removeSlot = ctx.ui.slot({
    append: "sidebar.content",
    render: (input) => <GoalSidebar ctx={ctx} sessionID={input.sessionID} />,
  })

  const seen = new Map<string, string>()
  const stopNotices = ctx.data.on("session.metadata.updated", (event) => {
    const { sessionID, metadata } = event.data
    const note = readGoalMetadata(metadata).notice
    if (!note || seen.get(sessionID) === note.id) return
    seen.set(sessionID, note.id)
    ctx.ui.toast.show({ title: "Goal", message: note.message, variant: note.variant, duration: note.variant === "error" ? 8000 : 5000, sessionID })
  })

  const currentSession = () => {
    const route = ctx.ui.router.current()
    return route.type === "session" ? route.sessionID : undefined
  }

  const showGoal = () => {
    const sessionID = currentSession()
    if (!sessionID) return
    const goal = goalOf(ctx, sessionID)
    if (!goal) {
      ctx.ui.toast.show({ title: "Goal", message: "No goal set for this session.", variant: "info", duration: 3000 })
      return
    }
    void ctx.ui.dialog.alert({ title: "🎯 Goal", message: formatGoalSummary(goal) })
  }

  ctx.keymap.layer(() => ({
    commands: [
      {
        id: "goal.show",
        title: "Goal",
        description: "Show the active goal for the current session",
        group: "Goal",
        palette: true,
        enabled: () => currentSession() !== undefined,
        run: () => showGoal(),
      },
    ],
  }))

  return () => {
    stopNotices()
    removeSlot()
  }
}

export default {
  id: "goal-opencode.tui",
  setup,
} satisfies Plugin.Definition
