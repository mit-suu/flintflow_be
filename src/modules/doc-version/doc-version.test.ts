import mongoose from "mongoose"
import { describe, it, expect } from "vitest"
import { DocVersion } from "./doc-version.model.js"
import {
  compareQuerySchema,
  docVersionDtoSchema,
  downloadQuerySchema,
  releaseRequestSchema,
  releaseResponseSchema
} from "./doc-version.dto.js"

const oid = () => new mongoose.Types.ObjectId()
const AT = "2026-09-18T08:00:00.000Z"

describe("DocVersion model", () => {
  it("unique (projectId, version)", () => {
    expect(DocVersion.schema.indexes()).toContainEqual([{ projectId: 1, version: 1 }, { unique: true }])
  })

  it("version phải dạng major.minor; kind thuộc imported | cr_revision | release", () => {
    const base = { projectId: oid(), file_ref: "gridfs:1", created_by: oid() }
    expect(new DocVersion({ ...base, version: "0.1", kind: "cr_revision", based_on: "0.0", cr_ids: ["CR-001"] }).validateSync()).toBeUndefined()
    expect(new DocVersion({ ...base, version: "v1.0", kind: "release" }).validateSync()?.errors.version).toBeDefined()
    expect(new DocVersion({ ...base, version: "1.0", kind: "baseline" }).validateSync()?.errors.kind).toBeDefined()
  })
})

describe("doc-version DTO", () => {
  const dto = {
    version: "1.0",
    kind: "release",
    based_on: "0.3",
    cr_ids: ["CR-001", "CR-002", "CR-004"],
    baseline_id: "BL002",
    has_clean_file: true,
    has_original_file: false,
    created_by: "66f000000000000000000001",
    created_at: AT
  }

  it("DocVersion hợp lệ; based_on phải là version", () => {
    expect(docVersionDtoSchema.safeParse(dto).success).toBe(true)
    expect(docVersionDtoSchema.safeParse({ ...dto, based_on: "latest" }).success).toBe(false)
  })

  it("download mặc định auto; compare cần hai version khác nhau", () => {
    expect(downloadQuerySchema.parse({}).variant).toBe("auto")
    expect(compareQuerySchema.safeParse({ from: "0.1", to: "0.2" }).success).toBe(true)
    expect(compareQuerySchema.safeParse({ from: "0.1", to: "0.1" }).success).toBe(false)
    expect(compareQuerySchema.safeParse({ from: "0.1" }).success).toBe(false)
  })

  it("release mang base_version; response kèm baseline type release", () => {
    expect(releaseRequestSchema.safeParse({}).success).toBe(false)
    const res = {
      version: dto,
      baseline: { id: "BL002", version: "1.0", type: "release", doc_version: "1.0", at: AT, snapshot_ref: "66f000000000000000000009", checked_at_version: 12, waived_count: 0 },
      cr_ids: ["CR-001", "CR-002", "CR-004"],
      spine_version: 12
    }
    expect(releaseResponseSchema.parse(res).baseline.type).toBe("release")
  })
})
