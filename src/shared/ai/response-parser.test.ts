import { describe, it, expect } from "vitest"
import { ActionType, AiActionError } from "./ai-action.types.js"
import { parseResponse, type OpTransaction, type ChangeInstructionOutput, type ReviewOutput } from "./response-parser.js"

const expectAiError = (fn: () => unknown, code: string) => {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(AiActionError)
    expect((err as AiActionError).code).toBe(code)
    return
  }
  throw new Error(`Expected AiActionError ${code}`)
}

describe("parseResponse — schema pipeline (T03)", () => {
  it("DRAFT nhận opTransaction hợp lệ, kể cả bọc code fence", () => {
    const raw = '```json\n{"ops":[{"op":"set","path":"actors[id=A03].name","value":"Administrator","reason":"typo"},{"op":"renumber","path":"features[]"}]}\n```'
    const out = parseResponse<OpTransaction>(raw, ActionType.DRAFT)

    expect(out.ops).toHaveLength(2)
    expect(out.ops[0].path).toBe("actors[id=A03].name")
  })

  it("DRAFT từ chối op lạ — không trả raw text", () => {
    expectAiError(
      () => parseResponse('{"ops":[{"op":"replace","path":"actors[]"}]}', ActionType.DRAFT),
      "SCHEMA_MISMATCH"
    )
  })

  it("DRAFT không phải JSON → PARSE_FAILED", () => {
    expectAiError(() => parseResponse("Here is the section text...", ActionType.DRAFT), "PARSE_FAILED")
  })

  it("ELICIT chuẩn hoá question dạng chuỗi", () => {
    const out = parseResponse<{ reply: string; questions: Array<{ question: string }> }>(
      '{"reply":"Ok","questions":["Ai duyệt yêu cầu?"]}',
      ActionType.ELICIT
    )

    expect(out.questions[0].question).toBe("Ai duyệt yêu cầu?")
  })

  it("CHAT hỏng JSON vẫn cứu được câu hỏi có option object", () => {
    const raw = '{"reply":"Ok","questions":[{"question":"Nền tảng?","options":[{"label":"Web","description":"Trình duyệt"},{"label":"Mobile"}],"multiple":false},{"question":"Kể thêm?"'
    const out = parseResponse<{ questions: Array<{ question: string; options: Array<{ label: string }> }> }>(raw, ActionType.CHAT)
    expect(out.questions[0]).toMatchObject({ question: "Nền tảng?", options: [{ label: "Web" }, { label: "Mobile" }] })
    expect(out.questions[1]).toMatchObject({ question: "Kể thêm?", options: [] })
  })

  it("REVIEW đòi section_id và message", () => {
    const ok = parseResponse<ReviewOutput>(
      '{"flags":[{"level":"yellow","rule_id":"ambiguity","section_id":"function:FN07","message":"mơ hồ"}]}',
      ActionType.REVIEW
    )
    expect(ok.flags).toHaveLength(1)

    expectAiError(
      () => parseResponse('{"flags":[{"level":"yellow","message":"x"}]}', ActionType.REVIEW),
      "SCHEMA_MISMATCH"
    )
  })

  it("CHANGE_INSTRUCTION cần clarification_needed hoặc ops", () => {
    const ask = parseResponse<ChangeInstructionOutput>(
      '{"clarification_needed":"Đổi actor nào?"}',
      ActionType.CHANGE_INSTRUCTION
    )
    expect(ask.clarification_needed).toBeTruthy()

    expectAiError(() => parseResponse("{}", ActionType.CHANGE_INSTRUCTION), "SCHEMA_MISMATCH")
  })

  it("RENDER_FIX đòi puml", () => {
    const out = parseResponse<{ puml: string }>('{"puml":"@startuml\\n@enduml"}', ActionType.RENDER_FIX)
    expect(out.puml).toContain("@startuml")
  })
})

