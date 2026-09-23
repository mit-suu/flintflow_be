/**
 * Hành trình mode 1 v2 đi một mạch (V6, plan §10) trên Mongo in-memory + provider giả:
 *
 *   import ⇒ workspace (kế hoạch step + cờ) ⇒ chạy step ⇒ sửa qua chat ⇒ ký baseline v1
 *   ⇒ chat sau v1 thành CR ⇒ duyệt CR ⇒ version 0.x ⇒ release 1.0
 *
 * Từng chặng đã có test riêng (`step-plan`, `write`, `release`…). File này kiểm **cái mà test riêng không
 * kiểm được**: các chặng nối vào nhau đúng trên cùng một dự án — trạng thái một chặng để lại là đầu vào hợp lệ
 * của chặng sau (cờ đóng đúng lúc, guard bật đúng lúc, version đi đúng 0.0 → 0.x → 1.0).
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import request from "supertest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import app from "../../../src/app.js"
import { parseSse, seedFixture } from "../../setup.js"
import { findOpCase, mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { createMode1Project, fakeMode1, mode1Api } from "../../helpers/mode1.js"
import { binary, crDetail, documentXml, releaseNow, routeReplaceCr } from "../../helpers/mode1-release-p4.js"
import { fillCoreSections } from "../../helpers/mode1-v2.js"
import { makeSrsDocx } from "../../../src/modules/import/testing/srs-fixture.js"
import { stepPlanResponseSchema } from "../../../src/modules/import/import.dto.js"
import { changeRequiresCrMetaSchema } from "../../../src/modules/change-request/change-request.dto.js"
import { gateResponseSchema, stepEventSchema, stepsResponseSchema } from "../../../src/modules/pipeline/pipeline.dto.js"
import { releaseResponseSchema, versionsResponseSchema } from "../../../src/modules/doc-version/doc-version.dto.js"
import type { Flag } from "../../../src/modules/spine/spine.types.js"
import { ChatSession } from "../../../src/modules/project/chat-session.model.js"

type Client = ReturnType<typeof mode1Api>

/** Step có op-case fixture chỉ `add` vào một mảng — chạy được trên Spine import mà không cần id dựng sẵn. */
const SELF_CONTAINED_STEPS = new Set(["S-6.3", "S-6.4", "S-7.2", "S-7.3", "S-7.4"])

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

