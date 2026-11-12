import { describe, expect, it } from "vitest"
import { migrationIdSchema, patchDecisionsSchema, patchPairsSchema, startFromFileSchema, startFromTemplateSchema } from "./template-migration.dto.js"

const ID = "64b7f0f2a1c2d3e4f5a6b7c8"

describe("template-migration DTO", () => {
  it("start bằng mẫu org: cần template_id hợp lệ + version nguyên ≥ 1, không nhận field lạ", () => {
    expect(startFromTemplateSchema.safeParse({ template_id: ID, version: 1 }).success).toBe(true)
    expect(startFromTemplateSchema.safeParse({ template_id: ID, version: 0 }).success).toBe(false)
    expect(startFromTemplateSchema.safeParse({ template_id: "x", version: 1 }).success).toBe(false)
    expect(startFromTemplateSchema.safeParse({ template_id: ID, version: 1, orgId: ID }).success).toBe(false)
  })

  it("start bằng file: field multipart là chữ, publish_to_org mặc định false", () => {
    expect(startFromFileSchema.parse({})).toEqual({ publish_to_org: false })
    expect(startFromFileSchema.parse({ publish_to_org: "true", name: " Mẫu " })).toEqual({ publish_to_org: true, name: "Mẫu" })
    expect(startFromFileSchema.safeParse({ publish_to_org: "yes" }).success).toBe(false)
  })

  it("pairs / decisions: không rỗng, không field lạ", () => {
    expect(patchPairsSchema.safeParse({ pairs: [{ old_key: "a", new_key: null }] }).success).toBe(true)
    expect(patchPairsSchema.safeParse({ pairs: [] }).success).toBe(false)
    expect(patchDecisionsSchema.safeParse({ decisions: [{ id: "e:a", choice: "delete" }] }).success).toBe(true)
    expect(patchDecisionsSchema.safeParse({ batch: "keep_all" }).success).toBe(true)
    expect(patchDecisionsSchema.safeParse({}).success).toBe(false)
    expect(patchDecisionsSchema.safeParse({ batch: "all" }).success).toBe(false)
  })

  it("migrationId phải là ObjectId", () => {
    expect(migrationIdSchema.safeParse(ID).success).toBe(true)
    expect(migrationIdSchema.safeParse("1").success).toBe(false)
  })
})
