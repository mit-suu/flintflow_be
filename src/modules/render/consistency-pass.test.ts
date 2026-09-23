import { describe, expect, it } from "vitest"
import type { Spine } from "../spine/spine.types.js"
import type { RenderedSection } from "./rendered-document.types.js"
import { CONSISTENCY_LLM_ENABLED, runConsistencyPass } from "./consistency-pass.js"

const emptySpine = (): Spine => ({
  project: { name: "Demo", system_name: null, vision: null, goals: [], type: null, domain: null, complexity: null, form_factor: null, stakes: null, working_mode: null, review_mode: "balanced" as const, release_scope: { in: [], out: [] } },
  progress: { current_phase: null, current_step: null, screen_cursor: null, screen_queue: [], elicit_turns_this_phase: 0 },
  steps: [],
  features: [],
  actors: [],
  roles: [],
  use_cases: [],
  screens: [],
  permissions: [],
  entities: [],
  functions: [],
  nfrs: [],
  business_rules: [],
  common_requirements: [],
  messages: [],
  other_requirements: [],
  glossary: [],
  addendum: [],
  custom_sections: [],
  diagrams: [],
  assumptions: [],
  decisions: [],
  flags: [],
  sections: [],
  baselines: [],
  spine_version: 1
})

const section = (over: Partial<RenderedSection>): RenderedSection => ({
  id: "fixed:1",
  number: "1",
  heading: "Product Overview",
  level: 1,
  blocks: [],
  ...over
})

describe("runConsistencyPass — tất định", () => {
  it("phát hiện tham chiếu chết (dead_reference) qua reference-fields", async () => {
    const spine: Spine = { ...emptySpine(), screens: [{ id: "S1", feature_id: "MISSING", name: "S", description: "", flow_to: [], is_popup: false, tabs: [], primary_function_id: null, queue_order: null, detail_status: "pending" }] }
    const findings = await runConsistencyPass(spine, [])
    expect(findings).toContainEqual(expect.objectContaining({ rule: "dead_reference", path: "screens[id=S1].feature_id" }))
  })

  it("phát hiện số hiệu section trùng nhau", async () => {
    const sections = [section({ id: "fixed:1", number: "1" }), section({ id: "feature:F1", number: "1" })]
    const findings = await runConsistencyPass(emptySpine(), sections)
    expect(findings).toContainEqual(expect.objectContaining({ rule: "duplicate_section_number", message: expect.stringContaining('"1"') }))
  })

  it("cờ thuật ngữ viết-hoa-toàn-bộ chưa có trong glossary (heuristic)", async () => {
    const sections = [section({ blocks: [{ type: "paragraph", runs: [{ text: "Uses HTTPS and SSE for delivery." }] }] })]
    const findings = await runConsistencyPass(emptySpine(), sections)
    const terms = findings.filter((f) => f.rule === "undefined_term").map((f) => f.message)
    expect(terms.some((m) => m.includes('"HTTPS"'))).toBe(true)
    expect(terms.some((m) => m.includes('"SSE"'))).toBe(true)
  })

  it("thuật ngữ đã có trong glossary (không phân biệt hoa/thường) không bị cờ", async () => {
    const spine: Spine = { ...emptySpine(), glossary: [{ id: "G1", term: "SRS", definition: "Software Requirement Specification" }] }
    const sections = [section({ blocks: [{ type: "paragraph", runs: [{ text: "The SRS document." }] }] })]
    const findings = await runConsistencyPass(spine, sections)
    expect(findings.some((f) => f.rule === "undefined_term")).toBe(false)
  })

  it("không có gì bất thường ⇒ mảng rỗng", async () => {
    expect(await runConsistencyPass(emptySpine(), [section({})])).toEqual([])
  })

  it("mặc định CONSISTENCY_LLM_ENABLED = false (không gọi model)", () => {
    expect(CONSISTENCY_LLM_ENABLED).toBe(false)
  })
})

