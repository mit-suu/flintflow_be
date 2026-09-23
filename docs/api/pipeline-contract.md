# Pipeline API contract

> **Trạng thái:** T08 — **đã approve 2026-09-15**, đóng băng tại M2. Sau M2 mọi thay đổi phải qua PR nhãn `contract-change` được cả 4 người duyệt, và sửa `src/modules/pipeline/pipeline.dto.ts` trong cùng PR.
> **Nguồn:** `context/srs-spine.md` §3, §6, §7, §9 và `context/Product-Brief-to-SRS-Phases.md` §2–§4.
> **Schema zod:** `src/modules/pipeline/pipeline.dto.ts` (request/response), `src/modules/spine/op.types.ts` (op, transaction), `src/modules/spine/spine.schema.ts` (Spine, change, flag, baseline).

## 0. Quy ước chung

- Base URL `/api/v1`. Mọi endpoint cần `Authorization: Bearer <access token>`. User chỉ truy cập được project của mình; project không thuộc user trả `404 PROJECT_NOT_FOUND`, không trả 403.
- Response JSON luôn nằm trong envelope: `{ "data": …, "meta"?: {…}, "error": null | { "code", "message" } }`.
- **Khoá lạc quan.** Mọi request ghi Spine đều mang `base_version`, là `spine_version` client đọc gần nhất. Nếu lệch thì trả `409 SPINE_VERSION_CONFLICT`; client tải lại Spine rồi thử lại. Mỗi transaction chỉ tăng `spine_version` **một lần**.
- Tên field Spine giữ snake_case y như `srs-spine.md`. Thời điểm là chuỗi ISO 8601.
- Cột **Task** cho biết task nào hiện thực endpoint. Endpoint của task chưa merge thì FE mock bằng msw theo đúng hình ở đây (T12).

### 0.1 Op và path

```json
{ "op": "set", "path": "actors[id=A03].name", "value": "Administrator", "reason": "typo" }
```

| `op` | Ai phát | `path` | `value` |
| --- | --- | --- | --- |
| `set` | user, model | field (`actors[id=A03].name`, `project.release_scope.in`) hoặc phần tử (`actors[id=A03]`) | bắt buộc; set phần tử phải giữ nguyên khoá |
| `add` | user, model | mảng kết thúc bằng `[]`: `actors[]`, `screens[id=S07].flow_to[]` | bắt buộc; phần tử có `id` không được trùng |
| `remove` | user, model | phần tử (`screens[id=S08]`, `screens[id=S07].flow_to[=S08]`) hoặc field tuỳ chọn (`nfrs[id=N01].metric`) | — |
| `renumber` | user, model | `features[]` hoặc `functions[]` | tuỳ chọn: mảng id theo thứ tự mong muốn |
| `clone`, `migrate` | chỉ hệ thống | `$` | toàn bộ Spine |
| `revert` | chỉ engine ghi lại | — | — |

Quy tắc path, theo `srs-spine.md` §1:
- Phân giải **qua khoá**, không qua chỉ số. `actors[1]` bị từ chối với `index_selector_forbidden`.
- Selector nhiều trường dùng dấu phẩy: `permissions[screen_id=S3,role_id=R1,action=create]`. Selector phải khớp đúng một phần tử, khớp nhiều trả `path_ambiguous`.
- Phần tử vô hướng dùng `[=value]`.
- Giá trị selector được chứa `.` `:` `@` `-` (ví dụ `sections[id=fixed:3.1.1]`). Không được chứa `,` `[` `]`.
- **Cấm đổi khoá.** Không set/remove `id`, cũng không set/remove trường xuất hiện trong selector của phần tử (`key_change_forbidden`).
- Mảng phần tử có `id` chỉ sửa bằng `add`/`remove` từng phần tử, không `set` cả mảng (`op_not_allowed`).

### 0.2 Transaction (engine, không phải body HTTP)

```ts
Transaction = { txn?, base_version, ops: Op[], reason?, by, step_id? }
ApplyResult = { spine, changes: Change[], txn: string | null, spine_version }
```

