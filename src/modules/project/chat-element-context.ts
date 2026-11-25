/**
 * chat-element-context.ts
 * ─────────────────────────────────────────────────────────────────
 * Chat hỏi đáp về nội dung tài liệu: `chat-spine-index.ts` chỉ cho model số lượng + "mã tên", nên câu hỏi như "UC-05 làm gì,
 * qua màn nào?" không có chữ nào để trả lời. Hàm này nhận diện mã / tên phần tử được nhắc trong câu hỏi rồi dựng nội dung
 * đầy đủ của CHÍNH phần tử đó (mô tả, luồng, quy tắc, màn liên quan) dạng chữ ngắn, có trần token. Không nhắc phần tử nào
 * ⇒ chuỗi rỗng và prompt dùng chỉ mục như cũ. Không nạp cả Spine (điều cấm 4): tối đa vài phần tử, mỗi phần tử có trần chữ.
 */

import type { Function as SpineFunction, Spine } from "../spine/spine.types.js"
import { buildChatSpineIndex, type SpineIndexSource } from "./chat-spine-index.js"

/** Ngân sách khối nội dung (token). */
export const ELEMENT_CONTEXT_MAX_TOKENS = 4000
/** Ước lượng thô ~4 ký tự / token (chữ Anh của Spine; tiếng Việt tốn hơn nhưng khối này là chữ Spine). */
const CHARS_PER_TOKEN = 4
export const ELEMENT_CONTEXT_MAX_CHARS = ELEMENT_CONTEXT_MAX_TOKENS * CHARS_PER_TOKEN
/** Số phần tử tối đa kéo nội dung — câu hỏi nhắc cả chục mã thì chỉ lấy các mã nhắc trước. */
export const ELEMENT_CONTEXT_MAX_ELEMENTS = 8
/** Trần chữ của một phần tử — một function dài không ăn hết ngân sách của các phần tử còn lại. */
const PER_ELEMENT_MAX_CHARS = 3000
const MIN_NAME_LENGTH = 4

type Source = Pick<Spine, "actors" | "use_cases" | "features" | "screens" | "functions" | "entities" | "nfrs" | "business_rules" | "messages" | "roles" | "permissions">

interface Hit {
  /** Vị trí nhắc đầu tiên trong câu hỏi — thứ tự ưu tiên khi vượt trần. */
  at: number
  text: string
}

/** Khoá so mã: `UC-05` = `UC05` = `uc 5`. */
const codeKey = (id: string): string => id.trim().toUpperCase().replace(/[-_\s]+/g, "").replace(/(^|\D)0+(?=\d)/g, "$1")

