import { describe, it, expect } from "vitest"
import { Organization, ORG_NAME_MAX } from "./organization.model.js"
import { Membership, ORG_ROLES } from "./membership.model.js"
import { Invitation, INVITABLE_ROLES } from "./invitation.model.js"

/** schema.indexes() trả [[fields, options]] — tìm theo tập khoá để không phụ thuộc thứ tự khai báo. */
type SchemaIndex = [Record<string, unknown>, Record<string, unknown> | undefined]

const findIndex = (indexes: unknown[], fields: string[]): SchemaIndex | undefined =>
  (indexes as SchemaIndex[]).find((entry) => JSON.stringify(Object.keys(entry[0])) === JSON.stringify(fields))

describe("organization models (task-26 Pha 0)", () => {
  it("ba vai trò trong org, tách khỏi User.role của nền tảng", () => {
    expect([...ORG_ROLES]).toEqual(["lead", "analyst", "viewer"])
  })

  it("UC-08 chỉ mời được Analyst / Viewer — Lead phải nâng qua UC-73", () => {
    expect([...INVITABLE_ROLES]).toEqual(["analyst", "viewer"])
    expect(INVITABLE_ROLES).not.toContain("lead")
  })

  it("một người chỉ có một vai trò trong một org (chặn accept mã mời hai lần)", () => {
    const unique = findIndex(Membership.schema.indexes(), ["organizationId", "userId"])
    expect(unique?.[1]).toMatchObject({ unique: true })
  })

  it("có index đếm Lead còn lại cho BR-02", () => {
    expect(findIndex(Membership.schema.indexes(), ["organizationId", "role"])).toBeDefined()
  })

  it("mã mời lưu hash, không lưu mã thô, và hash là duy nhất", () => {
    const paths = Object.keys(Invitation.schema.paths)
    expect(paths).toContain("codeHash")
    expect(paths).not.toContain("code")
    expect(Invitation.schema.path("codeHash").options.unique).toBe(true)
  })

  it("trạng thái mã mời là giá trị suy diễn — không có field status trong schema", () => {
    expect(Object.keys(Invitation.schema.paths)).not.toContain("status")
    for (const field of ["expiresAt", "acceptedAt", "revokedAt"]) {
      expect(Invitation.schema.path(field)).toBeDefined()
    }
  })

  it("tên org bị chặn độ dài ở schema", () => {
    expect(Organization.schema.path("name").options.maxlength).toBe(ORG_NAME_MAX)
  })
})
