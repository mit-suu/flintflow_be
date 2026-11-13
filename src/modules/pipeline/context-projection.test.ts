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
import { ASSUMPTION_KEYS_READ, STEP_SKILLS, addendumForUnit, assumptionsForPrompt, openAssumptionsFor, buildStepContext, getStepSpec, parseStepId, projectStep, sectionsFedBy } from "./context-projection.js"
import { stepNeedsSourceDocuments } from "../../shared/ai/document-context.service.js"
import { getStep, loadStepRegistry, orderedSteps } from "./step-registry.js"
import { askableFields } from "./decisions.service.js"
import { sectionsOfPath } from "../spine/section-registry.js"

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

  it("B-2.3 đọc assumptions LỌC vẫn nhận thêm danh sách id đầy đủ (M4: 'AS10 đã tồn tại')", () => {
    // Đúng hình sau B-2.1: phần lớn assumption đã confirmed, chỉ còn một cái unconfirmed.
    const spine = structuredClone(FIXTURE)
    expect(spine.assumptions.length).toBeGreaterThan(1)
    for (const a of spine.assumptions) a.status = "confirmed"
    spine.assumptions[spine.assumptions.length - 1]!.status = "unconfirmed"

    const p = projectStep(spine, "B-2.3")
    // `reads` đã có assumptions[status=unconfirmed] — chỉ MỘT PHẦN mảng, không đủ để suy ra id kế tiếp
    const filtered = p.projection["assumptions[status=unconfirmed]"] as { status: string }[]
    expect(filtered).toHaveLength(1)

    const allKeys = p.projection[ASSUMPTION_KEYS_READ] as Record<string, unknown>[]
    expect(allKeys).toHaveLength(spine.assumptions.length)
    for (const a of allKeys) expect(Object.keys(a).sort()).toEqual(["id", "path", "status"])
  })

  it("step đọc trọn assumptions thì không thêm khoá thứ hai (B-2.1)", () => {
    const p = projectStep(FIXTURE, "B-2.1")
    expect(Object.keys(p.projection)).toEqual(["assumptions"])
  })

  it("emptyFields liệt kê phần còn thiếu (fixture minimal ở S-3.1)", () => {
    const p = projectStep(load("spine-fixture-minimal.json"), "S-3.1")
    expect(p.emptyFields).toEqual(expect.arrayContaining(["actors", "roles", "use_cases"]))
    const overview = projectStep(load("spine-fixture-minimal.json"), "S-2.2")
    expect(overview.emptyFields.every((f) => f.startsWith("project"))).toBe(true)
  })

  it("FLF-220: project.working_mode đã nghỉ - không vào projection, không tính là field trống", () => {
    const spine = structuredClone(FIXTURE)
    spine.project = {
      ...spine.project,
      system_name: "Minh An Booking",
      vision: "V",
      goals: ["G1"],
      type: "web_application",
      domain: "healthcare",
      complexity: "medium",
      form_factor: ["web_app"],
      stakes: "production",
      working_mode: null
    }
    const p = projectStep(spine, "S-1.2")
    expect(p.emptyFields).not.toContain("project.working_mode")
    // FLF-337: cài đặt "không hỏi lại" rỗng cũng không phải field trống
    expect(p.emptyFields).not.toContain("project.skip_confirm_sections")
    expect(p.projection.project).not.toHaveProperty("working_mode")
  })

  it("FLF-221: B-0.2 chỉ đọc project.form_factor, chỉ ghi project.form_factor + assumptions", () => {
    const spine = structuredClone(FIXTURE)
    spine.project = { ...spine.project, form_factor: [] }
    const p = projectStep(spine, "B-0.2")
    expect(p.projection["project:form_factor"]).toEqual({ form_factor: [] })
    expect(Object.keys(p.projection).filter((k) => k !== ASSUMPTION_KEYS_READ)).toEqual(["project:form_factor"])
    expect(p.emptyFields).toEqual(["project.form_factor"])
    expect(p.writable).toEqual(["project.form_factor", "assumptions"])
  })

  it("form_factor nhiều nền tảng đi nguyên mảng vào projection của các bước SRS đọc nó (S-6.1…S-6.5, S-7.2; S-4.1 không đọc form_factor theo registry)", () => {
    const spine = structuredClone(FIXTURE)
    spine.project = { ...spine.project, form_factor: ["web_app", "mobile_app"] }
    for (const id of ["S-6.1", "S-6.2", "S-6.3", "S-6.4", "S-6.5", "S-7.2"]) {
      const { projection, emptyFields } = projectStep(spine, id)
      const key = Object.keys(projection).find((k) => k.startsWith("project:") && k.includes("form_factor"))
      expect(key, id).toBeDefined()
      expect((projection[key as string] as { form_factor: string[] }).form_factor, id).toEqual(["web_app", "mobile_app"])
      expect(emptyFields, id).not.toContain("project.form_factor")
    }
  })

  it("step B-*: project.vision/goals không bao giờ nằm trong emptyFields; step S-* vẫn tính", () => {
    const spine = structuredClone(FIXTURE)
    spine.project = { ...spine.project, vision: null, goals: [] }
    for (const id of ["B-1.2", "B-1.3", "B-1.4", "B-1.5", "B-1.6", "B-2.2", "B-2.3"]) {
      const { emptyFields } = projectStep(spine, id)
      expect(emptyFields, id).not.toContain("project.vision")
      expect(emptyFields, id).not.toContain("project.goals")
      expect(askableFields(getStep(id).template_id, emptyFields), id).not.toContain("project.vision")
    }
    expect(projectStep(spine, "B-2.2").emptyFields).toEqual([])
    expect(projectStep(spine, "S-1.2").emptyFields.some((f) => f.startsWith("project."))).toBe(true)
  })

  it("FLF-221: step cuối mỗi giai đoạn Brief giữ writes = hợp của giai đoạn (revision ở phase gate)", () => {
    const registry = loadStepRegistry()
    for (const phase of ["B-0", "B-1", "B-2"]) {
      const steps = registry.filter((s) => s.phase === phase)
      const last = steps[steps.length - 1]
      const union = new Set(steps.flatMap((s) => s.writes))
      for (const w of union) {
        const covered = last.writes.some((lw) => w === lw || w.startsWith(`${lw}.`))
        expect(covered, `${last.id} phải ghi được ${w}`).toBe(true)
      }
    }
  })
})

