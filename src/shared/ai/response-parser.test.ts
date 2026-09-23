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
