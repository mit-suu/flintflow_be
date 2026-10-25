import { describe, expect, it } from "vitest"
import { planCrPackage } from "./migrate-cr-package.js"

describe("planCrPackage (FLF-330)", () => {
  it("group bị từ chối ⇒ vị trí thành not_related; group đã duyệt / chờ ⇒ về pending để BA xác nhận lại", () => {
    expect(
      planCrPackage("CR-003", [
        { group_id: "G01", decision: "approved", location_ids: ["L001"] },
        { group_id: "G02", decision: "rejected", location_ids: ["L002", "L003"] },
        { group_id: "G03", decision: "pending", location_ids: ["L004"] }
      ])
    ).toEqual({ cr_id: "CR-003", unrelated_location_ids: ["L002", "L003"], reset_group_ids: ["G01", "G03"] })
  })

  it("không group ⇒ kế hoạch rỗng", () => {
    expect(planCrPackage("CR-001", [])).toEqual({ cr_id: "CR-001", unrelated_location_ids: [], reset_group_ids: [] })
  })
})
