/**
 * Hành trình mode 1 v3 đi một mạch trên **một** dự án, đúng thứ tự nút BPMN (`doc/flintflow-business-flow (1).bpmn`)
 * — Mongo in-memory + provider giả (phase 6.1 của `claude_plan/mode1-v3/phase-6-test-tai-lieu.md`):
 *
 *   1.1 upload ⇒ 1.2/1.3 kiểm file ⇒ 1.5/1.6 map ⇒ 1.8 trích ⇒ 1.9 xác nhận ⇒ 1.10 v0 (0.0) ⇒ 1.11 AI check ⇒ 1.12 luật
 *   ⇒ 1.13 gap report
 *   ⇒ 3.1 CR nguồn `gap_report` (mục FPT trống) ⇒ 3.2 ⇒ 3.4 ⇒ 3.5 ⇒ 3.6 ⇒ 3.7 ⇒ 3.8 ⇒ 3.11 ⇒ 3.12 (lý do) ⇒ 3.14 ⇒ **0.1**
 *     + bản có đánh dấu (tác giả = CR id)
 *   ⇒ xem trước lệnh sửa ⇒ 3.1 nguồn `verbal` kèm `preview_id` ⇒ … ⇒ 3.14 ⇒ **0.2**
 *   ⇒ 6.1 (0 cờ đỏ) ⇒ 6.2 ⇒ **1.0** bản sạch có stamp
 *   ⇒ upload lại file 1.0 (có stamp) ⇒ 1.4 diff ⇒ 3.1 nguồn `reupload`.
 *
 * Từng chặng có test riêng (`finalize`, `write`, `cr-seed`, `release`, `reupload`…). File này kiểm **cái mà test riêng
 * không kiểm được**: các chặng nối vào nhau đúng trên cùng một dự án (guard bật đúng lúc, version 0.0 → 0.1 → 0.2 → 1.0,
 * file tải về của chặng trước là đầu vào hợp lệ của chặng sau).
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import request from "supertest"
import JSZip from "jszip"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import app from "../../../src/app.js"
import { parseSse, seedFixture } from "../../setup.js"
import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { createMode1Project, fakeCrClarify, fakeMode1, mode1Api, promptLocations } from "../../helpers/mode1.js"
import { binary, crDetail, documentXml, releaseNow, routeReplaceCr } from "../../helpers/mode1-release-p4.js"
import { fillCoreSections } from "../../helpers/mode1-v2.js"
import { makeSrsDocx, SRS_FIXTURE_TEXT } from "../../../src/modules/import/testing/srs-fixture.js"
import { gapReportSchema, reuploadResponseSchema, stepPlanResponseSchema } from "../../../src/modules/import/import.dto.js"
import { changeRequiresCrMetaSchema } from "../../../src/modules/change-request/change-request.dto.js"
import { releaseResponseSchema, versionsResponseSchema } from "../../../src/modules/doc-version/doc-version.dto.js"
import { DocxPackage, readStamp } from "../../../src/modules/docx-ooxml/index.js"
import type { Flag } from "../../../src/modules/spine/spine.types.js"
import { ChatSession } from "../../../src/modules/project/chat-session.model.js"

type Client = ReturnType<typeof mode1Api>

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = (p) => fakeMode1(p)
})

const redOpen = async (c: Client): Promise<Flag[]> => {
  const res = await c.get("/flags?level=red&open=true")
  expect(res.status, JSON.stringify(res.body.error)).toBe(200)
  return res.body.data as Flag[]
}

/** `/run` là SSE: supertest trả text thô, phải tự tách event như `test/helpers/pipeline.ts`. Trả mã lỗi (nếu có). */
const runStep = async (seededToken: string, projectId: string, stepId: string, sessionId: string, baseVersion: number) => {
  const res = await request(app)
    .post(`/api/v1/projects/${projectId}/steps/${stepId}/run`)
    .set("Authorization", `Bearer ${seededToken}`)
    .send({ session_id: sessionId, base_version: baseVersion })
  const isSse = String(res.headers["content-type"] ?? "").startsWith("text/event-stream")
  const events = (isSse ? parseSse(res.text ?? "") : []) as Array<Record<string, unknown> & { type: string }>
  return isSse ? ((events.find((e) => e.type === "error")?.code as string) ?? null) : ((res.body?.error?.code as string) ?? null)
}

