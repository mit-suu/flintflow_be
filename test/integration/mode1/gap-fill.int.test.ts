/**
 * FLF-382 — luồng B (có sẵn · mẫu cố định): một nút "Hoàn thiện". File còn 3 mục trống (mục FPT `5.5 Glossary`, phần nhỏ
 * `5.6 Assumptions`, mục riêng `5.10 Document Conventions`) ⇒ "Hoàn thiện" chốt 0.1 ⇒ tự mở CR "Bổ sung mục còn thiếu" một lần ⇒
 * C-2 hỏi ⇒ trả lời ⇒ C-3 mỗi mục một vị trí ⇒ C-4 ⇒ C-5 ⇒ C-6 ghi 0.2, I-5 cập nhật. Luồng A / C không đổi. Mongo thật, AI giả.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { createMode1Project, fakeMode1, mode1Api, promptLocations } from "../../helpers/mode1.js"
import { fileOf } from "../../helpers/mode1-import-p4.js"
import { seedFixture } from "../../setup.js"
import { p, styled } from "../../../src/modules/docx-ooxml/testing/make-docx.js"
import { makeSrsDocx } from "../../../src/modules/import/testing/srs-fixture.js"
import { acceptLatest, uploadImport } from "../../../src/modules/import/import.service.js"
import { runExtraction } from "../../../src/modules/import/extract.service.js"
import { resumeCheck } from "../../../src/modules/import/finalize.service.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import { Project } from "../../../src/modules/project/project.model.js"
import { ChangeRequest } from "../../../src/modules/change-request/change-request.model.js"
import { prepareAutoGapFill } from "../../../src/modules/change-request/gap-fill.service.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"

const EMPTY_SECTIONS =
  styled("u2", "5.5 Glossary") +
  p("[List the terms and abbreviations used in this document.]") +
  styled("u2", "5.6 Assumptions") +
  p("[List the assumptions the requirements rely on.]") +
  styled("u2", "5.10 Document Conventions") +
  p("[Describe the typographical conventions used in this SRS.]")

const prompts: string[] = []

/** C-2 của CR bổ sung: vòng 1 hỏi một câu, sau đó rõ. */
const fakeGapClarify = (prompt: string): string | undefined => {
  if (!prompt.includes("# CR Clarify")) return undefined
  const round = Number(/Round (\d+) of at most 3/.exec(prompt)?.[1] ?? 1)
  if (round === 1) return JSON.stringify({ ambiguous: true, questions: ["Mục Document Conventions dùng quy ước chữ nào?"], suggestions: [["In đậm cho thuật ngữ"]], targets: { entity_paths: [], keywords: [] } })
  return JSON.stringify({ ambiguous: false, questions: [], targets: { entity_paths: ["actors[id=A01]"], keywords: ["learner"] } })
}

/** C-4: mỗi vị trí mục trống một đề xuất thêm nội dung. */
const fakeGapPropose = (prompt: string): string | undefined => {
  if (!prompt.includes("# CR Propose")) return undefined
  const locations = promptLocations(prompt).map((l) => {
    const edit = (spine_ops: object[]) => ({ location_id: l.location_id, conclusion: "edit", reason: "Soạn mục còn trống", spine_ops, assumptions: [] })
    if (l.path === "glossary[]") return edit([{ op: "add", path: "glossary[]", value: { id: "GL-90", term: "LMS", definition: "Learning management system." } }])
    if (l.path === "other_requirements[]")
      return edit([{ op: "add", path: "other_requirements[]", value: { id: "OR-90", kind: "assumption", statement: "Learners have a stable internet connection." } }])
    if (l.path.startsWith("custom_sections[")) {
      const current = JSON.parse(l.text) as Record<string, unknown>
      return edit([{ op: "set", path: l.path, value: { ...current, blocks: [{ kind: "paragraph", text: "Bold text marks a defined term.", rows: null, image_ref: null }] } }])
    }
    return { location_id: l.location_id, conclusion: "not_related", reason: "Không thuộc mục trống", spine_ops: [] }
  })
  return JSON.stringify({ locations })
}

const fakeConsistency = (prompt: string): string | undefined => (prompt.includes("# CR Consistency") ? JSON.stringify({ findings: [] }) : undefined)

beforeEach(() => {
  resetMockLlm()
  prompts.length = 0
  mockOverrides.next = (prompt: string) => {
    prompts.push(prompt)
    return fakeMode1(prompt) ?? fakeGapClarify(prompt) ?? fakeGapPropose(prompt) ?? fakeConsistency(prompt)
  }
})

const setup = async (project: { start_kind: "existing" | "new"; template_intent: "fixed" | "free" | null }, extraBody = EMPTY_SECTIONS) => {
  const seeded = await seedFixture("minimal", { balance: 1000 })
  const projectId = await createMode1Project(seeded)
  await Project.updateOne({ _id: projectId }, { $set: { ...project, has_required_template: project.template_intent === "fixed" } })
  const doc = await uploadImport(projectId, seeded.userId, fileOf(await makeSrsDocx({ extraBody })), project.template_intent ? { intent: project.template_intent } : undefined)
  await acceptLatest(doc, true)
  const importId = String(doc._id)
  const run = await runExtraction(projectId, seeded.userId, importId)
  expect(run.doc.status).toBe("baselining")
  return { seeded, projectId, importId, userId: seeded.userId, api: mode1Api(seeded, projectId) }
}

