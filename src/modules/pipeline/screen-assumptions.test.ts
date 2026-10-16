import { describe, it, expect } from "vitest"
import type { Assumption, Spine } from "../spine/spine.types.js"
import { retireFrameOnlyAssumptionOps } from "./screen-assumptions.js"

const assumption = (over: Partial<Assumption>): Assumption => ({
  id: "AS01",
  path: "screens[id=S01].detail_status",
  statement: "The Login screen keeps a frame only, without detailed description.",
  rationale: "Not core.",
  origin_step_id: "S-4.1",
  status: "unconfirmed",
  confirmed_at: null,
  ...over
})

const spineWith = (assumptions: Assumption[]): Spine => ({ assumptions }) as unknown as Spine

describe("retireFrameOnlyAssumptionOps — màn ký xong ở S-5.5 thì giả định 'chỉ giữ khung' không còn đúng", () => {
  it("gỡ giả định S-4.1 trỏ detail_status của đúng màn đó, bất kể trạng thái", () => {
    const spine = spineWith([
      assumption({ id: "AS01" }),
      assumption({ id: "AS02", status: "rejected" }),
      assumption({ id: "AS03", path: "screens[id=S02].detail_status" })
    ])
    expect(retireFrameOnlyAssumptionOps(spine, "S01").map((op) => [op.op, op.path])).toEqual([
      ["remove", "assumptions[id=AS01]"],
      ["remove", "assumptions[id=AS02]"]
    ])
  })

  it("Spine cũ (path trỏ cả màn): chỉ gỡ khi câu chữ là 'frame only'; giả định khác về màn giữ nguyên", () => {
    const spine = spineWith([
      assumption({ id: "AS12", path: "screens[id=S17]" }),
      assumption({ id: "AS24", path: "screens[id=S17]", statement: "The dashboard is a simple overview page." }),
      assumption({ id: "AS26", path: "screens[id=S17]", origin_step_id: "S-4.3" })
    ])
    expect(retireFrameOnlyAssumptionOps(spine, "S17").map((op) => op.path)).toEqual(["assumptions[id=AS12]"])
  })
})
