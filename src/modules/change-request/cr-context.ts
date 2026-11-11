/**
 * Ngữ cảnh gửi model cho CR (C-2, C-4, C-5) — phép chiếu gọn, không nạp toàn Spine (coding-rules §3.6). FLF-171.
 */

import { scanMentions, type NamedEntity } from "../import/mentions.js"
import { Bm25 } from "../../shared/search/bm25.js"
import { chunkText } from "../../shared/search/md-chunks.js"
import { foldText } from "../import/text-similarity.js"
import type { CustomBlock, Spine } from "../spine/spine.types.js"
import type { IChangeRequest } from "./change-request.model.js"
import { listElements, sectionOfElement, valueText } from "./spine-location.js"

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

/**
 * FLF-367: ngân sách chữ cho phần ngữ cảnh mở rộng — BR / NFR liên quan (đủ câu, không cắt 40 ký tự) và đoạn văn giữ
 * nguyên (`custom_sections`) liên quan. Chỉ phần liên quan, không gửi toàn bộ để giữ độ dài prompt và credit.
 */
export const RELATED_RULES_CHARS = 3000
/**
 * Tổng BR / NFR (đủ câu) không quá ngưỡng này ⇒ gửi **tất cả**, không lọc theo từ chung: CR viết tiếng Việt cho tài liệu
 * tiếng Anh ("khoá sau 3 lần" ↔ "locked after five failed login attempts") không có từ nào trùng, lọc theo từ thì model chỉ
 * thấy 40 ký tự đầu ở chỉ mục và không nhận ra mâu thuẫn. FAP (38 BR + 20 NFR) ≈ 7.5k ký tự.
 */
export const ALL_RULES_CHARS = 10000
export const RELATED_PASSAGES_CHARS = 4000
/** Một đoạn văn / một phần tử dài quá thì cắt ở đây (vẫn đủ dài để thấy con số nằm sau 40 ký tự đầu). */
const RELATED_ITEM_CHARS = 600
/** Điểm liên quan tối thiểu: một cụm hai từ chung (2) + một từ dài chung (1). */
const MIN_RELEVANCE = 3

/** Từ quá chung (đã gập dấu) — không tính khi so liên quan. */
const COMMON_WORDS = new Set(
  (
    "the a an of and or to in on for with by is are be shall must should will can may that this when then from at as not " +
    "system user users va cua cac nhung cho khi trong voi la duoc phai co khong mot nay do thi de ve tu theo sau truoc " +
    "nguoi dung he thong tren duoi neu hoac cung nhu tai lieu muc phan"
  ).split(" ")
)
const isNumber = (t: string): boolean => /^\d+$/.test(t)

/** Từ (≥ 4 ký tự) + cụm hai từ liền nhau của chữ đã gập dấu; bỏ số (hai phía mâu thuẫn thường khác đúng con số) và từ chung. */
const gramsOf = (text: string): Set<string> => {
  const tokens = foldText(text).split(" ").filter(Boolean)
  const out = new Set<string>()
  tokens.forEach((t, i) => {
    if (isNumber(t) || COMMON_WORDS.has(t)) return
    if (t.length >= 4) out.add(t)
    const next = tokens[i + 1]
    if (next && !isNumber(next) && !COMMON_WORDS.has(next)) out.add(`${t} ${next}`)
  })
  return out
}

/** Điểm liên quan của `text` với chữ CR: cụm hai từ chung 2 điểm, từ chung 1 điểm. */
export const relevanceScore = (query: ReadonlySet<string>, text: string): number => {
  let score = 0
  for (const g of gramsOf(text)) if (query.has(g)) score += g.includes(" ") ? 2 : 1
  return score
}

export interface RelatedOptions {
  /** Section đích (`fixed:5.1`, `custom:CS02`) — phần tử / đoạn văn trong đó luôn tính là liên quan. */
  sections?: readonly string[]
  /** Path phần tử bỏ qua (đã có ở chỗ khác của prompt). */
  exclude?: readonly string[]
}

interface Candidate {
  path: string
  section_id: string
  text: string
  order: number
  /** Chữ dùng chấm điểm (mặc định `text`) — phần tử JSON chỉ lấy giá trị, tên khoá không tính. */
  score_text?: string
}