- Id lô (`txn`) do server sinh; không nhận `txn` từ output model.
- **Lô không đổi gì** (mọi op trùng giá trị hiện tại): không ghi change, `spine_version` giữ nguyên, `txn = null`.
- Ghi Spine và `changes[]` trong một Mongo transaction khi deployment hỗ trợ (replica set). Mongo standalone: lưu Spine (khoá version) trước rồi ghi change; trùng `seq` thì cấp lại dải seq — không có lỗ seq, không xoá change của lô khác.

Engine áp op tuần tự lên bản sao, rồi làm tiếp theo thứ tự:
1. Mở rộng **cascade** tới khi không sinh thêm op.
2. Kiểm **8 bất biến** và `spineSchema` ở **cuối lô**.
3. Ghi `changes[]`: seq liên tục, mỗi thay đổi có `before`.

Cascade khi xoá phần tử đang được tham chiếu (`reference_fields[]`, §4.1):

| Chính sách | Field |
| --- | --- |
| gỡ khoá khỏi mảng | `use_cases[].actor_ids/function_ids/includes/extends`, `screens[].flow_to`, `functions[].business_rule_ids`, `entities[].relations`, `business_rules[].source_validation_ids`, `messages[].function_ids`, `progress.screen_queue` |
| đặt null | `roles[].actor_id`, `screens[].primary_function_id` |
| xoá phần tử chứa khoá | `permissions[]`, `functions[screen_id]`, `diagrams[owner_id]`, `flags[]`, `assumptions[]` (path trỏ phần tử đã xoá), `sections[feature:*/function:*]`, `steps[@screen]` |
| **không tự xoá** — từ chối lô, trả `referrers` | `screens[].feature_id`, `functions[].feature_id` |
| để yên | `progress.screen_cursor` (bất biến 8 quyết), `addendum[].target_section` (chỉ cần đúng dạng section key — entry Brief được trỏ section chưa sinh) |

Hai op engine tự thêm vào lô:
- Xoá feature thì đánh lại `features[].order`.
- Thêm màn khi `current_phase = S-5` thì thêm màn đó vào `progress.screen_queue[]`.

Nếu lô đã tự liệt kê op cascade, engine không sinh trùng.

**Mã hoá `changes[]`** (phục vụ undo/resume):
- `before = {"_absent": true}` nghĩa là op tạo mới phần tử hoặc key.
- `value = {"_absent": true, "index": n}` nghĩa là op xoá phần tử ở vị trí `n`.
- `value = {"_absent": true}` nghĩa là op xoá key tuỳ chọn.
- `path` luôn được chuẩn hoá về `[id=...]`.

**Revert** (resume/regenerate T13, undo T17) áp nghịch đảo dải `changes[]` theo seq giảm dần, trong một txn mới `op: "revert"`:
- Mỗi change chỉ revert được khi giá trị hiện tại **đúng là** giá trị change đó ghi. Khác (có thay đổi sau dải đụng cùng chỗ, hoặc phần tử cùng khoá đã được thêm lại) ⇒ `revert_conflict`, không ghi đè im lặng.
- Màn được revert khôi phục không bị bất biến 8 coi là "màn mới thêm trong S-5".

**Path user được ghi qua `POST /changes`**: mọi gốc trừ `flags`, `steps`, `progress`, `baselines`, `sections`, `diagrams` (hệ thống quản lý, đi qua `/flags`, gate, `/baseline`, render). Vi phạm ⇒ `path_not_writable` kèm `op_index`. Selector vô hướng `[=v]` khớp nhiều bản trùng thì lấy bản đầu.

### 0.3 Lỗi

