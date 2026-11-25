/**
 * Luật CR của business-flow §3.2 trên Mongo thật, provider AI giả: C-1 mỗi người một CR mở, C-3 liệt kê đủ + báo chi phí,
 * C-4 cảnh báo / "Vẫn làm", C-5 "giữ theo ý mình" (cờ đỏ thật sau khi ghi), C-6 kiểm lại lúc xác nhận (cả đường tự ghi mức
 * "Chỉ ở mốc chốt"), CR có xoá không tự ghi, hoàn tác = CR mới, gửi duyệt gói không bị CR mở chặn.
 * Hàm thuần có test ở `src/modules/change-request/cr-flow-rules.test.ts` và `revert-cr.service.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import mongoose from "mongoose"
import { PERF_TARGETS, crToImpact, crToReady, detail, importedProject, newCr, resetCrMock, routeCr, type Mode1Client } from "../../helpers/mode1-cr-p4.js"
import { fakeCrClarify, fakeCrPropose, promptLocations } from "../../helpers/mode1.js"
import { ChangeLocation } from "../../../src/modules/change-request/change-location.model.js"
import { assertNoOwnOpenCr } from "../../../src/modules/change-request/change-request.service.js"
import { loadOutOfScopeSections } from "../../../src/modules/change-request/out-of-scope.js"
import { Spine } from "../../../src/modules/spine/spine.model.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"

const NFR = "nfrs[id=NFR-01]"
const NO_FINDINGS = JSON.stringify({ findings: [] })
const noAi = (p: string): string | undefined => (p.includes("# CR Consistency") ? NO_FINDINGS : undefined)

beforeEach(() => resetCrMock((p) => noAi(p) ?? fakeCrClarify(PERF_TARGETS)(p) ?? fakeCrPropose(p)))

const actorsOf = async (projectId: string) => (await spineRepository.get(projectId))!.actors

/** C-2 nhắm một actor; C-4 đổi tên actor đó thành `name`, vị trí khác not_related. */
const routeRenameActor = (actorPath: string, name: string) =>
  routeCr(
    (p) =>
      noAi(p) ??
      fakeCrClarify({ entity_paths: [actorPath], keywords: [] })(p) ??
      (p.includes("# CR Propose")
        ? JSON.stringify({
            locations: promptLocations(p).map((l) =>
              l.path === actorPath
                ? { location_id: l.location_id, conclusion: "edit", reason: "Rename", spine_ops: [{ op: "set", path: `${actorPath}.name`, value: name }] }
                : { location_id: l.location_id, conclusion: "not_related", reason: "Khác", spine_ops: [] }
            )
          })
        : undefined)
  )

describe("C-1 mỗi người một CR mở", () => {
  it("đã có CR chưa xong ⇒ 409 CR_OWN_OPEN kèm mã CR đó; huỷ xong thì tạo được; người khác không bị chặn", async () => {
    const { c, projectId, seeded } = await importedProject()
    const first = await newCr(c)
    const blocked = await c.post("/change-requests", { title: "Thêm", description: "Đổi nữa", source: { kind: "verbal" }, requester: "PM" })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.code).toBe("CR_OWN_OPEN")
    expect(blocked.body.meta.cr_id).toBe(first)

    // Người khác (không có CR mở) không liên quan tới CR của người này
    await expect(assertNoOwnOpenCr(projectId, String(new mongoose.Types.ObjectId()))).resolves.toBeUndefined()
    await expect(assertNoOwnOpenCr(projectId, seeded.userId)).rejects.toMatchObject({ code: "CR_OWN_OPEN", statusCode: 409 })

    expect((await c.post(`/change-requests/${first}/cancel`, { reason: "Không làm nữa nhé" })).status).toBe(200)
    expect(await newCr(c)).toBe("CR-002")
  })
})