const gapCrs = (projectId: string) => ChangeRequest.find({ projectId, kind: "gap_fill" }).lean()

describe("FLF-382 luồng B — Hoàn thiện ⇒ CR bổ sung mục còn thiếu", () => {
  it("3 mục trống (FPT / phần nhỏ / mục riêng) ⇒ CR tự mở một lần ⇒ hỏi ⇒ đề xuất ⇒ kiểm ⇒ ghi 0.2, I-5 cập nhật", async () => {
    const { projectId, importId, userId, api } = await setup({ start_kind: "existing", template_intent: "fixed" })

    // Lần finalize đầu dừng ở "Kết quả đọc file" — có ước tính credit soạn mục trống, chưa có CR
    const stopped = await api.finalizeAndWait(importId)
    expect(stopped.view?.import?.status).toBe("incomplete")
    expect(stopped.view?.target_structure?.missing).toEqual(expect.arrayContaining(["fixed:5.5", "slot:assumptions"]))
    expect(stopped.view?.gap_fill_cr_id).toBeNull()
    expect(stopped.view?.gap_fill_credit_estimate).toBeGreaterThan(0)

    // "Hoàn thiện" ⇒ 0.1 + CR bổ sung có ngay khi import tới `gap_review`, C-2 đã hỏi
    const done = await api.finalizeAndWait(importId, { complete: true })
    expect(done.res.status).toBe(200)
    expect(done.view?.import?.status).toBe("gap_review")
    expect(done.view?.gap_fill_cr_id).toBe("CR-001")
    expect(done.view?.gap_fill_credit_estimate).toBeNull()

    const custom = (await spineRepository.get(projectId))!.custom_sections.find((c) => c.heading.includes("Document Conventions"))!
    const detail = (await api.get("/change-requests/CR-001")).body.data
    expect(detail.change_request).toMatchObject({ kind: "gap_fill", status: "awaiting_answers", source: { kind: "gap_report" } })
    expect(detail.change_request.gap_sections).toEqual([
      { section_id: "fixed:5.5", title: "5.5 Glossary" },
      { section_id: "slot:assumptions", title: "5.6 Assumptions" },
      { section_id: `custom:${custom.id}`, title: "5.10 Document Conventions" }
    ])
    // Heading tính năng (chỉ chứa chức năng con) không có chỗ ghi ⇒ không vào CR
    expect(detail.change_request.description).toContain("5.5 Glossary, 5.6 Assumptions, 5.10 Document Conventions")
    expect(detail.pending_questions).toHaveLength(1)
    const clarifyPrompt = prompts.find((x) => x.includes("# CR Clarify"))!
    expect(clarifyPrompt).toContain("Gap-fill CR")
    expect(clarifyPrompt).toContain("List the terms and abbreviations")
    expect(clarifyPrompt).toContain("Expected content (ISO 29148): terms, acronyms")

    // Danh sách CR cũng mang kind + mục; CR cũ / CR thường ⇒ edit
    const list = (await api.get("/change-requests")).body.data
    expect(list[0]).toMatchObject({ cr_id: "CR-001", kind: "gap_fill" })
    expect(list[0].gap_sections).toHaveLength(3)

    // Job kiểm tra chạy lại không tạo CR thứ hai
    const doc = (await ImportedDocument.findById(importId))!
    expect(await prepareAutoGapFill(doc, userId)).toBeNull()
    await ImportedDocument.updateOne({ _id: importId }, { $set: { status: "checking" } })
    await resumeCheck((await ImportedDocument.findById(importId))!, userId)
    expect(await gapCrs(projectId)).toHaveLength(1)
    expect((await ImportedDocument.findById(importId))!.status).toBe("gap_review")

    // Endpoint mở lại CR bổ sung đang mở (không tạo mới), cùng shape chi tiết CR
    const again = await api.post("/change-requests/gap-fill", {})
    expect(again.status).toBe(200)
    expect(again.body.data.change_request.cr_id).toBe("CR-001")
    expect(await gapCrs(projectId)).toHaveLength(1)

    // Gap report: mục đang soạn ở CR-001
    const report = (await api.get("/gap-report")).body.data
    expect(report.layout.find((l: { heading: string }) => l.heading === "5.5 Glossary")?.drafting_cr_id).toBe("CR-001")

    // Trả lời ⇒ rõ ⇒ C-3: mỗi mục một vị trí "thêm nội dung" (không tìm theo đích / từ khoá của model)
    const answered = await api.post("/change-requests/CR-001/answers", { answers: ["In đậm cho thuật ngữ"] })
    expect(answered.body.data.change_request.status).toBe("impact_review")
    const impact = await api.post("/change-requests/CR-001/impact")
    expect(impact.status).toBe(200)
    const locations = impact.body.data.locations as { path: string; section_id: string }[]
    expect(locations.map((l) => [l.path, l.section_id])).toEqual([
      ["glossary[]", "fixed:5.5"],
      ["other_requirements[]", "slot:assumptions"],
      [`custom_sections[id=${custom.id}]`, `custom:${custom.id}`]
    ])

    const proposed = await api.post("/change-requests/CR-001/propose")
    expect(proposed.status).toBe(200)
    const proposePrompt = prompts.find((x) => x.includes("# CR Propose"))!
    expect(proposePrompt).toContain("Gap-fill CR")
    expect(proposePrompt).toContain("never copy a template's guidance")
    expect(proposePrompt).toContain(`one \`set\` of the whole element \`custom_sections[id=${custom.id}]\``)
    const verified = await api.post("/change-requests/CR-001/verify")
    expect(verified.status).toBe(200)
    expect(verified.body.data.change_request.status, JSON.stringify(verified.body.data.locations.map((l: { verify: unknown; proposal: unknown }) => [l.verify, l.proposal]))).not.toBe("proposing")
    // C-5: mọi mục đã có nội dung ⇒ không nhận xét "vẫn trống"
    expect((verified.body.data.locations as { verify: { ai_flags: { rule: string }[] } }[]).flatMap((l) => l.verify.ai_flags).map((f) => f.rule)).not.toContain("gap_section_empty")
    if (verified.body.data.change_request.status === "ready_to_submit") {
      const submitted = await api.post("/change-requests/CR-001/submit")
      expect(submitted.status, JSON.stringify(submitted.body.error)).toBe(200)
    }
    const cr = (await api.get("/change-requests/CR-001")).body.data.change_request
    expect(cr).toMatchObject({ status: "written", result_doc_version: "0.2" })

    const spine = (await spineRepository.get(projectId))!
    expect(spine.glossary.map((g) => g.term)).toContain("LMS")
    expect(spine.other_requirements.some((o) => o.kind === "assumption")).toBe(true)
    expect(spine.custom_sections.find((c) => c.id === custom.id)?.blocks[0]?.text).toBe("Bold text marks a defined term.")

    const structure = (await TemplateProfile.findOne({ projectId }).lean())!.target_structure!
    const statusOf = (id: string) => structure.sections.find((s) => s.section_id === id)?.status
    expect([statusOf("fixed:5.5"), statusOf("slot:assumptions"), statusOf(`custom:${custom.id}`)]).toEqual(["present", "present", "present"])

    // Không còn mục nào CR soạn được ⇒ 409
    const none = await api.post("/change-requests/gap-fill", {})
    expect(none.status).toBe(409)
    expect(none.body.error.code).toBe("NO_MISSING_SECTIONS")
  })

  it("huỷ CR bổ sung ⇒ endpoint tạo CR bổ sung mới cho mục còn trống", async () => {
    const { projectId, importId, api } = await setup({ start_kind: "existing", template_intent: "fixed" })
    await api.finalizeAndWait(importId)
    await api.finalizeAndWait(importId, { complete: true })
    const cancelled = await api.post("/change-requests/CR-001/cancel", { reason: "Để soạn sau, chưa cần bây giờ" })
    expect(cancelled.status).toBe(200)
    const fresh = await api.post("/change-requests/gap-fill", {})
    expect(fresh.status).toBe(201)
    expect(fresh.body.data.change_request).toMatchObject({ cr_id: "CR-002", kind: "gap_fill", status: "awaiting_answers" })
    expect(fresh.body.data.change_request.gap_sections).toHaveLength(3)
    expect((await api.get("/import")).body.data.gap_fill_cr_id).toBe("CR-002")
    expect(await gapCrs(projectId)).toHaveLength(2)
  })
})

