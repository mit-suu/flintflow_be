import { beforeEach, describe, expect, it, vi } from "vitest"
import mongoose from "mongoose"

const store = vi.hoisted(() => ({ family: null as null | { _id: unknown; orgId: unknown; name: string; latest_version: number }, lastFilter: null as unknown }))
vi.mock("./org-library.model.js", () => ({
  OrgTemplate: {
    findOne: (filter: { _id: unknown; orgId: unknown }) => {
      store.lastFilter = filter
      const f = store.family
      const hit = f && String(f._id) === String(filter._id) && String(f.orgId) === String(filter.orgId) ? f : null
      return { select: () => ({ lean: async () => hit }) }
    }
  }
}))

import { templateUpdateOf } from "./template-update.js"

const orgId = new mongoose.Types.ObjectId()
const templateId = new mongoose.Types.ObjectId()
const project = (version: number | null, org: mongoose.Types.ObjectId | null = orgId) => ({
  organizationId: org,
  template_ref: version === null ? null : { template_id: templateId, version }
})

beforeEach(() => {
  store.family = { _id: templateId, orgId, name: "Mẫu ngân hàng", latest_version: 3 }
})

describe("templateUpdateOf", () => {
  it("bản org mới hơn ⇒ trả thông tin cập nhật cho Lead / Analyst, tra theo org của project", async () => {
    const expected = { template_id: String(templateId), name: "Mẫu ngân hàng", current_version: 1, latest_version: 3 }
    expect(await templateUpdateOf(project(1), "lead")).toEqual(expected)
    expect(await templateUpdateOf(project(1), "analyst")).toEqual(expected)
    expect(store.lastFilter).toEqual({ _id: templateId, orgId })
  })

  it("Viewer / không vai trò / chưa gắn mẫu / không thuộc org ⇒ null", async () => {
    expect(await templateUpdateOf(project(1), "viewer")).toBeNull()
    expect(await templateUpdateOf(project(1), undefined)).toBeNull()
    expect(await templateUpdateOf(project(null), "lead")).toBeNull()
    expect(await templateUpdateOf(project(1, null), "lead")).toBeNull()
  })

  it("đang ở bản mới nhất, hoặc họ mẫu thuộc org khác / đã xoá ⇒ null", async () => {
    expect(await templateUpdateOf(project(3), "lead")).toBeNull()
    expect(await templateUpdateOf(project(1, new mongoose.Types.ObjectId()), "lead")).toBeNull()
    store.family = null
    expect(await templateUpdateOf(project(1), "lead")).toBeNull()
  })
})