describe("C-3 liệt kê đủ, báo trước chi phí C-4", () => {
  it("CR hơn 80 vị trí ở bước xem phạm vi ⇒ detail có propose_estimate (số lô × giá một lô); ít hơn thì null", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr, impact } = await crToImpact(c)
    expect(impact.propose_estimate ?? null).toBeNull()
    const base = await ChangeLocation.countDocuments({ projectId, cr_id: crId })
    const extra = 85
    await ChangeLocation.insertMany(
      Array.from({ length: extra }, (_, i) => ({
        projectId,
        cr_id: crId,
        location_id: `L${String(base + i + 1).padStart(3, "0")}`,
        path: `glossary[id=GX${i}]`,
        section_id: "fixed:5.5",
        found_by: ["keyword"],
        owner_step: "S-7.5"
      }))
    )
    const big = detail(await c.get(cr))
    expect(big.locations.length).toBe(base + extra)
    // 85 vị trí cùng chủ sở hữu ⇒ 22 lô × 3 credit, cộng các vị trí gốc
    expect(big.propose_estimate).toMatchObject({ locations: base + extra })
    expect(big.propose_estimate!.batches).toBeGreaterThanOrEqual(Math.ceil(extra / 4))
    expect(big.propose_estimate!.credits).toBe(big.propose_estimate!.batches * 3)
  })

  it("loadOutOfScopeSections đọc các mục custom:* ngoài phạm vi của so cấu trúc đích", async () => {
    const { projectId } = await importedProject()
    await TemplateProfile.updateOne(
      { projectId },
      {
        $set: {
          target_structure: {
            target: "template",
            intent: "free",
            resolved_mode: 1,
            missing: [],
            compared_at: new Date().toISOString(),
            sections: [
              { section_id: "custom:CS01", title: "Phụ lục", status: "out_of_scope", owner_steps: [] },
              { section_id: "fixed:2.1", title: "Actors", status: "present", owner_steps: [] }
            ]
          }
        }
      }
    )
    expect([...(await loadOutOfScopeSections(String(projectId)))]).toEqual(["custom:CS01"])
  })
})

describe("C-4 cảnh báo và Vẫn làm", () => {
  it("AI cảnh báo ⇒ chỗ đó chỉ có ghi chú, chặn xác nhận; BA chọn Vẫn làm ⇒ kept_intent và AI soạn theo yêu cầu, xác nhận ghi được", async () => {
    routeCr((p) => {
      if (noAi(p)) return noAi(p)
      if (!p.includes("# CR Propose")) return fakeCrClarify(PERF_TARGETS)(p)
      const proceed = p.includes("read your warning for this location")
      return JSON.stringify({
        locations: promptLocations(p).map((l) =>
          l.path === NFR
            ? {
                location_id: l.location_id,
                conclusion: "edit",
                reason: "Đổi ngưỡng",
                spine_ops: [{ op: "set", path: `${NFR}.threshold`, value: "1 s" }],
                ...(proceed ? {} : { warning: { text: "Ngưỡng 1 s khó đạt.", reason: "Máy chủ hiện tại không đáp ứng." } })
              }
            : { location_id: l.location_id, conclusion: "not_related", reason: "Khác", spine_ops: [] }
        )
      })
    })
    const { c } = await importedProject()
    const { cr } = await crToImpact(c)
    detail(await c.post(`${cr}/propose`))
    const verified = detail(await c.post(`${cr}/verify`))
    expect(verified.change_request.status).toBe("ready_to_submit")
    const warned = verified.locations.find((l) => l.path === NFR)!
    expect(warned).toMatchObject({ conclusion: "comment", warning: { text: "Ngưỡng 1 s khó đạt." }, kept_intent: false })
    expect(warned.proposal!.spine_ops).toEqual([])

    const early = await c.post(`${cr}/submit`)
    expect(early.status).toBe(409)
    expect(early.body.error.code).toBe("CR_WARNING_PENDING")

    const proceeded = detail(await c.patch(`${cr}/locations/${warned.location_id}`, { action: "proceed" }))
    const loc = proceeded.locations.find((l) => l.path === NFR)!
    expect(loc).toMatchObject({ conclusion: "edit", kept_intent: true })
    expect(loc.proposal!.spine_ops).toHaveLength(1)

    expect(detail(await c.post(`${cr}/verify`)).change_request.status).toBe("ready_to_submit")
    expect(detail(await c.post(`${cr}/submit`)).change_request.status).toBe("written")
  })

  it("C-2 cảnh báo, người yêu cầu bấm Vẫn làm ⇒ mọi vị trí C-3 có kept_intent, C-4 không cảnh báo lại", async () => {
    const WARN = "Ngưỡng 1 s khó đạt với máy chủ hiện tại. Bạn vẫn muốn làm?"
    routeCr((p) => {
      if (noAi(p)) return noAi(p)
      if (p.includes("# CR Clarify")) {
        // Vòng 1 cảnh báo; vòng sau (đã có câu trả lời) đi tiếp
        return p.includes(WARN)
          ? JSON.stringify({ ambiguous: false, questions: [], targets: PERF_TARGETS })
          : JSON.stringify({ ambiguous: false, questions: [], warnings: [{ question: WARN, suggestions: ["Vẫn làm", "Bỏ yêu cầu này"] }], targets: PERF_TARGETS })
      }
      if (!p.includes("# CR Propose")) return undefined
      const proceed = p.includes("read your warning for this location")
      return JSON.stringify({
        locations: promptLocations(p).map((l) =>
          l.path === NFR
            ? {
                location_id: l.location_id,
                conclusion: "edit",
                reason: "Đổi ngưỡng",
                spine_ops: [{ op: "set", path: `${NFR}.threshold`, value: "1 s" }],
                ...(proceed ? {} : { warning: { text: "Ngưỡng 1 s khó đạt.", reason: "Máy chủ hiện tại không đáp ứng." } })
              }
            : { location_id: l.location_id, conclusion: "not_related", reason: "Khác", spine_ops: [] }
        )
      })
    })
    const { c } = await importedProject()
    const crId = await newCr(c)
    const cr = `/change-requests/${crId}`
    const asked = detail(await c.post(`${cr}/clarify`))
    expect(asked.change_request.status).toBe("awaiting_answers")
    expect(asked.change_request.clarifications[0].questions).toEqual([WARN])

    expect(detail(await c.post(`${cr}/answers`, { answers: ["Vẫn làm"] })).change_request.status).toBe("impact_review")
    const impact = detail(await c.post(`${cr}/impact`))
    expect(impact.locations.length).toBeGreaterThan(0)
    expect(impact.locations.every((l) => l.kept_intent)).toBe(true)

    const proposed = detail(await c.post(`${cr}/propose`))
    expect(proposed.locations.find((l) => l.path === NFR)).toMatchObject({ conclusion: "edit", warning: null })
  })

  it("proceed ở chỗ không có cảnh báo ⇒ 409 CR_NO_WARNING", async () => {
    const { c } = await importedProject()
    const { cr } = await crToImpact(c)
    const proposed = detail(await c.post(`${cr}/propose`))
    const res = await c.patch(`${cr}/locations/${proposed.locations[0].location_id}`, { action: "proceed" })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("CR_NO_WARNING")
  })
})

