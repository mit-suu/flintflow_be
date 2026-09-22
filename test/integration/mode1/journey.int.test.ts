/**
 * Hành trình mode 1 v3 đi một mạch (bám BPMN 2026-09-22 — Flow 1 ⇒ 3.1 ⇒ Flow 3 ⇒ Flow 6) trên Mongo in-memory
 * + provider giả:
 *
 *   import (1.1–1.10) ⇒ check + gap report (1.11–1.13) ⇒ mọi đường sửa ngoài CR bị chặn (không step, không ký v1,
 *   không waive, không áp thẳng) ⇒ CR (3.1–3.14) ⇒ version 0.x ⇒ release 1.0 (Flow 6)
 *
 * Từng chặng đã có test riêng (`chat-guard`, `step-plan`, `write`, `release`…). File này kiểm **cái mà test riêng
 * không kiểm được**: các chặng nối vào nhau đúng trên cùng một dự án (guard bật đúng lúc, version đi 0.0 → 0.x → 1.0).
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import request from "supertest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import app from "../../../src/app.js"
import { parseSse, seedFixture } from "../../setup.js"
import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { createMode1Project, fakeMode1, mode1Api } from "../../helpers/mode1.js"
import { binary, crDetail, documentXml, releaseNow, routeReplaceCr } from "../../helpers/mode1-release-p4.js"
import { fillCoreSections } from "../../helpers/mode1-v2.js"
import { makeSrsDocx } from "../../../src/modules/import/testing/srs-fixture.js"
import { stepPlanResponseSchema } from "../../../src/modules/import/import.dto.js"
import { changeRequiresCrMetaSchema } from "../../../src/modules/change-request/change-request.dto.js"
import { releaseResponseSchema, versionsResponseSchema } from "../../../src/modules/doc-version/doc-version.dto.js"
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

/** `/run` là SSE: supertest trả text thô, phải tự tách event như `test/helpers/pipeline.ts`. */
const runStep = async (c: Client, seededToken: string, projectId: string, stepId: string, sessionId: string, baseVersion: number) => {
  const res = await request(app)
    .post(`/api/v1/projects/${projectId}/steps/${stepId}/run`)
    .set("Authorization", `Bearer ${seededToken}`)
    .send({ session_id: sessionId, base_version: baseVersion })
  const isSse = String(res.headers["content-type"] ?? "").startsWith("text/event-stream")
  const events = (isSse ? parseSse(res.text ?? "") : []) as Array<Record<string, unknown> & { type: string }>
  return { status: res.status, events, errorCode: isSse ? ((events.find((e) => e.type === "error")?.code as string) ?? null) : ((res.body?.error?.code as string) ?? null) }
}