describe("buildStepContext", () => {
  beforeEach(() => {
    vi.mocked(get).mockResolvedValue({ projectId: "p", ...structuredClone(FIXTURE) })
    vi.mocked(buildDocumentContext).mockResolvedValue({ contextText: "DOC", tokenCount: 7, documentsUsed: 1, usedSummary: false, mode: "full", chunksUsed: 0, fullTokens: 7 })
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
    // FLF-393: step gửi kèm câu hỏi tìm đoạn (nhãn step + câu trả lời của user) và tiêu đề section nó nuôi (S-3.1 ⇒ Actors)
    expect(buildDocumentContext).toHaveBeenCalledWith({
      projectId: "p",
      actionType: "draft",
      stepId: "S-3.1",
      query: expect.stringContaining("Students and teachers"),
      sectionTitles: expect.arrayContaining(["Actors", "Tác nhân"]),
      broad: false,
      focus: "Students and teachers"
    })
  })

  it("transcriptTail kèm lượt phỏng vấn đầu giai đoạn (câu trả lời mở không vào sổ quyết định)", async () => {
    vi.mocked(ChatSession.findById).mockReturnValue({
      lean: async () => ({
        messages: [
          { role: "ai", content: "1. Mô tả quy trình?\n2. Ai duyệt?", step: "B-1", createdAt: new Date() },
          { role: "user", content: "Khách đặt online, quản lý duyệt", step: "B-1", createdAt: new Date() },
          { role: "user", content: "Câu của bước khác", step: "B-1.2", createdAt: new Date() },
          { role: "user", content: "Giai đoạn khác", step: "B-0", createdAt: new Date() }
        ]
      })
    } as never)
    const ctx = await buildStepContext("p", "B-1.1", { sessionId: "s1" })
    expect(ctx.transcriptTail).toContain("User: Khách đặt online, quản lý duyệt")
    expect(ctx.transcriptTail).not.toContain("Câu của bước khác")
    expect(ctx.transcriptTail).not.toContain("Giai đoạn khác")
  })

  it("stepNeedsSourceDocuments theo token documents của registry", () => {
    expect(stepNeedsSourceDocuments("S-5.4@S01")).toBe(true)
    expect(stepNeedsSourceDocuments("S-3.4")).toBe(false)
    expect(stepNeedsSourceDocuments("not-a-step")).toBe(false)
  })
})

describe("addendumForUnit - lượt hỏi gộp / chat thấy điều user đã kể", () => {
  it("Brief và S-1 (step hoặc đơn vị giai đoạn) ⇒ toàn bộ addendum, dạng gửi model", () => {
    expect(FIXTURE.addendum.length).toBeGreaterThan(0)
    for (const unit of ["B-1", "B-1.3", "S-1"]) {
      expect(addendumForUnit(FIXTURE, unit)).toEqual(
        FIXTURE.addendum.map(({ id, topic, target_section, content_en }) => ({ id, topic, target_section, content_en }))
      )
    }
  })

  it("giai đoạn khác ⇒ không nạp (giữ như cũ)", () => {
    expect(addendumForUnit(FIXTURE, "S-4")).toEqual([])
    expect(addendumForUnit(FIXTURE, "S-5@S03")).toEqual([])
  })
})