describe("parseResponse — mode 1 (FLF-171)", () => {
  const json = (v: unknown) => JSON.stringify(v)

  it("IMPORT_EXTRACT_FIELDS: theo thực thể, bắt buộc block nguồn, field_confidence mặc định {}", () => {
    const out = parseResponse(
      json({
        section_id: "fixed:2.1",
        items: [{ entity: "actors", key: null, value: { name: "Student" }, confidence: 0.9, source_block_ids: ["B0031"] }]
      }),
      ActionType.IMPORT_EXTRACT_FIELDS
    ) as { items: { field_confidence: Record<string, number> }[]; unmapped_block_ids: string[] }
    expect(out.items[0].field_confidence).toEqual({})
    expect(out.unmapped_block_ids).toEqual([])

    const base = { entity: "actors", key: null, value: { name: "x" }, confidence: 0.9, source_block_ids: ["B0031"] }
    expectAiError(() => parseResponse(json({ section_id: "s", items: [{ ...base, source_block_ids: [] }] }), ActionType.IMPORT_EXTRACT_FIELDS), "SCHEMA_MISMATCH")
    expectAiError(() => parseResponse(json({ section_id: "s", items: [{ ...base, entity: "flags" }] }), ActionType.IMPORT_EXTRACT_FIELDS), "SCHEMA_MISMATCH")
    expectAiError(() => parseResponse(json({ section_id: "s", items: [{ ...base, confidence: 1.2 }] }), ActionType.IMPORT_EXTRACT_FIELDS), "SCHEMA_MISMATCH")
  })

  it("IMPORT_SEMANTIC_CHECK / CR_CONSISTENCY: findings không có level (chỉ vàng)", () => {
    for (const at of [ActionType.IMPORT_SEMANTIC_CHECK, ActionType.CR_CONSISTENCY]) {
      const out = parseResponse(json({ findings: [{ rule: "ambiguity", section_id: "fixed:4.2.3", message: "\"quickly\" không đo được" }] }), at) as {
        findings: { block_ids: string[] }[]
      }
      expect(out.findings[0].block_ids).toEqual([])
    }
    expectAiError(() => parseResponse(json({ findings: [{ rule: "x", section_id: "s" }] }), ActionType.CR_CONSISTENCY), "SCHEMA_MISMATCH")
  })

  it("CR_CLARIFY: mơ hồ cần câu hỏi; rõ cần đích", () => {
    expect(parseResponse(json({ ambiguous: true, questions: ["Có tính mobile?"], targets: {} }), ActionType.CR_CLARIFY)).toMatchObject({ ambiguous: true })
    expect(parseResponse(json({ ambiguous: false, targets: { keywords: ["log out"] } }), ActionType.CR_CLARIFY)).toMatchObject({
      targets: { entity_paths: [], keywords: ["log out"] }
    })
    expectAiError(() => parseResponse(json({ ambiguous: true, questions: [], targets: {} }), ActionType.CR_CLARIFY), "SCHEMA_MISMATCH")
    expectAiError(() => parseResponse(json({ ambiguous: false, targets: {} }), ActionType.CR_CLARIFY), "SCHEMA_MISMATCH")
  })

  it("CR_PROPOSE: edit cần spine_ops (FLF-186), comment cần comment_text, not_related không kèm op", () => {
    const ok = parseResponse(
      json({
        locations: [
          { location_id: "L001", conclusion: "edit", reason: "r", spine_ops: [{ op: "set", path: "functions[id=FN04].name", value: "Sign out of all devices" }] },
          { location_id: "L002", conclusion: "not_related", reason: "chỉ nói về đăng nhập" }
        ]
      }),
      ActionType.CR_PROPOSE
    ) as { locations: { spine_ops: unknown[] }[] }
    expect(ok.locations[1].spine_ops).toEqual([])
    const bad = (loc: Record<string, unknown>) => expectAiError(() => parseResponse(json({ locations: [loc] }), ActionType.CR_PROPOSE), "SCHEMA_MISMATCH")
    bad({ location_id: "L001", conclusion: "edit", reason: "r" })
    bad({ location_id: "L001", conclusion: "edit", reason: "r", new_text: "chỉ có text, không op" })
    bad({ location_id: "L001", conclusion: "comment", reason: "r" })
    bad({ location_id: "L001", conclusion: "not_related", reason: "r", spine_ops: [{ op: "set", path: "actors[id=A1].name", value: "x" }] })
    bad({ location_id: "1", conclusion: "comment", reason: "r", comment_text: "c" })
  })
})

