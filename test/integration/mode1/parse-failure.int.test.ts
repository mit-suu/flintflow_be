/**
 * FLF-343: tách file / khớp mẫu lỗi sau preflight ⇒ import không treo ở `parsing`: `preflight_rejected` + issue PARSE_FAILED,
 * trả `422 IMPORT_FILE_REJECTED` (FE hiện như preflight từ chối, cho tải file khác).
 */
import { describe, expect, it, vi } from "vitest"

vi.mock("../../../src/modules/import/profile-match.service.js", async (orig) => ({
  ...(await orig<typeof import("../../../src/modules/import/profile-match.service.js")>()),
  matchProfile: () => {
    throw new Error("XML lạ (test)")
  }
}))

import { seedFixture } from "../../setup.js"
import { createMode1Project, mode1Api } from "../../helpers/mode1.js"
import { makeSrsDocx } from "../../../src/modules/import/testing/srs-fixture.js"
import { getImportResponseSchema } from "../../../src/modules/import/import.dto.js"
import { Project } from "../../../src/modules/project/project.model.js"

describe("FLF-343 — tách file lỗi", () => {
  it("upload ⇒ 422 IMPORT_FILE_REJECTED kèm PARSE_FAILED; GET /import thấy preflight_rejected; upload lại được", async () => {
    const seeded = await seedFixture("minimal")
    const projectId = await createMode1Project(seeded)
    const c = mode1Api(seeded, projectId)
    const res = await c.upload(await makeSrsDocx())
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe("IMPORT_FILE_REJECTED")
    expect(res.body.meta.issues).toEqual([expect.objectContaining({ code: "PARSE_FAILED" })])
    const view = getImportResponseSchema.parse((await c.get("/import")).body.data)
    expect(view.import).toMatchObject({ status: "preflight_rejected", preflight: { status: "rejected", issues: [expect.objectContaining({ code: "PARSE_FAILED" })] } })
    expect((await Project.findById(projectId).lean())?.import_state).toBe("preflight_rejected")
    // không kẹt: tải file khác vẫn tạo bản ghi mới (vẫn lỗi vì mock, nhưng không 409)
    expect((await c.upload(await makeSrsDocx())).status).toBe(422)
  })
})
