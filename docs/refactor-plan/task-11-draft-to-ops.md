# Task 11 — Draft-to-ops + retry schema + context projection

**Wave:** 2 · **Người phụ trách:** C · **Effort:** 6 điểm · **Trạng thái:** [ ] Chưa làm  [ ] Đang làm  [ ] Xong

## Mục tiêu
Cầu nối AI sang op engine: dựng context cho một step bằng projection (chỉ field Sở hữu/Đọc/Suy dẫn + addendum liên quan + tài liệu upload theo budget), gọi skill draft, parse op batch, validate path/schema, gửi lại kèm lỗi tối đa 2 lần, rồi trả về cho user.

## Lệch hướng audit cần đóng
B5 (nạp toàn transcript + mọi section phase trước, prompt generic), D5 (parse lỗi thì lưu raw text làm content).

## File / module liên quan
### Hiện có (đọc / sửa / xoá)
- Đọc: `flintflow_be/src/shared/ai/document-context.service.ts` (giữ `buildDocumentContext` cho tài liệu upload; bỏ dùng `buildPriorPhaseSectionsContext` và `SECTION_NEEDS_SOURCE_DOCUMENTS`), `ai-action.service.ts` (`executeAiAction`), `response-parser.ts` (`opTransactionSchema` T03), `modules/spine/op.types.ts`, `path-resolver.ts` (T08).
- Sửa: `flintflow_be/src/shared/ai/document-context.service.ts` thêm `STEP_NEEDS_SOURCE_DOCUMENTS` theo step registry (`reads` có `documents`).
### Tạo mới
- `flintflow_be/src/modules/pipeline/context-projection.ts` — `buildStepContext(projectId, stepId, {sessionId})` trả `{projection: object, addendum: Addendum[], documents: string, emptyFields: string[], transcriptTail: string}`: `projection` lấy theo `reads[]`/`writes[]` của step (step registry T12; trước khi merge dùng bảng tạm từ srs-spine §4) qua `FIELD_SECTION_MAP` T09; `addendum[target_section thuộc sections của step]`; `transcriptTail` chỉ các câu trả lời Elicit của step hiện tại (không phải toàn transcript); ước lượng token và ghi `contextTokens`.
- `flintflow_be/src/modules/pipeline/draft-to-ops.ts` — `draftOps(projectId, stepId, ctx, {maxSchemaRetries: 2})` trả `{txn: Transaction, attempts, usage}`: gọi skill content của step (`getSkill`) qua `executeAiAction(ActionType.DRAFT, …)`, parse `opTransactionSchema`, `validateOps` (mọi path resolve được trên Spine hiện tại + value đúng zod field), lỗi thì gọi lại với `{{validation_errors}}`; hết 2 lần thì ném `ApiError(422, "NEEDS_USER_INPUT", {errors, lastOps})`.
- `flintflow_be/src/modules/pipeline/op-validator.ts` — `validateOps(spine, ops)` trả `ValidationError[]` (dùng `path-resolver` + zod của field từ `spine.schema.ts`).
- Điền `assets/skills/action/draft-to-ops/SKILL.md` (định dạng op, quy tắc path, ví dụ) + `assets/skills/action/phase-intake/SKILL.md` (liệt kê field trống, đọc addendum).
- Test: `context-projection.test.ts` (S-3.5 chỉ nạp actors/use_cases/functions khung + addendum §2.2.2), `draft-to-ops.test.ts` (mock provider: lần 1 sai path, lần 2 đúng; 3 lần sai trả 422).

## Các bước implement
1. `op-validator` + test.
2. `context-projection` + test token budget.
3. `draft-to-ops` với retry + usage attempt.
4. Điền 2 skill action.
5. Chạy 10 ca op T02 qua mock provider trả `expected_ops`.

## Dependency
- Phụ thuộc: T01, T03, T08 (`op.types.ts`, `path-resolver.ts`), T09 (`FIELD_SECTION_MAP`), T12 (step registry — dùng bản tạm nếu chưa merge).
- Chặn: T13, T14, T17, T20.
- Chạy song song với: T08, T09, T10, T12.

## Output kỳ vọng
- Hai hàm `buildStepContext`, `draftOps` dùng được độc lập với step runner.

## Tiêu chí hoàn thành (DoD)
- [ ] 10 ca op T02 pass qua mock provider.
- [ ] Retry đúng 2 lần rồi 422 kèm lỗi cụ thể; không bao giờ ghi raw text vào Spine.
- [ ] Projection S-5.4@S-01 không chứa `nfrs[]`, `glossary[]`, transcript phase khác.

## Ghi chú / rủi ro
- Chi phí input là rủi ro gốc (srs-spine §10); ghi `contextTokens` vào `usage[]` để T22 đo.
