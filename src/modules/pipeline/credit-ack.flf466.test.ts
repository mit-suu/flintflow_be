import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { StepStatus } from "../spine/spine.types.js"
import { uncoveredScreens } from "./credit-ack.js"

describe("uncoveredScreens FLF-466 Mode 3/4 (màn có sẵn không bị coi là màn thêm)", () => {
  it("màn đã hoàn tất toàn bộ step S-5 (accepted/skipped) dù detail_status vẫn pending ⇒ không báo screens_added", () => {
    const spine = createEmptySpine({ name: "Mode3" })
    spine.screens = [{ id: "S01", name: "Login", order: 1, detail_status: "pending" } as never, { id: "S02", name: "New", order: 2, detail_status: "pending" } as never]
    spine.steps = [
      { id: "S-4.1", status: "accepted", first_seq: null, last_seq: null, accepted_at: null },
      { id: "S-5.1@S01", status: "accepted" as StepStatus, first_seq: null, last_seq: null, accepted_at: null },
      { id: "S-5.2@S01", status: "accepted" as StepStatus, first_seq: null, last_seq: null, accepted_at: null },
      { id: "S-5.3@S01", status: "skipped" as StepStatus, first_seq: null, last_seq: null, accepted_at: null },
      { id: "S-5.4@S01", status: "accepted" as StepStatus, first_seq: null, last_seq: null, accepted_at: null },
      { id: "S-5.5@S01", status: "accepted" as StepStatus, first_seq: null, last_seq: null, accepted_at: null },
      { id: "S-5.1@S02", status: "pending" as StepStatus, first_seq: null, last_seq: null, accepted_at: null },
    ]
    spine.progress = { ...spine.progress, credit_acked_screens: [] }
    expect(uncoveredScreens(spine)).toEqual(["S02"])
  })
})