describe("C-5 giữ theo ý mình", () => {
  const toManualFix = async (c: Mode1Client, cr: string) => {
    for (let i = 0; i < 3; i++) {
      detail(await c.post(`${cr}/propose`))
      detail(await c.post(`${cr}/verify`))
    }
    return detail(await c.get(cr))
  }

  it("lỗi luật (cờ đỏ mới) sau 2 lần AI sửa ⇒ manual_fix; giữ theo ý mình ⇒ qua kiểm, ghi được, cờ đỏ thật hiện trên Spine; chữ cũ không khớp thì không giữ được", async () => {
    const { c, projectId } = await importedProject()
    const [learner, admin] = await actorsOf(projectId)
    expect(learner.name).toBe("Learner")
    const adminPath = `actors[id=${admin.id}]`
    routeRenameActor(adminPath, learner.name) // hai actor trùng tên ⇒ cờ đỏ duplicate_name
    const { cr } = await crToImpact(c)
    const stuck = await toManualFix(c, cr)
    expect(stuck.change_request.status).toBe("manual_fix")
    const loc = stuck.locations.find((l) => l.path === adminPath)!
    expect(loc.verify!.violations.every((v) => v.rule === "new_red_flag")).toBe(true)

    // Lỗi không phải lỗi luật (chữ cũ không còn khớp) ⇒ không giữ được
    await Spine.updateOne({ projectId, "actors.id": admin.id }, { $set: { "actors.$.description": "Edited elsewhere" }, $inc: { spine_version: 1 } })
    const outdated = detail(await c.post(`${cr}/verify`))
    const stale = outdated.locations.find((l) => l.path === adminPath)!
    expect(stale.verify!.violations.map((v) => v.rule)).toContain("value_changed")
    const refused = await c.patch(`${cr}/locations/${loc.location_id}`, { action: "keep" })
    expect(refused.status).toBe(409)
    expect(refused.body.error.code).toBe("CR_CANNOT_KEEP")
  })

  it("giữ theo ý mình rồi ghi: CR written, cờ đỏ duplicate_name thật còn trên Spine và chặn Gửi duyệt gói", async () => {
    const { c, projectId } = await importedProject()
    const [learner, admin] = await actorsOf(projectId)
    const adminPath = `actors[id=${admin.id}]`
    routeRenameActor(adminPath, learner.name)
    const { cr } = await crToImpact(c)
    const stuck = await toManualFix(c, cr)
    expect(stuck.change_request.status).toBe("manual_fix")
    const loc = stuck.locations.find((l) => l.path === adminPath)!

    const kept = detail(await c.patch(`${cr}/locations/${loc.location_id}`, { action: "keep" }))
    expect(kept.locations.find((l) => l.path === adminPath)).toMatchObject({ kept_violations: ["new_red_flag"], manual: true })
    expect(detail(await c.post(`${cr}/verify`)).change_request.status).toBe("ready_to_submit")
    expect(detail(await c.post(`${cr}/submit`)).change_request.status).toBe("written")

    const after = (await spineRepository.get(projectId))!
    expect(after.actors.find((a) => a.id === admin.id)!.name).toBe(learner.name)
    expect(after.flags.some((f) => f.level === "red" && f.rule_id === "duplicate_name" && f.resolved_at === null)).toBe(true)
    const pkg = await c.post("/review-package/submit", { base_version: await c.spineVersion() })
    expect(pkg.status).toBe(422)
    expect(pkg.body.error.code).toBe("RELEASE_RED_FLAGS_OPEN")
  })
})

