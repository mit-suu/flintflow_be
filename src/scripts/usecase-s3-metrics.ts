/**
 * Chấm chất lượng đầu ra S-3.1 → S-3.5 trên một Spine — hàm thuần, dùng cho `eval-usecase-s3.ts`.
 *
 * Đo cái máy kiểm chắc được (cờ tất định, số lượng, persona của brief có thành actor không) và trả kèm
 * danh sách quan hệ include/extend + `reason` của op để người soát tay — đúng/sai NGỮ NGHĨA của một quan
 * hệ không suy ra được bằng code.
 */
import type { Spine } from "../modules/spine/spine.types.js"
import { runDeterministicCheck, type RuleProfile } from "../modules/spine/deterministic-check.js"

/** Một persona brief nêu tên; khớp khi tên một actor human chứa một trong các từ khoá (không phân biệt hoa thường). */
export interface PersonaExpectation {
  persona: string
  keywords: string[]
}

export interface RelationRow {
  kind: "include" | "extend"
  from: string
  to: string
  reason: string | null
}

export interface S3Metrics {
  actors: { human: number; system: number; time: number }
  useCases: number
  includes: number
  extends: number
  /** Số use case bị cờ tương ứng. */
  flags: {
    auth_relation: number
    orphan_actor: number
    relation_invalid: number
    floating: number
    name_semantic: number
    name_style: number
  }
  personasCovered: string[]
  personasMissing: string[]
  relations: RelationRow[]
}

/**
 * Lượt đo chấm CHẤT LƯỢNG mô hình hoá của những gì S-3 vừa sinh ra, không chấm tiến độ: Spine đo luôn
 * đứng giữa chừng (chưa qua S-4), nên cổng "bước sở hữu đã chốt chưa" (FLF-213) phải mở, nếu không
 * `orphan_actor`/`usecase_floating` im lặng và mọi lượt đo đều ra 0.
 */
const EVAL_PROFILE: RuleProfile = { exclude: new Set(), downgrade: new Set(), skipOwnerStepGate: true }

const RULE_KEYS = {
  usecase_auth_relation: "auth_relation",
  orphan_actor: "orphan_actor",
  usecase_relation_invalid: "relation_invalid",
  usecase_floating: "floating",
  usecase_name_semantic: "name_semantic",
  usecase_name_style: "name_style"
} as const

/**
 * @param reasons `reason` của op ghi quan hệ, khoá theo path op (`use_cases[id=UC02].includes`) — lấy từ
 *   `changes`. Thiếu ⇒ cột reason để trống.
 */
export const scoreS3 = (
  spine: Spine,
  personas: readonly PersonaExpectation[],
  reasons: ReadonlyMap<string, string> = new Map()
): S3Metrics => {
  const kinds = { human: 0, system: 0, time: 0 }
  for (const a of spine.actors) kinds[a.kind] += 1

  const flags = { auth_relation: 0, orphan_actor: 0, relation_invalid: 0, floating: 0, name_semantic: 0, name_style: 0 }
  for (const f of runDeterministicCheck(spine, [], { ruleProfile: EVAL_PROFILE })) {
    const key = RULE_KEYS[f.rule_id as keyof typeof RULE_KEYS]
    if (key) flags[key] += 1
  }

  const humanNames = spine.actors.filter((a) => a.kind === "human").map((a) => a.name.toLowerCase())
  const covered = personas.filter((p) => p.keywords.some((k) => humanNames.some((n) => n.includes(k.toLowerCase()))))

  const nameOf = new Map(spine.use_cases.map((u) => [u.id, u.name]))
  const label = (id: string): string => `${nameOf.get(id) ?? id} (${id})`
  const relations: RelationRow[] = spine.use_cases.flatMap((u) => [
    ...u.includes.map((t) => ({ kind: "include" as const, from: label(u.id), to: label(t), reason: reasons.get(`use_cases[id=${u.id}].includes`) ?? null })),
    ...u.extends.map((t) => ({ kind: "extend" as const, from: label(u.id), to: label(t), reason: reasons.get(`use_cases[id=${u.id}].extends`) ?? null }))
  ])

  return {
    actors: kinds,
    useCases: spine.use_cases.length,
    includes: relations.filter((r) => r.kind === "include").length,
    extends: relations.filter((r) => r.kind === "extend").length,
    flags,
    personasCovered: covered.map((p) => p.persona),
    personasMissing: personas.filter((p) => !covered.includes(p)).map((p) => p.persona),
    relations
  }
}
