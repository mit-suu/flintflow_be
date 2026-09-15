import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../spine/spine.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../spine/spine.repository.js")>()
  return { ...actual, get: vi.fn() }
})
vi.mock("../project/chat-session.model.js", () => ({ ChatSession: { findById: vi.fn() } }))
vi.mock("../../shared/ai/document-context.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/ai/document-context.service.js")>()
  return { ...actual, buildDocumentContext: vi.fn() }
})

import { spineSchema } from "../spine/spine.schema.js"
import type { Spine } from "../spine/spine.types.js"
import { get } from "../spine/spine.repository.js"
import { ChatSession } from "../project/chat-session.model.js"
import { buildDocumentContext } from "../../shared/ai/document-context.service.js"
import { ASSUMPTION_KEYS_READ, STEP_SKILLS, buildStepContext, getStepSpec, parseStepId, projectStep, sectionsFedBy } from "./context-projection.js"
import { stepNeedsSourceDocuments } from "../../shared/ai/document-context.service.js"
import { loadStepRegistry, orderedSteps } from "./step-registry.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const load = (file: string): Spine =>
  spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures", file), "utf8")))
const FIXTURE = load("spine-fixture-19-screens.json")

describe("getStepSpec (step registry T12 + STEP_SKILLS)", () => {
  it("khoá STEP_SKILLS đều là step trong registry; step có skill đều ghi được assumptions", () => {
    const registry = new Map(loadStepRegistry().map((s) => [s.id, s]))
    for (const id of Object.keys(STEP_SKILLS)) {
      expect(registry.has(id), id).toBe(true)
      expect(registry.get(id)?.writes, id).toContain("assumptions")
    }
  })

  it("mọi step của fixture 19 màn đều projection được; reads không lẫn token documents", () => {
    for (const step of orderedSteps(FIXTURE)) {
      expect(getStepSpec(step.id).reads, step.id).not.toContain("documents")
      expect(() => projectStep(FIXTURE, step.id), step.id).not.toThrow()
    }
  })

  it("parseStepId / getStepSpec", () => {
    expect(parseStepId("S-5.4@S01")).toEqual({ id: "S-5.4@S01", base: "S-5.4", phase: "S-5", loop: "S01" })
    expect(getStepSpec("S-5.4@nonscreen").skill).toBe("function-detail")
    expect(() => getStepSpec("S-10.1")).toThrow(expect.objectContaining({ statusCode: 404, code: "STEP_NOT_FOUND" }))
  })
})

