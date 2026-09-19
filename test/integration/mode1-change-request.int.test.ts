/**
 * Mode 1 — change request trọn luồng qua HTTP trên Mongo thật, provider AI giả (FLF-171, P2 2E):
 * log → làm rõ → impact + khoá → đề xuất → verify → nộp → duyệt một phần → file 0.1 có Track Changes + comment
 * author CR-001; khoá trùng giữa hai CR; verify trượt 3 lần ⇒ manual_fix; huỷ mở khoá.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../src/shared/ai/providers/llm.router.js", async () => (await import("../helpers/mock-llm.js")).mockLlmRouterModule())

import { seedFixture } from "../setup.js"
import { mockOverrides, resetMockLlm } from "../helpers/mock-llm.js"
import { createMode1Project, fakeCrClarify, fakeCrPropose, fakeCrProposeNoChange, fakeMode1, mode1Api } from "../helpers/mode1.js"
import { makeSrsDocx } from "../../src/modules/import/testing/srs-fixture.js"
import { changeRequestDetailSchema, listChangeRequestsResponseSchema } from "../../src/modules/change-request/change-request.dto.js"
import { DocxPackage, listComments, listRevisions, readBlocks, readStamp } from "../../src/modules/docx-ooxml/index.js"
import { DocBlock } from "../../src/modules/import/doc-block.model.js"
import { DocVersion } from "../../src/modules/doc-version/doc-version.model.js"
import { docFileStore } from "../../src/modules/doc-version/doc-file.store.js"
import { Notification } from "../../src/modules/notification/notification.model.js"
import * as spineRepository from "../../src/modules/spine/spine.repository.js"

const PERF_TARGETS = { entity_paths: ["nfrs[id=NFR-01]"], keywords: ["2 seconds", "Performance", "Business Rules"] }

let routeCr: (prompt: string) => string | undefined = () => undefined

beforeEach(() => {
  resetMockLlm()
  routeCr = (p) => fakeCrClarify(PERF_TARGETS)(p) ?? fakeCrPropose(p)
  mockOverrides.next = (p) => fakeMode1(p) ?? routeCr(p)
})

const importedProject = async () => {
  const seeded = await seedFixture("minimal")
  const projectId = await createMode1Project(seeded)
  const c = mode1Api(seeded, projectId)
  const id = (await c.upload(await makeSrsDocx())).body.data.import.id as string
  await c.post("/import/confirm-latest", { import_id: id })
  await c.extractAndWait(id)
  await c.patch("/import/fields", { import_id: id, confirm_all: true })
  const fin = await c.post("/import/finalize", { import_id: id, base_version: await c.spineVersion() })
  expect(fin.status, JSON.stringify(fin.body.error)).toBe(200)
  return { seeded, projectId, c }
}

const newCr = async (c: ReturnType<typeof mode1Api>, title = "Faster response time", description = "Response time must be 1 second instead of 2 seconds.") => {
  const res = await c.post("/change-requests", { title, description, source: { kind: "stakeholder_email", ref: "Email PM 2026-09-17" }, requester: "PM Lan" })
  expect(res.status, JSON.stringify(res.body.error)).toBe(201)
  return changeRequestDetailSchema.parse(res.body.data).change_request.cr_id
}

const detail = (res: { status: number; body: { data: unknown; error: unknown } }) => {
  expect(res.status, JSON.stringify(res.body.error)).toBe(200)
  return changeRequestDetailSchema.parse(res.body.data)
}

/** Tạo CR rồi chạy tới `ready_to_submit`. */
const crToReady = async (c: ReturnType<typeof mode1Api>) => {
  const crId = await newCr(c)
  const cr = `/change-requests/${crId}`
  expect(detail(await c.post(`${cr}/clarify`)).change_request.status).toBe("impact_review")
  const impact = detail(await c.post(`${cr}/impact`))
  const proposed = detail(await c.post(`${cr}/propose`))
  const verified = detail(await c.post(`${cr}/verify`))
  return { crId, cr, impact, proposed, verified }
}

