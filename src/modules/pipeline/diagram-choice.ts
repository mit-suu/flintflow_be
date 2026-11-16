/**
 * FLF-418 — thẻ hỏi TẤT ĐỊNH trong khung chat (không gọi model): S-4.5 hỏi ký pháp ERD, S-5.4 lần đầu hỏi mức Sequence
 * Diagram. Lựa chọn ghi vào Project (`erdNotation` / `sequenceLevel`, ngoài Spine — cùng cách làm với ký pháp ERD) và sổ
 * quyết định (`decisions[topic_key]`) như mọi câu trả lời khác. Đã có giá trị (chat, cài đặt dự án, import đọc từ file) ⇒
 * không hỏi. Spec: `spec/FLF-418-sequence-level-chat-choice/01-spec.md` §5.
 *
 * Câu trả lời chỉ khớp tất định (nhãn lựa chọn, tên vi / en, viết tắt) — chữ tự do không khớp ⇒ hỏi lại một lần, rồi
 * dùng giá trị khuyến nghị (03 #7).
 */

import mongoose from "mongoose"
import { ERD_NOTATIONS, erdNotationChosen, toErdNotation, type ErdNotation } from "../../shared/diagram/erd-notation.js"
import { SEQUENCE_LEVELS, sequenceLevelChosen, toSequenceLevel, type SequenceLevel } from "../../shared/diagram/sequence-level.js"
import { byLanguage, type ReplyLanguage } from "../../shared/i18n/reply-language.js"
import type { QuestionOption } from "../../shared/ai/response-parser.js"
import type { Spine } from "../spine/spine.types.js"
import { Project } from "../project/project.model.js"
import { stripRecommended, type ModelQuestion } from "./question-shape.js"

export type DiagramChoiceKind = "erd" | "sequence"

export const DIAGRAM_CHOICE_TOPICS: Readonly<Record<DiagramChoiceKind, string>> = Object.freeze({ erd: "erd_notation", sequence: "sequence_level" })

/** Template step hỏi lựa chọn: S-4.5 vẽ ERD, S-5.4 sinh dữ liệu sơ đồ tuần tự (mức phải biết trước Draft). */
const STEP_OF_KIND: Readonly<Record<DiagramChoiceKind, string>> = Object.freeze({ erd: "S-4.5", sequence: "S-5.4" })

export type DiagramChoiceValue = ErdNotation | SequenceLevel

/** Field của Project đọc / ghi. */
export interface DiagramChoiceState {
  erdNotation?: unknown
  sequenceLevel?: unknown
}

export type DiagramChoiceQuestion = ModelQuestion & { topic_key: string }

/** Giá trị dùng khi người dùng trả lời không khớp hai lần — cũng là lựa chọn "(Khuyến nghị)". */
export const DEFAULT_CHOICE: Readonly<Record<DiagramChoiceKind, DiagramChoiceValue>> = Object.freeze({ erd: "chen", sequence: "system" })

interface ChoiceOption {
  value: DiagramChoiceValue
  label: Readonly<Record<ReplyLanguage, string>>
  description: Readonly<Record<ReplyLanguage, string>>
  preview: string
  /** Từ khoá khớp chữ tự do (đã bỏ dấu, chữ thường). */
  aliases: readonly string[]
}

const OPTIONS: Readonly<Record<DiagramChoiceKind, readonly ChoiceOption[]>> = Object.freeze({
  erd: [
    {
      value: "chen",
      label: { vi: "Chen", en: "Chen" },
      description: {
        vi: "Thực thể là hình chữ nhật, quan hệ là hình thoi có động từ, bản số ghi trên cạnh. Dễ đọc với người không chuyên.",
        en: "Entities are rectangles, relationships are verb diamonds, cardinality on the edges. Easy for non-technical readers."
      },
      preview: "[Customer] --1-- <places> --N-- [Order]",
      aliases: ["chen"]
    },
    {
      value: "crowsfoot",
      label: { vi: "Crow's Foot", en: "Crow's Foot" },
      description: {
        vi: "Ký hiệu chân chim ở đầu cạnh (một / nhiều, bắt buộc / tuỳ chọn). Phổ biến trong thiết kế cơ sở dữ liệu.",
        en: "Crow's foot marks at the line ends (one / many, mandatory / optional). Common in database design."
      },
      preview: "[Customer] ||------o{ [Order]",
      aliases: ["crowsfoot", "crow", "crows", "chan chim", "ie"]
    },
    {
      value: "idef1x",
      label: { vi: "IDEF1X", en: "IDEF1X" },
      description: {
        vi: "Chuẩn IDEF1X: chấm tròn ở phía nhiều, thực thể phụ thuộc bo góc. Hay dùng trong hồ sơ kỹ thuật chính thức.",
        en: "IDEF1X standard: a dot on the many side, dependent entities with rounded corners. Used in formal technical documents."
      },
      preview: "[Customer] |-------● [Order]",
      aliases: ["idef1x", "idef", "idef 1x"]
    }
  ],
  sequence: [
    {
      value: "system",
      label: { vi: "Hệ thống", en: "System" },
      description: {
        vi: "Actor ↔ hệ thống, hệ thống là hộp đen. Hợp với SRS gửi khách hàng.",
        en: "Actor ↔ system, the system is a black box. Suits an SRS for the customer."
      },
      preview: ":Actor  ->  :System\n:Actor  <-- :System",
      aliases: ["system", "he thong", "hop den", "black box", "ssd"]
    },
    {
      value: "component",
      label: { vi: "Thành phần", en: "Component" },
      description: {
        vi: "Màn → Controller → Entity theo Visual Paradigm. Chi tiết hơn, AI soạn thêm luồng giữa các thành phần.",
        en: "Screen → Controller → Entity as in Visual Paradigm. More detail; the AI also drafts the flow between the parts."
      },
      preview: ":Actor -> :Screen -> :Controller -> :Entity",
      aliases: ["component", "thanh phan", "chi tiet", "boundary", "controller", "entity"]
    }
  ]
})

