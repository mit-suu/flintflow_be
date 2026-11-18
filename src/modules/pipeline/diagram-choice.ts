/**
 * FLF-418 — thẻ hỏi TẤT ĐỊNH trong khung chat (không gọi model): S-4.5 hỏi ký pháp ERD, S-5.4 lần đầu hỏi mức Sequence
 * Diagram. Lựa chọn ghi vào Project (`erdNotation` / `sequenceLevel`, ngoài Spine — cùng cách làm với ký pháp ERD) và sổ
 * quyết định (`decisions[topic_key]`) như mọi câu trả lời khác. Đã có giá trị (chat, cài đặt dự án, import đọc từ file) ⇒
 * không hỏi. Spec: `spec/FLF-418-sequence-level-chat-choice/01-spec.md` §5.
 *
 * FLF-441: trước hai câu trên hỏi CÓ CẦN sơ đồ không — S-4.5 hỏi Class Diagram, S-5.4 lần đầu hỏi Sequence Diagram (ghi
 * `Project.classDiagram` / `sequenceDiagram`). Chọn "Không" cho Sequence ⇒ không hỏi mức Sequence.
 *
 * Câu trả lời chỉ khớp tất định (nhãn lựa chọn, tên vi / en, viết tắt) — chữ tự do không khớp ⇒ hỏi lại một lần, rồi
 * dùng giá trị khuyến nghị (03 #7).
 */

import mongoose from "mongoose"
import { ERD_NOTATIONS, erdNotationChosen, toErdNotation, type ErdNotation } from "../../shared/diagram/erd-notation.js"
import { SEQUENCE_LEVELS, sequenceLevelChosen, toSequenceLevel, type SequenceLevel } from "../../shared/diagram/sequence-level.js"
import { diagramInclusionChosen, diagramIncluded, type DiagramInclusionState } from "../../shared/diagram/diagram-inclusion.js"
import { byLanguage, type ReplyLanguage } from "../../shared/i18n/reply-language.js"
import type { QuestionOption } from "../../shared/ai/response-parser.js"
import type { Spine } from "../spine/spine.types.js"
import { Project } from "../project/project.model.js"
import { stripRecommended, type ModelQuestion } from "./question-shape.js"

/** `class_diagram` / `sequence_diagram` (FLF-441): có cần sơ đồ không — giá trị `yes` | `no`. */
export type DiagramChoiceKind = "erd" | "sequence" | "class_diagram" | "sequence_diagram"

export const DIAGRAM_CHOICE_TOPICS: Readonly<Record<DiagramChoiceKind, string>> = Object.freeze({
  erd: "erd_notation",
  sequence: "sequence_level",
  class_diagram: "class_diagram",
  sequence_diagram: "sequence_diagram"
})

/**
 * Template step hỏi lựa chọn, theo thứ tự hỏi: S-4.5 vẽ ERD + Class Diagram, S-5.4 sinh dữ liệu sơ đồ tuần tự (có cần / mức
 * phải biết trước Draft). Câu "có cần" đứng trước để "Không" bỏ được câu mức.
 */
const KINDS_OF_STEP: Readonly<Record<string, readonly DiagramChoiceKind[]>> = Object.freeze({
  "S-4.5": ["class_diagram", "erd"],
  "S-5.4": ["sequence_diagram", "sequence"]
})

export type YesNo = "yes" | "no"
export type DiagramChoiceValue = ErdNotation | SequenceLevel | YesNo

/** Field của Project đọc / ghi. */
export interface DiagramChoiceState extends DiagramInclusionState {
  erdNotation?: unknown
  sequenceLevel?: unknown
}

const INCLUSION_OF: Readonly<Partial<Record<DiagramChoiceKind, "class" | "sequence">>> = Object.freeze({ class_diagram: "class", sequence_diagram: "sequence" })

export type DiagramChoiceQuestion = ModelQuestion & { topic_key: string }

