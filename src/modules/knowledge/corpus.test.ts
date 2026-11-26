import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it, expect } from "vitest"
import { chunkCorpus } from "./chunker.js"
import { ISO_29148_CORPUS, ISO_29148_CORPUS_DIR, loadCorpus, stepsBySkill } from "./corpus.js"

describe("loadCorpus - skill (assets/skills)", () => {
  const docs = loadCorpus("assets/skills", { corpus: "skills" })
  const bySource = new Map(docs.map((d) => [d.source, d]))

  it("đọc mọi SKILL.md trừ skill đánh dấu `knowledge_index: false` (knowledge-answer)", () => {
    // 52 = 53 skill (thêm renderer/sequence; FLF-365: 3 skill mục IEEE 29148; FLF-395: skeleton-generic-names, template-migration-resolve;
    // FLF-390: renderer/activity, renderer/deployment; FLF-492: cr-record-summary) trừ knowledge-answer
    expect(docs).toHaveLength(52)
    expect(bySource.has("knowledge-answer")).toBe(false)
    expect(docs.every((d) => d.source_kind === "internal_skill" && d.status === "verified" && d.corpus === "skills")).toBe(true)
    expect(docs.every((d) => d.doc_id === d.source)).toBe(true)
  })

  it("lấy kind, description từ frontmatter; thân không còn frontmatter và xuống dòng LF", () => {
    const d = bySource.get("draft-to-ops")!
    expect(d.topic).toBe("action")
    expect(d.description).toMatch(/op transaction/i)
    expect(d.body.startsWith("---")).toBe(false)
    expect(d.body.includes("\r")).toBe(false)
  })

  it("applies_to: skill content theo STEP_SKILLS, renderer theo `renders` của step registry, skill action thì rỗng", () => {
    expect(bySource.get("actors-and-usecases")!.applies_to).toEqual(["S-3.1", "S-3.2", "S-3.3", "S-3.4", "S-3.5"])
    expect(bySource.get("usecase")!.applies_to.length).toBeGreaterThan(0)
    expect(bySource.get("screen-flow")!.applies_to).toEqual(stepsBySkill().get("screen-flow"))
    expect(bySource.get("draft-to-ops")!.applies_to).toEqual([])
  })
})

describe("loadCorpus - corpus khác (chuẩn ngoài, phase 2)", () => {
  let dir: string
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it("đọc mọi *.md kể cả thư mục con; mặc định standard + placeholder; frontmatter ghi đè được", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kcorpus-"))
    fs.mkdirSync(path.join(dir, "iso-29148"))
    fs.writeFileSync(path.join(dir, "iso-29148", "index.md"), "---\nsource: ISO/IEC/IEEE 29148\ntopic: requirements\n---\n\nIndex.\r\n")
    fs.writeFileSync(
      path.join(dir, "iso-29148", "5-2-5.md"),
      "---\nsource: ISO/IEC/IEEE 29148\nsection: 5.2.5 Characteristics\ntopic: requirements\nstatus: verified\napplies_to: [S-6.1]\n---\n\nClause body.\n"
    )
    fs.writeFileSync(path.join(dir, "draft.md"), "---\nknowledge_index: false\n---\nIgnored.\n")
    const docs = loadCorpus(dir, { corpus: "standards" })
    expect(docs.map((d) => d.doc_id)).toEqual(["iso-29148/5-2-5", "iso-29148/index"])
    const clause = docs[0]!
    expect(clause).toMatchObject({ corpus: "standards", source: "ISO/IEC/IEEE 29148", source_kind: "standard", status: "verified", applies_to: ["S-6.1"], section: "5.2.5 Characteristics" })
    expect(docs[1]).toMatchObject({ status: "placeholder", applies_to: [], topic: "requirements" })
    expect(docs[1]!.body.includes("\r")).toBe(false)
  })

  it("thư mục không tồn tại ⇒ lỗi rõ", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kcorpus-"))
    expect(() => loadCorpus(path.join(dir, "nope"), { corpus: "x" })).toThrow(/Không thấy thư mục corpus/)
  })
})

describe("FLF-465 - kho điều khoản ISO/IEC/IEEE 29148 (assets/knowledge/iso-29148)", () => {
  const docs = loadCorpus(ISO_29148_CORPUS_DIR, { corpus: ISO_29148_CORPUS })

  it("tên corpus mặc định của ingest (tên thư mục) trùng hằng số chat tra cứu", () => {
    expect(path.basename(ISO_29148_CORPUS_DIR)).toBe(ISO_29148_CORPUS)
  })

  it("mọi điều khoản là chuẩn ngoài đã xác minh, nguồn ghi rõ phiên bản, nhãn section bắt đầu bằng số điều khoản; index không vào kho", () => {
    expect(docs.length).toBeGreaterThanOrEqual(5)
    expect(docs.map((d) => d.doc_id)).not.toContain("index")
    for (const d of docs) {
      expect(d).toMatchObject({ corpus: ISO_29148_CORPUS, source: "ISO/IEC/IEEE 29148:2018", source_kind: "standard", status: "verified" })
      expect(d.section).toMatch(/^\d+(\.\d+)+ \S/)
      expect(d.body.trim().length).toBeGreaterThan(200)
    }
    expect(docs.map((d) => d.section)).toContain("5.2.5 Characteristics of individual requirements")
  })

  it("chunk của mỗi điều khoản mang nhãn section = số điều khoản để trích dẫn được; id duy nhất", () => {
    const { chunks } = chunkCorpus(docs)
    expect(chunks.length).toBeGreaterThanOrEqual(docs.length)
    expect(new Set(chunks.map((c) => c.chunk_id)).size).toBe(chunks.length)
    expect(chunks.every((c) => /^\d+(\.\d+)+ /.test(c.section) && c.status === "verified" && c.source_kind === "standard")).toBe(true)
  })
})
