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
import { STEP_SPECS, buildStepContext, getStepSpec, parseStepId, projectStep, sectionsFedBy } from "./context-projection.js"
import { stepNeedsSourceDocuments } from "../../shared/ai/document-context.service.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const load = (file: string): Spine =>
  spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures", file), "utf8")))
const FIXTURE = load("spine-fixture-19-screens.json")

describe("STEP_SPECS (bảng tạm trước T12)", () => {
  it("đủ 13 step Brief + 38 step SRS cố định (S-5 tính 5 template)", () => {
    const ids = Object.keys(STEP_SPECS)
    expect(ids.filter((id) => id.startsWith("B-"))).toHaveLength(13)
    // 38 step SRS cố định + 5 template vòng S-5 (Phases §6.4)
    expect(ids.filter((id) => id.startsWith("S-") && !id.startsWith("S-5."))).toHaveLength(38)
    expect(ids.filter((id) => id.startsWith("S-5."))).toHaveLength(5)
    for (const s of Object.values(STEP_SPECS)) if (s.writes.length > 1) expect(s.writes).toContain("assumptions")
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
    expect(Object.keys(p.projection)).toEqual(["actors", "roles", "use_cases", "functions:id,name,screen_id"])
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

  it("STEP_NEEDS_SOURCE_DOCUMENTS theo step (bỏ @)", () => {
    expect(stepNeedsSourceDocuments("S-5.4@S01")).toBe(true)
    expect(stepNeedsSourceDocuments("S-3.4")).toBe(false)
  })
})