/** Giá trị dùng khi người dùng trả lời không khớp hai lần — cũng là lựa chọn "(Khuyến nghị)". */
export const DEFAULT_CHOICE: Readonly<Record<DiagramChoiceKind, DiagramChoiceValue>> = Object.freeze({ erd: "chen", sequence: "system", class_diagram: "yes", sequence_diagram: "yes" })

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
  ],
  class_diagram: [
    {
      value: "yes",
      label: { vi: "Có", en: "Yes" },
      description: {
        vi: "Mỗi tính năng có một Class Diagram riêng (các lớp của tính năng đó), đặt ở đầu mục tính năng. ERD là hình riêng, không đổi.",
        en: "Each feature gets its own class diagram (the classes of that feature) at the top of its section. The ERD is separate and unchanged."
      },
      preview: "[Order] 1 ---- * [OrderItem]",
      aliases: []
    },
    {
      value: "no",
      label: { vi: "Không", en: "No" },
      description: {
        vi: "Các mục tính năng không có Class Diagram. ERD của cả hệ thống vẫn vẽ như thường.",
        en: "No class diagram in the feature sections. The system ERD is still drawn."
      },
      preview: "ERD: yes\nClass Diagram: -",
      aliases: []
    }
  ],
  sequence_diagram: [
    {
      value: "yes",
      label: { vi: "Có", en: "Yes" },
      description: {
        vi: "Chức năng có nhiều bước / nhánh lỗi được vẽ Sequence Diagram kèm mô tả. Bước sau hỏi mức vẽ.",
        en: "Functions with several steps or error branches get a sequence diagram with a description. The level is asked next."
      },
      preview: ":Actor  ->  :System\n:Actor  <-- :System",
      aliases: []
    },
    {
      value: "no",
      label: { vi: "Không", en: "No" },
      description: {
        vi: "Không vẽ Sequence Diagram. Mỗi chức năng vẫn có mô tả luồng, màn hình và quy tắc.",
        en: "No sequence diagrams. Each function keeps its flow description, screen and rules."
      },
      preview: "Sequence Diagram: -",
      aliases: []
    }
  ]
})

