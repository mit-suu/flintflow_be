/**
 * FLF-445 — chế độ 1: một nhóm cờ thành một change request. Tạo CR với `flag_ids` (kiểm cờ, gieo đích C-3), hàng việc chờ
 * quyết bỏ cờ đang thuộc CR mở, CR huỷ thì cờ quay lại hàng. Mongo thật, provider AI giả.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../src/shared/ai/providers/llm.router.js", async () => (await import("../helpers/mock-llm.js")).mockLlmRouterModule())

import { seedFixture } from "../setup.js"
import { mockOverrides, resetMockLlm } from "../helpers/mock-llm.js"
import { createMode1Project, fakeCrClarify, fakeCrPropose, fakeMode1, mode1Api } from "../helpers/mode1.js"
import { makeSrsDocx } from "../../src/modules/import/testing/srs-fixture.js"
import { changeRequestDetailSchema } from "../../src/modules/change-request/change-request.dto.js"
import { pendingQueueResponseSchema } from "../../src/modules/pipeline/pipeline.dto.js"
import { Spine } from "../../src/modules/spine/spine.model.js"

beforeEach(() => {
  resetMockLlm()
  // Model C-2 trả từ khoá rộng: CR từ nhóm cờ phải bỏ chúng, chỉ bám chỗ bị cờ
  mockOverrides.next = (p) => fakeMode1(p) ?? fakeCrClarify({ entity_paths: [], keywords: ["Passwords", "seconds"] })(p) ?? fakeCrPropose(p)
})

const flag = (id: string, over: Record<string, unknown>) => ({
  id,
  level: "yellow",
  rule_id: "missing_measurable_criteria",
  section_id: "fixed:4.2.3",
  target_id: null,
  message: `Cờ ${id}`,
  remediation_step: "S-7.2",
  opened_at_version: 1,
  resolved_at: null,
  waived_by_user: false,
  waive_reason: null,
  waived_at_version: null,
  kept_reason: null,
  kept_by: null,
  kept_at: null,
  ...over
})

const importedWithFlags = async () => {
  const seeded = await seedFixture("minimal")
  const projectId = await createMode1Project(seeded)
  const c = mode1Api(seeded, projectId)
  const id = (await c.upload(await makeSrsDocx())).body.data.import.id as string
  const fin = await c.extractAndWait(id)
  expect(fin.res.status, JSON.stringify(fin.res.body.error)).toBe(200)
  // Cờ do test đặt (không qua recompute): hai cờ mở chạm NFR-01, một cờ đã đóng, một cờ đỏ đã "giữ nguyên"
  await Spine.updateOne(
    { projectId },
    {
      $set: {
        flags: [
          flag("FX1", { target_id: "NFR-01" }),
          flag("FX2", { target_id: "nfrs[id=NFR-01]" }),
          flag("FX3", { target_id: "NFR-01", resolved_at: "2026-11-18T00:00:00.000Z" }),
          flag("FX4", { level: "red", rule_id: "dead_reference", kept_reason: "Khách hàng đã xác nhận giữ nguyên chỗ này", kept_by: "u", kept_at: "2026-11-18T00:00:00.000Z" })
        ]
      },
      // cache đọc Spine khoá theo spine_version
      $inc: { spine_version: 1 }
    }
  )
  return { c }
}

const groupBody = (flag_ids: string[]) => ({
  title: "Nhóm cờ ở Performance",
  description: "Cờ FX1\nCờ FX2",
  source: { kind: "gap_report" },
  requester: "BA Lan",
  flag_ids
})

const queueFlagIds = async (c: ReturnType<typeof mode1Api>): Promise<string[]> => {
  const res = await c.get("/pending-queue")
  expect(res.status, JSON.stringify(res.body.error)).toBe(200)
  return pendingQueueResponseSchema.parse(res.body.data).items.flatMap((i) => i.refs.flag_ids ?? [])
}

describe("FLF-445 - CR từ nhóm cờ", () => {
  it("cờ lạ ⇒ 404 FLAG_NOT_FOUND; cờ đã đóng / giữ nguyên ⇒ 400 FLAG_NOT_OPEN; lỗi không tốn mã CR", async () => {
    const { c } = await importedWithFlags()
    const unknown = await c.post("/change-requests", groupBody(["FX1", "NOPE"]))
    expect(unknown.status).toBe(404)
    expect(unknown.body.error.code).toBe("FLAG_NOT_FOUND")
    for (const closed of ["FX3", "FX4"]) {
      const res = await c.post("/change-requests", groupBody(["FX1", closed]))
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe("FLAG_NOT_OPEN")
    }
    const created = await c.post("/change-requests", groupBody(["FX1", "FX2"]))
    expect(created.status, JSON.stringify(created.body.error)).toBe(201)
    expect(changeRequestDetailSchema.parse(created.body.data).change_request.cr_id).toBe("CR-001")
  })

  it("tạo CR ⇒ lưu flag_ids, gieo đích từ phần tử của cờ; cờ rời hàng đợi; C-3 bám đúng phần tử; huỷ ⇒ cờ quay lại", async () => {
    const { c } = await importedWithFlags()
    expect(await queueFlagIds(c)).toEqual(expect.arrayContaining(["FX1", "FX2"]))

    const res = await c.post("/change-requests", groupBody(["FX1", "FX2", "FX1"]))
    expect(res.status, JSON.stringify(res.body.error)).toBe(201)
    const cr = changeRequestDetailSchema.parse(res.body.data).change_request
    expect(cr.flag_ids).toEqual(["FX1", "FX2"])
    expect(cr.source.kind).toBe("gap_report")
    expect(cr.requester).toBe("BA Lan")
    expect(cr.seed?.targets).toEqual(["nfrs[id=NFR-01]"])

    const queued = await queueFlagIds(c)
    expect(queued).not.toContain("FX1")
    expect(queued).not.toContain("FX2")

    const base = `/change-requests/${cr.cr_id}`
    expect(changeRequestDetailSchema.parse((await c.post(`${base}/clarify`)).body.data).change_request.status).toBe("impact_review")
    const impact = changeRequestDetailSchema.parse((await c.post(`${base}/impact`)).body.data)
    const nfr = impact.locations.find((l) => l.path === "nfrs[id=NFR-01]")
    expect(nfr?.found_by).toContain("spine_link")
    // Từ khoá model C-2 trả ("Passwords") bị bỏ ⇒ BR-01 không bị kéo vào
    expect(impact.locations.some((l) => l.path === "business_rules[id=BR-01]")).toBe(false)

    const cancelled = await c.post(`${base}/cancel`, { reason: "Tách nhóm lại cho gọn hơn" })
    expect(cancelled.status, JSON.stringify(cancelled.body.error)).toBe(200)
    expect(await queueFlagIds(c)).toEqual(expect.arrayContaining(["FX1", "FX2"]))
  })

  it("CR thường (không flag_ids) trả flag_ids rỗng, không có gợi ý", async () => {
    const { c } = await importedWithFlags()
    const res = await c.post("/change-requests", { title: "Faster", description: "Response 1 second", source: { kind: "verbal" }, requester: "PM" })
    expect(res.status, JSON.stringify(res.body.error)).toBe(201)
    const cr = changeRequestDetailSchema.parse(res.body.data).change_request
    expect(cr.flag_ids).toEqual([])
    expect(cr.seed).toBeNull()
  })
})
