/**
 * C-3 tìm vị trí ảnh hưởng (nút 3.4, UC-50) — tất định, không tốn credit — rồi khoá block (3.5). FLF-171, plan §6 2E.
 * Hợp của ba nguồn trên block của version mới nhất:
 *   (a) `spine_link`: `impactOf` (thực thể đích + phần tử tham chiếu tới nó) ⇒ `FieldAnchor` ⇒ block; block thuộc
 *       section của feature/function đích.
 *   (b) `mention`: block có mention trỏ tới thực thể đó (mã UC/FR… hoặc tên, quét lúc import).
 *   (c) `keyword`: block chứa từ khoá của C-2 (theo ranh giới từ, không phân biệt hoa thường).
 * Khử trùng theo block, ghi `found_by[]`, gán `owner_step` theo section.
 */

import { latestDocVersion } from "../doc-version/doc-version.service.js"
import { DocBlock } from "../import/doc-block.model.js"
import { FieldAnchor } from "../import/field-anchor.model.js"
import type { MentionEntity } from "../import/import.constants.js"
import { stripRecord } from "../import/check.service.js"
import { impactOf } from "../spine/impact.service.js"
import { ownerStepOf } from "../spine/section-registry.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { LocationFoundBy } from "./change-request.constants.js"
import type { IChangeRequest } from "./change-request.model.js"
import { assertCrStatus } from "./change-request.service.js"
import { ChangeLocation } from "./change-location.model.js"
import { lockBlocks, unlockBlocks } from "./lock.service.js"

/** Trần số vị trí một CR — CR chạm quá nhiều chỗ nên tách nhỏ. */
export const MAX_LOCATIONS = 80

const MENTION_OF: Readonly<Record<string, MentionEntity>> = {
  use_cases: "use_case",
  functions: "function",
  nfrs: "nfr",
  business_rules: "business_rule",
  screens: "screen",
  actors: "actor",
  entities: "entity",
  features: "feature"
}

const ELEMENT = /^(\w+)\[id=([^\]]+)\]/

/** `use_cases[id=UC-01].name` ⇒ `use_cases[id=UC-01]`; path không phải phần tử ⇒ null. */
export const elementPathOf = (path: string): string | null => ELEMENT.exec(path)?.[0] ?? null

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export interface FoundLocation {
  block_id: string
  found_by: LocationFoundBy[]
  entity_paths: string[]
  owner_step: string | null
}

type BlockLite = { block_id: string; text: string; section_id: string | null; mentions: { entity: string; id: string }[]; anchor: { ordinal: number } }

/** Hàm thuần: gom vị trí từ ba nguồn. */
export const findLocations = (
  blocks: BlockLite[],
  elements: string[],
  anchoredBlocks: Map<string, string[]>,
  keywords: string[],
  ownerStep: (sectionId: string) => string | null
): FoundLocation[] => {
  const hits = new Map<string, { found_by: Set<LocationFoundBy>; entity_paths: Set<string> }>()
  const hit = (blockId: string, by: LocationFoundBy, path?: string) => {
    const cur = hits.get(blockId) ?? { found_by: new Set<LocationFoundBy>(), entity_paths: new Set<string>() }
    cur.found_by.add(by)
    if (path) cur.entity_paths.add(path)
    hits.set(blockId, cur)
  }
  const byId = new Map(blocks.map((b) => [b.block_id, b]))
  for (const el of elements) {
    const [, arr, id] = ELEMENT.exec(el) ?? []
    for (const blockId of anchoredBlocks.get(el) ?? []) if (byId.has(blockId)) hit(blockId, "spine_link", el)
    const sectionKey = arr === "functions" ? `function:${id}` : arr === "features" ? `feature:${id}` : null
    const mention = MENTION_OF[arr]
    for (const b of blocks) {
      if (sectionKey && b.section_id === sectionKey) hit(b.block_id, "spine_link", el)
      if (mention && b.mentions.some((m) => m.entity === mention && m.id === id)) hit(b.block_id, "mention", el)
    }
  }
  const patterns = keywords
    .map((k) => k.trim())
    .filter((k) => k.length >= 3)
    .map((k) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(k)}(?![\\p{L}\\p{N}])`, "iu"))
  for (const b of blocks) if (patterns.some((re) => re.test(b.text))) hit(b.block_id, "keyword")

  return blocks
    .filter((b) => hits.has(b.block_id))
    .slice(0, MAX_LOCATIONS)
    .map((b) => {
      const h = hits.get(b.block_id)!
      return { block_id: b.block_id, found_by: [...h.found_by], entity_paths: [...h.entity_paths], owner_step: b.section_id ? ownerStep(b.section_id) : null }
    })
}

export const formatLocationId = (n: number): string => `L${String(n).padStart(3, "0")}`

/** POST …/impact: tìm lại toàn bộ vị trí (thay lần trước) rồi khoá. */
export const runImpact = async (cr: IChangeRequest): Promise<void> => {
  assertCrStatus(cr, ["impact_review"], "impact_review")
  const version = (await latestDocVersion(cr.projectId))!
  const record = await spineRepository.get(String(cr.projectId))
  if (!record) throw new Error("Không tìm thấy Spine của project")
  const spine = stripRecord(record)

  const targets = cr.targets.entity_paths.map(elementPathOf).filter((p): p is string => !!p)
  const impact = impactOf(spine, targets)
  const elements = [...new Set([...targets, ...impact.referrers.map((r) => elementPathOf(r.path)).filter((p): p is string => !!p)])]
  const anchors = await FieldAnchor.find({ projectId: cr.projectId, entity_path: { $in: elements } }).lean()
  const anchored = new Map(anchors.map((a) => [a.entity_path, a.block_ids]))
  const blocks = await DocBlock.find({
    projectId: cr.projectId,
    doc_version: version.version,
    editable: true,
    kind: { $in: ["heading", "paragraph", "list_item", "table_cell", "caption"] },
    text: { $ne: "" }
  })
    .sort({ "anchor.ordinal": 1 })
    .select("block_id text section_id mentions anchor.ordinal")
    .lean<BlockLite[]>()

  const found = findLocations(blocks, elements, anchored, cr.targets.keywords, (section) => ownerStepOf(section, spine))
  const previous: string[] = await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id }).distinct("block_id")
  await ChangeLocation.deleteMany({ projectId: cr.projectId, cr_id: cr.cr_id })
  const docs = await ChangeLocation.insertMany(
    found.map((f, i) => ({ projectId: cr.projectId, cr_id: cr.cr_id, location_id: formatLocationId(i + 1), ...f }))
  )
  try {
    await lockBlocks(cr.projectId, version.version, cr.cr_id, found.map((f) => f.block_id))
    const kept = new Set(found.map((f) => f.block_id))
    const dropped = previous.filter((b) => !kept.has(b))
    if (dropped.length) await unlockBlocks(cr.projectId, cr.cr_id, dropped)
  } catch (err) {
    await ChangeLocation.deleteMany({ _id: { $in: docs.map((d) => d._id) } })
    throw err
  }
}