/** 3.1 ⇒ 3.2 ⇒ 3.4/3.5 ⇒ 3.6 ⇒ 3.7/3.8 ⇒ 3.11 ⇒ 3.12 (duyệt mọi group, kèm lý do) ⇒ 3.14. Trả CR đã ghi. */
const runCrToWritten = async (c: Client, body: Record<string, unknown>) => {
  const created = await c.post("/change-requests", body)
  expect(created.status, JSON.stringify(created.body.error)).toBe(201)
  const crId = crDetail({ status: 200, body: created.body }).change_request.cr_id
  const cr = `/change-requests/${crId}`
  expect(crDetail(await c.post(`${cr}/clarify`)).change_request.status, "3.2 rõ ⇒ 3.4").toBe("impact_review")
  const impact = crDetail(await c.post(`${cr}/impact`))
  expect(impact.locations.length, "3.4 tìm vị trí, 3.5 khoá").toBeGreaterThan(0)
  crDetail(await c.post(`${cr}/propose`)) // 3.6 (+ 3.7 dựng nhóm)
  expect(crDetail(await c.post(`${cr}/verify`)).change_request.status, "3.8 qua ⇒ 3.11").toBe("ready_to_submit")
  const { groups } = crDetail(await c.post(`${cr}/submit`))
  expect(groups.length, "phải có nhóm thay đổi để duyệt").toBeGreaterThan(0)
  // 3.12: duyệt không kèm lý do ⇒ 400 (BPMN "quyết định từng group, kèm lý do")
  const noReason = await c.post(`${cr}/groups/${groups[0]!.group_id}/decision`, { decision: "approved", base_version: await c.spineVersion() })
  expect(noReason.status).toBe(400)
  let last: ReturnType<typeof crDetail> | null = null
  for (const g of groups) last = crDetail(await c.post(`${cr}/groups/${g.group_id}/decision`, { decision: "approved", reason: "Đúng yêu cầu của khách", base_version: await c.spineVersion() }))
  expect(last?.change_request.status, "3.14 ghi xong").toBe("written")
  return { crId, impact, written: last! }
}

/** Provider giả cho CR bổ sung mục 5.4 đang trống: C-2 trỏ `fixed:5.4`, C-4 thêm một other_requirement. */
const routeGapCr = () => {
  mockOverrides.next = (p) =>
    fakeMode1(p) ??
    fakeCrClarify({ entity_paths: ["fixed:5.4"], keywords: [] })(p) ??
    (p.includes("# CR Propose")
      ? JSON.stringify({
          locations: promptLocations(p).map((l) =>
            l.path === "other_requirements[]"
              ? { location_id: l.location_id, conclusion: "edit", reason: "Mục còn trống", spine_ops: [{ op: "add", path: "other_requirements[]", value: { id: "OR-01", kind: "assumption", statement: "The system runs on Chrome 120 or newer." } }] }
              : { location_id: l.location_id, conclusion: "not_related", reason: "Khác", spine_ops: [] }
          )
        })
      : undefined)
}

const download = async (c: Client, path: string) => {
  const res = await binary(c.get(path))
  expect(res.status, `tải ${path}`).toBe(200)
  return res.body as Buffer
}