describe("mode 1 v3 — import ⇒ gap report ⇒ CR ⇒ release", () => {
  it("đi trọn luồng trên một dự án", { timeout: 180_000 }, async () => {
    const seeded = await seedFixture("minimal")
    const projectId = await createMode1Project(seeded, "Lumen journey")
    const c = mode1Api(seeded, projectId)

    // ── 1. Import: upload ⇒ xác nhận bản mới ⇒ trích ⇒ chốt field ⇒ finalize (baseline 0.0) ──────────
    const importId = (await c.upload(await makeSrsDocx())).body.data.import.id as string
    expect(await c.post("/import/confirm-latest", { import_id: importId })).toMatchObject({ status: 200 })
    await c.extractAndWait(importId)
    await c.patch("/import/fields", { import_id: importId, confirm_all: true })
    const finalize = await c.post("/import/finalize", { import_id: importId, base_version: await c.spineVersion() })
    expect(finalize.status, JSON.stringify(finalize.body.error)).toBe(200)

    const versionsAfterImport = versionsResponseSchema.parse((await c.get("/versions")).body.data)
    expect(versionsAfterImport.map((v) => v.version)).toContain("0.0")
    expect(versionsAfterImport.find((v) => v.version === "0.0")?.has_original_file, "file gốc giữ lại để tải").toBe(true)

    // ── 2. Gap report (1.13): kế hoạch step chỉ để đọc (step sở hữu field), mục FPT trống ⇒ cờ đỏ ──────
    const plan = stepPlanResponseSchema.parse((await c.get("/step-plan")).body.data).steps
    expect(plan.some((s) => s.missing), "SRS mẫu nhỏ ⇒ còn đầu mục FPT thiếu").toBe(true)
    const empties = (await redOpen(c)).filter((f) => f.rule_id === "section_empty")
    expect(empties.length, "mục FPT trống ⇒ cờ đỏ section_empty chặn release").toBeGreaterThan(0)

    // ── 3. Flow 1 không có workspace sửa tự do: step, ký v1, waive, áp thẳng đều bị chặn ──────────────
    const session = await ChatSession.create({ projectId, messages: [], is_pipeline: true })
    const version0 = await c.spineVersion()
    const run = await runStep(c, seeded.token, projectId, empties[0]!.remediation_step ?? "S-7.1", String(session._id), version0)
    expect(run.errorCode).toBe("MODE1_NO_STEPS")
    const signoff = await c.post("/baseline", { base_version: version0 })
    expect(signoff.body.error?.code).toBe("MODE1_NO_SIGNOFF")
    const waive = await c.post(`/flags/${empties[0]!.id}/waive`, { reason: "Khách chưa cần mục này ở giai đoạn đầu" })
    expect(waive.body.error?.code).toBe("MODE1_NO_WAIVE")

    const preview = await c.post("/changes/preview", { base_version: version0, ops: [{ op: "set", path: "project.vision", value: "Lumen helps small training centers run their courses online." }] })
    expect(preview.status, "xem trước chỉ đọc vẫn chạy — dùng để soạn CR").toBe(200)
    expect(preview.body.meta).toMatchObject({ requires_cr: true })
    const guarded = await c.post("/changes", { base_version: version0, instruction: "Rename actor Learner to Student" })
    expect(guarded.body.error?.code).toBe("CHANGE_REQUIRES_CR")
    expect(changeRequiresCrMetaSchema.parse(guarded.body.meta).prefill.source).toEqual({ kind: "verbal", ref: null })
    expect(await c.spineVersion(), "không lượt nào ở trên được ghi Spine").toBe(version0)
    expect((await c.get("/change-requests")).body.data, "không tự tạo CR — 3.1 là việc của BA").toEqual([])

    // ── 4. Mục trống: tạm điền thẳng DB (phase 1.4 thay bằng CR nguồn gap_report) ───────────────────────
    await fillCoreSections(projectId)
    expect(await redOpen(c)).toEqual([])

    // ── 5. CR đi hết vòng: làm rõ ⇒ vị trí ⇒ đề xuất ⇒ kiểm ⇒ nộp ⇒ duyệt ⇒ ghi ⇒ version 0.1 ──────
    routeReplaceCr("2 seconds", "1 second")
    const crId = await (async () => {
      const res = await c.post("/change-requests", { title: "Faster response", description: "Response time must be 1 second instead of 2 seconds.", source: { kind: "verbal" }, requester: "PM Lan" })
      expect(res.status, JSON.stringify(res.body.error)).toBe(201)
      return crDetail({ status: 200, body: res.body }).change_request.cr_id
    })()
    const cr = `/change-requests/${crId}`
    for (const phase of ["clarify", "impact", "propose", "verify", "submit"]) crDetail(await c.post(`${cr}/${phase}`))

    const { groups } = crDetail(await c.get(cr))
    expect(groups.length, "phải có nhóm thay đổi để duyệt").toBeGreaterThan(0)
    let written: ReturnType<typeof crDetail> | null = null
    for (const g of groups) written = crDetail(await c.post(`${cr}/groups/${g.group_id}/decision`, { decision: "approved", base_version: await c.spineVersion() }))
    expect(written?.change_request.status).toBe("written")
    expect(written?.change_request.result_doc_version, "CR duyệt xong ⇒ version minor").toBe("0.1")

    // ── 6. Release 1.0 + bản sạch tải được ─────────────────────────────────────────────────────────
    expect(await redOpen(c), "CR ghi xong không được để lại cờ đỏ").toEqual([])
    const released = await releaseNow(c)
    expect(released.status, JSON.stringify(released.body.error)).toBe(201)
    expect(releaseResponseSchema.parse(released.body.data).version.version).toBe("1.0")

    const versions = versionsResponseSchema.parse((await c.get("/versions")).body.data).map((v) => v.version)
    expect(versions, "đủ ba mốc của hành trình").toEqual(expect.arrayContaining(["0.0", "0.1", "1.0"]))

    const file = await binary(c.get("/versions/1.0/download"))
    expect(file.status, "bản release tải được").toBe(200)
    const xml = await documentXml(file.body as Buffer)
    expect(xml).toContain("1 second")
    expect(xml).not.toContain("2 seconds")
  })
})
