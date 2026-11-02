/**
 * entity-features.ts
 * ─────────────────────────────────────────────────────────────────
 * Entity thuộc feature nào (`entities[].feature_ids`) — nguồn của class diagram mỗi feature một hình. Một entity có thể
 * thuộc nhiều feature (xuất hiện ở nhiều hình). Entity không thuộc feature nào còn tồn tại (Spine cũ, import mode 1, chưa
 * qua S-4.5) không có class diagram. Hàm thuần, dùng chung bởi renderer và `source-hash.ts`.
 */

import type { Entity, Spine } from "./spine.types.js"

export interface EntityGroup {
  featureId: string
  entities: Entity[]
}

const byId = <T extends { id: string }>(items: readonly T[]): T[] => [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

/** Entity dùng feature `featureId` (feature phải còn tồn tại), sắp theo id. */
export const entitiesOfFeature = (spine: Pick<Spine, "entities" | "features">, featureId: string | null): Entity[] =>
  featureId === null || !spine.features.some((f) => f.id === featureId) ? [] : byId(spine.entities.filter((e) => (e.feature_ids ?? []).includes(featureId)))

/** Nhóm theo thứ tự trong tài liệu: feature theo `order`, chỉ feature có entity. */
export const entityGroups = (spine: Pick<Spine, "entities" | "features">): EntityGroup[] =>
  [...spine.features]
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1))
    .map((f) => ({ featureId: f.id, entities: entitiesOfFeature(spine, f.id) }))
    .filter((g) => g.entities.length > 0)
