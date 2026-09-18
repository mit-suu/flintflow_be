/**
 * Thư viện OOXML của mode 1 (FLF-171, plan §6 2A): đọc block, neo bookmark, Track Changes, comment,
 * stamp, accept-all, watermark. Chỉ dựa vào `jszip` + `@xmldom/xmldom`.
 */

export { DocxPackage, MAX_UNCOMPRESSED_BYTES, relsPathOf, type Relationship } from "./package.js"
export {
  MAIN_PART,
  blockIdOfBookmark,
  bookmarkName,
  ensureBlockBookmarks,
  findBlock,
  isAnchorable,
  parseBlocks,
  readBlocks,
  type AnchorQuery,
  type CellRef,
  type OoxmlBlock
} from "./blocks.js"
export { normalizeText, paragraphText, textHash, visibleRuns } from "./text.js"
export { RevisionIds, applyEdit, diffWords, toWDate, tokenize, type EditHunk, type RevisionAuthor } from "./track-changes.js"
export { COMMENTS_PART, addComment, listComments, removeComments, type CommentInfo } from "./comments.js"
export { CUSTOM_PROPS_PART, readCustomProperties, readStamp, writeStamp, type Stamp } from "./properties.js"
export { acceptAll, type AcceptAllResult } from "./accept-all.js"
export { addDraftWatermark, type WatermarkResult } from "./watermark.js"
export { commentParagraph, enclosingParagraph, listRevisions, type RevisionInfo } from "./revisions.js"
export { OoxmlError } from "./xml.js"