describe("parseResponse — translate_document (FLF-265)", () => {
  it("nhận lô có chuỗi và mảng chuỗi", () => {
    const raw =
      '```json\n{"items":[{"key":"actors[id=A01].name","text":"Quản trị viên"},{"key":"functions[id=FN3].normal","text":["Bước 1","Bước 2"]}]}\n```'
    const out = parseResponse<{ items: { key: string; text: string | string[] }[] }>(raw, ActionType.TRANSLATE_DOCUMENT)

    expect(out.items).toHaveLength(2)
    expect(out.items[1].text).toEqual(["Bước 1", "Bước 2"])
  })

  it("nhận lô rỗng; items không phải mảng / thiếu ⇒ SCHEMA_MISMATCH", () => {
    expect(parseResponse<{ items: unknown[] }>('{"items":[]}', ActionType.TRANSLATE_DOCUMENT).items).toEqual([])
    expectAiError(() => parseResponse('{"items":{"key":"a","text":"x"}}', ActionType.TRANSLATE_DOCUMENT), "SCHEMA_MISMATCH")
    expectAiError(() => parseResponse('{"result":[]}', ActionType.TRANSLATE_DOCUMENT), "SCHEMA_MISMATCH")
  })

  it("mục sai khuôn (key rỗng, text null / số / object) ⇒ bỏ đúng mục đó, giữ phần còn lại của lô", () => {
    const raw = JSON.stringify({
      items: [
        { key: "a", text: "Một" },
        { key: "", text: "x" },
        { key: "b", text: null },
        { key: "c", text: 3 },
        { key: "d", text: { vi: "x" } },
        "rác",
        { key: "e", text: ["Bước 1", "Bước 2"] }
      ]
    })
    const out = parseResponse<{ items: { key: string; text: string | string[] }[] }>(raw, ActionType.TRANSLATE_DOCUMENT)
    expect(out.items).toEqual([
      { key: "a", text: "Một" },
      { key: "e", text: ["Bước 1", "Bước 2"] }
    ])
  })

  it("chữ rỗng không làm hỏng cả lô — service bỏ đơn vị đó sau (fitTranslation)", () => {
    const raw = '{"items":[{"key":"a","text":"Một"},{"key":"b","text":"  "}]}'
    const out = parseResponse<{ items: { key: string; text: string }[] }>(raw, ActionType.TRANSLATE_DOCUMENT)
    expect(out.items.map((i) => i.key)).toEqual(["a", "b"])
  })
})

describe("parseResponse — localized cạnh ops (FLF-265 D16)", () => {
  const localized = [{ path: "actors[id=A03].name", value: "Quản trị viên" }]
  const op = { op: "set", path: "actors[id=A03].name", value: "Administrator" }

  it("opTransaction / discoveryStep / changeInstruction nhận localized tuỳ chọn; thiếu vẫn qua", () => {
    expect(parseResponse<OpTransaction>(JSON.stringify({ ops: [op], localized }), ActionType.DRAFT).localized).toEqual(localized)
    expect(parseResponse<OpTransaction>(JSON.stringify({ ops: [op], localized }), ActionType.RECONCILE).localized).toEqual(localized)
    expect(parseResponse<ChangeInstructionOutput>(JSON.stringify({ ops: [op], localized }), ActionType.CHANGE_INSTRUCTION).localized).toEqual(localized)
    expect(parseResponse<{ localized?: unknown }>(JSON.stringify({ reply: "ok", ops: [op], localized }), ActionType.DISCOVERY_STEP).localized).toEqual(localized)

    const plain = parseResponse<OpTransaction>(JSON.stringify({ ops: [op] }), ActionType.DRAFT)
    expect(plain).toEqual({ ops: [op] })
    expect(plain).not.toHaveProperty("localized")
    expect(parseResponse<ChangeInstructionOutput>(JSON.stringify({ clarification_needed: "Which actor?" }), ActionType.CHANGE_INSTRUCTION)).not.toHaveProperty("localized")
  })

  it("localized sai khuôn không bao giờ làm hỏng lượt ghi: mục hỏng bị bỏ, không phải mảng ⇒ coi như không có", () => {
    const messy = { ops: [op], localized: [{ path: "", value: "x" }, { value: "x" }, "x", null, ...localized] }
    expect(parseResponse<OpTransaction>(JSON.stringify(messy), ActionType.DRAFT).localized).toEqual(localized)
    expect(parseResponse<OpTransaction>(JSON.stringify({ ops: [op], localized: "Quản trị viên" }), ActionType.DRAFT).localized).toBeUndefined()
    expect(parseResponse<OpTransaction>(JSON.stringify({ ops: [op], localized: null }), ActionType.REVISION).ops).toEqual([op])
  })

  it("op vẫn theo opSchema đóng băng — localized nằm cạnh ops, không phải field của op", () => {
    expectAiError(() => parseResponse(JSON.stringify({ ops: [{ op: "move", path: "actors[]" }], localized }), ActionType.DRAFT), "SCHEMA_MISMATCH")
    const out = parseResponse<OpTransaction>(JSON.stringify({ ops: [{ ...op, localized: "x" }] }), ActionType.DRAFT)
    expect(out.ops[0]).not.toHaveProperty("localized")
  })
})
