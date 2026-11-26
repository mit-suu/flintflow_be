import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  notify: vi.fn(async () => undefined),
  projectFind: vi.fn(),
  memberFind: vi.fn()
}))

vi.mock("../notification/notification.service.js", () => ({ notify: h.notify }))
vi.mock("../project/project.model.js", () => ({ Project: { find: h.projectFind } }))
vi.mock("../organization/membership.model.js", () => ({ Membership: { find: h.memberFind } }))
vi.mock("../user/user.model.js", () => ({ User: { find: () => ({ select: () => ({ lean: async () => [] }) }) } }))
vi.mock("./org-library.model.js", () => {
  const family = { _id: "t1", name: "Lumen - mẫu", skeleton_of: "p-src", latest_version: 2 }
  const draft = { _id: "v2", version: 2, status: "draft", visibility: "org", headings: [], created_by: "u-lead", createdAt: new Date(), file_ref: "f", source_file: { name: "x.docx" }, language: "vi", template_family: null }
  return {
    OrgTemplate: { findOne: async () => family, findOneAndUpdate: async () => family },
    OrgTemplateVersion: { findOne: async () => draft, findOneAndUpdate: async () => ({ ...draft, status: "published" }) }
  }
})

import { publishVersion } from "./org-template-versions.service.js"

beforeEach(() => {
  h.notify.mockClear()
  h.projectFind.mockReset()
  h.memberFind.mockReset()
  h.projectFind.mockReturnValue({ select: () => ({ lean: async () => [{ _id: "p-other", name: "Dự án B" }] }) })
  h.memberFind.mockImplementation((q: { userId?: unknown }) => ({
    select: () => ({
      lean: async () => (q.userId && typeof q.userId === "object" && "$ne" in (q.userId as object) ? [{ userId: "u-analyst" }, { userId: "u-lead2" }] : [])
    })
  }))
})

describe("notifyNewVersion cho mẫu lưu từ dự án (FLF-466 phase 10)", () => {
  it("không còn bỏ qua họ lưu từ dự án: báo Lead + Analyst (trừ người đăng, không Viewer) của org có dự án theo bản cũ hơn", async () => {
    await publishVersion("o1", { userId: "u-lead", role: "lead" }, "665f1f77bcf86cd799439011", 2, [], { skipProjectIds: ["p-src"] })
    // dự án nguồn bị loại, chỉ dự án đang theo bản cũ hơn
    expect(h.projectFind.mock.calls[0][0]).toMatchObject({ organizationId: "o1", _id: { $nin: ["p-src"] }, "template_ref.version": { $lt: 2 } })
    // người nhận: chỉ lead + analyst, trừ người đăng
    expect(h.memberFind.mock.calls[0][0]).toMatchObject({ organizationId: "o1", role: { $in: ["lead", "analyst"] }, userId: { $ne: "u-lead" } })
    expect(h.notify).toHaveBeenCalledTimes(2)
    expect(h.notify.mock.calls.map((c) => (c as unknown as [string])[0]).sort()).toEqual(["u-analyst", "u-lead2"])
  })
})
