import { describe, it, expect } from "vitest"
import { createEmptySpine } from "./spine.repository.js"
import { spineSchema } from "./spine.schema.js"
import { planTransaction } from "./op-engine.js"
import { renderedDiagramHash } from "./source-hash.js"
import { buildChangeProjection } from "./change.service.js"
import { fieldLabel } from "./human-labels.js"
import type { Spine } from "./spine.types.js"

/**
 * FLF-493 (I1, lỗi #26): "Bệnh nhân chỉ dùng app trên điện thoại; lễ tân, bác sĩ dùng web" ⇒ op đặt `actors[].platforms`
 * ⇒ hash mockup của màn bệnh nhân đổi, màn của lễ tân giữ nguyên ⇒ cờ `diagram_stale` chỉ ở màn bị ảnh hưởng.
 */

const fn = (id: string, screenId: string) =>
  ({ id, screen_id: screenId, feature_id: "F1", order: 0, name: id, trigger: "", description: "", normal: [], abnormal: [], validations: [], business_rule_ids: [], priority: null }) as Spine["functions"][number]
const screen = (id: string, fnId: string) =>
  ({ id, feature_id: "F1", name: id, description: "", flow_to: [], is_popup: false, tabs: [], primary_function_id: fnId, queue_order: 1, detail_status: "placeholder" as const }) as Spine["screens"][number]
const human = (id: string, name: string) => ({ id, name, kind: "human" as const, description: "" })
const uc = (id: string, actor_ids: string[], function_ids: string[]) => ({ id, name: id, actor_ids, function_ids, description: "", includes: [], extends: [] })

/** S01 chỉ bệnh nhân (A01) dùng; S02 chỉ lễ tân (A02) dùng; sản phẩm có cả web lẫn app. */
const clinic = (): Spine => {
  const s = createEmptySpine()
  s.project.form_factor = ["web_app", "mobile_app"]
  s.actors = [human("A01", "Patient"), human("A02", "Receptionist")]
  s.screens = [screen("S01", "FN1"), screen("S02", "FN2")]
  s.functions = [fn("FN1", "S01"), fn("FN2", "S02")]
  s.use_cases = [uc("UC1", ["A01"], ["FN1"]), uc("UC2", ["A02"], ["FN2"])]
  return spineSchema.parse(s)
}

const layout = (screenId: string) => ({ kind: "screen_layout" as const, owner_id: screenId })
const setPlatforms = (spine: Spine, actorId: string, value: unknown) =>
  planTransaction(spine, { base_version: spine.spine_version, by: "user-1", ops: [{ op: "set", path: `actors[id=${actorId}].platforms`, value }] }, { startSeq: 1 })

describe("op đặt actors[].platforms ⇒ hash màn đổi theo actor dùng màn", () => {
  it("bệnh nhân chỉ mobile: hash mockup S01 đổi, S02 (lễ tân chưa khai) giữ nguyên", () => {
    const before = clinic()
    const plan = setPlatforms(before, "A01", ["mobile"])
    expect(plan.spine.actors.find((a) => a.id === "A01")?.platforms).toEqual(["mobile"])
    expect(plan.changes).toMatchObject([{ path: "actors[id=A01].platforms", value: ["mobile"] }])

    expect(renderedDiagramHash(plan.spine, layout("S01"))).not.toBe(renderedDiagramHash(before, layout("S01")))
    expect(renderedDiagramHash(plan.spine, layout("S02"))).toBe(renderedDiagramHash(before, layout("S02")))
  })

  it("lễ tân và bác sĩ dùng web, bệnh nhân mobile: mỗi màn chỉ đổi khi tập nền tảng của nó thu hẹp", () => {
    const before = clinic()
    const step1 = setPlatforms(before, "A01", ["mobile"]).spine
    const step2 = setPlatforms(step1, "A02", ["web"]).spine
    expect(renderedDiagramHash(step2, layout("S02"))).not.toBe(renderedDiagramHash(step1, layout("S02")))
    // S01 đã thu hẹp ở bước 1, bước 2 không đụng actor của nó
    expect(renderedDiagramHash(step2, layout("S01"))).toBe(renderedDiagramHash(step1, layout("S01")))
  })

  it("khai đủ cả hai nền tảng (không thu hẹp) ⇒ hash không đổi, hình cũ không bị đánh cũ oan", () => {
    const before = clinic()
    const plan = setPlatforms(before, "A01", ["web", "mobile"])
    expect(renderedDiagramHash(plan.spine, layout("S01"))).toBe(renderedDiagramHash(before, layout("S01")))
  })

  it("giá trị lạ bị validator chặn", () => {
    expect(() => setPlatforms(clinic(), "A01", ["tablet"])).toThrow()
  })
})

describe("lệnh sửa nói về thiết bị ⇒ model thấy actor kèm platforms", () => {
  const instruction = "Bệnh nhân chỉ dùng app trên điện thoại; lễ tân, bác sĩ dùng web"

  it("projection có mọi actor người với platforms (null = chưa khai) và nền tảng sản phẩm", () => {
    const spine = clinic()
    spine.actors[1].platforms = ["web"]
    const projection = buildChangeProjection(spine, instruction)
    expect(projection.actors).toMatchObject([
      { id: "A01", name: "Patient", platforms: null },
      { id: "A02", name: "Receptionist", platforms: ["web"] }
    ])
    expect(projection.project).toMatchObject({ form_factor: ["web_app", "mobile_app"] })
  })

  it("actor system không bị gắn platforms; lệnh không nói về thiết bị thì không thêm actor / form_factor", () => {
    const spine = clinic()
    spine.actors.push({ id: "A03", name: "SMS Gateway", kind: "system", description: "" })
    const withDevice = buildChangeProjection(spine, instruction).actors as Record<string, unknown>[]
    expect(withDevice.find((a) => a.id === "A03")).toBeUndefined()
    const other = buildChangeProjection(spine, "Đổi tên Patient thành Customer")
    expect(other.project).not.toHaveProperty("form_factor")
  })

  it("nhãn xem trước của field là 'Nền tảng'", () => {
    expect(fieldLabel("platforms")).toBe("Nền tảng")
  })
})