describe("mode 1 v2 — import ⇒ step ⇒ chat ⇒ v1 ⇒ CR ⇒ release", () => {
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

    // ── 2. Workspace: kế hoạch step theo template + cờ đỏ của đầu mục FPT còn thiếu (D6) ─────────────
    const plan = stepPlanResponseSchema.parse((await c.get("/step-plan")).body.data).steps
    expect(plan.some((s) => s.state === "applied"), "step có section trong template ⇒ applied").toBe(true)
    expect(plan.some((s) => s.state === "hidden"), "Brief không sinh đầu mục ⇒ ẩn").toBe(true)
    const missingSteps = new Set(plan.filter((s) => s.missing).map((s) => s.step_id))
    expect(missingSteps.size, "SRS mẫu nhỏ ⇒ còn đầu mục FPT thiếu").toBeGreaterThan(0)

    const listed = stepsResponseSchema.parse((await c.get("/steps")).body.data).steps
    expect(listed.some((s) => s.status === "skipped"), "/steps không trả step ẩn").toBe(false)

    const flagsAfterImport = await redOpen(c)
    const empties = flagsAfterImport.filter((f) => f.rule_id === "section_empty")
    expect(empties.length, "mục FPT trống ⇒ cờ đỏ section_empty chặn ký v1").toBeGreaterThan(0)

    // ── 3. Chạy một step đang thiếu ⇒ cờ của chính mục đó phải đóng ─────────────────────────────────
    // Chỉ chọn trong các step mà op-case fixture **thuần thêm mới** (`add` vào một mảng, không trỏ tới id có
    // sẵn): fixture của step khác được viết cho chuỗi mode 2 nên tham chiếu id mà Spine import không có.
    const target = empties.find((f) => f.remediation_step !== null && missingSteps.has(f.remediation_step) && SELF_CONTAINED_STEPS.has(f.remediation_step) && findOpCase(f.remediation_step) !== null)
    expect(target, `phải có mục thiếu chạy được bằng op-case thuần thêm mới; đang thiếu: ${empties.map((f) => f.remediation_step).join(", ")}`).toBeDefined()
    const stepId = target!.remediation_step as string

    const session = await ChatSession.create({ projectId, messages: [], is_pipeline: true })
    const run = await runStep(c, seeded.token, projectId, stepId, String(session._id), await c.spineVersion())
    expect(run.errorCode, `${stepId}: ${JSON.stringify(run.events.at(-1))}`).toBeNull()
    run.events.forEach((e) => stepEventSchema.parse(e))
    const gateReady = run.events.at(-1)
    expect(gateReady?.type).toBe("gate_ready")

    // L11: version của gate_ready phải là version CUỐI (sau render + recompute cờ), cao hơn `ops_applied` —
    // FE lấy đúng nó thì lượt `/run` sau không gửi base_version cũ rồi ăn 409 SPINE_VERSION_CONFLICT.
    const opsVersion = run.events.filter((e) => e.type === "ops_applied").map((e) => e.spine_version as number)
    expect(gateReady?.spine_version, "gate_ready mang version cuối").toBe(await c.spineVersion())
    if (opsVersion.length) expect(gateReady?.spine_version as number).toBeGreaterThan(Math.max(...opsVersion))
    // L11b: step này vừa ghi dữ liệu thật ⇒ không báo lô rỗng, không còn mục trống
    expect(gateReady?.wrote_ops).toBe(true)
    expect(gateReady?.empty_sections).toEqual([])

    // Cờ được tính lại ở CUỐI lượt chạy (step-runner), không phải lúc accept — nên nó phải tắt ngay ở đây.
    expect((await redOpen(c)).some((f) => f.rule_id === "section_empty" && f.section_id === target!.section_id), `cờ của ${target!.section_id} phải đóng sau khi step ghi dữ liệu`).toBe(false)

    const gate = await request(app)
      .post(`/api/v1/projects/${projectId}/steps/${stepId}/gate`)
      .set("Authorization", `Bearer ${seeded.token}`)
      .send({ session_id: String(session._id), action: "accept", base_version: await c.spineVersion() })
    expect(gate.status, JSON.stringify(gate.body.error)).toBe(200)
    expect(gateResponseSchema.parse(gate.body.data).step.status).toBe("accepted")

    // ── 4. Trước v1: sửa thẳng qua chat được phép (D3) ──────────────────────────────────────────────
    const beforeChange = await c.spineVersion()
    // Import đã tạo baseline 0.0 ⇒ nhánh `post_baseline`: lô nào cũng phải kèm `reason` (vào Record of Changes).
    const changed = await c.post("/changes", {
      base_version: beforeChange,
      reason: "Làm rõ tầm nhìn sau khi đọc lại bản import",
      ops: [{ op: "set", path: "project.vision", value: "Lumen helps small training centers run their courses online.", reason: "journey" }]
    })
    expect(changed.status, JSON.stringify(changed.body.error)).toBe(200)
    expect(await c.spineVersion()).toBeGreaterThan(beforeChange)

    // ── 5. Ký baseline v1: còn cờ đỏ ⇒ chặn; hết cờ ⇒ ký được ───────────────────────────────────────
    expect((await redOpen(c)).length, "vẫn còn mục FPT khác trống").toBeGreaterThan(0)
    const blocked = await c.post("/baseline", { base_version: await c.spineVersion() })
    expect(blocked.status).toBe(422)
    expect(blocked.body.error.code).toBe("BASELINE_BLOCKED")

    // Điền nốt các mục còn trống như người dùng đã chạy hết step thiếu
    await fillCoreSections(projectId)
    expect(await redOpen(c)).toEqual([])
    const signed = await c.post("/baseline", { base_version: await c.spineVersion() })
    expect(signed.status, JSON.stringify(signed.body.error)).toBe(201)

    // ── 6. Sau v1: lệnh sửa trong chat không ghi thẳng nữa mà đẻ ra CR nguồn verbal (BR-03, nợ T8) ──
    const afterV1 = await c.spineVersion()
    const guarded = await c.post("/changes", { base_version: afterV1, instruction: "Rename actor Learner to Student" })
    expect(guarded.status).toBe(409)
    expect(guarded.body.error.code).toBe("CHANGE_REQUIRES_CR")
    const meta = changeRequiresCrMetaSchema.parse(guarded.body.meta)
    expect(meta.change_request?.cr_id, "lệnh sửa sau v1 tạo sẵn CR để mở ra làm").toBeTruthy()
    expect(await c.spineVersion(), "Spine không được đổi trong lượt bị chặn").toBe(afterV1)

    // ── 7. CR đi hết vòng: làm rõ ⇒ vị trí ⇒ đề xuất ⇒ kiểm ⇒ nộp ⇒ duyệt ⇒ ghi ⇒ version 0.1 ──────
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

    // ── 8. Release 1.0 + bản sạch tải được ─────────────────────────────────────────────────────────
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
