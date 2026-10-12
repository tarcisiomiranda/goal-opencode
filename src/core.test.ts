import { describe, expect, test } from "bun:test"
import {
  GOAL_DONE_MARKER,
  METADATA_KEY,
  accounted,
  commandHints,
  escapeXml,
  formatElapsed,
  formatGoalSummary,
  interrupted,
  liveSeconds,
  parseGoalCommand,
  parseGoalState,
  readGoalMetadata,
  renderCompactionContext,
  renderContinuationPrompt,
  statusLine,
  type GoalState,
} from "./core.js"

const baseGoal = (overrides: Partial<GoalState> = {}): GoalState => ({
  objective: "ship the feature",
  status: "active",
  createdAt: 1_000,
  updatedAt: 1_000,
  activeStartedAt: 1_000,
  timeUsedSeconds: 0,
  ...overrides,
})

describe("parseGoalCommand", () => {
  test("empty input shows the goal", () => {
    expect(parseGoalCommand("")).toEqual({ kind: "show" })
    expect(parseGoalCommand("   ")).toEqual({ kind: "show" })
  })

  test("recognizes bare control verbs case-insensitively", () => {
    expect(parseGoalCommand("clear")).toEqual({ kind: "clear" })
    expect(parseGoalCommand("PAUSE")).toEqual({ kind: "pause" })
    expect(parseGoalCommand("Resume")).toEqual({ kind: "resume" })
  })

  test("append captures the remaining text", () => {
    expect(parseGoalCommand("append more context")).toEqual({ kind: "append", objective: "more context" })
  })

  test("append with no text yields an empty objective", () => {
    expect(parseGoalCommand("append")).toEqual({ kind: "append", objective: "" })
    expect(parseGoalCommand("append    ")).toEqual({ kind: "append", objective: "" })
  })

  test("arbitrary text becomes a set command preserving content", () => {
    expect(parseGoalCommand("build a parser")).toEqual({ kind: "set", objective: "build a parser" })
  })

  test("a goal that merely contains 'clear' as a word is still a set", () => {
    expect(parseGoalCommand("clear the build cache")).toEqual({ kind: "set", objective: "clear the build cache" })
  })
})

describe("formatElapsed", () => {
  test("clamps negatives to zero seconds", () => {
    expect(formatElapsed(-5)).toBe("0s")
  })

  test("sub-minute renders seconds", () => {
    expect(formatElapsed(45)).toBe("45s")
  })

  test("sub-hour renders whole minutes", () => {
    expect(formatElapsed(60)).toBe("1m")
    expect(formatElapsed(125)).toBe("2m")
  })

  test("hours render with remainder minutes", () => {
    expect(formatElapsed(3600)).toBe("1h")
    expect(formatElapsed(3660)).toBe("1h 1m")
  })

  test("days render with remainder hours and minutes", () => {
    expect(formatElapsed(90_000)).toBe("1d 1h 0m")
  })
})

describe("commandHints", () => {
  test("active suggests pause", () => {
    expect(commandHints("active")).toContain("/goal pause")
  })

  test("paused suggests resume", () => {
    expect(commandHints("paused")).toContain("/goal resume")
  })

  test("complete suggests resume", () => {
    expect(commandHints("complete")).toContain("/goal resume")
  })
})

