import { describe, it, expect } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Flag, Spine } from "../spine/spine.types.js"
import { directLocationCount, flagTargets, seedFromFlags } from "./flag-seed.js"

const flag = (id: string, over: Partial<Flag> = {}): Flag => ({
  id,
  level: "yellow",
  rule_id: "r",
  section_id: "fixed:5.2",
  target_id: null,
  message: "m",
  remediation_step: "S-7.2",
  opened_at_version: 1,
  resolved_at: null,
  waived_by_user: false,
  waive_reason: null,
  waived_at_version: null,
  kept_reason: null,
  kept_by: null,
  kept_at: null,
  ...over
})

const spineWith = (flags: Flag[], nfrCount = 1): Spine => {
  const spine = createEmptySpine({ name: "P" })
  spine.nfrs = Array.from({ length: nfrCount }, (_, i) => ({ id: `NFR-${String(i + 1).padStart(2, "0")}` }) as unknown as Spine["nfrs"][number])
  spine.flags = flags
  return spine
}

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (err) {
    return (err as { code?: string }).code
  }
  return undefined
}

describe("seedFromFlags", () => {
  it("id trần / ref path cùng phần tử gộp một đích; cờ không phần tử ⇒ mục của cờ; bỏ id trùng", () => {
    const spine = spineWith([flag("F1", { target_id: "NFR-01" }), flag("F2", { target_id: "nfrs[id=NFR-01]" }), flag("F3", { section_id: "fixed:5.4" })])
    const { flagIds, seed } = seedFromFlags(spine, ["F1", "F2", "F3", "F1"])
    expect(flagIds).toEqual(["F1", "F2", "F3"])
    expect(seed).toEqual({ instruction: null, ops: [], targets: ["nfrs[id=NFR-01]", "fixed:5.4"] })
  })

  it("id không có ⇒ FLAG_NOT_FOUND; đóng / giữ nguyên / đã bỏ qua ⇒ FLAG_NOT_OPEN", () => {
    const spine = spineWith([
      flag("F1"),
      flag("F2", { resolved_at: "2026-11-18T00:00:00.000Z" }),
      flag("F3", { level: "red", kept_reason: "x".repeat(20) }),
      flag("F4", { waived_by_user: true })
    ])
    expect(codeOf(() => seedFromFlags(spine, ["F1", "F9"]))).toBe("FLAG_NOT_FOUND")
    for (const id of ["F2", "F3", "F4"]) expect(codeOf(() => seedFromFlags(spine, ["F1", id]))).toBe("FLAG_NOT_OPEN")
  })

  it("nhóm cờ chạm hơn 80 phần tử vẫn nhận, không từ chối", () => {
    const n = 81
    const flags = Array.from({ length: n }, (_, i) => flag(`F${i}`, { target_id: `NFR-${String(i + 1).padStart(2, "0")}` }))
    const spine = spineWith(flags, n)
    expect(directLocationCount(spine, flagTargets(spine, flags))).toBe(n)
    expect(seedFromFlags(spine, flags.map((f) => f.id)).seed.targets).toHaveLength(n)
  })
})
