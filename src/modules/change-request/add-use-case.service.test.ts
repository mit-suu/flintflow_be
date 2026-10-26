import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { spineSchema } from "../spine/spine.schema.js"
import { planTransaction } from "../spine/op-engine.js"
import type { Op } from "../spine/op.types.js"
import type { Spine } from "../spine/spine.types.js"
import { normalizeUseCaseBatch } from "../spine/use-case-propagation.js"
import { bundleNewText, concreteBatch, crAddsUseCase, crUseCaseIntent, distributeOps, seedBatch } from "./add-use-case.service.js"

/**
 * FLF-318: lô thêm use case của CR — id thật trước khi chia, chia về ô "thêm mới" / phần tử có sẵn, ghi được theo bất kỳ
 * thứ tự vị trí nào (bất biến chỉ kiểm cuối lô), người duyệt thấy phần tử mới của từng mục.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8")))

const batch = (): Op[] => [
  { op: "add", path: "use_cases[]", value: { name: "Send Absence Warning", actor_ids: ["A02"], function_ids: ["$newFn"], description: "Lecturer warns absent students." } },
  { op: "add", path: "screens[]", value: { id: "$newScreen", name: "Absence Warning", description: "Warn students.", feature_id: "F3", flow_to: [], tabs: [] } },
  {
    op: "add",
    path: "functions[]",
    value: { id: "$newFn", name: "Send Warning", screen_id: "$newScreen", feature_id: "F3", trigger: "Click Send", description: "Sends warning.", normal: ["a"], abnormal: ["b"], validations: [] }
  },
  { op: "set", path: "screens[id=S07].flow_to", value: [...(FIXTURE.screens.find((s) => s.id === "S07")?.flow_to ?? []), "$newScreen"] },
  { op: "add", path: "permissions[]", value: { screen_id: "$newScreen", role_id: "R2", action: "view" } }
]

const prepared = () => {
  const out = concreteBatch(FIXTURE, normalizeUseCaseBatch(FIXTURE, batch()))
  if (!out) throw new Error("lô mẫu phải áp thử được")
  return out
}

describe("crAddsUseCase", () => {
  it("nhận ra lệnh thêm use case trong tiêu đề / mô tả / câu trả lời", () => {
    const cr = { title: "Absence warning", description: "Thêm use case Send Absence Warning cho Lecturer", amendments: [], clarifications: [] }
    expect(crAddsUseCase(cr)).toBe(true)
    expect(crAddsUseCase({ ...cr, description: "Availability must be 99.9%" })).toBe(false)
    expect(crAddsUseCase({ ...cr, description: "x", clarifications: [{ answers: ["add a use case for it"] }] } as never)).toBe(true)
  })
})

describe("concreteBatch", () => {
  it("id tạm ⇒ id thật trong path và value, giữ đúng số op của lô (không gồm op cascade)", () => {
    const normalized = normalizeUseCaseBatch(FIXTURE, batch())
    const { ops } = prepared()
    expect(ops).toHaveLength(normalized.length)
    expect(JSON.stringify(ops)).not.toMatch(/\$new/)
  })

  it("lô sai bất biến ⇒ null", () => {
    expect(concreteBatch(FIXTURE, [{ op: "add", path: "functions[]", value: { name: "X", screen_id: "S-404", feature_id: "F3" } }])).toBeNull()
  })
})

describe("distributeOps", () => {
  it("phần tử mới ⇒ ô thêm mới của mảng (kể cả op set con); phần tử có sẵn ⇒ vị trí của chính nó; section theo mục hiển thị", () => {
    const { ops, after } = prepared()
    const locs = distributeOps(FIXTURE, after, ops)
    const byPath = new Map(locs.map((l) => [l.path, l]))
    expect([...byPath.keys()].sort()).toEqual(["functions[]", "permissions[]", "screens[]", "screens[id=S07]", "use_cases[]"])
    expect(byPath.get("use_cases[]")?.section_id).toBe("fixed:2.2.2")
    expect(byPath.get("functions[]")?.section_id).toBe("feature:F3")
    expect(byPath.get("screens[]")?.section_id).toBe("fixed:3.1.1")
    expect(byPath.get("permissions[]")?.section_id).toBe("fixed:3.1.3")
    // primary_function_id của màn mới là op set trên phần tử mới ⇒ ở ô screens[], đòi khoá phần tử mới đó
    const screens = byPath.get("screens[]")!
    expect(screens.ops.map((o) => o.op)).toEqual(["add", "set"])
    expect(screens.new_elements).toHaveLength(1)
    expect(screens.new_elements[0]).toMatch(/^screens\[id=/)
    expect(byPath.get("screens[id=S07]")?.new_elements).toEqual([])
  })

  it("ghi theo bất kỳ thứ tự vị trí nào cũng ra cùng Spine", () => {
    const { ops, after } = prepared()
    const locs = distributeOps(FIXTURE, after, ops)
    for (const order of [locs, [...locs].reverse()]) {
      const plan = planTransaction(FIXTURE, { base_version: FIXTURE.spine_version, ops: order.flatMap((l) => l.ops), by: "CR-001" }, { startSeq: 1 })
      expect(plan.spine.use_cases.length).toBe(FIXTURE.use_cases.length + 1)
      expect(plan.spine.functions.length).toBe(FIXTURE.functions.length + 1)
      expect(plan.spine.screens.length).toBe(FIXTURE.screens.length + 1)
    }
  })

  it("bundleNewText: ô thêm mới chỉ hiện phần tử thêm; phần tử có sẵn hiện giá trị sau lô", () => {
    const { after } = prepared()
    expect(bundleNewText(FIXTURE, after, "use_cases[]")).toContain("Send Absence Warning")
    expect(bundleNewText(FIXTURE, after, "use_cases[]")).not.toContain(FIXTURE.use_cases[0].name)
    const newScreen = after.screens[after.screens.length - 1].id
    expect(bundleNewText(FIXTURE, after, "screens[id=S07]")).toContain(newScreen)
  })
})

describe("CR xoá use case (luật 3g, như chat trước baseline)", () => {
  it("crUseCaseIntent: thêm / xoá theo động từ đứng trước; câu trả lời làm rõ cũng tính", () => {
    const cr = { title: "Phúc khảo", description: "Xoá UC phúc khảo điểm", amendments: [], clarifications: [] }
    expect(crUseCaseIntent(cr)).toBe("remove")
    expect(crAddsUseCase(cr)).toBe(false)
    expect(crUseCaseIntent({ ...cr, description: "Thêm use case Request Grade Review" })).toBe("add")
    expect(crUseCaseIntent({ ...cr, description: "Sửa ngưỡng hiệu năng" })).toBeNull()
  })

  it("lô xoá: mỗi op về vị trí của phần tử bị xoá; giá trị sau lô của phần tử bị xoá là rỗng", () => {
    const uc = FIXTURE.use_cases.find((u) => u.function_ids.some((id) => !FIXTURE.use_cases.some((o) => o.id !== u.id && o.function_ids.includes(id))))!
    const fnIds = uc.function_ids.filter((id) => !FIXTURE.use_cases.some((o) => o.id !== uc.id && o.function_ids.includes(id)))
    const out = concreteBatch(FIXTURE, [{ op: "remove", path: `use_cases[id=${uc.id}]` }, ...fnIds.map((id) => ({ op: "remove" as const, path: `functions[id=${id}]` }))])!
    const locs = distributeOps(FIXTURE, out.after, out.ops)
    expect(locs.map((l) => l.path).sort()).toEqual([`use_cases[id=${uc.id}]`, ...fnIds.map((id) => `functions[id=${id}]`)].sort())
    expect(locs.every((l) => l.new_elements.length === 0)).toBe(true)
    expect(locs.find((l) => l.path === `use_cases[id=${uc.id}]`)?.section_id).not.toBe("misc")
    expect(bundleNewText(FIXTURE, out.after, `use_cases[id=${uc.id}]`)).toBe("")
  })
})

describe("seedBatch — CR tạo từ bản xem trước trong chat (FLF-318)", () => {
  it("op của bản xem trước (đã chuẩn hoá, còn id tạm) ⇒ lô có id thật; không có / sai ⇒ null", () => {
    const seeded = seedBatch(FIXTURE, { seed: { instruction: "x", ops: normalizeUseCaseBatch(FIXTURE, batch()) as unknown as Record<string, unknown>[], targets: [] } })
    expect(seeded).not.toBeNull()
    expect(JSON.stringify(seeded!.ops)).not.toMatch(/\$new/)
    expect(seedBatch(FIXTURE, { seed: null })).toBeNull()
    expect(seedBatch(FIXTURE, { seed: { instruction: "x", ops: [{ op: "bogus" }], targets: [] } })).toBeNull()
  })
})
