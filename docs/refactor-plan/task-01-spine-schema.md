# Task 01 — Spine schema, types, Mongoose model, repository

**Wave:** 1 · **Người phụ trách:** A · **Effort:** 8 điểm · **Trạng thái:** [ ] Chưa làm  [ ] Đang làm  [ ] Xong

## Mục tiêu
Dựng nền dữ liệu Spine đúng `srs-spine.md` §2: một document `Spine` cho mỗi project, quan hệ bằng khoá, `spine_version` tăng đơn điệu, lịch sử `changes[]`, `usage[]`, `baselines[]` tách collection. Đây là task critical path của Wave 1: mọi task Wave 2 phụ thuộc vào types/schema ở đây.

## Lệch hướng audit cần đóng
A1 (không có Spine), A6 (thiếu steps/progress/assumptions/flags/addendum/diagrams/usage/sessions.is_pipeline), A8 (project thiếu type/domain/complexity/form_factor/stakes/working_mode/release_scope/vision/goals), E3 (không có base_version), nền cho A4/A5.

## File / module liên quan
### Hiện có (đọc / sửa / xoá)
- Đọc: `context/srs-spine.md` §2, §2.1, §3, §4.1; `context/Product-Brief-to-SRS-Phases.md` §4.4.
- Sửa: `flintflow_be/src/modules/project/project.model.ts` (giữ `userId, name, status`; các field `currentStep/currentPhase/workspacePhase/baselineVersion/progressPercent` **chưa xoá**, xoá ở T21).
- Sửa: `flintflow_be/src/modules/project/chat-session.model.ts` thêm `is_pipeline: boolean` (default false; session đầu tiên của project = true).
- Sửa: `flintflow_be/src/modules/project/project.service.ts` `createProject` gọi `spineRepository.getOrCreate(projectId)`; session đầu `is_pipeline = true`.
- Không xoá `modules/specification/*`, `modules/verification/*` ở task này.
### Tạo mới
- `flintflow_be/src/modules/spine/spine.types.ts` — toàn bộ interface: `SpineProject`, `Progress`, `StepState`, `Feature`, `Actor`, `Role`, `UseCase`, `Screen`, `Permission`, `Entity`, `Function`, `Validation`, `Nfr`, `BusinessRule`, `CommonRequirement`, `Message`, `OtherRequirement`, `GlossaryTerm`, `Addendum`, `Diagram`, `Assumption`, `Flag`, `SectionState`, `Baseline`, `Change`, `Usage`, `Spine`.
- `flintflow_be/src/modules/spine/spine.schema.ts` — zod cho mọi kiểu trên; `export const spineSchema`; hàm `toJsonSchema()` dùng `z.toJSONSchema` (zod 4).
- `flintflow_be/assets/schema/srs-spine.schema.json` — xuất từ script `npm run schema:export`.
- `flintflow_be/src/modules/spine/spine.model.ts` — Mongoose `Spine` (`projectId` unique index, `spine_version: Number default 1`, các mảng thực thể, `progress`, `steps`, `assumptions`, `flags`, `sections`, `addendum`, `diagrams`; `strict: true`).
- `flintflow_be/src/modules/spine/change.model.ts` — `Change {projectId, seq, txn, op, path, before, value, reason, at, by, step_id}`; index `{projectId:1, seq:1}` unique.
- `flintflow_be/src/modules/spine/baseline.model.ts` — `Baseline {projectId, version, at, checked_at_version, waived_count, snapshot: Mixed}`; `snapshot_ref` trong Spine trỏ tới `_id`.
- `flintflow_be/src/modules/spine/usage.model.ts` — `Usage {projectId, userId, step_id, call_kind, attempt, tokens_in, tokens_out, cost, state: reserved|deducted|refunded, expires_at, logId}`.
- `flintflow_be/src/modules/spine/spine.repository.ts` — `getOrCreate(projectId)`, `get(projectId)`, `saveWithVersion(spine, baseVersion)` (dùng `findOneAndUpdate({projectId, spine_version: baseVersion}, {...spine, spine_version: baseVersion+1})`, null thì ném `ApiError(409, "SPINE_VERSION_CONFLICT")`), `nextSeq(projectId)`, `appendChanges(projectId, changes[])`, `listChanges(projectId, {fromSeq, toSeq})`.
- `flintflow_be/src/modules/spine/spine.controller.ts` + `spine.route.ts` — `GET /api/v1/projects/:projectId/spine` (auth + ownership) trả Spine; mount trong `app.ts`.
- `flintflow_be/src/modules/spine/spine.schema.test.ts`, `spine.repository.test.ts`.
- `flintflow_be/src/scripts/export-schema.ts`.

## Các bước implement
1. Chép lược đồ §2 thành `spine.types.ts`; đặt tên field **giữ snake_case y như tài liệu** (`actor_ids`, `flow_to`, `detail_status`…) để path resolver (T08) khớp tài liệu.
2. Viết zod schema; enum đúng tài liệu (`kind: human|system|time`, `detail_status: pending|in_progress|signed_off|placeholder`, `status` của steps, flags `level`, usage `state`…). `sections[]` chỉ có `{id, asset_version}` (status là hàm tính, T09).
3. Viết model Mongoose từ zod (viết tay, không dùng lib chuyển đổi); `projectId` unique.
4. Tách `Change`, `Baseline`, `Usage` thành collection riêng; thêm index.
5. Viết repository với khoá lạc quan; test race: hai `saveWithVersion` cùng base thì một thành công, một 409.
6. Sửa `project.model.ts`, `chat-session.model.ts`, `project.service.ts` như trên.
7. Route `GET /spine`; kiểm ownership qua `getProjectById(projectId, userId)`.
8. Script xuất JSON schema; thêm `schema:export` vào `package.json`.
9. Cập nhật swagger tag `Spine`.

## Dependency
- Phụ thuộc: không.
- Chặn: T08, T09, T10, T11 (cần types); T02, T07 chỉnh lại theo schema tại M1.
- Chạy song song với: T02, T03, T04, T05, T06, T07.

## Output kỳ vọng
- Package `modules/spine` compile, có route đọc Spine; JSON schema file trong `assets/schema/`.
- Tài liệu ngắn `flintflow_be/src/modules/spine/README.md` mô tả quy ước path và versioning.

## Tiêu chí hoàn thành (DoD)
- [ ] `npm run typecheck` xanh.
- [ ] `spine.schema.test.ts`: Spine rỗng hợp lệ; fixture T02 (khi có) hợp lệ; enum sai bị từ chối.
- [ ] `spine.repository.test.ts`: conflict trả 409; `nextSeq` liên tục.
- [ ] `GET /projects/:id/spine` trả 200 cho chủ project, 404 cho người khác.
- [ ] `assets/schema/srs-spine.schema.json` tồn tại và được commit.

## Ghi chú / rủi ro
- Merge trước tiên trong Wave 1 (mục tiêu ≤ 3 ngày) để T02/T07 kịp đồng bộ.
- Không đặt `status` vào `sections[]` (A7). Không đặt `progressPercent` vào Spine.
- Document Mongo giới hạn 16MB: `changes[]`, `usage[]`, snapshot tách riêng là bắt buộc.
