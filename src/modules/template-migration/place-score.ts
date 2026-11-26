/**
 * Chấm điểm "mục cũ nên đặt vào mục nào của mẫu mới" theo nghĩa — thuần, không AI, 0 credit, cùng đầu vào ⇒ cùng kết quả.
 *
 * Mục cũ và mục mẫu được quy về vector khái niệm (`concept-lexicon.ts`):
 *  - mục cũ: tên heading (×3) + loại dữ liệu của `section_id` (×2) + mẫu nội dung Spine (×1);
 *  - mục mẫu: tên heading (×3) + loại dữ liệu của các mục cũ đã ghép vào nó (×2) + loại dữ liệu của chính `section_id` (×2 khi tên
 *    không nói gì, ×0,5 khi tên đã có khái niệm — mapping lúc đăng mẫu có thể gán sai id, tên là tín hiệu chắc hơn) + chữ hướng dẫn (×1).
 * Điểm = 0,30·cosine khái niệm + 0,20·tên mục mẫu nói đúng khái niệm của mục cũ + 0,20·hợp loại dữ liệu + 0,20·cùng id (chồng lấn
 * tính nửa) + 0,10·tên giống. Cùng id chỉ là một tín hiệu: cosine dưới `SAME_ID_MIN_CONCEPT` thì bỏ thưởng cùng id (mẫu tự nhận
 * "3.4 Tuân thủ" là mục Yêu cầu khác). Heading nhóm có mục con bị trừ nhẹ: chỉ thắng khi không mục con nào hợp.
 */
import { overlapsOf } from "../import/content-slots.js"
import { splitHeadingNumber, titleSimilarity } from "../import/text-similarity.js"
import { conceptsOf, dataConceptsOf, type Concept } from "./concept-lexicon.js"

export interface PlaceSource {
  heading_text: string
  section_id: string
  /** Mẫu nội dung Spine của mục (vài phần tử đầu, đã cắt ngắn). */
  sample?: string
}

export interface PlaceTarget {
  key: string
  heading_text: string
  section_id: string
  guidance?: string | null
  /** `section_id` của các mục cũ đã ghép vào heading này (không tính chính mục đang chấm). */
  paired_section_ids?: readonly string[]
  /** Heading nhóm có mục con trong mẫu. */
  has_children?: boolean
}

export type PlaceWhy = "same_section" | "guidance" | "data_fit" | "title"

export interface PlaceScore {
  new_key: string
  score: number
  why: PlaceWhy[]
  /** Loại dữ liệu của mục cũ hợp với mục mẫu (một phần trở lên). */
  data_fit: boolean
}

/** Cosine khái niệm dưới mức này ⇒ cùng id không được thưởng (ghép theo id nhưng sai nghĩa). */
export const SAME_ID_MIN_CONCEPT = 0.15
const WRAPPER_FACTOR = 0.9

type Vector = Map<Concept, number>

const addAll = (v: Vector, concepts: Iterable<Concept>, weight: number): void => {
  for (const c of concepts) v.set(c, (v.get(c) ?? 0) + weight)
}

const cosine = (a: Vector, b: Vector): number => {
  let dot = 0
  for (const [c, w] of a) dot += w * (b.get(c) ?? 0)
  if (!dot) return 0
  const norm = (v: Vector): number => Math.sqrt([...v.values()].reduce((s, w) => s + w * w, 0))
  return dot / (norm(a) * norm(b))
}

const titleOf = (text: string): string => splitHeadingNumber(text).title

const sourceVector = (s: PlaceSource): Vector => {
  const v: Vector = new Map()
  addAll(v, conceptsOf(titleOf(s.heading_text)), 3)
  addAll(v, dataConceptsOf(s.section_id), 2)
  if (s.sample) addAll(v, conceptsOf(s.sample), 1)
  return v
}