describe("FLF-382 — luồng A / C không đổi", () => {
  it("luồng A (có sẵn · tự do): Hoàn thiện không mở CR bổ sung", async () => {
    const { projectId, importId, api } = await setup({ start_kind: "existing", template_intent: "free" })
    const first = await api.finalizeAndWait(importId)
    if (first.view?.import?.status === "incomplete") {
      expect(first.view.gap_fill_credit_estimate).toBeNull()
      await api.finalizeAndWait(importId, { complete: true })
    }
    const view = (await api.get("/import")).body.data
    expect(view.import.status).toBe("gap_review")
    expect(view.gap_fill_cr_id).toBeNull()
    expect((await ImportedDocument.findById(importId))!.gap_fill_requested).toBeNull()
    expect(await gapCrs(projectId)).toHaveLength(0)
    expect((await api.post("/change-requests/gap-fill", {})).body.error.code).toBe("NO_MISSING_SECTIONS")
  })

  it("luồng C (dự án mới · mẫu bắt buộc): dừng ở incomplete, không ước tính / không CR bổ sung", async () => {
    const { projectId, importId, api } = await setup({ start_kind: "new", template_intent: "fixed" })
    const first = await api.finalizeAndWait(importId)
    expect(first.view?.import?.status).toBe("incomplete")
    expect(first.view?.gap_fill_credit_estimate).toBeNull()
    expect(first.view?.gap_fill_cr_id).toBeNull()
    expect(await gapCrs(projectId)).toHaveLength(0)
  })
})