/** Mọi giá trị chữ / số trong một giá trị JSON (bỏ tên khoá) — chữ JSON lỗi thì trả nguyên. */
export const plainValues = (value: unknown): string => {
  if (typeof value === "string") {
    const t = value.trim()
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        return plainValues(JSON.parse(t) as unknown)
      } catch {
        return value
      }
    }
    return value
  }
  if (typeof value === "number") return String(value)
  if (Array.isArray(value)) return value.map(plainValues).filter(Boolean).join("\n")
  if (value && typeof value === "object") return Object.values(value).map(plainValues).filter(Boolean).join("\n")
  return ""
}

/**
 * Mọi ứng viên nếu tổng chữ không quá `whole` (không phụ thuộc ngôn ngữ của CR); quá thì chọn theo điểm như `pickRelated`.
 */
const allOrRelated = (query: ReadonlySet<string>, candidates: readonly Candidate[], whole: number, budget: number, sections: ReadonlySet<string>): Candidate[] =>
  candidates.reduce((n, c) => n + c.text.length, 0) <= whole ? [...candidates].sort((a, b) => a.order - b.order) : pickRelated(query, candidates, budget, sections)

/** Ứng viên liên quan theo điểm (section đích trước), trong `budget` ký tự; trả về theo thứ tự tài liệu. */
const pickRelated = (query: ReadonlySet<string>, candidates: readonly Candidate[], budget: number, sections: ReadonlySet<string>): Candidate[] => {
  const scored = candidates
    .map((c) => ({ c, score: sections.has(c.section_id) ? Number.MAX_SAFE_INTEGER : relevanceScore(query, c.score_text ?? c.text) }))
    .filter((x) => x.score >= MIN_RELEVANCE)
    .sort((a, b) => b.score - a.score || a.c.order - b.c.order)
  const picked: Candidate[] = []
  let used = 0
  for (const { c } of scored) {
    if (used + c.text.length > budget) continue
    picked.push(c)
    used += c.text.length
  }
  return picked.sort((a, b) => a.order - b.order)
}

/** BR / NFR liên quan tới chữ CR, đủ câu: `business_rules[id=BR-03] (fixed:5.1): …`. */
export const relatedRules = (spine: Spine, text: string, opts: RelatedOptions = {}): string[] => {
  const exclude = new Set(opts.exclude ?? [])
  const candidates: Candidate[] = (["business_rules", "nfrs"] as const).flatMap((arr) =>
    (spine[arr] as { id: string; statement: string; metric?: string; threshold?: string }[])
      .map((x, i) => {
        const path = `${arr}[id=${x.id}]`
        const extra = [x.metric, x.threshold].filter(Boolean).join("; ")
        return { path, section_id: sectionOfElement(spine, path), text: truncate(`${x.statement}${extra ? ` (${extra})` : ""}`, RELATED_ITEM_CHARS), order: i }
      })
      .filter((c) => !exclude.has(c.path))
  )
  return allOrRelated(gramsOf(text), candidates, ALL_RULES_CHARS, RELATED_RULES_CHARS, new Set(opts.sections ?? [])).map((c) => `${c.path} (${c.section_id}): ${c.text}`)
}

/** Ngân sách phần tử liên quan ở section khác cho C-5 (FLF-367). */
export const RELATED_ELEMENTS_CHARS = 3000

/** Phần tử Spine (mọi mảng, mọi section) liên quan tới chữ CR — C-5 so cả section khác, không chỉ cùng section. */
export const relatedElements = (spine: Spine, text: string, opts: RelatedOptions = {}): { path: string; section_id: string; text: string }[] => {
  const exclude = new Set(opts.exclude ?? [])
  const candidates: Candidate[] = listElements(spine)
    .filter((e) => !exclude.has(e.path) && !e.path.startsWith("custom_sections["))
    .map((e, i) => ({
      path: e.path,
      section_id: sectionOfElement(spine, e.path),
      text: truncate(valueText(e.value), RELATED_ITEM_CHARS),
      score_text: plainValues(e.value),
      order: i
    }))
  return pickRelated(gramsOf(text), candidates, RELATED_ELEMENTS_CHARS, new Set(opts.sections ?? [])).map(({ path, section_id, text }) => ({ path, section_id, text }))
}

const blockText = (b: CustomBlock): string => (b.kind === "table" && b.rows?.length ? b.rows.map((r) => r.join(" | ")).join("\n") : b.text).trim()

