/**
 * Ngữ cảnh gửi model cho CR (C-2, C-4, C-5) — phép chiếu gọn, không nạp toàn Spine (coding-rules §3.6). FLF-171.
 */

import { scanMentions, type NamedEntity } from "../import/mentions.js"
import type { Spine } from "../spine/spine.types.js"
import type { IChangeRequest } from "./change-request.model.js"

const LIMIT = 8000
export const truncate = (s: string, max = LIMIT): string => (s.length > max ? `${s.slice(0, max)}\n…(truncated)` : s)

const ENTITY_ARRAY: Record<string, keyof Spine> = {
  use_case: "use_cases",
  function: "functions",
  nfr: "nfrs",
  business_rule: "business_rules",
  screen: "screens",
  actor: "actors",
  entity: "entities",
  feature: "features"
}

export const namedEntities = (spine: Spine): NamedEntity[] => [
  ...spine.actors.map((a) => ({ entity: "actor" as const, id: a.id, name: a.name })),
  ...spine.entities.map((e) => ({ entity: "entity" as const, id: e.id, name: e.name })),
  ...spine.features.map((f) => ({ entity: "feature" as const, id: f.id, name: f.name })),
  ...spine.screens.map((s) => ({ entity: "screen" as const, id: s.id, name: s.name })),
  ...spine.use_cases.map((u) => ({ entity: "use_case" as const, id: u.id, name: u.name })),
  ...spine.functions.map((f) => ({ entity: "function" as const, id: f.id, name: f.name }))
]

/** Chỉ mục id + tên của mọi phần tử (một dòng mỗi mảng) + chi tiết phần tử được CR nhắc tới. */
export const crProjection = (spine: Spine, text: string): string => {
  const index = (["actors", "use_cases", "features", "functions", "screens", "entities", "nfrs", "business_rules"] as const)
    .map((arr) => {
      const items = (spine[arr] as { id: string; name?: string; statement?: string }[]).map((x) => `${x.id} ${x.name ?? (x.statement ?? "").slice(0, 40)}`)
      return items.length ? `${arr}: ${items.join("; ")}` : null
    })
    .filter(Boolean)
    .join("\n")
  const mentioned = scanMentions(text, namedEntities(spine)).map((m) => {
    const arr = ENTITY_ARRAY[m.entity]
    const el = (spine[arr] as { id: string }[] | undefined)?.find((x) => x.id === m.id)
    return el ? `${arr}[id=${m.id}] = ${JSON.stringify(el)}` : null
  })
  return truncate(`${index}\n\nMentioned in the CR:\n${mentioned.filter(Boolean).join("\n") || "(none)"}`)
}

/**
 * Bản xem trước đính kèm CR (mode 1 v3, BPMN 3.1) — nối vào mô tả để C-2/C-4/C-5 thấy người yêu cầu đã xem thay đổi gì.
 * Chỉ là gợi ý: model vẫn tự làm rõ, tự kết luận từng vị trí.
 */
export const seedText = (cr: Pick<IChangeRequest, "seed">): string => {
  if (!cr.seed) return ""
  const instruction = cr.seed.instruction ? `Instruction: ${cr.seed.instruction}
` : ""
  return truncate(`

The requester previewed this change before logging the CR (a suggestion — check it, do not copy blindly):
${instruction}Ops: ${JSON.stringify(cr.seed.ops)}`, 3000)
}

/** Lệnh sửa gộp thêm (phase 8) — nối sau mô tả, theo thứ tự; cùng một CR phải làm cả lệnh gốc lẫn các lệnh này. */
export const amendmentsText = (cr: Pick<IChangeRequest, "amendments">): string =>
  (cr.amendments ?? []).length
    ? `\n\nThe requester then added (all of these are part of the same change request):\n${cr.amendments.map((a, i) => `${i + 1}. ${a.text}`).join("\n")}`
    : ""

export const crHeader = (cr: IChangeRequest) => ({
  cr_id: cr.cr_id,
  title: cr.title,
  description: `${cr.description}${amendmentsText(cr)}${seedText(cr)}`,
  source: `${cr.source.kind}${cr.source.ref ? ` — ${cr.source.ref}` : ""}`
})

export const answersText = (cr: IChangeRequest): string =>
  cr.clarifications
    // Mode 1 v3 phase 7: câu trả lời trống = người dùng chưa biết ⇒ model coi dữ kiện đó là thiếu
    .flatMap((c) => c.questions.map((q, i) => `Q${c.round}.${i + 1}: ${q}\nA: ${c.answers[i]?.trim() || "(no answer — unknown)"}`))
    .join("\n") || "(none)"

/** Tổng chữ tài liệu bổ sung đưa vào một prompt (mode 1 v3 phase 7) — chia cho các tài liệu. */
export const MATERIALS_PROMPT_CHARS = 12_000

/**
 * Tài liệu bổ sung của CR cho prompt C-2 / C-4 / 3.9: `[M01] tên (lúc đính kèm)` rồi nội dung. Tổng
 * ≤ `MATERIALS_PROMPT_CHARS`; tài liệu ngắn lấy đủ, phần còn lại chia đều cho tài liệu dài hơn.
 */
export const materialsText = (cr: Pick<IChangeRequest, "materials">): string => {
  const materials = cr.materials ?? []
  if (!materials.length) return "(none)"
  let budget = MATERIALS_PROMPT_CHARS
  const parts: string[] = new Array(materials.length)
  const byLength = materials.map((m, i) => ({ m, i })).sort((a, b) => a.m.text.length - b.m.text.length)
  byLength.forEach(({ m, i }, k) => {
    const share = Math.floor(budget / (byLength.length - k))
    const body = m.text.length > share ? `${m.text.slice(0, share)}\n…(truncated)` : m.text
    budget -= Math.min(m.text.length, share)
    const when = m.round === 0 ? "attached when the CR was logged" : `attached with the answers of round ${m.round}`
    parts[i] = `[${m.material_id}] ${m.name} (${when}${m.truncated ? "; cut at upload" : ""})\n${body}`
  })
  return parts.join("\n\n")
}

export const missingInfoText = (cr: Pick<IChangeRequest, "missing_info">): string =>
  cr.missing_info?.length ? cr.missing_info.map((f) => `- ${f}`).join("\n") : "(none)"

export const glossaryText = (spine: Spine): string => truncate(spine.glossary.map((g) => `${g.term}: ${g.definition}`).join("\n") || "(empty)", 3000)
