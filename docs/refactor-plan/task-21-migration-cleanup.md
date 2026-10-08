# Task 21 — Data migration + xoá legacy + cập nhật docs

**Wave:** 5 · **Người phụ trách:** A · **Effort:** 7 điểm · **Trạng thái:** [ ] Chưa làm  [ ] Đang làm  [ ] Xong

## Mục tiêu
Chuyển project cũ (Section markdown) sang Spine ở mức best-effort, xoá toàn bộ module/route/prompt/script legacy đã được thay thế, cập nhật README/swagger/CLAUDE.md.

## Lệch hướng audit cần đóng
Dứt điểm A1–A8, B1, C1, C2, C4 (xoá nguồn cũ để không còn hai nguồn sự thật); dọn nợ kỹ thuật §6 audit (scripts tạm, README lỗi thời).

## File / module liên quan
### Hiện có (đọc / sửa / xoá)
- Xoá BE: `src/modules/specification/` (toàn bộ), `src/modules/verification/` (toàn bộ), `src/shared/constants/section-types.ts`, `src/shared/ai/document-context.service.ts` phần `SECTION_NEEDS_SOURCE_DOCUMENTS`/`buildPriorPhaseSectionsContext`, `chat-session.service.ts:360-506 rollbackMessages` + route `POST /chats/:chatId/rollback` + `ConfirmRollbackModal`, route `generate-phase`, `assets/prompts/{generate_section,priority_ranking,scope_out_of_scope,chat_discovery}.md`, `assets/prompts/_archive/drawtest`, `assets/_archive/diagram-skill`, `src/_archive/drawtest`, `src/scripts/{test-task-a,b,c,d}.ts`, `seed-test-uc34.ts`, `verify-task2c-2d.ts`, `audit-callers.ts` (nếu không còn đúng), model `PromptTemplate` + `seed-from-md.ts` nếu T03 đã bỏ hẳn DB override (giữ `audit-ai-db.ts` nếu còn dùng cho PricingConfig).
- Sửa BE: `src/modules/project/project.model.ts` gỡ `currentStep, currentPhase, workspacePhase, baselineVersion, progressPercent`; `project.service.ts` (`deleteProject(hard)` cascade `Spine, Change, Baseline, Usage, Notification, PaymentIntent`, gỡ `listProjects/renameProject/archiveProject` chết); `project.controller.ts` (gỡ handler chết); `project-document.service.ts` (`deleteProjectDocument` xoá Cloudinary asset); `ai-action.types.ts` gỡ ActionType deprecated; `response-parser.ts` gỡ schema cũ; `credit-reservation.service.ts` gỡ giá cũ; `app.ts` gỡ mount cũ; `config/swagger.ts`; `README.md` BE (kiến trúc mới: spine/pipeline/render/diagram/notification/billing); `shared/ai/README.md`.
- Xoá FE: `lib/constants/section-types.ts`, `_components/{DraftReviewCard,GeneratingIndicator,ConfirmRollbackModal,DiscoveryStepBar,SummaryReviewCard,StepTransitionBanner}.tsx` (nếu T20 đã thay), `lib/api.ts` re-export cũ; `README.md` FE cập nhật.
- Sửa: `D:\Learning\Capstone\FlintFlow\CLAUDE.md` (mô tả hiện trạng mới, không còn "version cũ").
### Tạo mới
- `flintflow_be/src/scripts/migrate-sections-to-spine.ts` (`--dry-run`, `--project <id>`): với mỗi project có `Section`: `getOrCreate` Spine; `vision_problem/business_goals/value_proposition` thành `project.vision`, `goals[]` (heuristic dòng bullet) + addendum `fixed:1`; `high_level_business_rules` thành addendum `fixed:1`; `stakeholders/user_journey` thành addendum `fixed:2.1`; `use_case_spec` thử parse bảng markdown thành `use_cases[]` (id, name, actor tên tạo `actors[]` nếu chưa), fallback addendum `fixed:2.2.2`; `screen_flow/screen_description/rbac/non_screen_functions/erd/functional_requirements` thành addendum `fixed:3.1.x`; `user_story/acceptance_criteria` thành addendum chung (`target_section: fixed:3.1.2`); phase 4 sections thành addendum `fixed:4.x/5.x`; `SectionVersion` không migrate (ghi 1 dòng `changes[] {op:"migrate", reason: "legacy import", before: null}`); `steps[]` rỗng; `progress` B-0 (Intake sẽ thấy Spine có addendum). Ghi báo cáo `docs/migration-report.md`.
- `docs/architecture.md` (sơ đồ module mới, luồng step, luồng change).

## Các bước implement
1. Migration script + dry-run trên dump dev; báo cáo số project/section chuyển.
2. Xoá legacy theo danh sách; typecheck; sửa import vỡ.
3. Cập nhật README/swagger/CLAUDE.md/architecture.md.
4. Chạy full test BE/FE.

## Dependency
- Phụ thuộc: toàn bộ Wave 4 (T17, T18, T19, T20) merge.
- Chặn: T22, T23, T24 (chạy sau khi legacy đã xoá để test không bám code cũ).
- Chạy song song với: T22, T23, T24 (bắt đầu cùng lúc; T21 merge trước cuối wave).

## Output kỳ vọng
- Codebase không còn Section/SectionVersion/VerificationContext/rollback; migration chạy được; docs đúng hiện trạng.

## Tiêu chí hoàn thành (DoD)
- [ ] Grep `SectionType|workspacePhase|SectionVersion|RequirementSourceLink|VerificationContext` trong `flintflow_be/src`, `flintflow_fe/app`, `flintflow_fe/lib` rỗng.
- [ ] Migration dry-run + thật trên dump dev; project cũ mở được ở B-0 với addendum.
- [ ] `npm run typecheck && npm test` BE/FE xanh.
- [ ] README/swagger/CLAUDE.md phản ánh module mới.

## Ghi chú / rủi ro
- Migration best-effort: không hứa parse UC/FR cũ chính xác; addendum là đích an toàn.