describe("mode 1 — change request", () => {
  it("chưa có baseline ⇒ CR_REQUIRES_BASELINE; thiếu nguồn ⇒ CR_SOURCE_REQUIRED", async () => {
    const seeded = await seedFixture("minimal")
    const projectId = await createMode1Project(seeded)
    const c = mode1Api(seeded, projectId)
    const noBaseline = await c.post("/change-requests", { title: "x", description: "y", source: { kind: "verbal" }, requester: "PM" })
    expect(noBaseline.status).toBe(409)
    expect(noBaseline.body.error.code).toBe("CR_REQUIRES_BASELINE")
    const noSource = await c.post("/change-requests", { title: "x", description: "y", requester: "PM" })
    expect(noSource.status).toBe(400)
    expect(noSource.body.error.code).toBe("CR_SOURCE_REQUIRED")
  })

  it("trọn luồng: làm rõ → impact + khoá → đề xuất → verify → nộp → duyệt một phần ⇒ 0.1 có Track Changes + comment CR-001", async () => {
    const { c, projectId, seeded } = await importedProject()
    const { crId, cr, impact, proposed, verified } = await crToReady(c)
    expect(crId).toBe("CR-001")
    const list = listChangeRequestsResponseSchema.parse((await c.get("/change-requests")).body.data)
    expect(list.map((x) => x.cr_id)).toEqual(["CR-001"])
    expect((await c.get("/import")).body.data.import.status).toBe("change_requested")

    // impact: câu perf (spine_link + keyword), heading 4.2.3 + 5.1 (keyword); tất cả bị khoá bởi CR-001
    const byText = (t: string) => impact.locations.find((l) => l.block?.text.startsWith(t))!
    expect(byText("The system shall respond").found_by.sort()).toEqual(["keyword", "spine_link"])
    expect(byText("4.2.3 Performance").found_by).toEqual(["keyword"])
    expect(impact.locations.every((l) => l.block?.locked_by_cr === "CR-001")).toBe(true)

    expect(proposed.change_request.status).toBe("proposing")
    expect(proposed.groups.map((g) => g.title).sort()).toEqual(["Business Rules", "Performance"])
    expect(verified.change_request.status).toBe("ready_to_submit")
    expect(verified.locations.every((l) => l.verify?.code_ok)).toBe(true)

    const submitted = detail(await c.post(`${cr}/submit`))
    expect(submitted.change_request.status).toBe("in_review")
    expect(submitted.change_request.submitted_at).not.toBeNull()

    const perfGroup = submitted.groups.find((g) => g.title === "Performance")!
    const brGroup = submitted.groups.find((g) => g.title === "Business Rules")!
    const shortReason = await c.post(`${cr}/groups/${brGroup.group_id}/decision`, { decision: "rejected", reason: "no", base_version: 1 })
    expect(shortReason.status).toBe(400)
    const rejected = detail(await c.post(`${cr}/groups/${brGroup.group_id}/decision`, { decision: "rejected", reason: "Ngoài phạm vi bản 1.0", base_version: await c.spineVersion() }))
    expect(rejected.change_request.status).toBe("in_review")
    // group bị từ chối mở khoá ngay
    const brBlock = rejected.locations.find((l) => l.group_id === brGroup.group_id)!
    expect(brBlock.block?.locked_by_cr).toBeNull()

    const written = detail(await c.post(`${cr}/groups/${perfGroup.group_id}/decision`, { decision: "approved", base_version: await c.spineVersion() }))
    expect(written.change_request).toMatchObject({ status: "written", result_doc_version: "0.1" })

    // version 0.1: Track Changes + comment author CR-001, stamp 0.1, text mới
    const v01 = await DocVersion.findOne({ projectId, version: "0.1" }).lean()
    expect(v01).toMatchObject({ kind: "cr_revision", based_on: "0.0", cr_ids: ["CR-001"] })
    const pkg = await DocxPackage.load(await docFileStore().load(v01!.file_ref))
    expect(await readStamp(pkg)).toMatchObject({ project_id: projectId, version: "0.1", source: "cr_revision" })
    const revs = await listRevisions(pkg)
    expect(revs.length).toBeGreaterThan(0)
    expect(new Set(revs.map((r) => r.author))).toEqual(new Set(["CR-001"]))
    expect((await listComments(pkg)).map((x) => x.author)).toEqual(["CR-001"])
    const blocks = await readBlocks(pkg)
    expect(blocks.find((b) => b.text.startsWith("The system shall respond"))?.text).toBe("The system shall respond within 1 second for 95% of requests.")

    // block của 0.1: text mới, mọi khoá đã mở; Spine có op của CR
    const newBlocks = await DocBlock.find({ projectId, doc_version: "0.1" }).lean()
    expect(newBlocks.find((b) => b.text.includes("1 second"))).toBeDefined()
    expect(await DocBlock.countDocuments({ projectId, locked_by_cr: "CR-001" })).toBe(0)
    const spine = (await spineRepository.get(projectId))!
    expect(spine.nfrs.find((n) => n.id === "NFR-01")?.threshold).toBe("1 s")
    const changes = await spineRepository.listChanges(projectId)
    expect(changes.find((ch) => ch.path === "nfrs[id=NFR-01].threshold")).toMatchObject({ by: "CR-001", reason: "CR-001: Faster response time" })
    expect(await Notification.countDocuments({ userId: seeded.userId, type: "change_request_decided" })).toBe(2)
  })

  it("hai CR cùng chạm một block ⇒ CR thứ hai nhận 409 BLOCK_LOCKED; huỷ CR-001 ⇒ mở khoá, CR-002 khoá được", async () => {
    const { c } = await importedProject()
    const first = await newCr(c)
    detail(await c.post(`/change-requests/${first}/clarify`))
    detail(await c.post(`/change-requests/${first}/impact`))
    const second = await newCr(c, "Tighter performance", "Also about the 2 seconds response time.")
    detail(await c.post(`/change-requests/${second}/clarify`))
    const locked = await c.post(`/change-requests/${second}/impact`)
    expect(locked.status).toBe(409)
    expect(locked.body.error.code).toBe("BLOCK_LOCKED")
    expect(locked.body.meta.locked[0].cr_id).toBe("CR-001")
    // CR-002 không giữ khoá nào sau khi thất bại
    expect(detail(await c.get(`/change-requests/${second}`)).locations).toEqual([])

    const cancelled = detail(await c.post(`/change-requests/${first}/cancel`, { reason: "Trùng với CR khác" }))
    expect(cancelled.change_request.status).toBe("cancelled")
    expect(cancelled.locations.every((l) => l.block?.locked_by_cr === null)).toBe(true)
    const retry = detail(await c.post(`/change-requests/${second}/impact`))
    expect(retry.locations.every((l) => l.block?.locked_by_cr === "CR-002")).toBe(true)
  })

  it("verify trượt 3 lần ⇒ manual_fix; sửa tay ⇒ verify đạt", async () => {
    routeCr = (p) => fakeCrClarify(PERF_TARGETS)(p) ?? fakeCrProposeNoChange(p)
    const { c } = await importedProject()
    const crId = await newCr(c)
    const cr = `/change-requests/${crId}`
    detail(await c.post(`${cr}/clarify`))
    detail(await c.post(`${cr}/impact`))
    const statuses: string[] = []
    for (let i = 0; i < 3; i++) {
      detail(await c.post(`${cr}/propose`))
      statuses.push(detail(await c.post(`${cr}/verify`)).change_request.status)
    }
    expect(statuses).toEqual(["proposing", "proposing", "manual_fix"])
    const d = detail(await c.get(cr))
    const perf = d.locations.find((l) => l.block?.text.startsWith("The system shall respond"))!
    expect(perf.redo_count).toBe(2)
    expect(perf.verify?.violations[0].rule).toBe("edit_no_change")

    for (const l of d.locations) {
      const body =
        l.location_id === perf.location_id
          ? { conclusion: "edit", new_text: "The system shall respond within 1 second for 95% of requests." }
          : { conclusion: "not_related", reason: "Không liên quan tới thời gian phản hồi" }
      detail(await c.patch(`${cr}/locations/${l.location_id}`, body))
    }
    const ok = detail(await c.post(`${cr}/verify`))
    expect(ok.change_request.status).toBe("ready_to_submit")
    expect(ok.locations.find((l) => l.location_id === perf.location_id)).toMatchObject({ manual: true, verify: { code_ok: true } })
  })

  it("CR mơ hồ ⇒ hỏi lại; trả lời ⇒ chạy lại C-2 và đi tiếp; sai số câu trả lời ⇒ 400", async () => {
    const { c } = await importedProject()
    const crId = await newCr(c, "Change the login", "AMBIGUOUS-CR: change the login somehow.")
    const cr = `/change-requests/${crId}`
    const asked = detail(await c.post(`${cr}/clarify`))
    expect(asked.change_request.status).toBe("awaiting_answers")
    expect(asked.pending_questions).toEqual(["Which screen?"])
    expect((await c.post(`${cr}/answers`, { answers: ["a", "b"] })).status).toBe(400)
    const answered = detail(await c.post(`${cr}/answers`, { answers: ["The login screen SCR-01"] }))
    expect(answered.change_request.status).toBe("impact_review")
    expect(answered.change_request.clarifications[0]).toMatchObject({ round: 1, answers: ["The login screen SCR-01"] })
  })

  it("hết credit ở C-4 ⇒ paused; nạp rồi resume đi tiếp", async () => {
    const { c, seeded } = await importedProject()
    const crId = await newCr(c)
    const cr = `/change-requests/${crId}`
    detail(await c.post(`${cr}/clarify`))
    detail(await c.post(`${cr}/impact`))
    const { CreditWallet } = await import("../../src/modules/credits/credit-wallet.model.js")
    await CreditWallet.updateOne({ userId: seeded.userId }, { $set: { balance: 0 } })
    const paused = detail(await c.post(`${cr}/propose`))
    expect(paused.change_request).toMatchObject({ status: "proposing", paused: { reason: "credits" } })
    await CreditWallet.updateOne({ userId: seeded.userId }, { $set: { balance: 100 } })
    const resumed = detail(await c.post(`${cr}/resume`))
    expect(resumed.change_request.paused).toBeNull()
    expect(resumed.groups.length).toBeGreaterThan(0)
  })
})
