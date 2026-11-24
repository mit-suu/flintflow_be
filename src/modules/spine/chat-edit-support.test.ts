import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { spineSchema } from "./spine.schema.js"
import type { Spine } from "./spine.types.js"
import { assumptionOps, assumptionsNote, predictRedFlags, predictedRedNote, sectionDraftProblems, stampChatSource } from "./chat-edit-support.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8")))
const variant = (fn: (s: Spine) => void): Spine => {
  const s = structuredClone(FIXTURE)
  fn(s)
  return s
}

describe("predictRedFlags", () => {
  it("chỉ báo cờ đỏ MỚI, không báo cờ đỏ đã có từ trước", () => {
    const before = variant((s) => (s.nfrs[0].statement = "The UI is easy to use."))
    const after = variant((s) => {
      s.nfrs[0].statement = "The UI is easy to use."
      s.nfrs[1].statement = "Pages load fast."
    })
    expect(predictRedFlags(before, after).map((f) => f.target_id)).toEqual([FIXTURE.nfrs[1].id])
    expect(predictRedFlags(before, before)).toEqual([])
  })

  it("không báo cờ sơ đồ (code vẽ lại ngay sau khi ghi)", () => {
    const after = variant((s) => {
      s.actors[0].name = "Renamed Actor"
    })
    expect(predictRedFlags(FIXTURE, after).filter((f) => f.rule_id === "diagram_stale")).toEqual([])
  })

  it("câu 'chặn baseline' theo ngôn ngữ; không cờ ⇒ rỗng", () => {
    const flags = predictRedFlags(FIXTURE, variant((s) => (s.nfrs[0].statement = "Pages load fast.")))
    expect(predictedRedNote(flags, "vi")).toContain("chặn baseline")
    expect(predictedRedNote(flags, "en")).toContain("block the baseline")
    expect(predictedRedNote([], "vi")).toBe("")
  })
})

describe("sectionDraftProblems", () => {
  const table = (...rows: string[][]) => ({ kind: "table" as const, text: "", rows, image_ref: null })
  const para = (text: string) => ({ kind: "paragraph" as const, text, rows: null, image_ref: null })
  const withSection = (blocks: Spine["custom_sections"][number]["blocks"]): Spine => ({
    ...FIXTURE,
    custom_sections: [{ id: "CS1", heading: "Targets", level: 2, blocks, source: "import" }]
  })
  const template = withSection([para("[Describe the targets.]"), table(["ID", "Target"], ["[x]", "[y]"])])
  const rewritten = (blocks: Spine["custom_sections"][number]["blocks"]): Spine => ({ ...template, custom_sections: [{ ...template.custom_sections[0], blocks }] })

  it("bảng đúng cột, chữ cụ thể ⇒ đạt", () => {
    expect(sectionDraftProblems(template, rewritten([para("Targets for the first release."), table(["id", " TARGET "], ["T1", "p95 under 2 s"])]), "")).toEqual([])
  })

  it("thiếu bảng / sai cột ⇒ câu cho người đọc, không có mã luật", () => {
    const missing = sectionDraftProblems(template, rewritten([para("Targets.")]), "")
    expect(missing[0]).toContain('thiếu bảng thứ 1 của mẫu (cột: ID, Target)')
    const wrong = sectionDraftProblems(template, rewritten([table(["ID", "Goal"], ["T1", "a"])]), "")
    expect(wrong[0]).toContain("phải đúng các cột của mẫu (ID, Target)")
    expect(wrong.join(" ")).not.toMatch(/duplicate|vague_wording|table_structure/)
  })

  it("từ mơ hồ trong chữ mới ⇒ báo; từ người dùng gõ trong lệnh ⇒ giữ; chữ cũ của mẫu không tính", () => {
    const vague = rewritten([table(["ID", "Target"], ["T1", "Responses are fast and efficient."])])
    expect(sectionDraftProblems(template, vague, "")[0]).toContain('"fast"')
    expect(sectionDraftProblems(template, vague, "ghi fast và efficient").length).toBe(0)
    expect(sectionDraftProblems(withSection([para("Be fast.")]), withSection([para("Be fast.")]), "")).toEqual([])
  })

  it("mục không đổi hoặc không có trước đó ⇒ không xét", () => {
    expect(sectionDraftProblems(template, template, "")).toEqual([])
    expect(sectionDraftProblems(FIXTURE, template, "")).toEqual([])
  })
})

describe("giả định", () => {
  const list = [{ path: "nfrs[id=N07].threshold", statement: "p95 under 2 s", statement_vi: "p95 dưới 2 giây" }]

  it("thành op add assumptions[] unconfirmed, origin_step_id là bước sở hữu mục; id tạm vẫn tra được mục sở hữu, path hỏng ⇒ S-9.1", () => {
    const [op] = assumptionOps(FIXTURE, list)
    expect(op).toMatchObject({ op: "add", path: "assumptions[]", value: { path: "nfrs[id=N07].threshold", status: "unconfirmed", confirmed_at: null, origin_step_id: "S-6.4" } })
    expect(assumptionOps(FIXTURE, [{ path: "use_cases[id=$new1].name", statement: "x" }])[0].value).toMatchObject({ origin_step_id: "S-3.2" })
    expect(assumptionOps(FIXTURE, [{ path: "not a path", statement: "x" }])[0].value).toMatchObject({ origin_step_id: "S-9.1" })
  })

  it("câu nói giả định giọng BA theo ngôn ngữ, không nhãn hộp; rỗng ⇒ rỗng", () => {
    expect(assumptionsNote(list, "vi")).toBe("Chỗ bạn chưa nói rõ nên mình tạm hiểu: p95 dưới 2 giây. Sai chỗ nào bạn nhắn mình sửa lại nhé.")
    expect(assumptionsNote(list, "en")).toContain("p95 under 2 s")
    expect(assumptionsNote([], "vi")).toBe("")
    expect(assumptionsNote(list, "vi")).not.toContain("—")
  })
})

describe("stampChatSource", () => {
  it("chỉ gắn nguồn cho op add vào functions / nfrs / business_rules thiếu source_ref", () => {
    const ops = stampChatSource([
      { op: "add", path: "nfrs[]", value: { category: "performance", statement: "x" } },
      { op: "add", path: "business_rules[]", value: { statement: "y", source_ref: "Brief" } },
      { op: "add", path: "actors[]", value: { name: "z" } },
      { op: "set", path: "nfrs[id=N01].statement", value: "w" }
    ])
    expect(ops[0].value).toMatchObject({ source_ref: "User request via chat" })
    expect(ops[1].value).toMatchObject({ source_ref: "Brief" })
    expect(ops[2].value).toEqual({ name: "z" })
    expect(ops[3].value).toBe("w")
  })
})
