import type { Model } from "mongoose"
import { ChatSession } from "./chat-session.model.js"
import { ProjectDocument } from "./project-document.model.js"
import { ProjectDocumentChunk } from "./project-document-chunk.model.js"
import { RequirementSource } from "./requirement-source.model.js"
import { Spine } from "../spine/spine.model.js"
import { Change } from "../spine/change.model.js"
import { Baseline } from "../spine/baseline.model.js"
import { Usage } from "../spine/usage.model.js"
import { RenderedDocumentCache } from "../render/rendered-document.model.js"
import { StepRun } from "../pipeline/run-state.model.js"
import { AutoPass } from "../pipeline/auto-pass.model.js"
import { ImportedDocument } from "../import/imported-document.model.js"
import { DocBlock } from "../import/doc-block.model.js"
import { TemplateProfile } from "../import/template-profile.model.js"
import { ExtractionDraft } from "../import/extraction-draft.model.js"
import { FieldAnchor } from "../import/field-anchor.model.js"
import { ReuploadDiff } from "../import/reupload-diff.model.js"
import { DocVersion } from "../doc-version/doc-version.model.js"
import { ChangeRequest, CrCounter } from "../change-request/change-request.model.js"
import { ChangeLocation } from "../change-request/change-location.model.js"
import { ChangeGroup } from "../change-request/change-group.model.js"
import { SpineLock } from "../change-request/spine-lock.model.js"
import { SpineEmbedding } from "../change-request/embedding/spine-embedding.model.js"
import { RequirementExtraction } from "../change-request/requirement-extraction.model.js"
import { ScreenMockupRun } from "../diagram/screen-mockup-run.model.js"
import { SpineTranslation } from "../translation/spine-translation.model.js"
import { TranslationGlossary } from "../translation/translation-glossary.model.js"
import { TranslationRunLock } from "../translation/translation-run-lock.model.js"
import { Comment, CommentCounter } from "../comment/comment.model.js"
import { TemplateMigration } from "../template-migration/template-migration.model.js"
import { GoogleDocLink } from "../google/google-doc-link.model.js"

/** Phần chung của mọi document theo dự án — đủ để lọc / xoá theo `projectId`. */
export interface ProjectScopedDoc {
  projectId: unknown
}

/**
 * Mọi collection chứa dữ liệu CỦA MỘT dự án (lọc theo `projectId`) — xoá cứng dự án (`purgeProject`) dọn hết danh sách này,
 * script `cleanup-orphan-project-data` dùng cùng danh sách để tìm dữ liệu mồ côi. Thêm model mới có `projectId` thì thêm vào đây.
 *
 * Cố ý KHÔNG có: `CreditTransaction`, `CreditTopupRequest`, `AiActionLog` / `AiActionPayload` (lịch sử credit, thanh toán,
 * nhật ký AI thuộc tổ chức — không mất theo dự án), `OrgTemplate` / `OrgTemplateVersion` (`project_id` chỉ là nguồn của mẫu
 * tổ chức, mẫu vẫn dùng được khi dự án nguồn đã xoá).
 *
 * Là hàm (không phải hằng) để chỉ chạm tới các model lúc dùng: module import gián tiếp file này (test mock một phần model)
 * không vỡ lúc nạp.
 */
export const projectScopedModels = (): ReadonlyArray<Model<ProjectScopedDoc>> => [
  ChatSession,
  ProjectDocument,
  ProjectDocumentChunk,
  RequirementSource,
  Spine,
  Change,
  Baseline,
  Usage,
  RenderedDocumentCache,
  // Lượt chạy bước, khoá chỗ sửa của CR, vector tìm chỗ sửa (QLHS #2)
  StepRun,
  AutoPass,
  SpineLock,
  SpineEmbedding,
  RequirementExtraction,
  ScreenMockupRun,
  // Mode 1 (FLF-171): import, block, version, change request
  ImportedDocument,
  DocBlock,
  TemplateProfile,
  ExtractionDraft,
  FieldAnchor,
  ReuploadDiff,
  DocVersion,
  ChangeRequest,
  CrCounter,
  ChangeLocation,
  ChangeGroup,
  // FLF-265: lớp bản dịch + glossary dịch + khoá lượt dịch
  SpineTranslation,
  TranslationGlossary,
  TranslationRunLock,
  // Comment + đổi mẫu (FLF-422)
  Comment,
  CommentCounter,
  TemplateMigration,
  GoogleDocLink
] as unknown as ReadonlyArray<Model<ProjectScopedDoc>>