| HTTP | `code` | Khi | `meta` |
| --- | --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Body/query sai DTO | — |
| 400 | `FLAG_NOT_WAIVABLE` | Waive luật `array_empty` / `dead_reference` / `render_error` | — |
| 401 | `UNAUTHORIZED` | Thiếu/sai token | — |
| 402 | `INSUFFICIENT_CREDIT` | Không reserve được credit cho lượt gọi model | `{ required, balance }` |
| 403 | `NOT_PIPELINE_SESSION` | `run/answer/gate` từ session không có `is_pipeline` | — |
| 404 | `PROJECT_NOT_FOUND` · `SPINE_NOT_FOUND` · `STEP_NOT_FOUND` · `FLAG_NOT_FOUND` · `BASELINE_NOT_FOUND` · `DIAGRAM_NOT_FOUND` | Không tồn tại / không thuộc user | — |
| 409 | `SPINE_VERSION_CONFLICT` | `base_version` lệch | `{ spine_version }` tuỳ chọn |
| 409 | `NEEDS_USER_INPUT` | Step đang chờ `answer_needed` mà client gọi `run`/`gate` | `{ questions }` |
| 409 | `NEEDS_CLARIFICATION` | `POST /changes` với `instruction` mơ hồ (UC 6.11) | `{ clarification }` |
| 409 | `REGENERATE_LIMIT` | Regenerate lần 4 trong một step | `{ regenerate_used: 3 }` |
| 409 | `CALL_LIMIT` | Lượt gọi model thứ 9 trong một step; chỉ còn `accept` / `accept_as_is` | `{ calls_used: 8 }` |
| 409 | `STEP_NOT_RUNNABLE` | Chạy step chưa tới lượt, hoặc gate step không ở `gate_ready` | — |
| 409 | `NO_WORKING_DRAFT` | `GET /document` hoặc `GET /export/word` với `source=draft` khi chưa `POST /assemble` lần nào | `{ hint: "S-8.2" }` |
| 422 | `OP_INVALID` | Op sai: `path_invalid`, `path_not_resolved`, `path_ambiguous`, `index_selector_forbidden`, `key_change_forbidden`, `duplicate_id`, `op_value_missing`, `op_not_allowed`, `schema_invalid`, `path_not_writable`, `revert_conflict` | `{ violations[], referrers[] }` |
| 422 | `INVARIANT_VIOLATION` | Vi phạm bất biến ở cuối lô: `invariant_1_required_section`, `invariant_2_last_element`, `invariant_3_dead_reference`, `invariant_4_screen_missing`, `invariant_5_feature_order`, `invariant_5_function_order`, `invariant_6_feature_mismatch`, `invariant_8_cursor_screen`, `invariant_8_screen_not_pending`, `invariant_8_screen_not_queued` | `{ violations[], referrers[] }` |
| 422 | `CHANGE_RANGE_INVALID` | Dải seq revert không hợp lệ/không đầy đủ | — |
| 422 | `NOTHING_TO_UNDO` | Không còn txn có thể undo | — |
| 422 | `BASELINE_BLOCKED` | Còn cờ đỏ chưa waive khi ghi baseline | `{ flags[] }` |
| 429 | `RATE_LIMIT_EXCEEDED` | Nhà cung cấp AI từ chối: hết hạn mức, chưa gắn thanh toán, hoặc gọi quá nhanh | — |
| 502 | `AI_PROVIDER_ERROR` | Nhà cung cấp AI lỗi / trả rỗng (`GLM_EMPTY_OUTPUT`, 5xx…) | — |
| 501 | `NOT_IMPLEMENTED` | Nhánh chưa hiện thực (vd `instruction` trước T17) | — |

`violations[]` = `{ rule, message, path?, op_index? }`. `referrers[]` = `{ path, id }`: các khoá đang trỏ tới phần tử bị xoá, để user tự quyết.

Bất biến 1, 2 và 8 kiểm **việc xoá**, bằng cách so trạng thái trước và sau lô. Bất biến 3 đến 6 chỉ từ chối vi phạm **mới phát sinh** trong lô; vi phạm đã có từ trước hiện qua cờ đỏ (T09). Bất biến 7 (đúng một session pipeline) được giữ ở collection `chatsessions`.

## 1. Endpoint