/** Mã trong câu hỏi: 1-4 chữ cái + số, có thể ngăn bằng `-`, `_` hoặc khoảng trắng. */
const CODE_IN_TEXT = /(?<![\p{L}\p{N}])([A-Za-z]{1,4})[-_ ]?(\d{1,4}(?:\.\d+)*)(?![\p{L}\p{N}])/gu

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 3)}...` : text)

const line = (label: string, value: string | readonly string[] | null | undefined): string => {
  const text = Array.isArray(value) ? value.join("; ") : (value ?? "")
  return String(text).trim() ? `${label}: ${text}` : ""
}

const nameOf = (list: readonly { id: string; name: string }[], id: string): string => list.find((x) => x.id === id)?.name ?? id
const named = (list: readonly { id: string; name: string }[], ids: readonly string[]): string[] => ids.map((id) => `${id} ${nameOf(list, id)}`.trim())

const functionText = (spine: Source, fn: SpineFunction): string => {
  const rules = fn.business_rule_ids.map((id) => spine.business_rules.find((b) => b.id === id)).filter((b): b is Source["business_rules"][number] => !!b)
  const messages = spine.messages.filter((m) => m.function_ids.includes(fn.id))
  return [
    `Function ${fn.id} ${fn.name}`,
    line("Screen", fn.screen_id ? `${fn.screen_id} ${nameOf(spine.screens, fn.screen_id)}` : "none (no screen)"),
    line("Feature", `${fn.feature_id} ${nameOf(spine.features, fn.feature_id)}`),
    line("Trigger", fn.trigger),
    line("Description", fn.description),
    fn.normal.length ? `Normal flow: ${fn.normal.map((s, i) => `${i + 1}. ${s}`).join(" ")}` : "",
    fn.abnormal.length ? `Abnormal flow: ${fn.abnormal.map((s, i) => `${i + 1}. ${s}`).join(" ")}` : "",
    fn.validations.length ? `Validations: ${fn.validations.map((v) => v.statement).join("; ")}` : "",
    rules.length ? `Business rules: ${rules.map((b) => `${b.id} ${b.statement}`).join("; ")}` : "",
    messages.length ? `Messages: ${messages.map((m) => `${m.code} ${m.text}`).join("; ")}` : "",
    fn.priority ? line("Priority", fn.priority) : ""
  ]
    .filter(Boolean)
    .join("\n")
}

const describe = (spine: Source, kind: string, id: string): string | null => {
  switch (kind) {
    case "use_cases": {
      const uc = spine.use_cases.find((x) => x.id === id)
      if (!uc) return null
      const fns = uc.function_ids.map((fid) => spine.functions.find((f) => f.id === fid)).filter((f): f is SpineFunction => !!f)
      const screenIds = [...new Set(fns.map((f) => f.screen_id).filter((s): s is string => !!s))]
      return [
        `Use case ${uc.id} ${uc.name}`,
        line("Actors", named(spine.actors, uc.actor_ids)),
        line("Description", uc.description),
        line("Includes", named(spine.use_cases, uc.includes)),
        line("Extends", named(spine.use_cases, uc.extends)),
        uc.activity_nodes?.length ? `Flow steps: ${uc.activity_nodes.map((n) => n.name ?? n.id).join(" -> ")}` : "",
        line("Functions", named(spine.functions, uc.function_ids)),
        line("Related screens", named(spine.screens, screenIds)),
        ...fns.slice(0, 3).map((f) => functionText(spine, f))
      ]
        .filter(Boolean)
        .join("\n")
    }
    case "functions": {
      const fn = spine.functions.find((x) => x.id === id)
      return fn ? functionText(spine, fn) : null
    }
    case "screens": {
      const s = spine.screens.find((x) => x.id === id)
      if (!s) return null
      const fns = spine.functions.filter((f) => f.screen_id === s.id)
      return [
        `Screen ${s.id} ${s.name}${s.is_popup ? " (popup)" : ""}`,
        line("Feature", `${s.feature_id} ${nameOf(spine.features, s.feature_id)}`),
        line("Description", s.description),
        line("Tabs", s.tabs),
        line("Leads to", s.flow_to.map((e) => `${nameOf(spine.screens, e.to)}${e.trigger ? ` (${e.trigger})` : ""}`)),
        line("Functions", named(spine.functions, fns.map((f) => f.id))),
        line("Use cases", named(spine.use_cases, spine.use_cases.filter((u) => u.function_ids.some((fid) => fns.some((f) => f.id === fid))).map((u) => u.id))),
        line("Roles that can use it", [...new Set(spine.permissions.filter((p) => p.screen_id === s.id).map((p) => nameOf(spine.roles, p.role_id)))])
      ]
        .filter(Boolean)
        .join("\n")
    }
    case "features": {
      const f = spine.features.find((x) => x.id === id)
      if (!f) return null
      return [
        `Feature ${f.id} ${f.name}`,
        line("Screens", named(spine.screens, spine.screens.filter((s) => s.feature_id === f.id).map((s) => s.id))),
        line("Functions", named(spine.functions, spine.functions.filter((fn) => fn.feature_id === f.id).map((fn) => fn.id)))
      ]
        .filter(Boolean)
        .join("\n")
    }
    case "actors": {
      const a = spine.actors.find((x) => x.id === id)
      if (!a) return null
      return [
        `Actor ${a.id} ${a.name} (${a.kind})`,
        line("Description", a.description),
        line("Use cases", named(spine.use_cases, spine.use_cases.filter((u) => u.actor_ids.includes(a.id)).map((u) => u.id)))
      ]
        .filter(Boolean)
        .join("\n")
    }
    case "entities": {
      const e = spine.entities.find((x) => x.id === id)
      if (!e) return null
      return [
        `Entity ${e.id} ${e.name}`,
        line("Description", e.description),
        line("Attributes", (e.attributes ?? []).map((a) => a.name)),
        line("Related entities", named(spine.entities, e.relations))
      ]
        .filter(Boolean)
        .join("\n")
    }
    case "nfrs": {
      const n = spine.nfrs.find((x) => x.id === id)
      return n ? [`NFR ${n.id} (${n.category})`, line("Statement", n.statement), line("Metric", n.metric), line("Threshold", n.threshold)].filter(Boolean).join("\n") : null
    }
    case "business_rules": {
      const b = spine.business_rules.find((x) => x.id === id)
      return b ? `Business rule ${b.id} (${b.tier}): ${b.statement}` : null
    }
    case "messages": {
      const m = spine.messages.find((x) => x.id === id)
      return m ? [`Message ${m.code}${m.type ? ` (${m.type})` : ""}: ${m.text}`, line("Shown when", m.context)].filter(Boolean).join("\n") : null
    }
    default:
      return null
  }
}

const COLLECTIONS = ["use_cases", "functions", "screens", "features", "actors", "entities", "nfrs", "business_rules", "messages"] as const

/**
 * Nội dung các phần tử mà `question` nhắc tới (mã `UC-05` / `FN012` hoặc nguyên tên), cũ nhất nhắc trước, tổng không quá
 * `ELEMENT_CONTEXT_MAX_TOKENS`. Rỗng khi không nhắc phần tử nào hoặc chưa có Spine.
 */
export const buildChatElementContext = (spine: Source | null | undefined, question: string): string => {
  if (!spine || !question.trim()) return ""
  const asked = new Map<string, number>()
  for (const m of question.matchAll(CODE_IN_TEXT)) {
    const key = codeKey(`${m[1]}${m[2]}`)
    if (!asked.has(key)) asked.set(key, m.index ?? 0)
  }
  const lowered = question.toLowerCase()
  const hits: Hit[] = []
  const seen = new Set<string>()
  for (const kind of COLLECTIONS) {
    const list = (spine[kind] ?? []) as unknown as { id: string; name?: string; code?: string }[]
    for (const el of list) {
      const byCode = asked.get(codeKey(el.id)) ?? (el.code ? asked.get(codeKey(el.code)) : undefined)
      let at = byCode
      if (at === undefined && el.name && el.name.trim().length >= MIN_NAME_LENGTH) {
        const m = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(el.name.trim().toLowerCase())}(?![\\p{L}\\p{N}])`, "u").exec(lowered)
        if (m) at = m.index
      }
      if (at === undefined || seen.has(`${kind}:${el.id}`)) continue
      const text = describe(spine, kind, el.id)
      if (!text) continue
      seen.add(`${kind}:${el.id}`)
      hits.push({ at, text: clip(text, PER_ELEMENT_MAX_CHARS) })
    }
  }
  hits.sort((a, b) => a.at - b.at)
  const blocks: string[] = []
  let used = 0
  for (const hit of hits.slice(0, ELEMENT_CONTEXT_MAX_ELEMENTS)) {
    const room = ELEMENT_CONTEXT_MAX_CHARS - used
    if (room < 200) break
    const text = clip(hit.text, room)
    blocks.push(text)
    used += text.length + 2
  }
  return blocks.join("\n\n")
}

/**
 * Biến `spine_index` của prompt CHAT: chỉ mục gọn như cũ, và khi câu hỏi nhắc phần tử cụ thể thì nối thêm khối nội dung đầy đủ
 * của phần tử đó (cùng biến để mọi nơi dựng prompt CHAT — kể cả luồng change request — không phải thêm biến mới).
 */
export const chatSpineIndexFor = (spine: (SpineIndexSource & Source) | null | undefined, question: string): string => {
  const index = buildChatSpineIndex(spine)
  const detail = buildChatElementContext(spine, question)
  return detail ? `${index}

Chi tiết các phần tử được nhắc trong câu hỏi (nội dung đầy đủ trong tài liệu):
${detail}` : index
}