/**
 * Đoạn văn giữ nguyên (`custom_sections`) liên quan tới chữ CR — các khối khớp, gom theo mục:
 * `custom_sections[id=CS01] "Heading" (custom:CS01):` rồi `  - chữ khối`.
 */
export const relatedPassages = (spine: Spine, text: string, opts: RelatedOptions = {}): string[] => {
  const exclude = new Set(opts.exclude ?? [])
  let order = 0
  const candidates: Candidate[] = spine.custom_sections
    .filter((c) => !exclude.has(`custom_sections[id=${c.id}]`))
    .flatMap((c) =>
      c.blocks.map(blockText).flatMap((t) => (t ? [{ path: `custom_sections[id=${c.id}]`, section_id: `custom:${c.id}`, text: truncate(t, RELATED_ITEM_CHARS), order: order++ }] : []))
    )
  // Văn xuôi giữ nguyên vừa ngân sách ⇒ gửi hết (CR khác ngôn ngữ tài liệu vẫn thấy "5 lần"); quá thì chọn theo từ chung
  const picked = allOrRelated(gramsOf(text), candidates, RELATED_PASSAGES_CHARS, RELATED_PASSAGES_CHARS, new Set(opts.sections ?? []))
  const out: string[] = []
  let current: string | null = null
  for (const p of picked) {
    if (p.path !== current) {
      const section = spine.custom_sections.find((c) => `custom_sections[id=${c.id}]` === p.path)
      out.push(`${p.path} "${section?.heading ?? ""}" (${p.section_id}):`)
      current = p.path
    }
    out.push(`  - ${p.text.replace(/\n/g, "\n    ")}`)
  }
  return out
}

/**
 * Chỉ mục id + tên của mọi phần tử (một dòng mỗi mảng) + chi tiết phần tử được CR nhắc tới. FLF-367: thêm BR / NFR liên
 * quan (đủ câu) và đoạn văn giữ nguyên liên quan — để model thấy CR có mâu thuẫn với tài liệu hiện có không.
 */