describe("C-6 kiểm lại lúc xác nhận", () => {
  it("Spine đổi giữa lúc kiểm và lúc xác nhận làm đề xuất sinh cờ đỏ mới ⇒ về manual_fix, không ghi", async () => {
    const { c, projectId } = await importedProject()
    const [learner, admin] = await actorsOf(projectId)
    const adminPath = `actors[id=${admin.id}]`
    routeRenameActor(adminPath, "Teacher")
    const { cr } = await crToImpact(c)
    detail(await c.post(`${cr}/propose`))
    expect(detail(await c.post(`${cr}/verify`)).change_request.status).toBe("ready_to_submit")
    // Người khác đổi actor kia thành đúng tên mà CR sắp đặt (chỗ khác, không đụng phần tử của CR)
    await Spine.updateOne({ projectId, "actors.id": learner.id }, { $set: { "actors.$.name": "Teacher" }, $inc: { spine_version: 1 } })
    const submitted = detail(await c.post(`${cr}/submit`))
    expect(submitted.change_request.status).toBe("manual_fix")
    expect(submitted.locations.find((l) => l.path === adminPath)!.verify).toMatchObject({ code_ok: false })
    expect((await spineRepository.get(projectId))!.actors.find((a) => a.id === admin.id)!.name).toBe(admin.name)
  })

  it("mức Chỉ ở mốc chốt: CR còn lỗi luật BA giữ theo ý mình không tự ghi, chờ BA xác nhận", async () => {
    const { c, projectId } = await importedProject()
    const [learner, admin] = await actorsOf(projectId)
    const adminPath = `actors[id=${admin.id}]`
    expect((await c.patch("/review-mode", { review_mode: "milestones" })).status).toBe(200)
    routeRenameActor(adminPath, learner.name)
    const { cr } = await crToImpact(c)
    // Đề xuất trùng tên ⇒ kiểm C-5 chặn tới manual_fix; giữ theo ý mình xong CR qua kiểm nhưng không tự ghi (BA phải xem)
    for (let i = 0; i < 3; i++) {
      detail(await c.post(`${cr}/propose`))
      detail(await c.post(`${cr}/verify`))
    }
    const stuck = detail(await c.get(cr))
    expect(stuck.change_request.status).toBe("manual_fix")
    const loc = stuck.locations.find((l) => l.path === adminPath)!
    detail(await c.patch(`${cr}/locations/${loc.location_id}`, { action: "keep" }))
    const verified = detail(await c.post(`${cr}/verify`))
    expect(verified.change_request.status).toBe("ready_to_submit")
    expect((await spineRepository.get(projectId))!.actors.find((a) => a.id === admin.id)!.name).toBe(admin.name)
  })
})

