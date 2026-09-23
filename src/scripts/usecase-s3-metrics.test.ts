import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { spineSchema } from "../modules/spine/spine.schema.js"
import type { Spine } from "../modules/spine/spine.types.js"
import { nextStep } from "../modules/pipeline/step-registry.js"
import { checkInvariants } from "../modules/spine/invariants.js"
import { scoreS3, type PersonaExpectation } from "./usecase-s3-metrics.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const EVAL_DIR = path.resolve(__dirname, "../../fixtures/s3-eval")
const CASES = fs.readdirSync(EVAL_DIR).filter((f) => f.endsWith(".json"))

const loadCase = (file: string): { name: string; expected_personas: PersonaExpectation[]; spine: Spine } => {
  const raw = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, file), "utf8"))
  return { ...raw, spine: spineSchema.parse(raw.spine) }
}

describe("fixtures/s3-eval", () => {
  it("có đủ 3 ca, mỗi ca là Spine hợp lệ đứng ngay trước S-3.1", () => {
    expect(CASES.sort()).toEqual(["bookbox.json", "flintflow.json", "mediqueue.json"])
    for (const file of CASES) {
      const c = loadCase(file)
      expect(nextStep(c.spine)?.id, file).toBe("S-3.1")
      expect(checkInvariants(c.spine, c.spine), file).toEqual([])
      // Trước S-3.1: chỉ actor hệ thống ngoài của S-2.3, chưa có use case
      expect(c.spine.actors.every((a) => a.kind === "system"), file).toBe(true)
      expect(c.spine.use_cases, file).toEqual([])
      expect(c.expected_personas.length, file).toBeGreaterThan(0)
    }
  })
})

describe("scoreS3", () => {
  const base = loadCase("bookbox.json")
  const withUseCases = (fn: (s: Spine) => void): Spine => {
    const s = structuredClone(base.spine)
    s.actors.push(
      { id: "A10", name: "Member", kind: "human", description: "Buys books." },
      { id: "A11", name: "Store Manager", kind: "human", description: "Runs a store." }
    )
    s.use_cases.push(
      { id: "UC01", name: "Log In", actor_ids: ["A10", "A11"], function_ids: [], description: "d", includes: [], extends: [] },
      { id: "UC02", name: "Place Order", actor_ids: ["A10", "A01"], function_ids: [], description: "d", includes: [], extends: [] },
      { id: "UC03", name: "Apply Discount Voucher", actor_ids: ["A10"], function_ids: [], description: "When the member has a voucher", includes: [], extends: ["UC02"] }
    )
    fn(s)
    return s
  }

  it("đếm actor theo kind, quan hệ, persona khớp theo từ khoá", () => {
    const m = scoreS3(withUseCases(() => {}), base.expected_personas)
    expect(m.actors).toEqual({ human: 2, system: 3, time: 0 })
    expect(m.useCases).toBe(3)
    expect([m.includes, m.extends]).toEqual([0, 1])
    expect(m.personasCovered).toEqual(["Shopper / Member", "Store Manager"])
    expect(m.personasMissing).toEqual(["Store Staff", "Owner"])
  })

  it("đếm cờ tất định: include Log In ⇒ auth_relation; actor hệ thống không tham gia ⇒ orphan_actor", () => {
    const m = scoreS3(withUseCases((s) => (s.use_cases[1].includes = ["UC01"])), base.expected_personas)
    expect(m.flags.auth_relation).toBe(1)
    // A02 Shipping Partner, A03 Email Service không nằm trong use case nào
    expect(m.flags.orphan_actor).toBe(2)
    expect(m.flags.relation_invalid).toBe(0)
  })

  it("liệt kê quan hệ kèm reason của op theo path", () => {
    const reasons = new Map([["use_cases[id=UC03].extends", "only when a voucher is entered during checkout"]])
    const m = scoreS3(withUseCases(() => {}), base.expected_personas, reasons)
    expect(m.relations).toEqual([
      { kind: "extend", from: "Apply Discount Voucher (UC03)", to: "Place Order (UC02)", reason: "only when a voucher is entered during checkout" }
    ])
  })
})
