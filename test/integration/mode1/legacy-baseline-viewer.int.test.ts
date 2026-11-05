/**
 * Project cũ có bản gốc `0.0` (trước khi bản import đổi thành `0.1`): CR đầu tiên ghi ra bản nháp `0.1`.
 * Bản nháp đó trùng số với bản gốc của project mới, nhưng vẫn là bản nháp ⇒ Viewer không được tải (UC-50).
 * Viewer vẫn tải được bản gốc `0.0`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { resetMockLlm } from "../../helpers/mock-llm.js"
import { importedProject, routeReplaceCr, writeCr } from "../../helpers/mode1-release-p4.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import { Membership } from "../../../src/modules/organization/membership.model.js"

beforeEach(() => {
  resetMockLlm()
  routeReplaceCr("2 seconds", "1 second")
})

/** Đưa lịch sử version về dạng project cũ: bản gốc `0.0`, bản nháp CR đầu tiên `0.1`. */
const asLegacyProject = async (projectId: string) => {
  await DocVersion.updateOne({ projectId, kind: "imported" }, { $set: { version: "0.0" } })
  await DocVersion.updateOne({ projectId, kind: "cr_revision", version: "0.2" }, { $set: { version: "0.1", based_on: "0.0" } })
}

describe("project cũ ở 0.0 — quyền tải của Viewer", () => {
  it("Viewer tải được bản gốc 0.0, không tải được bản nháp CR 0.1", async () => {
    const { seeded, projectId, c } = await importedProject()
    expect(await writeCr(c, "Faster", "1 second instead of 2 seconds")).toEqual({ crId: "CR-001", version: "0.2" })
    await asLegacyProject(projectId)

    const versions = (await c.get("/versions")).body.data.map((v: { version: string; kind: string }) => [v.version, v.kind])
    expect(versions).toEqual([["0.1", "cr_revision"], ["0.0", "imported"]])

    await Membership.updateOne({ userId: seeded.userId }, { $set: { role: "viewer" } })
    expect((await c.get("/versions/0.0/download")).status).toBe(200)
    const draft = await c.get("/versions/0.1/download")
    expect(draft.status).toBe(403)
    expect(draft.body.error.code).toBe("ORG_ROLE_FORBIDDEN")
  })

  it("project mới: Viewer tải được bản gốc 0.1, không tải được bản nháp CR 0.2", async () => {
    const { seeded, c } = await importedProject()
    await writeCr(c, "Faster", "1 second instead of 2 seconds")
    await Membership.updateOne({ userId: seeded.userId }, { $set: { role: "viewer" } })
    expect((await c.get("/versions/0.1/download")).status).toBe(200)
    expect((await c.get("/versions/0.2/download")).status).toBe(403)
  })
})