describe("mức Chỉ ở mốc chốt: CR có xoá nội dung không tự ghi", () => {
  it("đề xuất có op remove ⇒ dừng ở ready_to_submit chờ BA; BA xác nhận thì ghi", async () => {
    const { c, projectId } = await importedProject()
    expect((await c.patch("/review-mode", { review_mode: "milestones" })).status).toBe(200)
    routeCr(
      (p) =>
        noAi(p) ??
        fakeCrClarify({ entity_paths: ["business_rules[id=BR-01]"], keywords: [] })(p) ??
        (p.includes("# CR Propose")
          ? JSON.stringify({
              locations: promptLocations(p).map((l) =>
                l.path === "business_rules[id=BR-01]"
                  ? { location_id: l.location_id, conclusion: "edit", reason: "Bỏ quy tắc", spine_ops: [{ op: "remove", path: "business_rules[id=BR-01]" }] }
                  : { location_id: l.location_id, conclusion: "not_related", reason: "Khác", spine_ops: [] }
              )
            })
          : undefined)
    )
    const { cr } = await crToImpact(c)
    detail(await c.post(`${cr}/propose`))
    const verified = detail(await c.post(`${cr}/verify`))
    expect(verified.change_request.status).toBe("ready_to_submit")
    expect((await spineRepository.get(projectId))!.business_rules.some((r) => r.id === "BR-01")).toBe(true)
    expect(detail(await c.post(`${cr}/submit`)).change_request.status).toBe("written")
    expect((await spineRepository.get(projectId))!.business_rules.some((r) => r.id === "BR-01")).toBe(false)
  })
})

describe("gửi duyệt gói không bị CR mở chặn", () => {
  it("còn CR chưa xong của mình mà gói có thay đổi đã ghi và không cờ đỏ ⇒ gửi duyệt được (BE chỉ chặn cờ đỏ)", async () => {
    const { c } = await importedProject()
    const ready = await crToReady(c)
    expect(detail(await c.post(`${ready.cr}/submit`)).change_request.status).toBe("written")
    const open = await newCr(c)
    expect(detail(await c.get(`/change-requests/${open}`)).change_request.status).toBe("draft")
    const sent = await c.post("/review-package/submit", { base_version: await c.spineVersion() })
    expect(sent.status, JSON.stringify(sent.body.error)).toBe(200)
  })
})

describe("hoàn tác = CR mới", () => {
  it("CR chưa ghi ⇒ 409 CR_REVERT_NOT_WRITTEN; CR đã ghi ⇒ CR nguồn revert dựng từ giá trị trước, xác nhận xong nội dung về như cũ", async () => {
    const { c, projectId } = await importedProject()
    const before = (await spineRepository.get(projectId))!.nfrs.find((n) => n.id === "NFR-01")!
    const ready = await crToReady(c)
    const notYet = await c.post(`${ready.cr}/revert`, { requester: "PM" })
    expect(notYet.status).toBe(409)
    expect(notYet.body.error.code).toBe("CR_REVERT_NOT_WRITTEN")

    expect(detail(await c.post(`${ready.cr}/submit`)).change_request.status).toBe("written")
    const changed = (await spineRepository.get(projectId))!.nfrs.find((n) => n.id === "NFR-01")!
    expect(changed.threshold).toBe("1 s")

    const res = await c.post(`${ready.cr}/revert`, { requester: "PM" })
    expect(res.status, JSON.stringify(res.body.error)).toBe(201)
    const reverted = detail({ status: 200, body: res.body })
    expect(reverted.change_request.source).toMatchObject({ kind: "revert", ref: ready.crId })
    expect(reverted.change_request.status).toBe("ready_to_submit")
    const nfr = reverted.locations.find((l) => l.path === NFR)!
    expect(nfr).toMatchObject({ conclusion: "edit" })

    const revertCr = `/change-requests/${reverted.change_request.cr_id}`
    expect(detail(await c.post(`${revertCr}/submit`)).change_request.status).toBe("written")
    const back = (await spineRepository.get(projectId))!.nfrs.find((n) => n.id === "NFR-01")!
    expect(back.threshold).toBe(before.threshold)
    expect(back.statement).toBe(before.statement)
  })
})