| # | Method + path | Task | Request | Response `data` | Lỗi riêng |
| --- | --- | --- | --- | --- | --- |
| 1 | `GET /projects/:id/spine` | T01 ✔ | — | `SpineRecord` | — |
| 2 | `GET /projects/:id/progress` | T09 ✔ | — | `progressResponseSchema` | — |
| 3 | `GET /projects/:id/steps` | T12/T13 | — | `stepsResponseSchema` | — |
| 4 | `POST /projects/:id/steps/:stepId/run` | T13 | `runStepRequestSchema` (thêm `reopen?: boolean` — chạy lại step đã `accepted`: BE đặt `revision_requested`, reset `first_seq/last_seq/accepted_at` như gate revision, B7) | **SSE** (mục 2) | `NOT_PIPELINE_SESSION`, `STEP_NOT_FOUND`, `STEP_NOT_RUNNABLE`, `NEEDS_USER_INPUT`, `CALL_LIMIT`, `INSUFFICIENT_CREDIT`, `SPINE_VERSION_CONFLICT` |
| 4a | `POST /projects/:id/phases/:phase/run` | FLF-198 | `runPhaseRequestSchema` | **SSE** (mục 2) — chạy liền cả giai đoạn | như endpoint 4 |
| 4b | `GET /projects/:id/steps/:stepId/run-state` | FLF-177 | — | `runStateResponseSchema` (null nếu step chưa chạy lần nào) | `PROJECT_NOT_FOUND` |
| 4c | `POST /projects/:id/steps/:stepId/cancel` | FLF-177 | `cancelRunRequestSchema` | `cancelRunResponseSchema` | `PROJECT_NOT_FOUND` |
| 4d | `GET /projects/:id/run-state/active` | FLF-177 | — | `runStateResponseSchema` hoặc `null` | `PROJECT_NOT_FOUND` |
| 5 | `POST /projects/:id/steps/:stepId/answer` | T13 | `stepAnswerRequestSchema` (≤ 20 answer, mỗi chuỗi ≤ 4000 ký tự) | `{ accepted: true }`, luồng SSE của `/run` tiếp tục | `NOT_PIPELINE_SESSION`, `STEP_NOT_RUNNABLE` |
| 6 | `POST /projects/:id/steps/:stepId/gate` | T13 | `gateRequestSchema` (`session_id` bắt buộc; `note` ≤ 2000 ký tự) | `gateResponseSchema` | `NOT_PIPELINE_SESSION`, `STEP_NOT_RUNNABLE`, `REGENERATE_LIMIT`, `CALL_LIMIT`, `NEEDS_USER_INPUT`, `INSUFFICIENT_CREDIT`, `SPINE_VERSION_CONFLICT` |
| 7 | `POST /projects/:id/changes` | T08 ✔ (`ops`) · T17 (`instruction`) | `changesRequestSchema` | `applyResultResponseSchema` | `SPINE_VERSION_CONFLICT`, `OP_INVALID`, `INVARIANT_VIOLATION`, `NEEDS_CLARIFICATION`, `INSUFFICIENT_CREDIT`, `NOT_IMPLEMENTED` |
| 8 | `POST /projects/:id/changes/preview` | T08 ✔ (`ops`) · T17 | `changesRequestSchema` | `changesPreviewResponseSchema` (200 cả khi `ok=false`) | `SPINE_VERSION_CONFLICT`, `INSUFFICIENT_CREDIT` |
| 9 | `POST /projects/:id/reconcile` | T17 | `reconcileRequestSchema` | chưa có `preview_id`: `changesPreviewResponseSchema`; có: `applyResultResponseSchema` | `SPINE_VERSION_CONFLICT`, `INVARIANT_VIOLATION`, `INSUFFICIENT_CREDIT` |
| 10 | `POST /projects/:id/undo` | T17 | `undoRequestSchema` | `applyResultResponseSchema` (op `revert`) | `SPINE_VERSION_CONFLICT`, `NOTHING_TO_UNDO`, `INVARIANT_VIOLATION` |
| 11 | `GET /projects/:id/changes?from&to` | T17 | `changesQuerySchema` | `Change[]` theo seq tăng dần | — |
| 12 | `GET /projects/:id/flags?level&open` | T09 ✔ | `flagsQuerySchema` | `Flag[]` | — |
| 13 | `POST /projects/:id/flags/:flagId/waive` | T09 ✔ | `waiveRequestSchema` (≥ 20 ký tự) | `Flag` | `FLAG_NOT_FOUND`, `FLAG_NOT_WAIVABLE`, `VALIDATION_ERROR`, `SPINE_VERSION_CONFLICT` |
| 14 | `POST /projects/:id/flags/recompute` | T09 ✔ | `recomputeFlagsRequestSchema` | `Flag[]`; `meta = { checked_at_version, opened[], resolved[], reopened[] }` | `SPINE_VERSION_CONFLICT` |
| 15 | `GET /projects/:id/traceability?entity&id` | T17 | `traceabilityQuerySchema` | `traceabilityResponseSchema` | `VALIDATION_ERROR` |
| 16 | `GET /projects/:id/document?source=draft\|baseline&baseline_id` | T15 | `documentQuerySchema` | `RenderedDocument` (`render/rendered-document.schema.ts`); `sections[].id` có thể là `group:<number>` (heading nhóm do Assemble chèn, không có status) | `BASELINE_NOT_FOUND`, `NO_WORKING_DRAFT` |
| 17 | `POST /projects/:id/assemble` | T15 | `assembleRequestSchema` | `assembleResponseSchema` (`sections` không đếm `group:*`) | `SPINE_VERSION_CONFLICT` |
| 18 | `GET /projects/:id/export/word?source=` | T15 | `exportWordQuerySchema` | file `.docx` (`Content-Disposition: attachment`), không bọc envelope | `BASELINE_NOT_FOUND`, `NO_WORKING_DRAFT` |
| 19 | `POST /projects/:id/baseline` | T19 | `baselineRequestSchema` | `Baseline` | `BASELINE_BLOCKED`, `SPINE_VERSION_CONFLICT` |
| 20 | `GET /projects/:id/baselines` | T19 | — | `Baseline[]` | — |
| 21 | `GET /projects/:id/diagrams/:diagramId.svg` (hoặc `.png`) | T10 ✔ | — | `image/svg+xml` / `image/png`, không bọc envelope | `DIAGRAM_NOT_FOUND` |
| 22 | `GET /projects/:id/diagrams` | T10 ✔ | — | `(Diagram & { stale: boolean, files: { svg, png } \| null })[]` | — |
| 23 | `POST /projects/:id/diagrams/:kind/render` (dev/thủ công; `kind` = `all` \| 5 kind) | T10 ✔ | `{ owner_id?, force? }` (`owner_id` bắt buộc với `screen_layout`; `force` compile lại cả hình có `source_hash` không đổi) | `{ spine_version, diagrams[], rendered[], removed[] }`; `.puml` lỗi ⇒ `render_status = error`, vẫn 200 | `VALIDATION_ERROR`, `SPINE_VERSION_CONFLICT` |
| 24 | `POST /projects/:id/resume` | T13 | — | `resumeResponseSchema` `{ reverted_step, spine_version, progress }` — step `in_progress` dang dở bị revert về `pending` | `SPINE_NOT_FOUND`, `STEP_NOT_RUNNABLE` (step đang chạy ở request khác), `CHANGE_RANGE_INVALID`, `OP_INVALID` (`revert_conflict`), `SPINE_VERSION_CONFLICT` |

