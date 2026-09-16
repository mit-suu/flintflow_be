/**
 * op-engine (T22) — endpoint 7, 8, 10, 11 qua HTTP trên Mongo replica set thật:
 * 10 ca op T02, khoá lạc quan `base_version`, ghi đồng thời, undo.
 */
import { describe, it, expect } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { seedFixture, type SeededFixture } from "../setup.js"
import { OP_CASE_FILES, applyOverrides, loadOpCase, userWritableOps } from "../helpers/op-cases.js"
import { applyResultResponseSchema, changesPreviewResponseSchema } from "../../src/modules/pipeline/pipeline.dto.js"
import { Change } from "../../src/modules/spine/change.model.js"
import { Spine } from "../../src/modules/spine/spine.model.js"

const post = (seeded: SeededFixture, suffix: string, body: object) =>
  request(app).post(`/api/v1/projects/${seeded.projectId}${suffix}`).set("Authorization", `Bearer ${seeded.token}`).send(body)

const actorOp = (id: string) => ({
  op: "add",
  path: "actors[]",
  value: { id, name: `Actor ${id}`, kind: "human", description: "Integration test actor." },
  reason: "integration test"
})

describe("10 ca op T02 qua POST /changes", () => {
  for (const file of OP_CASE_FILES) {
    const opCase = loadOpCase(file)
    const title = opCase.must_reject ? `từ chối ${opCase.must_reject}` : "áp được và ghi change"

    it(`${file} — ${opCase.name}: ${title}`, async () => {
      const seeded = await seedFixture("full", { mutate: (spine) => applyOverrides(spine, opCase.spine_before_overrides) })
      // Ca 03/06 kèm op vào `sections`/`progress` (path hệ thống quản lý: op engine tự cascade / tự nối
      // hàng đợi). User gửi qua /changes chỉ được phần user ghi được — phần còn lại engine phải tự sinh.
      const ops = opCase.must_reject ? opCase.expected_ops : userWritableOps(opCase.expected_ops)
      const res = await post(seeded, "/changes", { base_version: seeded.spineVersion, ops })

      if (opCase.must_reject) {
        expect(res.status).toBe(422)
        const rules = ((res.body.meta?.violations ?? []) as Array<{ rule: string }>).map((v) => v.rule)
        expect(rules).toContain(opCase.must_reject)
        // Bị từ chối ⇒ không ghi gì
        expect(await Change.countDocuments({ projectId: seeded.projectId })).toBe(0)
        const stored = await Spine.findOne({ projectId: seeded.projectId }).lean()
        expect(stored?.spine_version).toBe(seeded.spineVersion)
        return
      }

      expect(res.status, JSON.stringify(res.body.error)).toBe(200)
      const result = applyResultResponseSchema.parse(res.body.data)
      // Ghi flags sau transaction cũng tăng version (flags.service) ⇒ chỉ chắc chắn tăng
      expect(result.spine_version).toBeGreaterThan(seeded.spineVersion)
      // Engine tự sinh phần hệ thống quản lý (cascade, hàng đợi màn) ⇒ số change ≥ số op của ca
      expect(result.changes.length).toBeGreaterThanOrEqual(opCase.expected_ops.length)
      const spine = result.spine as unknown as Record<string, Array<{ id: string }>> & { progress: { screen_queue: string[] } }
      if (file === "case-03.json") {
        expect(spine.screens.some((x) => x.id === "S08")).toBe(false)
        expect(spine.functions.some((x) => x.id === "FN034")).toBe(false)
        expect(spine.sections.some((x) => x.id === "function:FN034")).toBe(false)
      }
      if (file === "case-06.json") {
        const added = (opCase.expected_ops[0].value as { id: string }).id
        expect(spine.progress.screen_queue).toContain(added)
      }
      // Cộng thêm change của transaction flags ghi sau (nếu có)
      expect(await Change.countDocuments({ projectId: seeded.projectId })).toBeGreaterThanOrEqual(result.changes.length)
    })
  }
})

describe("khoá lạc quan và lịch sử change", () => {
  it("preview không ghi gì; apply tăng spine_version; base_version cũ ⇒ 409 SPINE_VERSION_CONFLICT", async () => {
    const seeded = await seedFixture("full")
    const ops = [actorOp("A90")]

    const preview = await post(seeded, "/changes/preview", { base_version: seeded.spineVersion, ops })
    expect(preview.status).toBe(200)
    expect(changesPreviewResponseSchema.parse(preview.body.data).ok).toBe(true)
    expect(await Change.countDocuments({ projectId: seeded.projectId })).toBe(0)

    const applied = await post(seeded, "/changes", { base_version: seeded.spineVersion, ops })
    expect(applied.status).toBe(200)

    const stale = await post(seeded, "/changes", { base_version: seeded.spineVersion, ops: [actorOp("A91")] })
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe("SPINE_VERSION_CONFLICT")
  })

  it("hai request cùng base_version gửi đồng thời ⇒ đúng một request thắng, seq không trùng", async () => {
    const seeded = await seedFixture("full")
    const [a, b] = await Promise.all([
      post(seeded, "/changes", { base_version: seeded.spineVersion, ops: [actorOp("A92")] }),
      post(seeded, "/changes", { base_version: seeded.spineVersion, ops: [actorOp("A93")] })
    ])

    expect([a.status, b.status].sort()).toEqual([200, 409])
    const stored = await Spine.findOne({ projectId: seeded.projectId }).lean()
    const actorIds = ((stored?.actors ?? []) as Array<{ id: string }>).map((x) => x.id)
    expect(actorIds.filter((id) => id === "A92" || id === "A93")).toHaveLength(1)

    const seqs = (await Change.find({ projectId: seeded.projectId }).lean()).map((c) => c.seq)
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it("GET /changes trả seq tăng dần; POST /undo đảo transaction cuối về Spine ban đầu", async () => {
    const seeded = await seedFixture("full")
    const before = await Spine.findOne({ projectId: seeded.projectId }).lean()

    const applied = await post(seeded, "/changes", { base_version: seeded.spineVersion, ops: [actorOp("A94")] })
    expect(applied.status).toBe(200)

    const list = await request(app).get(`/api/v1/projects/${seeded.projectId}/changes`).set("Authorization", `Bearer ${seeded.token}`)
    expect(list.status).toBe(200)
    const seqs = (list.body.data as Array<{ seq: number }>).map((c) => c.seq)
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y))

    const undo = await post(seeded, "/undo", { base_version: applied.body.data.spine_version })
    expect(undo.status, JSON.stringify(undo.body.error)).toBe(200)
    const reverted = applyResultResponseSchema.parse(undo.body.data)
    expect(reverted.changes.every((c) => c.op === "revert")).toBe(true)
    expect(reverted.spine.actors).toEqual(before?.actors)
  })

  it("path hệ thống quản lý (flags) ⇒ 422 path_not_writable", async () => {
    const seeded = await seedFixture("full")
    const res = await post(seeded, "/changes", {
      base_version: seeded.spineVersion,
      ops: [{ op: "set", path: "progress.current_step", value: "S-9.5", reason: "integration test" }]
    })
    expect(res.status).toBe(422)
    expect(JSON.stringify(res.body.meta)).toContain("path_not_writable")
  })
})