describe("projectStep", () => {
  it("S-3.5 chỉ nạp actors/roles/use_cases + khung function, addendum §2.1/§2.2.2", () => {
    const p = projectStep(FIXTURE, "S-3.5")
    expect(Object.keys(p.projection)).toEqual(["actors", "roles", "use_cases", "functions:id,name,screen_id", ASSUMPTION_KEYS_READ])
    // Step ghi assumptions[] thấy id đã dùng (tránh "AS3 đã tồn tại"), chỉ khoá tối thiểu, không vào emptyFields.
    const assumptionKeys = p.projection[ASSUMPTION_KEYS_READ] as Record<string, unknown>[]
    expect(assumptionKeys).toHaveLength(FIXTURE.assumptions.length)
    for (const a of assumptionKeys) expect(Object.keys(a).sort()).toEqual(["id", "path", "status"])
    expect(p.emptyFields.some((f) => f.startsWith("assumptions"))).toBe(false)
    const fn = (p.projection["functions:id,name,screen_id"] as Record<string, unknown>[])[0]
    expect(Object.keys(fn).sort()).toEqual(["id", "name", "screen_id"])
    expect(p.writable).toEqual(["actors", "roles", "use_cases", "assumptions"])
    const targets = new Set(sectionsFedBy(FIXTURE, "S-3.5"))
    expect(targets).toEqual(new Set(["fixed:2.2.2"]))
    expect(p.addendum.every((a) => targets.has(a.target_section))).toBe(true)
  })

  it("S-5.4@S01 không chứa nfrs, glossary; chỉ màn/function/permission của S01", () => {
    const p = projectStep(FIXTURE, "S-5.4@S01")
    const json = JSON.stringify(p.projection)
    for (const key of Object.keys(p.projection)) expect(key).not.toMatch(/^(nfrs|glossary|entities|use_cases)/)
    expect(json).not.toContain('"N05"')
    expect(p.projection["screens[id=@loop]"]).toMatchObject([{ id: "S01" }])
    expect((p.projection["functions[screen_id=@loop]"] as { screen_id: string }[]).every((f) => f.screen_id === "S01")).toBe(true)
    expect((p.projection["permissions[screen_id=@loop]"] as { screen_id: string }[]).every((f) => f.screen_id === "S01")).toBe(true)
    expect(p.projection["features[id=@loopFeature]"]).toMatchObject([{ id: "F1" }])
  })

  it("vòng @nonscreen lấy function screen_id = null; addendum theo feature của màn trong S-5", () => {
    const nonscreen = projectStep(FIXTURE, "S-5.2@nonscreen")
    expect((nonscreen.projection["functions[screen_id=@loop]"] as { screen_id: null }[]).every((f) => f.screen_id === null)).toBe(true)
    expect(nonscreen.projection["screens[id=@loop]"]).toEqual([])

    const s07 = projectStep(FIXTURE, "S-5.4@S07")
    expect(s07.addendum.map((a) => a.target_section)).toContain("feature:F3")
  })

  it("S-6.3 nhận addendum §4.2.2; Brief nhận toàn bộ addendum", () => {
    expect(projectStep(FIXTURE, "S-6.3").addendum.map((a) => a.target_section)).toContain("fixed:4.2.2")
    expect(projectStep(FIXTURE, "B-1.1").addendum).toHaveLength(FIXTURE.addendum.length)
  })

  it("emptyFields liệt kê phần còn thiếu (fixture minimal ở S-3.1)", () => {
    const p = projectStep(load("spine-fixture-minimal.json"), "S-3.1")
    expect(p.emptyFields).toEqual(expect.arrayContaining(["actors", "roles", "use_cases"]))
    const overview = projectStep(load("spine-fixture-minimal.json"), "S-2.2")
    expect(overview.emptyFields.every((f) => f.startsWith("project"))).toBe(true)
  })
})

describe("buildStepContext", () => {
  beforeEach(() => {
    vi.mocked(get).mockResolvedValue({ projectId: "p", ...structuredClone(FIXTURE) })
    vi.mocked(buildDocumentContext).mockResolvedValue({ contextText: "DOC", tokenCount: 7, documentsUsed: 1, usedSummary: false })
    vi.mocked(ChatSession.findById).mockReturnValue({
      lean: async () => ({
        messages: [
          { role: "ai", content: "Which actors?", step: "S-3.1", createdAt: new Date() },
          { role: "user", content: "Students and teachers", step: "S-3.1", createdAt: new Date() },
          { role: "user", content: "Other phase answer", step: "B-1.2", createdAt: new Date() }
        ]
      })
    } as never)
  })

  it("transcriptTail chỉ gồm tin nhắn của step; tài liệu và contextTokens", async () => {
    const ctx = await buildStepContext("p", "S-3.1", { sessionId: "s1" })
    expect(ctx.transcriptTail).toBe("AI: Which actors?\nUser: Students and teachers")
    expect(ctx.transcriptTail).not.toContain("Other phase")
    expect(ctx.documents).toBe("DOC")
    expect(ctx.contextTokens).toBeGreaterThan(7)
    expect(buildDocumentContext).toHaveBeenCalledWith("p", "draft", "S-3.1", expect.any(Number), undefined, undefined)
  })

  it("stepNeedsSourceDocuments theo token documents của registry", () => {
    expect(stepNeedsSourceDocuments("S-5.4@S01")).toBe(true)
    expect(stepNeedsSourceDocuments("S-3.4")).toBe(false)
    expect(stepNeedsSourceDocuments("not-a-step")).toBe(false)
  })
})