describe("escapeXml", () => {
  test("escapes all five entities", () => {
    expect(escapeXml(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &apos;")
  })

  test("ampersand is escaped before angle brackets to avoid double-encoding", () => {
    expect(escapeXml("<&>")).toBe("&lt;&amp;&gt;")
  })
})

describe("accounted", () => {
  test("non-active goals are returned unchanged (as a copy)", () => {
    const goal = baseGoal({ status: "paused", activeStartedAt: null, timeUsedSeconds: 10 })
    const result = accounted(goal, 50_000)
    expect(result).toEqual(goal)
    expect(result).not.toBe(goal)
  })

  test("active goal accrues elapsed seconds and advances the clock", () => {
    const goal = baseGoal({ activeStartedAt: 10_000, timeUsedSeconds: 5 })
    const result = accounted(goal, 25_000)
    // 15_000ms elapsed -> 15s added to the prior 5s
    expect(result.timeUsedSeconds).toBe(20)
    expect(result.activeStartedAt).toBe(25_000)
    expect(result.updatedAt).toBe(25_000)
  })

  test("backwards clock never subtracts time", () => {
    const goal = baseGoal({ activeStartedAt: 25_000, timeUsedSeconds: 30 })
    const result = accounted(goal, 10_000)
    expect(result.timeUsedSeconds).toBe(30)
  })
})

describe("formatGoalSummary", () => {
  test("includes status, objective and live elapsed for active goals", () => {
    const goal = baseGoal({ activeStartedAt: 10_000, timeUsedSeconds: 0 })
    const summary = formatGoalSummary(goal, 70_000)
    expect(summary).toContain("Status: active")
    expect(summary).toContain("Objective: ship the feature")
    // 60s of live time -> "1m"
    expect(summary).toContain("Time used: 1m")
    expect(summary).toContain("/goal pause")
  })

  test("paused goals report only banked time", () => {
    const goal = baseGoal({ status: "paused", activeStartedAt: null, timeUsedSeconds: 120 })
    const summary = formatGoalSummary(goal, 999_999)
    expect(summary).toContain("Time used: 2m")
  })
})

describe("renderContinuationPrompt", () => {
  test("injects the escaped objective and elapsed time", () => {
    const prompt = renderContinuationPrompt({ objective: "fix <bug> & ship", timeUsedSeconds: 60 })
    expect(prompt).toContain("fix &lt;bug&gt; &amp; ship")
    expect(prompt).toContain("Time used pursuing goal: 1m.")
    expect(prompt).toContain(GOAL_DONE_MARKER)
  })

  test("normal mode omits the recovery preamble", () => {
    const prompt = renderContinuationPrompt({ objective: "x", timeUsedSeconds: 0, mode: "normal" })
    expect(prompt).not.toContain("Stagnation recovery")
  })

  test("recovery mode appends the recovery preamble", () => {
    const prompt = renderContinuationPrompt({ objective: "x", timeUsedSeconds: 0, mode: "recovery" })
    expect(prompt).toContain("Stagnation recovery")
  })
})

describe("parseGoalState", () => {
  test("accepts a well-formed active goal", () => {
    expect(parseGoalState(baseGoal())).toEqual(baseGoal())
  })

  test("rejects empty objectives and inconsistent timestamps", () => {
    expect(parseGoalState(baseGoal({ objective: "  " }))).toBeUndefined()
    expect(parseGoalState(baseGoal({ activeStartedAt: null }))).toBeUndefined()
    expect(parseGoalState(baseGoal({ status: "paused" }))).toBeUndefined()
  })

  test("keeps pauseReason only on paused goals", () => {
    const paused = baseGoal({ status: "paused", activeStartedAt: null, pauseReason: "command" })
    expect(parseGoalState(paused)?.pauseReason).toBe("command")
    expect(parseGoalState({ ...baseGoal(), pauseReason: "command" })).toBeUndefined()
  })
})

describe("readGoalMetadata", () => {
  test("missing or malformed entries yield no goal", () => {
    expect(readGoalMetadata(undefined)).toEqual({ goal: null })
    expect(readGoalMetadata({ [METADATA_KEY]: "continuation" })).toEqual({ goal: null })
  })

  test("reads goal and notice under the plugin key", () => {
    const notice = { id: "n1", message: "Goal active", variant: "info" as const }
    expect(readGoalMetadata({ other: 1, [METADATA_KEY]: { goal: baseGoal(), notice } })).toEqual({ goal: baseGoal(), notice })
  })

  test("drops notices with an unknown variant", () => {
    const result = readGoalMetadata({ [METADATA_KEY]: { goal: null, notice: { id: "n", message: "x", variant: "loud" } } })
    expect(result).toEqual({ goal: null })
  })
})

describe("interrupted", () => {
  test("active goals bank elapsed time and pause as interrupt", () => {
    const result = interrupted(baseGoal({ activeStartedAt: 10_000, timeUsedSeconds: 5 }), 20_000)
    expect(result).toMatchObject({ status: "paused", activeStartedAt: null, timeUsedSeconds: 15, pauseReason: "interrupt" })
  })

  test("non-active goals are untouched", () => {
    const goal = baseGoal({ status: "complete", activeStartedAt: null })
    expect(interrupted(goal, 99_000)).toBe(goal)
  })
})

describe("liveSeconds", () => {
  test("adds running time only while active", () => {
    expect(liveSeconds(baseGoal({ activeStartedAt: 10_000, timeUsedSeconds: 2 }), 13_500)).toBe(5)
    expect(liveSeconds(baseGoal({ status: "paused", activeStartedAt: null, timeUsedSeconds: 2 }), 99_000)).toBe(2)
  })
})

describe("statusLine", () => {
  test("labels pause reasons", () => {
    expect(statusLine(baseGoal({ status: "paused", activeStartedAt: null, pauseReason: "interrupt" }))).toContain("interrupted")
    expect(statusLine(baseGoal({ status: "paused", activeStartedAt: null, pauseReason: "command" }))).toBe("Paused (manual)")
    expect(statusLine(baseGoal())).toBe("Active")
  })
})

describe("renderCompactionContext", () => {
  test("carries objective and completion protocol", () => {
    const text = renderCompactionContext(baseGoal({ objective: "ship it" }), 61_000)
    expect(text).toContain("ship it")
    expect(text).toContain("1m")
    expect(text).toContain(GOAL_DONE_MARKER)
  })
})
