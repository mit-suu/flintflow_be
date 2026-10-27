/**
 * Gói duyệt mode 1 (FLF-330, business-flow §3.2 C-6 / C-7 — CR kiểu GitHub) qua HTTP trên Mongo thật + provider giả:
 * BA xác nhận CR ⇒ ghi ngay vào bản nháp; Analyst gửi gói ⇒ bản nháp khoá, Lead nhận thông báo; Lead yêu cầu sửa ⇒ mở
 * khoá; gửi lại ⇒ Lead duyệt cả gói = phát hành 1.0; Lead tự làm thì phát hành thẳng; còn cờ đỏ thì không gửi được.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { User } from "../../../src/modules/user/user.model.js"
import { Membership } from "../../../src/modules/organization/membership.model.js"
import { Notification } from "../../../src/modules/notification/notification.model.js"
import { reviewPackageSchema, releaseResponseSchema } from "../../../src/modules/doc-version/doc-version.dto.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"
import { applyTransaction } from "../../../src/modules/spine/op-engine.js"
import { authAs, type SeededFixture } from "../../setup.js"
import { resetMockLlm } from "../../helpers/mock-llm.js"
import { mode1Api } from "../../helpers/mode1.js"
import { createCr, crDetail, importedProject, releaseNow, routeReplaceCr, writeCr, type Mode1Api } from "../../helpers/mode1-release-p4.js"

const joinOrg = async (orgId: string, role: "lead" | "analyst") => {
  const email = `${role}-${Date.now()}@flintflow.test`
  const user = await User.create({ email, password: "test-password-123", emailVerified: true })
  await Membership.create({ organizationId: orgId, userId: user._id, role })
  return { id: String(user._id), token: await authAs({ _id: user._id, email, orgId }) }
}
const apiAs = (seeded: SeededFixture, token: string, projectId: string) => mode1Api({ ...seeded, token }, projectId)

const pkg = async (c: Mode1Api) => {
  const res = await c.get("/review-package")
  expect(res.status, JSON.stringify(res.body.error)).toBe(200)
  return reviewPackageSchema.parse(res.body.data)
}
const submitPkg = async (c: Mode1Api) => c.post("/review-package/submit", { base_version: await c.spineVersion() })

const addRedFlag = async (projectId: string) => {
  const spine = (await spineRepository.get(projectId))!
  await applyTransaction(projectId, {
    base_version: spine.spine_version,
    by: "test",
    ops: [
      {
        op: "add",
        path: "diagrams[]",
        value: { id: "D01", kind: "erd", format: "puml", source: "@startuml\n@enduml", section: "fixed:3.1.5", owner_kind: null, owner_id: null, render_status: "error", error: "boom", source_hash: "x", rendered_at: null }
      }
    ]
  })
}

const notificationsOf = async (userId: string, type: string, n: number) => {
  await vi.waitFor(async () => expect(await Notification.countDocuments({ userId, type })).toBe(n), { timeout: 3000 })
  return Notification.find({ userId, type }).sort({ createdAt: 1 }).lean()
}

beforeEach(() => {
  resetMockLlm()
  routeReplaceCr("2 seconds", "1 second")
})

describe("C-6 — BA xác nhận là ghi ngay vào bản nháp (CR = commit)", () => {
  it("3 CR xác nhận ⇒ bản nháp 'v0 · 3 thay đổi chưa duyệt', không có bước Lead duyệt từng CR, gói liệt kê đúng thứ tự", async () => {
    const { seeded, projectId, c } = await importedProject()
    const analyst = await joinOrg(seeded.orgId, "analyst")
    const a = apiAs(seeded, analyst.token, projectId)

    expect(await pkg(a)).toMatchObject({ status: "drafting", base_version: "v0", draft_label: "v0", change_requests: [] })

    const first = await writeCr(a, "Nhanh hơn", "1 second instead of 2 seconds")
    expect(first).toEqual({ crId: "CR-001", version: "0.2" })
    routeReplaceCr("1 second", "500 ms")
    await writeCr(a, "Nhanh nữa", "500 ms instead of 1 second")
    routeReplaceCr("500 ms", "300 ms")
    await writeCr(a, "Nhanh nhất", "300 ms instead of 500 ms")

    const p = await pkg(a)
    expect(p.status).toBe("drafting")
    expect(p.draft_label).toBe("v0 · 3 thay đổi chưa duyệt")
    expect(p.change_requests.map((x) => x.cr_id)).toEqual(["CR-001", "CR-002", "CR-003"])
    expect(p.change_requests[0]).toMatchObject({ requester: "PM", source: { kind: "verbal" }, result_doc_version: "0.2" })
    expect(p.next_version).toBe("1.0")
    expect(p.submission).toBeNull()
    await notificationsOf(analyst.id, "change_request_written", 3)
  })
})

describe("C-7 — gói duyệt kiểu pull request", () => {
  it("Analyst gửi ⇒ pending, bản nháp khoá (không tạo / xác nhận CR), Lead nhận thông báo; gửi lại ⇒ 409", async () => {
    const { seeded, projectId, c } = await importedProject()
    const analyst = await joinOrg(seeded.orgId, "analyst")
    const a = apiAs(seeded, analyst.token, projectId)
    await writeCr(a, "Nhanh hơn", "1 second instead of 2 seconds")

    const sent = await submitPkg(a)
    expect(sent.status, JSON.stringify(sent.body.error)).toBe(200)
    expect(reviewPackageSchema.parse(sent.body.data)).toMatchObject({ status: "pending", submission: { status: "pending", submitted_by: analyst.id } })

    // bản nháp khoá: tạo CR mới và xác nhận đều bị chặn
    const blocked = await a.post("/change-requests", { title: "Thêm nữa", description: "x", source: { kind: "verbal" }, requester: "PM" })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.code).toBe("PACKAGE_PENDING")
    expect((await submitPkg(a)).body.error.code).toBe("PACKAGE_ALREADY_SUBMITTED")

    const [n] = await notificationsOf(seeded.userId, "review_package_submitted", 1)
    expect(n.title).toContain("1 thay đổi chờ bạn duyệt")
    expect(n.meta).toMatchObject({ cr_ids: ["CR-001"] })
  })

  it("Lead yêu cầu sửa ⇒ mở khoá, người gửi được báo; BA hoàn tác bằng CR mới rồi gửi lại ⇒ Lead duyệt cả gói = phát hành 1.0, gói có đủ CR", async () => {
    const { seeded, projectId, c } = await importedProject()
    const analyst = await joinOrg(seeded.orgId, "analyst")
    const a = apiAs(seeded, analyst.token, projectId)
    await writeCr(a, "Nhanh hơn", "1 second instead of 2 seconds")
    expect((await submitPkg(a)).status).toBe(200)

    // Analyst không được yêu cầu sửa / phát hành
    expect((await a.post("/review-package/request-changes", { base_version: await a.spineVersion(), reason: "Chưa đúng ý khách hàng" })).status).toBe(403)
    expect((await releaseNow(a)).status).toBe(403)

    const changes = await c.post("/review-package/request-changes", { base_version: await c.spineVersion(), reason: "Giữ 1 giây là quá gắt, hãy đổi lại 2 giây" })
    expect(changes.status, JSON.stringify(changes.body.error)).toBe(200)
    expect(reviewPackageSchema.parse(changes.body.data)).toMatchObject({ status: "changes_requested", submission: { status: "rejected", reason: "Giữ 1 giây là quá gắt, hãy đổi lại 2 giây" } })
    const [n] = await notificationsOf(analyst.id, "review_package_changes_requested", 1)
    expect(n.body).toContain("2 giây")

    // mở khoá: hoàn tác cũng là một CR mới
    routeReplaceCr("1 second", "2 seconds")
    await writeCr(a, "Hoàn tác", "2 seconds instead of 1 second")
    expect((await pkg(a)).change_requests.map((x) => x.cr_id)).toEqual(["CR-001", "CR-002"])
    expect((await submitPkg(a)).status).toBe(200)

    const rel = await releaseNow(c)
    expect(rel.status, JSON.stringify(rel.body.error)).toBe(201)
    const released = releaseResponseSchema.parse(rel.body.data)
    expect(released.cr_ids).toEqual(["CR-001", "CR-002"])
    expect(released.version.version).toBe("1.0")
    const after = await pkg(c)
    expect(after).toMatchObject({ status: "drafting", base_version: "1.0", draft_label: "1.0", change_requests: [], submission: null })
    expect((await spineRepository.get(projectId))!.baseline_submission).toBeNull()
    await notificationsOf(analyst.id, "review_package_released", 1)
  })

  it("còn cờ đỏ ⇒ không gửi được (422 RELEASE_RED_FLAGS_OPEN, nêu cờ); chưa có CR ⇒ 409 PACKAGE_EMPTY", async () => {
    const { seeded, projectId, c } = await importedProject()
    const empty = await submitPkg(c)
    expect(empty.status).toBe(409)
    expect(empty.body.error.code).toBe("PACKAGE_EMPTY")

    await writeCr(c, "Nhanh hơn", "1 second instead of 2 seconds")
    await addRedFlag(projectId)
    const blocked = await submitPkg(c)
    expect(blocked.status).toBe(422)
    expect(blocked.body.error.code).toBe("RELEASE_RED_FLAGS_OPEN")
    expect(blocked.body.meta.flags.map((f: { rule_id: string }) => f.rule_id)).toContain("render_error")
    expect((await pkg(c)).red_open).toBeGreaterThan(0)
  })

  it("Lead tự làm ⇒ phát hành thẳng, không qua bước gửi; CR đã ghi trước FLF-330 (in_review) vẫn duyệt được qua group", async () => {
    const { projectId, c } = await importedProject()
    await writeCr(c, "Nhanh hơn", "1 second instead of 2 seconds")
    expect((await pkg(c)).status).toBe("drafting")
    const rel = await releaseNow(c)
    expect(rel.status, JSON.stringify(rel.body.error)).toBe(201)
    expect(releaseResponseSchema.parse(rel.body.data).version.version).toBe("1.0")
    expect((await spineRepository.get(projectId))!.baseline_submission).toBeNull()
    expect((await pkg(c)).base_version).toBe("1.0")
  })
})

describe("helper", () => {
  it("createCr vẫn cho tạo khi không có gói chờ", async () => {
    const { c } = await importedProject()
    expect(await createCr(c, "A", "1 second instead of 2 seconds")).toBe("CR-001")
    expect(crDetail(await c.get("/change-requests/CR-001")).change_request.status).toBe("draft")
  })
})
