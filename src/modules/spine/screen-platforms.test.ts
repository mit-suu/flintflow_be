import { describe, it, expect } from "vitest"
import { createEmptySpine } from "./spine.repository.js"
import { actorSchema } from "./spine.schema.js"
import { screenPlatforms, screenThemeFor } from "./screen-platforms.js"
import type { Spine } from "./spine.types.js"

const BOTH = ["web", "mobile"] as const
const fn = (id: string, screenId: string) =>
  ({ id, screen_id: screenId, feature_id: "F1", order: 0, name: id, trigger: "", description: "", normal: [], abnormal: [], validations: [], business_rule_ids: [], priority: null }) as Spine["functions"][number]
const uc = (id: string, actor_ids: string[], function_ids: string[]) => ({ id, name: id, actor_ids, function_ids, description: "", includes: [], extends: [] })
const human = (id: string, platforms?: ("web" | "mobile")[], parent_id?: string) => ({ id, name: id, kind: "human" as const, description: "", ...(platforms ? { platforms } : {}), ...(parent_id ? { parent_id } : {}) })

/** S01: một use case của mọi actor trong `actorIds`. */
const spineOf = (actors: Spine["actors"], actorIds: string[]): Spine => {
  const s = createEmptySpine()
  s.actors = actors
  s.screens = [{ id: "S01", feature_id: "F1", name: "S01", description: "", flow_to: [], is_popup: false, tabs: [], primary_function_id: "FN1", queue_order: 1, detail_status: "placeholder" as const }]
  s.functions = [fn("FN1", "S01")]
  s.use_cases = [uc("UC1", actorIds, ["FN1"])]
  return s
}

describe("screenPlatforms (FLF-493)", () => {
  it("màn chỉ actor mobile ⇒ chỉ mobile", () => {
    expect(screenPlatforms(spineOf([human("A01", ["mobile"])], ["A01"]), "S01", BOTH)).toEqual(["mobile"])
  })

  it("màn dùng chung actor mobile và actor web ⇒ cả hai, theo thứ tự web, mobile", () => {
    expect(screenPlatforms(spineOf([human("A01", ["mobile"]), human("A02", ["web"])], ["A01", "A02"]), "S01", BOTH)).toEqual(["web", "mobile"])
  })

  it("có actor chưa khai nền tảng ⇒ theme", () => {
    expect(screenPlatforms(spineOf([human("A01", ["mobile"]), human("A02")], ["A01", "A02"]), "S01", BOTH)).toEqual(["web", "mobile"])
  })

  it("actor cha không khai ⇒ hợp của con; một con chưa khai ⇒ chưa biết", () => {
    const actors = [human("A01", ["mobile"], "A03"), human("A02", ["mobile"], "A03"), human("A03")]
    expect(screenPlatforms(spineOf(actors, ["A03"]), "S01", BOTH)).toEqual(["mobile"])
    const unknown = [human("A01", ["mobile"], "A03"), human("A02", undefined, "A03"), human("A03")]
    expect(screenPlatforms(spineOf(unknown, ["A03"]), "S01", BOTH)).toEqual(["web", "mobile"])
  })

  it("actor tự khai thì thắng việc suy từ con", () => {
    const actors = [human("A01", ["mobile"], "A03"), human("A03", ["web"])]
    expect(screenPlatforms(spineOf(actors, ["A03"]), "S01", BOTH)).toEqual(["web"])
  })

  it("giao rỗng ⇒ theme (theme chỉ web mà actor khai mobile)", () => {
    expect(screenPlatforms(spineOf([human("A01", ["mobile"])], ["A01"]), "S01", ["web"])).toEqual(["web"])
  })

  it("theme thu hẹp hơn actor ⇒ giao theo theme", () => {
    expect(screenPlatforms(spineOf([human("A01", ["web", "mobile"])], ["A01"]), "S01", ["mobile"])).toEqual(["mobile"])
  })

  it("màn không có actor, hoặc màn không tồn tại ⇒ theme; actor system bị bỏ", () => {
    expect(screenPlatforms(spineOf([human("A01", ["mobile"])], []), "S01", BOTH)).toEqual(["web", "mobile"])
    expect(screenPlatforms(spineOf([human("A01", ["mobile"])], ["A01"]), "S99", BOTH)).toEqual(["web", "mobile"])
    const s = spineOf([human("A01", ["mobile"]), { id: "A02", name: "Gw", kind: "system", description: "" }], ["A01", "A02"])
    expect(screenPlatforms(s, "S01", BOTH)).toEqual(["mobile"])
  })

  it("screenThemeFor chỉ đổi platforms", () => {
    const theme = { primaryColor: "#3F5591", domain: null, platforms: ["web", "mobile"] as ("web" | "mobile")[] }
    expect(screenThemeFor(spineOf([human("A01", ["mobile"])], ["A01"]), "S01", theme)).toEqual({ ...theme, platforms: ["mobile"] })
  })
})

describe("actorSchema.platforms (FLF-493)", () => {
  const base = { id: "A01", name: "Customer", kind: "human", description: "" }
  it("nhận web / mobile, vắng cũng hợp lệ", () => {
    expect(actorSchema.safeParse({ ...base, platforms: ["mobile"] }).success).toBe(true)
    expect(actorSchema.safeParse(base).success).toBe(true)
  })
  it("từ chối giá trị lạ", () => {
    expect(actorSchema.safeParse({ ...base, platforms: ["tablet"] }).success).toBe(false)
    expect(actorSchema.safeParse({ ...base, platforms: "mobile" }).success).toBe(false)
  })
})