describe("mode 1 v3 — hành trình BPMN trên một dự án", () => {
  it("1.1 → 1.13 ⇒ CR gap_report (0.1 + bản đánh dấu) ⇒ CR từ bản xem trước (0.2) ⇒ release 1.0 ⇒ upload lại ⇒ CR reupload", { timeout: 240_000 }, async () => {
    const seeded = await seedFixture("minimal")
    const projectId = await createMode1Project(seeded, "Lumen journey")
    const c = mode1Api(seeded, projectId)

    // ── Flow 1: 1.1 upload ⇒ 1.2/1.3 preflight ⇒ 1.5/1.6 map (confirm-latest) ⇒ 1.8 trích ⇒ 1.9 ⇒ 1.10 v0 ─────────
    const importId = (await c.upload(await makeSrsDocx())).body.data.import.id as string
    expect(await c.post("/import/confirm-latest", { import_id: importId })).toMatchObject({ status: 200 })
    await c.extractAndWait(importId)
    expect((await c.patch("/import/fields", { import_id: importId, confirm_all: true })).status).toBe(200)
    const finalize = await c.post("/import/finalize", { import_id: importId, base_version: await c.spineVersion() })
    expect(finalize.status, JSON.stringify(finalize.body.error)).toBe(200)

    const versions0 = versionsResponseSchema.parse((await c.get("/versions")).body.data)
    expect(versions0.map((v) => v.version)).toEqual(["0.0"])
    expect(versions0[0]!.has_original_file, "file gốc giữ lại để tải").toBe(true)

    // ── 1.11 + 1.12 ⇒ 1.13 gap report: mục FPT trống ⇒ cờ đỏ section_empty ────────────────────────────────
    const gap = gapReportSchema.parse((await c.get("/gap-report")).body.data)
    expect(gap.doc_version).toBe("0.0")
    expect(gap.missing_fpt_sections.map((s) => s.section_id)).toContain("fixed:5.4")
    expect(gap.totals.red).toBeGreaterThan(0)
    const plan = stepPlanResponseSchema.parse((await c.get("/step-plan")).body.data).steps
    expect(plan.some((s) => s.missing), "kế hoạch step chỉ để đọc — còn đầu mục thiếu").toBe(true)
    const empties = (await redOpen(c)).filter((f) => f.rule_id === "section_empty")
    expect(empties.some((f) => f.section_id === "fixed:5.4")).toBe(true)

    // Import xong ⇒ mọi đường sửa ngoài CR bị chặn: step, ký v1, waive, áp thẳng
    const session = await ChatSession.create({ projectId, messages: [], is_pipeline: true })
    const v0 = await c.spineVersion()
    expect(await runStep(seeded.token, projectId, empties[0]!.remediation_step ?? "S-7.1", String(session._id), v0)).toBe("MODE1_NO_STEPS")
    expect((await c.post("/baseline", { base_version: v0 })).body.error?.code).toBe("MODE1_NO_SIGNOFF")
    expect((await c.post(`/flags/${empties[0]!.id}/waive`, { reason: "Khách chưa cần mục này ở giai đoạn đầu" })).body.error?.code).toBe("MODE1_NO_WAIVE")
    const guarded = await c.post("/changes", { base_version: v0, instruction: "Rename actor Learner to Student" })
    expect(guarded.body.error?.code).toBe("CHANGE_REQUIRES_CR")
    expect(changeRequiresCrMetaSchema.parse(guarded.body.meta).prefill.source).toEqual({ kind: "verbal", ref: null })
    expect(await c.spineVersion(), "không lượt nào ở trên được ghi Spine").toBe(v0)
    expect((await c.get("/change-requests")).body.data, "không tự tạo CR — 3.1 là việc của BA").toEqual([])

    // ── 3.1 nguồn gap_report ⇒ … ⇒ 3.14 ⇒ 0.1 ────────────────────────────────────────────────────────────
    routeGapCr()
    const gapCr = await runCrToWritten(c, {
      title: "Fill Other Requirements",
      description: "Gap report: section 5.4 Other Requirements is empty — add the browser assumption.",
      source: { kind: "gap_report", ref: "fixed:5.4" },
      requester: "BA Minh"
    })
    expect(gapCr.written.change_request.result_doc_version, "CR đầu ⇒ 0.1").toBe("0.1")
    expect((await redOpen(c)).some((f) => f.rule_id === "section_empty" && f.section_id === "fixed:5.4"), "mục có dữ liệu ⇒ cờ đóng").toBe(false)

    // Bản có đánh dấu của 0.1: Track Changes đứng tên CR (3.14); bản thường không có đánh dấu
    const tracked = await documentXml(await download(c, "/versions/0.1/download?variant=tracked"))
    expect(tracked).toMatch(new RegExp(`<w:ins [^>]*w:author="${gapCr.crId}"`))
    expect(tracked).toContain("Chrome 120")
    expect(await documentXml(await download(c, "/versions/0.1/download"))).not.toContain("<w:ins ")

    // Các mục FPT còn trống khác: điền thẳng DB cho gọn (mỗi mục một CR như trên — đã phủ ở write.int)
    await fillCoreSections(projectId)
    expect(await redOpen(c), "đủ mục ⇒ 0 cờ đỏ").toEqual([])

    // ── Panel "Sửa tài liệu có xem trước" ⇒ 3.1 nguồn verbal kèm preview_id ⇒ … ⇒ 3.14 ⇒ 0.2 ─────────────
    const nfr = ((await c.get("/spine")).body.data.nfrs as { id: string; statement: string }[]).find((n) => n.statement === SRS_FIXTURE_TEXT.perf)
    expect(nfr, "NFR hiệu năng từ file import").toBeTruthy()
    const nfrPath = `nfrs[id=${nfr!.id}]`
    const preview = await c.post("/changes/preview", { base_version: await c.spineVersion(), ops: [{ op: "set", path: `${nfrPath}.statement`, value: "The system shall respond within 1 second for 95% of requests." }] })
    expect(preview.status, JSON.stringify(preview.body.error)).toBe(200)
    expect(preview.body.meta).toMatchObject({ requires_cr: true })
    routeReplaceCr("2 seconds", "1 second")
    const previewCr = await runCrToWritten(c, {
      title: "Faster response",
      description: "Response time must be 1 second instead of 2 seconds.",
      source: { kind: "verbal" },
      requester: "PM Lan",
      preview_id: preview.body.data.preview_id
    })
    expect(previewCr.written.change_request.seed?.targets, "bản xem trước đi theo CR làm gợi ý").toContain(nfrPath)
    expect(previewCr.impact.locations.find((l) => l.path === nfrPath)?.found_by, "C-3 lấy phần tử bản xem trước chạm").toContain("preview")
    expect(previewCr.written.change_request.result_doc_version).toBe("0.2")

    // ── 6.1 cờ đỏ = 0 ⇒ 6.2 release ⇒ 1.0 bản sạch có stamp ─────────────────────────────────────────────
    expect(await redOpen(c), "CR ghi xong không để lại cờ đỏ").toEqual([])
    const released = await releaseNow(c)
    expect(released.status, JSON.stringify(released.body.error)).toBe(201)
    expect(releaseResponseSchema.parse(released.body.data).version.version).toBe("1.0")
    const versions = versionsResponseSchema.parse((await c.get("/versions")).body.data).map((v) => v.version)
    expect(versions, "đủ các mốc của hành trình").toEqual(expect.arrayContaining(["0.0", "0.1", "0.2", "1.0"]))

    const v1 = await download(c, "/versions/1.0/download")
    const v1Xml = await documentXml(v1)
    expect(v1Xml).toContain("1 second")
    expect(v1Xml).not.toContain("2 seconds")
    expect(v1Xml, "bản release là bản sạch").not.toContain("<w:ins ")
    expect(await readStamp(await DocxPackage.load(v1))).toEqual({ project_id: projectId, version: "1.0", source: "release" })

    // ── Upload lại file 1.0 khách đã sửa (còn stamp) ⇒ 1.4 diff ⇒ 3.1 nguồn reupload ───────────────────────
    const zip = await JSZip.loadAsync(v1)
    zip.file("word/document.xml", v1Xml.split("1 second").join("500 milliseconds"))
    const spineBefore = await c.spineVersion()
    const reup = await c.upload(await zip.generateAsync({ type: "nodebuffer" }), "Lumen_v1.0_khach-sua.docx", "/reupload")
    expect(reup.status, JSON.stringify(reup.body.error)).toBe(201)
    const diff = reuploadResponseSchema.parse(reup.body.data)
    expect(diff.against_version).toBe("1.0")
    expect(diff.summary.modified, "đoạn khách sửa ⇒ diff 'sửa'").toBeGreaterThan(0)
    expect(await c.spineVersion(), "1.4 không tự ghi Spine").toBe(spineBefore)

    const reuploadCr = await c.post("/change-requests", {
      title: "Customer edits from v1.0",
      description: "Customer changed the response time to 500 milliseconds in the uploaded file.",
      source: { kind: "reupload", ref: diff.id },
      requester: "Khách hàng"
    })
    expect(reuploadCr.status, JSON.stringify(reuploadCr.body.error)).toBe(201)
    expect(crDetail({ status: 200, body: reuploadCr.body }).change_request).toMatchObject({ status: "draft", source: { kind: "reupload", ref: diff.id } })
  })
})