const QUESTION: Readonly<Record<DiagramChoiceKind, { header: Readonly<Record<ReplyLanguage, string>>; text: Readonly<Record<ReplyLanguage, string>> }>> = Object.freeze({
  erd: { header: { vi: "Ký pháp ERD", en: "ERD style" }, text: { vi: "Bạn muốn vẽ ERD theo ký pháp nào?", en: "Which notation should the ERD use?" } },
  sequence: { header: { vi: "Sequence", en: "Sequence" }, text: { vi: "Sơ đồ tuần tự vẽ ở mức nào?", en: "At which level should the sequence diagrams be drawn?" } },
  class_diagram: {
    header: { vi: "Sơ đồ lớp", en: "Class diag." },
    text: { vi: "Các tính năng có cần Class Diagram (sơ đồ lớp) riêng không?", en: "Should each feature have its own class diagram?" }
  },
  sequence_diagram: {
    header: { vi: "Có Sequence?", en: "Sequence?" },
    text: { vi: "Tài liệu có cần Sequence Diagram (sơ đồ tuần tự) cho các chức năng không?", en: "Does the document need sequence diagrams for the functions?" }
  }
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

const toYesNo = (value: unknown): YesNo | null => (value === "yes" || value === "no" ? value : null)

const toValue = (kind: DiagramChoiceKind, value: unknown): DiagramChoiceValue | null =>
  kind === "erd" ? toErdNotation(value) : kind === "sequence" ? toSequenceLevel(value) : toYesNo(value)

const chosen = (kind: DiagramChoiceKind, project: DiagramChoiceState | null): boolean => {
  const inclusion = INCLUSION_OF[kind]
  if (inclusion) return diagramInclusionChosen(project, inclusion)
  if (kind === "erd") return erdNotationChosen(project)
  // Dự án không cần Sequence Diagram ⇒ không hỏi mức
  return sequenceLevelChosen(project) || !diagramIncluded(project, "sequence")
}

/** Kind của chủ đề sổ quyết định, không phải chủ đề lựa chọn sơ đồ ⇒ null. */
export const diagramChoiceKindOfTopic = (topicKey: string | undefined): DiagramChoiceKind | null =>
  (Object.keys(DIAGRAM_CHOICE_TOPICS) as DiagramChoiceKind[]).find((k) => DIAGRAM_CHOICE_TOPICS[k] === topicKey) ?? null

const NO_WORDS = ["khong", "ko", "k", "no", "bo", "bo qua", "skip", "none", "chua can"]
const YES_WORDS = ["co", "yes", "can", "ok", "okay", "dong y", "ve", "y"]

/** Có / Không: chữ phủ định thắng ("không cần" có chữ "cần"). */
const resolveYesNo = (text: string): YesNo | null => {
  const words = ` ${text} `
  if (NO_WORDS.some((w) => words.includes(` ${w} `))) return "no"
  if (YES_WORDS.some((w) => words.includes(` ${w} `))) return "yes"
  return null
}

/** Khớp chữ trả lời (nhãn thẻ có "(Khuyến nghị)", chữ gõ ở "Khác…" hay ô chat) với một giá trị. Không khớp / mơ hồ ⇒ null. */
export const resolveDiagramChoice = (kind: DiagramChoiceKind, answer: string): DiagramChoiceValue | null => {
  const text = normalize(stripRecommended(answer))
  if (text === "") return null
  if (INCLUSION_OF[kind]) return resolveYesNo(text)
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
 * Bước này cần hỏi gì (câu đầu tiên chưa có giá trị, theo `KINDS_OF_STEP`): S-4.5 ⇒ `class_diagram` rồi `erd`; S-5.4 ⇒
 * `sequence_diagram` rồi `sequence`. Đã đủ ⇒ null. Sổ đã có quyết định ⇒ `backfill` (ghi Project, không hỏi); câu "có cần"
 * mà Spine đã có hình loại đó (import, dự án cũ đã vẽ) ⇒ `backfill = yes`.
 */
export const diagramChoiceFor = (
  templateId: string,
  project: DiagramChoiceState | null,
  spine: Pick<Spine, "decisions"> & { diagrams?: readonly { kind: string }[] }
): { kind: DiagramChoiceKind; backfill: DiagramChoiceValue | null } | null => {
  // `null` = không đọc được Project (chưa nối DB) ⇒ không hỏi
  if (project === null) return null
  const kind = (KINDS_OF_STEP[templateId] ?? []).find((k) => !chosen(k, project))
  if (kind === undefined) return null
  const inclusion = INCLUSION_OF[kind]
  const drawn = inclusion !== undefined && (spine.diagrams ?? []).some((d) => d.kind === inclusion)
  return { kind, backfill: ledgerChoice(spine, kind) ?? (drawn ? "yes" : null) }
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
    : kind === "class_diagram"
      ? byLanguage(language, {
          vi: "Bước này dựng dữ liệu thực thể - từ đó mình vẽ ERD cho cả hệ thống và Class Diagram riêng cho từng tính năng. Bạn cho mình biết có cần Class Diagram ở các tính năng không nhé.",
          en: "This step builds the entity data - from it I draw the system ERD and a separate class diagram per feature. Tell me whether the features need class diagrams."
        })
      : kind === "sequence_diagram"
        ? byLanguage(language, {
            vi: "Trước khi soạn chi tiết chức năng, bạn cho mình biết tài liệu có cần Sequence Diagram không nhé.",
            en: "Before drafting the function details, tell me whether the document needs sequence diagrams."
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
    return (await Project.findById(projectId).select("erdNotation sequenceLevel classDiagram sequenceDiagram").lean()) ?? null
  },
  save: async (projectId, kind, value) => {
    if (toValue(kind, value) === null) return
    const set =
      kind === "erd"
        ? { erdNotation: value }
        : kind === "sequence"
          ? { sequenceLevel: value }
          : { [kind === "class_diagram" ? "classDiagram" : "sequenceDiagram"]: value === "yes" }
    await Project.updateOne({ _id: projectId }, { $set: set })
  }
}

/** Danh sách giá trị hợp lệ — cho test. */
export const DIAGRAM_CHOICE_VALUES: Readonly<Record<DiagramChoiceKind, readonly string[]>> = Object.freeze({
  erd: ERD_NOTATIONS,
  sequence: SEQUENCE_LEVELS,
  class_diagram: ["yes", "no"],
  sequence_diagram: ["yes", "no"]
})