describe("openAssumptionsFor - biến {{assumptions}} của elicit-loop (FLF-358)", () => {
  /** FIXTURE: AS01 nfrs[id=N05].threshold (S-6.3), AS02 actors[id=A05].name (S-2.3), AS03 screens[id=S07].tabs (S-4.2). */
  const withStatus = (status: Record<string, "unconfirmed" | "confirmed" | "rejected">): Spine => {
    const spine = structuredClone(FIXTURE)
    spine.assumptions = spine.assumptions.map((a) => ({ ...a, status: status[a.id] ?? a.status }))
    return spine
  }
  const ids = (spine: Spine, unit: string) => openAssumptionsFor(spine, unit).map((a) => a.id)

  it("chỉ giả định còn unconfirmed; dạng gửi model gồm id, path, statement, origin_step_id", () => {
    const spine = withStatus({ AS01: "unconfirmed", AS02: "rejected" })
    const as01 = spine.assumptions.find((a) => a.id === "AS01")!
    expect(openAssumptionsFor(spine, "S-6.3")).toEqual([{ id: "AS01", path: as01.path, statement: as01.statement, origin_step_id: "S-6.3" }])
    expect(ids(spine, "B-1")).toEqual(["AS01"])
  })

  it("Brief và S-1 (step hoặc đơn vị giai đoạn) ⇒ mọi giả định còn mở", () => {
    const spine = withStatus({ AS01: "unconfirmed", AS02: "unconfirmed", AS03: "unconfirmed" })
    for (const unit of ["B-1", "B-2.3", "S-1", "S-1.1"]) expect(ids(spine, unit)).toEqual(["AS01", "AS02", "AS03"])
  })

  it("step khác ⇒ do chính step sinh ra, hoặc path thuộc section step nuôi", () => {
    const spine = withStatus({ AS01: "unconfirmed", AS02: "unconfirmed", AS03: "unconfirmed" })
    expect(ids(spine, "S-6.3")).toContain("AS01")
    expect(ids(spine, "S-4.2")).toContain("AS03")
    // AS02 (sinh ở S-2.3) xuất hiện ở mọi step nuôi section chứa actors[id=A05].name, và chỉ ở đó
    const owner = new Set(sectionsOfPath(spine, "actors[id=A05].name").owner)
    expect(owner.size).toBeGreaterThan(0)
    for (const step of orderedSteps(spine).filter((s) => !/^(B-|S-1\.|S-2\.3$)/.test(s.id))) {
      const touches = sectionsFedBy(spine, step.id).some((section) => owner.has(section))
      expect(ids(spine, step.id).includes("AS02"), step.id).toBe(touches)
    }
  })

  it("đơn vị giai đoạn ⇒ gộp theo mọi bước của giai đoạn", () => {
    const spine = withStatus({ AS01: "unconfirmed", AS03: "unconfirmed" })
    expect(ids(spine, "S-6")).toContain("AS01")
    expect(ids(spine, "S-4")).toContain("AS03")
    expect(ids(spine, "S-6")).not.toContain("AS03")
  })

  it("assumptionsForPrompt: không có ⇒ (none)", () => {
    expect(assumptionsForPrompt(FIXTURE, "S-6.3")).toBe("(none)")
    expect(assumptionsForPrompt(withStatus({ AS01: "unconfirmed" }), "S-6.3")).toHaveLength(1)
  })
})

describe("FLF-413 - khung của mẫu không vào projection", () => {
  it("S-4.1 / S-4.4 không thấy tính năng / chức năng tên chỗ điền", () => {
    const spine: Spine = structuredClone(FIXTURE)
    spine.features = [...spine.features, { id: "F-3.2", name: "<<Feature Name 1>>", order: spine.features.length }]
    spine.functions = [...spine.functions, { ...spine.functions[0], id: "FR-3.2.1", feature_id: "F-3.2", screen_id: null, order: 0, name: "<<Function Name 1>>", validations: [] }]
    for (const stepId of ["S-4.1", "S-4.4"]) {
      const text = JSON.stringify(projectStep(spine, stepId).projection)
      expect(text, stepId).not.toContain("<<")
    }
    expect(JSON.stringify(projectStep(spine, "S-4.1").projection)).toContain(FIXTURE.features[0].name)
  })
})
