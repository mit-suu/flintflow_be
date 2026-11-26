import { describe, expect, it } from "vitest"
import type { StepState } from "../spine/spine.types.js"
import { sectionProgressOf } from "./section-progress.js"

const step = (id: string, status: StepState["status"]) => ({ id, status })
const sec = (section_id: string, status: "present" | "missing" | "out_of_scope", owner_steps: string[], title = section_id) => ({ section_id, title, status, owner_steps })

describe("sectionProgressOf - FLF-461 tiến độ chế độ 3/4 theo mục còn cần xử lý", () => {
  const sections = [
    sec("fixed:1", "present", ["S-2.1"]),
    sec("fixed:2.1", "missing", ["S-3.1"]),
    sec("fixed:5.5", "missing", ["S-8.3"]),
    sec("feature:F1", "missing", ["S-5.2"]),
    sec("custom:c1", "out_of_scope", []),
    sec("fixed:I", "missing", ["S-9.1"], "Table of Contents")
  ]
  it("đếm mục file còn thiếu mà bước sở hữu chưa chốt; mục đã viết, Ngoài phạm vi, bìa / mục lục không tính", () => {
    const steps = [step("S-2.1", "accepted"), step("S-3.1", "pending"), step("S-8.3", "pending"), step("S-5.2@S01", "pending")]
    expect(sectionProgressOf(sections, steps)).toEqual({ total: 3, remaining: 3 })
  })
  it("bước sở hữu đã chốt thì mục xong; bước vòng S-5 theo từng màn, còn một màn chưa chốt là mục còn việc", () => {
    const steps = [step("S-3.1", "accepted"), step("S-8.3", "skipped"), step("S-5.2@S01", "accepted"), step("S-5.2@S02", "pending")]
    expect(sectionProgressOf(sections, steps)).toEqual({ total: 3, remaining: 1 })
    expect(sectionProgressOf(sections, [step("S-3.1", "accepted"), step("S-8.3", "accepted"), step("S-5.2@S01", "accepted")])).toEqual({ total: 3, remaining: 0 })
  })
  it("mục thiếu không có bước soạn nào (owner_steps rỗng) vẫn là mục còn việc, không coi là xong", () => {
    expect(sectionProgressOf([sec("custom:c2", "missing", [])], [step("S-8.1", "accepted")])).toEqual({ total: 1, remaining: 1 })
  })
})