const QUESTION: Readonly<Record<DiagramChoiceKind, { header: Readonly<Record<ReplyLanguage, string>>; text: Readonly<Record<ReplyLanguage, string>> }>> = Object.freeze({
  erd: { header: { vi: "Ký pháp ERD", en: "ERD style" }, text: { vi: "Bạn muốn vẽ ERD theo ký pháp nào?", en: "Which notation should the ERD use?" } },
  sequence: { header: { vi: "Sequence", en: "Sequence" }, text: { vi: "Sơ đồ tuần tự vẽ ở mức nào?", en: "At which level should the sequence diagrams be drawn?" } }
})

const RECOMMENDED: Readonly<Record<ReplyLanguage, string>> = { vi: " (Khuyến nghị)", en: " (Recommended)" }

const normalize = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()

const kindForTemplate = (templateId: string): DiagramChoiceKind | null =>
  templateId === STEP_OF_KIND.erd ? "erd" : templateId === STEP_OF_KIND.sequence ? "sequence" : null

const toValue = (kind: DiagramChoiceKind, value: unknown): DiagramChoiceValue | null => (kind === "erd" ? toErdNotation(value) : toSequenceLevel(value))

const chosen = (kind: DiagramChoiceKind, project: DiagramChoiceState | null): boolean =>
  kind === "erd" ? erdNotationChosen(project) : sequenceLevelChosen(project)

/** Kind của chủ đề sổ quyết định (`erd_notation` / `sequence_level`), không phải ⇒ null. */
export const diagramChoiceKindOfTopic = (topicKey: string | undefined): DiagramChoiceKind | null =>
  topicKey === DIAGRAM_CHOICE_TOPICS.erd ? "erd" : topicKey === DIAGRAM_CHOICE_TOPICS.sequence ? "sequence" : null

/** Khớp chữ trả lời (nhãn thẻ có "(Khuyến nghị)", chữ gõ ở "Khác…" hay ô chat) với một giá trị. Không khớp / mơ hồ ⇒ null. */
export const resolveDiagramChoice = (kind: DiagramChoiceKind, answer: string): DiagramChoiceValue | null => {
  const text = normalize(stripRecommended(answer))
  if (text === "") return null
  const exact = OPTIONS[kind].find((o) => normalize(o.label.vi) === text || normalize(o.label.en) === text || o.value === text.replace(/ /g, ""))
  if (exact) return exact.value
  const words = ` ${text} `
  const hits = OPTIONS[kind].filter((o) => o.aliases.some((a) => words.includes(` ${a} `)))
  return hits.length === 1 ? hits[0].value : null
}

/** Giá trị đã chốt trong sổ quyết định (Project chưa ghi được — lỗi giữa chừng) ⇒ ghi bù, không hỏi lại. */
export const ledgerChoice = (spine: Pick<Spine, "decisions">, kind: DiagramChoiceKind): DiagramChoiceValue | null => {
  const decision = [...spine.decisions].reverse().find((d) => d.topic_key === DIAGRAM_CHOICE_TOPICS[kind] && d.superseded_by === null)
  return decision ? resolveDiagramChoice(kind, decision.answer) : null
}