Mọi endpoint còn có thể trả `401 UNAUTHORIZED`, `404 PROJECT_NOT_FOUND`, `400 VALIDATION_ERROR`.

### 1.1 Ví dụ `POST /projects/:id/changes`

```http
POST /api/v1/projects/6650…/changes
{ "base_version": 12, "ops": [ { "op": "remove", "path": "actors[id=A08]", "reason": "Email out of scope" } ] }
```

```json
{
  "data": {
    "txn": "b7c1…",
    "spine_version": 13,
    "changes": [
      { "projectId": "6650…", "seq": 88, "txn": "b7c1…", "op": "remove", "path": "actors[id=A08]", "before": { "id": "A08", "…": "…" }, "value": { "_absent": true, "index": 7 }, "reason": "Email out of scope", "at": "2026-09-14T09:00:00.000Z", "by": "<userId>", "step_id": null },
      { "seq": 89, "op": "remove", "path": "use_cases[id=UC01].actor_ids[=A08]", "before": "A08", "value": { "_absent": true, "index": 1 }, "reason": "Cascade: use_cases[id=UC01].actor_ids[=A08] referenced removed A08.", "…": "…" }
    ],
    "spine": { "projectId": "6650…", "spine_version": 13, "…": "…" }
  },
  "error": null
}
```

