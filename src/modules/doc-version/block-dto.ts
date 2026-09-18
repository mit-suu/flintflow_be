/** DocBlock (model) ⇒ DTO trên dây (`docBlockDtoSchema`). FLF-171. */

import type { DocBlockDto } from "../import/import.dto.js"
import type { IDocBlock } from "../import/doc-block.model.js"

type BlockLike = Pick<IDocBlock, "block_id" | "doc_version" | "kind" | "level" | "heading_path" | "text" | "section_id" | "mentions" | "editable" | "locked_by_cr">

export const toDocBlockDto = (b: BlockLike, revisions?: DocBlockDto["revisions"]): DocBlockDto => ({
  block_id: b.block_id,
  doc_version: b.doc_version,
  kind: b.kind,
  level: b.level ?? null,
  heading_path: [...(b.heading_path ?? [])],
  text: b.text,
  section_id: b.section_id ?? null,
  mentions: (b.mentions ?? []).map((m) => ({ entity: m.entity, id: m.id })),
  editable: b.editable,
  locked_by_cr: b.locked_by_cr ?? null,
  ...(revisions ? { revisions } : {})
})
