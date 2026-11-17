/**
 * P08 (FAP #23): id tạm `$newN` được cấp cho cả lô trước khi áp ⇒ op đứng TRƯỚC op add của id tạm cũng tham chiếu được.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { planTransaction, TransactionRejectedError } from "./op-engine.js"
import { spineSchema } from "./spine.schema.js"
import type { Spine } from "./spine.types.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8")))
const txn = (ops: unknown[]) => ({ ops, by: "u", txn: "t" }) as unknown as Parameters<typeof planTransaction>[1]
const plan = (ops: unknown[], spine: Spine = FIXTURE) => planTransaction(spine, txn(ops), { startSeq: 1 })

const NEW_FN = {
  id: "$new1",
  screen_id: "S01",
  feature_id: "F1",
  order: 50,
  name: "Remember Login",
  trigger: "User ticks Remember me.",
  description: "Keeps the user signed in on this device.",
  normal: ["User ticks Remember me.", "System keeps the session for 30 days."],
  abnormal: [],
  validations: [],
  business_rule_ids: [],
  priority: "should"
}

describe("id tạm cấp trước cho cả lô", () => {
  it("UC có sẵn gắn $new1 ở op ĐỨNG TRƯỚC op add chức năng ⇒ hợp lệ, cả hai dùng cùng id thật", () => {
    const uc = FIXTURE.use_cases.find((u) => u.id === "UC01")!
    const result = plan([
      { op: "set", path: "use_cases[id=UC01].function_ids", value: [...uc.function_ids, "$new1"] },
      { op: "add", path: "functions[]", value: NEW_FN }
    ])
    const added = result.spine.functions.find((f) => f.name === "Remember Login")!
    expect(added.id).not.toContain("$")
    expect(result.spine.use_cases.find((u) => u.id === "UC01")!.function_ids).toContain(added.id)
    expect(JSON.stringify(result.ops)).not.toContain("$new1")
  })

  it("hai phần tử mới tham chiếu chéo nhau (op trước nhắc id tạm của op sau) ⇒ id khác nhau, đúng thứ tự", () => {
    const result = plan([
      { op: "add", path: "functions[]", value: { ...NEW_FN, id: "$newA" } },
      { op: "add", path: "use_cases[]", value: { id: "$newUc", name: "Stay Signed In", actor_ids: ["A01"], function_ids: ["$newA", "$newB"], description: "User stays signed in.", includes: [], extends: [] } },
      { op: "add", path: "functions[]", value: { ...NEW_FN, id: "$newB", order: 51, name: "Forget Device" } }
    ])
    const a = result.spine.functions.find((f) => f.name === "Remember Login")!
    const b = result.spine.functions.find((f) => f.name === "Forget Device")!
    const uc = result.spine.use_cases.find((u) => u.name === "Stay Signed In")!
    expect(a.id).not.toBe(b.id)
    expect(uc.function_ids).toEqual([a.id, b.id])
  })

  it("id tạm không có op add nào ⇒ vẫn bị từ chối (tham chiếu chết)", () => {
    const uc = FIXTURE.use_cases.find((u) => u.id === "UC01")!
    expect(() => plan([{ op: "set", path: "use_cases[id=UC01].function_ids", value: [...uc.function_ids, "$new9"] }])).toThrow(TransactionRejectedError)
  })
})
