import { describe, expect, it } from "vitest"
import { textHash } from "../docx-ooxml/index.js"
import { diffBlockLists, type DiffBlock } from "./block-diff.js"

const b = (block_id: string | null, text: string, para_id: string | null = null): DiffBlock => ({ block_id, text, text_hash: textHash(text), para_id })

describe("diffBlockLists", () => {
  const base = [b("B0001", "Intro"), b("B0002", "Actors"), b("B0003", "Learner enrolls"), b("B0004", "Glossary")]

  it("không đổi ⇒ rỗng", () => {
    expect(diffBlockLists(base, base)).toEqual({ blocks: [], summary: { added: 0, removed: 0, modified: 0, moved: 0 } })
  })

  it("sửa theo bookmark, thêm, xoá", () => {
    const after = [b("B0001", "Intro"), b("B0003", "Learner enrolls in a course"), b(null, "New paragraph"), b("B0004", "Glossary")]
    const res = diffBlockLists(base, after)
    expect(res.blocks).toEqual([
      { block_id: "B0003", change: "modified", before: "Learner enrolls", after: "Learner enrolls in a course" },
      { block_id: null, change: "added", after: "New paragraph" },
      { block_id: "B0002", change: "removed", before: "Actors" }
    ])
    expect(res.summary).toEqual({ added: 1, removed: 1, modified: 1, moved: 0 })
  })

  it("di chuyển: block ra khỏi dãy thứ tự dài nhất", () => {
    const after = [b("B0001", "Intro"), b("B0004", "Glossary"), b("B0002", "Actors"), b("B0003", "Learner enrolls")]
    expect(diffBlockLists(base, after).blocks).toEqual([{ block_id: "B0004", change: "moved", before: "Glossary", after: "Glossary" }])
  })

  it("mất bookmark ⇒ khớp theo paraId rồi theo text", () => {
    const before = [b("B0001", "Alpha", "AAAA0001"), b("B0002", "Beta"), b("B0003", "Gamma")]
    const after = [b(null, "Alpha changed", "AAAA0001"), b(null, "Beta"), b(null, "Gamma")]
    expect(diffBlockLists(before, after).blocks).toEqual([{ block_id: "B0001", change: "modified", before: "Alpha", after: "Alpha changed" }])
  })

  it("FLF-186 — không neo (file render): block lẻ giữa cùng hai block đã khớp, giống từ ≥ 50% ⇒ modified; khác hẳn ⇒ xoá + thêm", () => {
    const n = (text: string) => b(null, text)
    const before = [n("Intro"), n("The system shall respond within 2 seconds."), n("Glossary")]
    const edited = diffBlockLists(before, [n("Intro"), n("The system shall respond within 1 second."), n("Glossary")])
    expect(edited.blocks).toEqual([{ block_id: null, change: "modified", before: "The system shall respond within 2 seconds.", after: "The system shall respond within 1 second." }])
    const replaced = diffBlockLists(before, [n("Intro"), n("Completely different words here"), n("Glossary")])
    expect(replaced.summary).toEqual({ added: 1, removed: 1, modified: 0, moved: 0 })
  })
})
