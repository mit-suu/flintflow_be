import { describe, expect, it } from "vitest"
import { shapeQuestions } from "./question-shape.js"
import { DEFAULT_CHOICE, diagramChoiceFor, diagramChoiceKindOfTopic, diagramChoiceQuestion, ledgerChoice, resolveDiagramChoice } from "./diagram-choice.js"
import type { Decision } from "../spine/spine.types.js"

const decision = (topic_key: string, answer: string, superseded_by: string | null = null): Decision => ({
  id: "DC1",
  topic_key,
  question: "q",
  answer,
  step_id: "S-4.5",
  at: "2026-11-14T00:00:00.000Z",
  superseded_by
})

describe("diagramChoiceFor (FLF-418)", () => {
  it("S-4.5 hỏi ký pháp, S-5.4 hỏi mức — chỉ khi Project chưa có giá trị", () => {
    expect(diagramChoiceFor("S-4.5", {}, { decisions: [] })).toEqual({ kind: "erd", backfill: null })
    expect(diagramChoiceFor("S-5.4", {}, { decisions: [] })).toEqual({ kind: "sequence", backfill: null })
    expect(diagramChoiceFor("S-4.5", { erdNotation: "chen" }, { decisions: [] })).toBeNull()
    expect(diagramChoiceFor("S-5.4", { sequenceLevel: "component" }, { decisions: [] })).toBeNull()
    expect(diagramChoiceFor("S-5.2", {}, { decisions: [] })).toBeNull()
    expect(diagramChoiceFor("S-4.5", null, { decisions: [] })).toBeNull()
  })

  it("sổ quyết định có câu trả lời ⇒ ghi bù; quyết định đã bị thay ⇒ bỏ qua", () => {
    expect(diagramChoiceFor("S-4.5", {}, { decisions: [decision("erd_notation", "IDEF1X")] })).toEqual({ kind: "erd", backfill: "idef1x" })
    expect(ledgerChoice({ decisions: [decision("sequence_level", "Thành phần")] }, "sequence")).toBe("component")
    expect(ledgerChoice({ decisions: [decision("erd_notation", "IDEF1X", "DC2")] }, "erd")).toBeNull()
  })
})

describe("resolveDiagramChoice", () => {
  it("nhãn thẻ (kể cả Khuyến nghị / Recommended), tên vi / en, viết tắt", () => {
    expect(resolveDiagramChoice("erd", "Chen (Khuyến nghị)")).toBe("chen")
    expect(resolveDiagramChoice("erd", "Crow's Foot")).toBe("crowsfoot")
    expect(resolveDiagramChoice("erd", "crows foot")).toBe("crowsfoot")
    expect(resolveDiagramChoice("erd", "vẽ kiểu chân chim giúp mình")).toBe("crowsfoot")
    expect(resolveDiagramChoice("erd", "idef1x")).toBe("idef1x")
    expect(resolveDiagramChoice("sequence", "Hệ thống (Khuyến nghị)")).toBe("system")
    expect(resolveDiagramChoice("sequence", "System (Recommended)")).toBe("system")
    expect(resolveDiagramChoice("sequence", "mình muốn chi tiết")).toBe("component")
    expect(resolveDiagramChoice("sequence", "Component")).toBe("component")
  })

  it("không khớp / mơ hồ ⇒ null", () => {
    expect(resolveDiagramChoice("erd", "tuỳ bạn")).toBeNull()
    expect(resolveDiagramChoice("erd", "")).toBeNull()
    expect(resolveDiagramChoice("erd", "chen hay crow đều được")).toBeNull()
    expect(resolveDiagramChoice("sequence", "hệ thống thành phần")).toBeNull()
  })
})

describe("diagramChoiceQuestion", () => {
  it("đúng luật thẻ hỏi: header ≤ 12, 2–4 lựa chọn, có mô tả + preview, mặc định Khuyến nghị; id Q_<topic>", () => {
    for (const language of ["vi", "en"] as const) {
      for (const kind of ["erd", "sequence"] as const) {
        const q = diagramChoiceQuestion(kind, language)
        expect(q.header!.length).toBeLessThanOrEqual(12)
        expect(diagramChoiceKindOfTopic(q.topic_key)).toBe(kind)
        const { questions } = shapeQuestions([q])
        expect(questions[0].id).toBe(`Q_${q.topic_key}`)
        expect(questions[0].options!.length).toBe(q.options.length)
        expect(q.options.every((o) => o.description && o.preview)).toBe(true)
        const recommended = q.options.find((o) => /Khuyến nghị|Recommended/.test(o.label))!
        expect(resolveDiagramChoice(kind, recommended.label)).toBe(DEFAULT_CHOICE[kind])
      }
    }
  })
})
