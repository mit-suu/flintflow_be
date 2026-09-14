import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { spineSchema } from "../spine/spine.schema.js"
import type { Spine } from "../spine/spine.types.js"
import { createEmptySpine } from "../spine/spine.repository.js"
import { FIXED_OWNER_STEPS, FEATURE_OWNER_STEPS, FUNCTION_OWNER_STEP_TEMPLATES } from "../spine/section-registry.js"
import {
  FIXED_STEP_COUNT,
  PHASES,
  expandS5,
  getStep,
  loadStepRegistry,
  loopKeys,
  nextStep,
  orderedSteps,
  phaseOf,
  stepRegistrySchema,
  totalSteps
} from "./step-registry.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)

const oneScreen = (): Spine => {
  const spine = createEmptySpine({ name: "One" })
  spine.features = [{ id: "F1", name: "Main", order: 0 }]
  spine.screens = [
    {
      id: "S01",
      feature_id: "F1",
      name: "Home",
      description: "",
      flow_to: [],
      is_popup: false,
      tabs: [],
      primary_function_id: null,
      queue_order: 0,
      detail_status: "pending"
    }
  ]
  return spine
}

describe("assets/step-registry.json", () => {
  it("parse qua schema: 13 Brief + 38 SRS cố định + 5 template S-5, đủ 12 phase", () => {
    const steps = loadStepRegistry()
    expect(steps.filter((s) => s.id.startsWith("B-"))).toHaveLength(13)
    expect(steps.filter((s) => s.id.startsWith("S-") && s.kind !== "loop")).toHaveLength(38)
    expect(steps.filter((s) => s.kind === "loop").map((s) => s.id)).toEqual(["S-5.1", "S-5.2", "S-5.3", "S-5.4", "S-5.5"])
    expect(steps.filter((s) => s.kind !== "loop")).toHaveLength(FIXED_STEP_COUNT)
    expect(new Set(steps.map((s) => s.phase))).toEqual(new Set(PHASES))
  })

  it("step tất định đúng Phases §4.2 (không Meter); renders khớp 5 kind", () => {
    const steps = loadStepRegistry()
    expect(steps.filter((s) => s.deterministic).map((s) => s.id)).toEqual(["S-8.2", "S-8.3", "S-9.1", "S-9.5"])
    expect(Object.fromEntries(steps.filter((s) => s.renders.length > 0).map((s) => [s.id, s.renders]))).toEqual({
      "S-2.5": ["context"],
      "S-3.6": ["usecase"],
      "S-4.2": ["screen_flow"],
      "S-4.5": ["erd"],
      "S-5.3": ["screen_layout"]
    })
  })

  it("mọi step sở hữu section trong section-registry (T09) tồn tại trong registry", () => {
    const ids = new Set(loadStepRegistry().map((s) => s.id))
    for (const owners of [...Object.values(FIXED_OWNER_STEPS), FEATURE_OWNER_STEPS, FUNCTION_OWNER_STEP_TEMPLATES]) {
      for (const id of owners) expect(ids.has(id), id).toBe(true)
    }
  })

  it("schema bắt trùng id, lệch phase, kind loop ngoài S-5", () => {
    const base = loadStepRegistry()[0]
    expect(stepRegistrySchema.safeParse([base, base]).success).toBe(false)
    expect(stepRegistrySchema.safeParse([{ ...base, phase: "S-1" }]).success).toBe(false)
    expect(stepRegistrySchema.safeParse([{ ...base, kind: "loop" }]).success).toBe(false)
  })
})

describe("đếm step (DoD T12)", () => {
  it("N = 1 ⇒ 56 step", () => {
    const spine = oneScreen()
    expect(loopKeys(spine)).toEqual(["S01"])
    expect(totalSteps(spine)).toBe(56)
    expect(orderedSteps(spine)).toHaveLength(56)
  })

  it("fixture 19 màn + non-screen ⇒ N = 20 ⇒ 151 step", () => {
    expect(loopKeys(FIXTURE)).toHaveLength(20)
    const keys = loopKeys(FIXTURE)
    expect(keys[keys.length - 1]).toBe("nonscreen")
    expect(totalSteps(FIXTURE)).toBe(151)
    expect(orderedSteps(FIXTURE)).toHaveLength(151)
    expect(expandS5(FIXTURE)).toHaveLength(100)
  })

  it("thứ tự: S-4.5 ngay trước vòng S-5 đầu, S-6.1 ngay sau vòng cuối", () => {
    const ids = orderedSteps(oneScreen()).map((s) => s.id)
    expect(ids.slice(ids.indexOf("S-4.5"), ids.indexOf("S-4.5") + 7)).toEqual([
      "S-4.5",
      "S-5.1@S01",
      "S-5.2@S01",
      "S-5.3@S01",
      "S-5.4@S01",
      "S-5.5@S01",
      "S-6.1"
    ])
  })
})

describe("getStep / phaseOf / nextStep", () => {
  it("getStep có @ cho vòng S-5, từ chối thiếu hoặc thừa @", () => {
    expect(getStep("S-5.4@S01")).toMatchObject({ id: "S-5.4@S01", template_id: "S-5.4", loop: "S01", phase: "S-5" })
    expect(getStep("S-3.1")).toMatchObject({ id: "S-3.1", loop: null, label_vi: "Actor" })
    for (const bad of ["S-5.4", "S-3.1@S01", "S-10.1", "S-5.4@"]) {
      expect(() => getStep(bad), bad).toThrow(expect.objectContaining({ statusCode: 404, code: "STEP_NOT_FOUND" }))
    }
    expect(phaseOf("B-1.4")).toBe("B-1")
  })

  it("Spine mới ⇒ B-0.1; fixture đã accepted hết (placeholder bỏ qua) ⇒ null", () => {
    expect(nextStep(createEmptySpine())?.id).toBe("B-0.1")
    const fixtureWithBrief: Spine = {
      ...FIXTURE,
      steps: [...FIXTURE.steps, ...loadStepRegistry().filter((s) => s.id.startsWith("B-")).map((s) => ({ id: s.id, status: "accepted" as const, first_seq: null, last_seq: null, accepted_at: null }))]
    }
    expect(nextStep(fixtureWithBrief)).toBeNull()
  })

  it("step đang revision_requested là step kế tiếp", () => {
    const spine = structuredClone(FIXTURE)
    spine.steps = loadStepRegistry()
      .filter((s) => s.kind !== "loop")
      .map((s) => ({ id: s.id, status: s.id === "S-3.2" ? ("revision_requested" as const) : ("accepted" as const), first_seq: null, last_seq: null, accepted_at: null }))
    spine.screens = spine.screens.map((s) => ({ ...s, detail_status: "placeholder" as const }))
    spine.functions = spine.functions.filter((f) => f.screen_id !== null)
    expect(nextStep(spine)?.id).toBe("S-3.2")
  })
})