/**
 * Bước này cần hỏi gì: S-4.5 chưa có ký pháp ⇒ `erd`; S-5.4 chưa có mức ⇒ `sequence`. Đã có giá trị ⇒ null.
 * Sổ đã có quyết định ⇒ `backfill` (ghi Project, không hỏi).
 */
export const diagramChoiceFor = (
  templateId: string,
  project: DiagramChoiceState | null,
  spine: Pick<Spine, "decisions">
): { kind: DiagramChoiceKind; backfill: DiagramChoiceValue | null } | null => {
  const kind = kindForTemplate(templateId)
  // `null` = không đọc được Project (chưa nối DB) ⇒ không hỏi
  if (kind === null || project === null || chosen(kind, project)) return null
  return { kind, backfill: ledgerChoice(spine, kind) }
}

/** Thẻ hỏi — 2–3 lựa chọn có mô tả + preview, lựa chọn mặc định đánh "(Khuyến nghị)". */
export const diagramChoiceQuestion = (kind: DiagramChoiceKind, language: ReplyLanguage, recommended: DiagramChoiceValue = DEFAULT_CHOICE[kind]): DiagramChoiceQuestion => ({
  question: byLanguage(language, QUESTION[kind].text),
  header: byLanguage(language, QUESTION[kind].header),
  topic_key: DIAGRAM_CHOICE_TOPICS[kind],
  options: OPTIONS[kind].map(
    (o): QuestionOption => ({
      label: `${byLanguage(language, o.label)}${o.value === recommended ? byLanguage(language, RECOMMENDED) : ""}`,
      description: byLanguage(language, o.description),
      preview: o.preview
    })
  )
})

/** Nhãn hiển thị của một giá trị (ghi sổ quyết định, câu thông báo). */
export const diagramChoiceLabel = (kind: DiagramChoiceKind, value: DiagramChoiceValue, language: ReplyLanguage): string =>
  byLanguage(language, OPTIONS[kind].find((o) => o.value === value)?.label ?? { vi: value, en: value })

/** Lời dẫn cố định của thẻ (không gọi model). `retry`: lần hỏi lại sau câu trả lời không khớp. */
export const diagramChoiceLead = (kind: DiagramChoiceKind, language: ReplyLanguage, retry = false): string =>
  retry
    ? byLanguage(language, {
        vi: "Mình chưa hiểu lựa chọn này - bạn chọn một trong các phương án bên dưới nhé.",
        en: "I could not match that answer - please pick one of the options below."
      })
    : kind === "erd"
      ? byLanguage(language, { vi: "Trước khi vẽ ERD, bạn chọn ký pháp cho cả tài liệu nhé.", en: "Before drawing the ERD, pick the notation for the whole document." })
      : byLanguage(language, {
          vi: "Trước khi soạn chi tiết chức năng, bạn chọn mức vẽ sơ đồ tuần tự cho cả tài liệu nhé.",
          en: "Before drafting the function details, pick the sequence diagram level for the whole document."
        })

/** Câu báo khi dùng giá trị mặc định sau hai lần không khớp. */
export const diagramChoiceFallbackNote = (kind: DiagramChoiceKind, value: DiagramChoiceValue, language: ReplyLanguage): string =>
  byLanguage(language, {
    vi: `Mình dùng ${diagramChoiceLabel(kind, value, language)} - bạn đổi trong cài đặt dự án nếu cần.`,
    en: `I will use ${diagramChoiceLabel(kind, value, language)} - you can change it in the project settings.`
  })

// ─── Project (Mongo) ─────────────────────────────────────────────

export interface DiagramChoiceStore {
  load: (projectId: string) => Promise<DiagramChoiceState | null>
  save: (projectId: string, kind: DiagramChoiceKind, value: DiagramChoiceValue) => Promise<void>
}

/** Chưa nối Mongo (test đơn vị) / id lạ ⇒ `null` = coi như đã chọn: không hỏi, không ghi. */
export const projectDiagramChoiceStore: DiagramChoiceStore = {
  load: async (projectId) => {
    if (mongoose.connection.readyState !== 1 || !mongoose.isValidObjectId(projectId)) return null
    return (await Project.findById(projectId).select("erdNotation sequenceLevel").lean()) ?? null
  },
  save: async (projectId, kind, value) => {
    if (toValue(kind, value) === null) return
    await Project.updateOne({ _id: projectId }, { $set: kind === "erd" ? { erdNotation: value } : { sequenceLevel: value } })
  }
}

/** Danh sách giá trị hợp lệ — cho test. */
export const DIAGRAM_CHOICE_VALUES: Readonly<Record<DiagramChoiceKind, readonly string[]>> = Object.freeze({ erd: ERD_NOTATIONS, sequence: SEQUENCE_LEVELS })
