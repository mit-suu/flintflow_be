import { describe, it, expect } from "vitest"
import {
  IMPORT_STATUSES,
  IMPORT_TRANSITIONS,
  assertTransition,
  canPause,
  canTransition,
  hasBaseline,
  isTerminal,
  type ImportStatus
} from "./import.state.js"
import { Mode1Error } from "./mode1.errors.js"

/** Bảng cạnh hợp lệ viết tay theo plan §5.2 — test đối chiếu từng cạnh của IMPORT_TRANSITIONS với bảng này. */
const EXPECTED: [ImportStatus, ImportStatus][] = [
  ["uploaded", "preflight_rejected"],
  ["uploaded", "awaiting_latest_confirm"],
  ["uploaded", "parsing"],
  ["awaiting_latest_confirm", "parsing"],
  ["parsing", "mapping_review"],
  ["parsing", "extracting"],
  ["mapping_review", "extracting"],
  ["extracting", "fields_review"],
  ["extracting", "baselining"],
  ["fields_review", "baselining"],
  ["baselining", "checking"],
  ["checking", "gap_review"],
  ["gap_review", "delivered"],
  ["gap_review", "change_requested"],
  ["delivered", "change_requested"]
]

const key = (from: ImportStatus, to: ImportStatus) => `${from}→${to}`
const allowed = new Set(EXPECTED.map(([f, t]) => key(f, t)))

describe("import.state — cạnh chuyển trạng thái", () => {
  it.each(EXPECTED)("%s → %s hợp lệ", (from, to) => {
    expect(canTransition(from, to)).toBe(true)
    expect(() => assertTransition(from, to)).not.toThrow()
  })

  it("mọi cặp (from, to) ngoài bảng đều bị từ chối — 100% cạnh có test", () => {
    for (const from of IMPORT_STATUSES) {
      for (const to of IMPORT_STATUSES) {
        expect(canTransition(from, to), key(from, to)).toBe(allowed.has(key(from, to)))
      }
    }
    const declared = IMPORT_STATUSES.flatMap((from) => IMPORT_TRANSITIONS[from].map((to) => key(from, to)))
    expect(new Set(declared)).toEqual(allowed)
  })

  it("chuyển sai ném 409 IMPORT_INVALID_STATE kèm trạng thái hiện tại và các đích hợp lệ", () => {
    try {
      assertTransition("uploaded", "baselining")
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(Mode1Error)
      const e = err as Mode1Error
      expect(e.statusCode).toBe(409)
      expect(e.code).toBe("IMPORT_INVALID_STATE")
      expect(e.meta).toEqual({ status: "uploaded", to: "baselining", allowed: ["preflight_rejected", "awaiting_latest_confirm", "parsing"] })
    }
  })

  it("không có trạng thái nào tự chuyển về chính nó", () => {
    for (const s of IMPORT_STATUSES) expect(canTransition(s, s)).toBe(false)
  })
})

describe("import.state — trạng thái đặc biệt", () => {
  it("chỉ preflight_rejected và change_requested là trạng thái cuối", () => {
    expect(IMPORT_STATUSES.filter(isTerminal)).toEqual(["preflight_rejected", "change_requested"])
  })

  it("chỉ hai bước gọi AI (extracting, checking) được pause", () => {
    expect(IMPORT_STATUSES.filter(canPause)).toEqual(["extracting", "checking"])
  })

  it("có baseline v0 từ checking trở đi (BR-03)", () => {
    expect(IMPORT_STATUSES.filter(hasBaseline)).toEqual(["checking", "gap_review", "delivered", "change_requested"])
  })
})
