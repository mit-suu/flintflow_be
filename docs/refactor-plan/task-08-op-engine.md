# Task 08 — Op engine: path resolver, ops, transaction, bất biến, cascade + Pipeline API contract

**Wave:** 2 · **Người phụ trách:** A · **Effort:** 13 điểm · **Trạng thái:** [ ] Chưa làm  [ ] Đang làm  [ ] Xong

## Mục tiêu
Hiện thực "op-based write" (Phases §2.1, srs-spine §3, §6): AI phát op, code áp; một step = một transaction; bất biến kiểm cuối lô; cascade xoá; `base_version` chống hai tab; `changes[]` có `before` để undo/resume. Đồng thời viết hợp đồng API pipeline để D mock và cả nhóm bám.

## Lệch hướng audit cần đóng
A2 (ghi đè cả section, không txn/bất biến/cascade), E3 (không kiểm version), nền cho C2 (undo), A4 (changes[] theo op).

## File / module liên quan
### Hiện có (đọc / sửa / xoá)
- Đọc: `flintflow_be/src/modules/spine/*` (T01), `fixtures/` (T02), `context/srs-spine.md` §1, §3, §4.1, §6.
- Sửa: `flintflow_be/src/modules/spine/spine.repository.ts` (thêm `applyAndSave` gọi từ op engine).
### Tạo mới
- `flintflow_be/src/modules/spine/path-resolver.ts` — parse `actors[id=A03].name`, `permissions[screen_id=S3,role_id=R1,action=create]`, `project.release_scope.in`, `functions[id=F1].validations[id=V2].statement`; `resolve(spine, path)` trả `{parent, key, value, exists}`; từ chối chỉ số mảng `actors[1]` và op đổi trường khoá (`id` hoặc trường trong selector).
- `flintflow_be/src/modules/spine/op.types.ts` — `Op = {op: "set"|"add"|"remove"|"renumber"|"clone"|"migrate", path, value?, reason?}`; `Transaction = {txn, base_version, ops: Op[], reason?, by, step_id?}`; `ApplyResult = {spine, changes: Change[], spine_version}`.
- `flintflow_be/src/modules/spine/reference-fields.ts` — danh sách §4.1 dạng `{path, targetCollection, cardinality}`; hàm `iterateReferences(spine)`.
- `flintflow_be/src/modules/spine/invariants.ts` — 8 bất biến §6, mỗi cái `{id, check(spine): Violation[]}`; danh sách section bắt buộc theo khoá logic (dùng registry T09 khi merge; trước đó hằng cục bộ).
- `flintflow_be/src/modules/spine/cascade.ts` — với `remove` phần tử được tham chiếu: sinh op cascade (screen: functions/permissions/flow_to/use_cases.function_ids/screen_queue/steps@X/sections function:*; actor: use_cases.actor_ids/roles.actor_id; feature: renumber; validation: business_rules.source_validation_ids…). Nếu cascade vi phạm bất biến khác thì `TransactionRejected{violations, referrers}`.
- `flintflow_be/src/modules/spine/op-engine.ts` — `applyTransaction(projectId, txn): Promise<ApplyResult>`: load Spine, kiểm `base_version === spine_version` (lệch: `ApiError 409 SPINE_VERSION_CONFLICT`), deep clone, áp op tuần tự ghi `before`, mở rộng cascade, kiểm bất biến cuối lô, bất biến 8 (append `screen_queue` khi `current_phase=S-5`), `spine_version++`, ghi `changes[]` (seq liên tục), `saveWithVersion`. `revertRange(projectId, first_seq, last_seq)` áp `before` theo thứ tự ngược trong một txn mới (`op: "revert"` ghi lại). `previewTransaction(projectId, txn)` trả diff không ghi.
- `flintflow_be/src/modules/spine/op-engine.test.ts` — chạy 10 ca op T02.
- `docs/api/pipeline-contract.md` + `flintflow_be/src/modules/pipeline/pipeline.dto.ts` (zod request/response) cho: `GET /projects/:id/spine`, `GET /projects/:id/progress`, `GET /projects/:id/steps` (danh sách step + status), `POST /projects/:id/steps/:stepId/run` (SSE events `intake|elicit|answer_needed|draft|ops_applied|render|flags|gate_ready|error`), `POST /projects/:id/steps/:stepId/answer {answers}`, `POST /projects/:id/steps/:stepId/gate {action: accept|revision|regenerate|accept_as_is, note?}`, `POST /projects/:id/changes {instruction?, ops?, base_version}`, `POST /projects/:id/changes/preview`, `POST /projects/:id/reconcile`, `POST /projects/:id/undo`, `GET /projects/:id/changes?from&to`, `GET /projects/:id/flags`, `POST /projects/:id/flags/:flagId/waive {reason}`, `POST /projects/:id/flags/recompute`, `GET /projects/:id/traceability?entity=&id=`, `GET /projects/:id/document?source=draft|baseline`, `POST /projects/:id/assemble`, `GET /projects/:id/export/word?source=`, `POST /projects/:id/baseline`, `GET /projects/:id/baselines`, `GET /projects/:id/diagrams/:diagramId.svg`. Mỗi endpoint: mã lỗi (`SPINE_VERSION_CONFLICT`, `INVARIANT_VIOLATION`, `NEEDS_USER_INPUT`, `NEEDS_CLARIFICATION`, `REGENERATE_LIMIT`, `CALL_LIMIT`, `INSUFFICIENT_CREDIT`, `NOT_PIPELINE_SESSION`).
- Route thực: `POST /projects/:id/changes` với `{ops}` thuần (không AI) và `POST /changes/preview` — để D test sớm; nhánh `{instruction}` là T17.

## Các bước implement
1. Path resolver + test (đủ 4 dạng path, từ chối chỉ số và đổi khoá).
2. `reference-fields.ts`; test iterate trên fixture.
3. Invariants 1–8 + test từng cái trên fixture biến thể.
4. Cascade + test xoá screen/actor/feature.
5. `applyTransaction`, `previewTransaction`, `revertRange`; test 10 ca op; test race 2 txn cùng base.
6. Contract doc + DTO zod; review với B, C, D; đóng băng tại M2.
7. Route `changes` (ops thuần) + `changes/preview`.

## Dependency
- Phụ thuộc: T01, T02 (fixture để test).
- Chặn: T11, T12 (contract), T13, T17; T10 nếu muốn ghi diagram qua op.
- Chạy song song với: T09, T10, T11 (T11 bắt đầu khi `op.types.ts` merge sớm), T12.

## Output kỳ vọng
- Op engine với test; contract doc được 4 người ký (comment "approved" trong PR).

## Tiêu chí hoàn thành (DoD)
- [ ] 10 ca op T02 pass (kể cả must_reject).
- [ ] `changes[]` seq liên tục, `before` đúng; `revertRange` khôi phục Spine bằng deep-equal.
- [ ] 2 txn cùng `base_version` thì một 409.
- [ ] `pipeline-contract.md` có đủ endpoint + mã lỗi; DTO zod export.

## Ghi chú / rủi ro
- Merge `op.types.ts` và `pipeline.dto.ts` sớm (ngày 1–2) dưới PR riêng để T11/T12 không chờ.
- Hiệu năng: deep clone Spine mỗi txn chấp nhận được vòng một (Spine < 1MB).