Lô bị từ chối:

```json
{
  "data": null,
  "meta": {
    "violations": [ { "rule": "invariant_3_dead_reference", "path": "screens[id=S14].feature_id", "message": "…" } ],
    "referrers": [ { "path": "screens[id=S14].feature_id", "id": "F6" } ]
  },
  "error": { "code": "INVARIANT_VIOLATION", "message": "…" }
}
```

## 2. SSE — `POST /projects/:id/steps/:stepId/run`

Response `Content-Type: text/event-stream`. Mỗi sự kiện có dạng `event: <type>` rồi `data: <JSON>`; phần JSON đúng `stepEventSchema` (có trường `type` trùng tên event). Luồng đóng sau `gate_ready` hoặc `error`. Nếu gặp `answer_needed`, client gửi `/answer` và giữ kết nối để nhận các sự kiện tiếp theo.

| `type` | Khi | `data` |
| --- | --- | --- |
| `intake` | Lần đầu vào phase: liệt kê field còn trống | `{ step_id, phase, empty_fields[] }` |
| `stage` | Runner chuyển giai đoạn (đọc → hỏi → soạn → kiểm → vẽ → duyệt) hoặc sang lô function kế | `{ step_id, stage, label_vi, detail_vi?, batch?, est_ms? }` |
| `heartbeat` | Mỗi 10 giây trong lúc chờ model/render — để FE biết lượt còn sống | `{ step_id, stage, elapsed_ms }` |
| `elicit` | Model đang hỏi/giải thích (stream chữ) | `{ step_id, delta }` |
| `answer_needed` | Cần user trả lời trước khi Draft | `{ step_id, questions[] }` |
| `answer_received` | Ngay khi `/answer` tới — trạng thái đổi luôn, không chờ lượt Draft | `{ step_id, count }` |
| `draft` | Bắt đầu một lượt Draft (kể cả retry schema) | `{ step_id, attempt }` |
| `draft_retry` | Model trả kết quả không hợp lệ, đang thử lại | `{ step_id, attempt, max, reason_vi }` — lời thường, không mã lỗi |
| `ops_applied` | Transaction của step đã ghi | `{ step_id, txn, spine_version, changes[], summary[]? }` |
| `render` | Mỗi diagram render xong | `{ step_id, diagram_id, render_status, error? }` |
| `flags` | Deterministic check chạy lại | `{ step_id, red_open, yellow_open, red_delta?, yellow_delta?, new_assumptions[]? }` |
| `gate_ready` | Chờ user chọn ở cổng chốt | `{ step_id, actions[], regenerate_used, calls_used, summary[]?, new_assumptions[]?, flags?, duration_ms?, credits_used?, doc_progress?, no_change_reason? }` |
| `auto_accepted` | Step "yên lặng" được tự Accept (chế độ duyệt Cân bằng/Nhanh) | `{ step_id, reason_vi }` |
| `phase_gate` | Cổng chốt cuối giai đoạn: tóm tắt cả giai đoạn, gồm cả bước đã tự Accept | `{ step_id, phase, reason_vi, summary[], new_assumptions[], steps[], flags? }` |
| `phase_progress` | Chạy liền cả phase: đang ở step thứ mấy | `{ step_id, phase, step_index, step_total, needs_user }` |
| `error` | Dừng step | `{ step_id, code, message, retryable }` — `code` thuộc bảng 0.3 |