export const crProjection = (spine: Spine, text: string, opts: RelatedOptions = {}): string => {
  const index = (["actors", "use_cases", "features", "functions", "screens", "entities", "nfrs", "business_rules"] as const)
    .map((arr) => {
      const items = (spine[arr] as { id: string; name?: string; statement?: string }[]).map((x) => `${x.id} ${x.name ?? (x.statement ?? "").slice(0, 40)}`)
      return items.length ? `${arr}: ${items.join("; ")}` : null
    })
    .filter(Boolean)
    .join("\n")
  const mentionedPaths: string[] = []
  const mentioned = scanMentions(text, namedEntities(spine)).map((m) => {
    const arr = ENTITY_ARRAY[m.entity]
    const el = (spine[arr] as { id: string }[] | undefined)?.find((x) => x.id === m.id)
    if (el) mentionedPaths.push(`${arr}[id=${m.id}]`)
    return el ? `${arr}[id=${m.id}] = ${JSON.stringify(el)}` : null
  })
  const head = truncate(`${index}\n\nMentioned in the CR:\n${mentioned.filter(Boolean).join("\n") || "(none)"}`)
  const rules = relatedRules(spine, text, { ...opts, exclude: [...(opts.exclude ?? []), ...mentionedPaths] })
  const passages = relatedPassages(spine, text, opts)
  return `${head}\n\nRelated business rules / non-functional requirements (full text):\n${rules.join("\n") || "(none)"}\n\nRelated passages of the document kept verbatim (not in the structured data above):\n${passages.join("\n") || "(none)"}`
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

/**
 * Câu hỏi – trả lời làm rõ theo vòng. FLF-307: vòng sau thường sửa vòng trước (vòng 1 "mọi actor", vòng 2 "chỉ tài
 * khoản email/mật khẩu") — model đọc ngang hàng thì vẫn làm theo vòng 1 ⇒ nói rõ vòng sau thắng khi lệch nhau.
 */
export const answersText = (cr: Pick<IChangeRequest, "clarifications">): string => {
  const rounds = cr.clarifications ?? []
  const lines = rounds
    // Mode 1 v3 phase 7: câu trả lời trống = người dùng chưa biết ⇒ model coi dữ kiện đó là thiếu
    .flatMap((c) => c.questions.map((q, i) => `Q${c.round}.${i + 1}: ${q}\nA: ${c.answers[i]?.trim() || "(no answer — unknown)"}`))
    .join("\n")
  if (!lines) return "(none)"
  if (rounds.length < 2) return lines
  const last = rounds[rounds.length - 1].round
  return `Later rounds refine earlier ones: where two answers disagree, the answer from the later round wins and the earlier one no longer applies (round ${last} is final).\n${lines}`
}

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

/**
 * FLF-375 — tài liệu bổ sung của CR cho prompt, chọn theo **liên quan** thay vì cắt cụt phần đầu: tổng ≤
 * `MATERIALS_PROMPT_CHARS` ⇒ đưa đủ như `materialsText`. Vượt ⇒ cắt từng tài liệu theo cấu trúc bằng Tree-sitter
 * (`shared/search/md-chunks.ts` — đoạn, mục danh sách, dòng bảng kèm đường tiêu đề), BM25 chấm từng đơn vị theo `query`
 * (yêu cầu CR + chỗ đang sửa), lấy đơn vị điểm cao nhất tới hết ngân sách rồi **in lại theo thứ tự trong tài liệu**, "…"
 * ở chỗ bỏ. Trước đây yêu cầu nằm cuối biên bản / email dài không tới được AI.
 */
export const relevantMaterialsText = async (cr: Pick<IChangeRequest, "materials">, query: string): Promise<string> => {
  const materials = cr.materials ?? []
  if (!materials.length) return "(none)"
  if (materials.reduce((n, m) => n + m.text.length, 0) <= MATERIALS_PROMPT_CHARS) return materialsText(cr)
  const units = (await Promise.all(materials.map(async (m, mi) => (await chunkText(m.text)).map((c, ci) => ({ mi, ci, chunk: c }))))).flat()
  const ranked = new Bm25(units, (u) => `${u.chunk.headings.join(" ")} ${u.chunk.text}`).search(query)
  const picked = new Set<string>()
  let budget = MATERIALS_PROMPT_CHARS
  // Không đơn vị nào khớp (truy vấn rỗng / khác chữ hẳn) ⇒ lấy theo thứ tự tài liệu như cũ
  const order = ranked.length ? ranked.map((h) => h.item) : units
  for (const u of order) {
    const cost = u.chunk.text.length + 20
    if (cost > budget) continue
    budget -= cost
    picked.add(`${u.mi}:${u.ci}`)
  }
  return materials
    .map((m, mi) => {
      const chosen = units.filter((u) => u.mi === mi)
      const lines: string[] = []
      let gap = false
      let heading = ""
      for (const u of chosen) {
        if (!picked.has(`${mi}:${u.ci}`)) {
          gap = true
          continue
        }
        if (gap && lines.length) lines.push("…")
        gap = false
        const path = u.chunk.headings.join(" › ")
        if (path && path !== heading) lines.push(`## ${path}`)
        heading = path
        lines.push(u.chunk.text)
      }
      const when = m.round === 0 ? "attached when the CR was logged" : `attached with the answers of round ${m.round}`
      const note = lines.length ? "only the passages relevant to this change request" : "no passage relevant to this change request"
      return `[${m.material_id}] ${m.name} (${when}; ${note})\n${lines.join("\n")}`
    })
    .join("\n\n")
}

/** Truy vấn BM25 của CR: tiêu đề, mô tả, lệnh gộp thêm, câu trả lời làm rõ + chữ thêm (chỗ đang sửa, hướng của BA). */
export const crQuery = (cr: Pick<IChangeRequest, "title" | "description" | "amendments" | "clarifications">, ...extra: string[]): string =>
  [cr.title, cr.description, ...(cr.amendments ?? []).map((a) => a.text), ...(cr.clarifications ?? []).flatMap((c) => c.answers ?? []), ...extra].filter(Boolean).join("\n")

export const missingInfoText = (cr: Pick<IChangeRequest, "missing_info">): string =>
  cr.missing_info?.length ? cr.missing_info.map((f) => `- ${f}`).join("\n") : "(none)"

export const glossaryText = (spine: Spine): string => truncate(spine.glossary.map((g) => `${g.term}: ${g.definition}`).join("\n") || "(empty)", 3000)
