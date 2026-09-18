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

export const crHeader = (cr: IChangeRequest) => ({
  cr_id: cr.cr_id,
  title: cr.title,
  description: cr.description,
  source: `${cr.source.kind}${cr.source.ref ? ` — ${cr.source.ref}` : ""}`
})

export const answersText = (cr: IChangeRequest): string =>
  cr.clarifications
    .flatMap((c) => c.questions.map((q, i) => `Q${c.round}.${i + 1}: ${q}\nA: ${c.answers[i] ?? "(no answer)"}`))
    .join("\n") || "(none)"

export const glossaryText = (spine: Spine): string => truncate(spine.glossary.map((g) => `${g.term}: ${g.definition}`).join("\n") || "(empty)", 3000)
