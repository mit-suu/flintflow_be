import { describe, it, expect } from "vitest"
import { MODE1_BACKFILL_STEPS } from "./migrate-mode1-defaults.js"

describe("migrate-mode1-defaults", () => {
  it("chỉ chạm projects và collection baselines — không ghi thẳng spines", () => {
    expect(MODE1_BACKFILL_STEPS.map((s) => s.collection)).toEqual(["projects", "baselines"])
  })

  it("project cũ ⇒ mode fpt; snapshot cũ ⇒ type generated, doc_version null", () => {
    const [projects, baselines] = MODE1_BACKFILL_STEPS
    expect(projects.set).toEqual({ mode: "fpt", import_state: null })
    expect(baselines.set).toEqual({ type: "generated", doc_version: null })
  })

  it("filter chỉ khớp document còn thiếu field ⇒ chạy lại không đè dữ liệu mode 1", () => {
    for (const step of MODE1_BACKFILL_STEPS) {
      const [field] = Object.keys(step.filter)
      expect(step.filter[field]).toEqual({ $exists: false })
      expect(step.set).toHaveProperty(field)
    }
  })
})