const related = (a: string, b: string): "same" | "overlap" | null => (a === b ? "same" : overlapsOf(a).includes(b) || overlapsOf(b).includes(a) ? "overlap" : null)

/** Điểm của một mục mẫu cho mục cũ `s`. */
export const scoreTarget = (s: PlaceSource, t: PlaceTarget, sv: Vector = sourceVector(s)): PlaceScore => {
  const title = conceptsOf(titleOf(t.heading_text))
  const own = dataConceptsOf(t.section_id)
  const paired = (t.paired_section_ids ?? []).flatMap((id) => [...dataConceptsOf(id)])
  const guidance = t.guidance ? conceptsOf(t.guidance) : new Set<Concept>()
  const tv: Vector = new Map()
  addAll(tv, title, 3)
  addAll(tv, paired, 2)
  addAll(tv, own, title.size ? 0.5 : 2)
  addAll(tv, guidance, 1)

  const concept = cosine(sv, tv)
  const titleHit = [...title].some((c) => sv.has(c)) ? 1 : 0
  const kinds = dataConceptsOf(s.section_id)
  const accept = new Set<Concept>([...title, ...paired, ...(title.size ? [] : own)])
  const fit = kinds.length ? kinds.filter((c) => accept.has(c)).length / kinds.length : titleHit
  const rel = related(s.section_id, t.section_id)
  const sameId = concept < SAME_ID_MIN_CONCEPT || !rel ? 0 : rel === "same" ? 1 : 0.5
  const name = titleSimilarity(titleOf(s.heading_text), titleOf(t.heading_text))
  const raw = 0.3 * concept + 0.2 * titleHit + 0.2 * fit + 0.2 * sameId + 0.1 * name
  const score = Math.round(raw * (t.has_children ? WRAPPER_FACTOR : 1) * 1000) / 1000

  const why: PlaceWhy[] = []
  if (sameId) why.push("same_section")
  if ([...guidance].some((c) => sv.has(c))) why.push("guidance")
  if (fit > 0) why.push("data_fit")
  if (name >= 0.5 || titleHit) why.push("title")
  return { new_key: t.key, score, why, data_fit: fit > 0 }
}

/** Xếp mục mẫu theo điểm giảm dần; bằng điểm ⇒ mục đứng trước trong mẫu. */
export const rankTargets = (s: PlaceSource, targets: readonly PlaceTarget[]): PlaceScore[] => {
  const sv = sourceVector(s)
  return targets
    .map((t, i) => ({ r: scoreTarget(s, t, sv), i }))
    .sort((a, b) => b.r.score - a.r.score || a.i - b.i)
    .map((x) => x.r)
}

/** Ngưỡng gợi ý: `high` cần điểm cao, hơn hạng hai rõ và hợp loại dữ liệu; `guess` chỉ cần điểm vừa. */
export const HIGH_SCORE = 0.6
export const HIGH_MARGIN = 0.15
export const GUESS_SCORE = 0.35

export type PlaceConfidence = "high" | "guess" | null

/** Độ tin của hạng nhất trong một bảng xếp hạng (`null` = không đủ để gợi ý). */
export const confidenceOf = (ranked: readonly PlaceScore[]): PlaceConfidence => {
  const [first, second] = ranked
  if (!first || first.score < GUESS_SCORE) return null
  return first.score >= HIGH_SCORE && first.data_fit && first.score - (second?.score ?? 0) >= HIGH_MARGIN ? "high" : "guess"
}

/** Một phần tử dữ liệu (yêu cầu, quy tắc…) ⇒ mục mẫu hợp nhất trong `candidates` theo tên mục; không mục nào nói đúng ⇒ `null`. */
export const itemTarget = (text: string, candidates: readonly PlaceTarget[]): string | null => {
  const item = conceptsOf(text)
  const hits = candidates.filter((t) => [...conceptsOf(titleOf(t.heading_text))].some((c) => item.has(c)))
  return hits.length === 1 ? hits[0].key : null
}