Gate (`accept` · `revision` · `regenerate` · `accept_as_is`):
- Trần **8 lượt gọi model/step** và **3 lần Regenerate/step**.
- `accept_as_is` chỉ có trong `actions[]` khi đã hết Regenerate, hoặc khi `revision` không giải quyết được. Hành động này bắt buộc `note`.
- Refund do `SPINE_VERSION_CONFLICT` **không** tính vào trần Regenerate.

## 3. Lịch sử thay đổi contract

| Ngày | PR | Thay đổi |
| --- | --- | --- |
| 2026-09-14 | T08 | Bản nháp đầu tiên |
| 2026-09-14 | review T08–T11 | `txn` nullable (lô không đổi gì), `path_not_writable`, `revert_conflict`, ghi Spine + changes trong transaction, `force` cho render, preview không tạo Spine |
| 2026-09-15 | contract-change Wave 3 | Endpoint 24 `POST /resume` (T13); `session_id` bắt buộc cho `/gate` + giới hạn độ dài `answers`/`note` (T13); mã `409 NO_WORKING_DRAFT` `{hint}` cho `/document`, `/export/word` (T15); `RenderedSection.id` `group:*` (T15); `step-registry.json` S-3.6 `renders: ["usecase", "context"]` (T14) |
| 2026-09-15 | contract-change M3 (chạy thật GLM) | `step-registry.json` `reads` S-2.3, S-3.1, S-3.2, S-3.3 thêm `project:name,vision,goals,release_scope` — model cần goals/scope để suy ra actor system/time và đủ use case (run12–13 chỉ ra 2 actor, 7 use case) |
| 2026-09-18 | contract-change FLF-171 (mode 1, P1 §5.5) | `Baseline` và `BaselineSnapshot` thêm `type` (`generated`, `imported` hoặc `release`) (mặc định `generated` cho dữ liệu cũ) và `doc_version` (chuỗi hoặc `null`) (mặc định `null`). Endpoint 19 `POST /baseline` luôn ghi `type: "generated"`, `doc_version: null`. Baseline `imported`/`release` do API mode 1 tạo (`docs/api/import-change-contract.md`) |
| 2026-09-22 | contract-change FLF-177 | `Spine.project` thêm `system_name` (chuỗi hoặc `null`, mặc định `null` cho dữ liệu cũ): tên hệ thống tiếng Anh in trên boundary sơ đồ use case/ngữ cảnh và bìa, tiêu đề, tên file docx; `null` ⇒ dùng tên project. `section-registry` thêm dòng `project_system_name` (sở hữu `fixed:1`, suy dẫn `diagram:context`, `diagram:usecase`). `step-registry.json` `reads` S-2.5 thành `project:name,system_name`, S-3.6 thêm `project:name,system_name`. Cờ vàng mới `system_name_missing` |
| 2026-09-23 | contract-change FLF-198 (fix-plan sau lượt test UI) | SSE thêm 7 sự kiện `stage`, `heartbeat`, `answer_received`, `draft_retry`, `auto_accepted`, `phase_progress`, `phase_gate`; `ops_applied` thêm `summary[]`; `flags` thêm `red_delta`/`yellow_delta`/`new_assumptions[]`; `gate_ready` thêm `summary[]`, `new_assumptions[]`, `flags`, `duration_ms`, `credits_used`, `doc_progress`, `table`, `no_change_reason`. Endpoint mới 4a `POST /phases/:phase/run` (SSE, chạy liền giai đoạn), 4b `GET /steps/:stepId/run-state`, 4c `POST /steps/:stepId/cancel`, 4d `GET /run-state/active`. `GET /document?source=draft` khi chưa ghép trả **200** `{ data: null, meta: { state: "not_assembled" } }` thay vì 409. `changesPreviewResponseSchema` thêm `notes`, `no_change`. `Spine.project` thêm `review_mode` (`strict|balanced|fast`, mặc định `balanced`); `Spine` thêm `decisions[]` (sổ quyết định). Collection mới `step_runs` (khoá step có TTL + trạng thái lượt chạy). Luật cờ mới: `screen_placeholder`, `function_without_uc`, `derived_from_changed_assumption` (đều vàng, waive được) |
