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

**Path user được ghi qua `POST /changes`**: mọi gốc trừ `flags`, `steps`, `progress`, `baselines`, `sections`, `diagrams` (hệ thống quản lý, đi qua `/flags`, gate, `/baseline`, render). Vi phạm ⇒ `path_not_writable` kèm `op_index`. Khi `progress.current_phase` là `B-*` (hoặc project mới chưa chạy step nào: `current_phase` null và chưa step nào `accepted`), thay đổi `project.vision`/`project.goals` cũng không ghi được qua `/changes` (`path_not_writable`; `set project` cả object giữ nguyên hai giá trị này thì qua): tầm nhìn/mục tiêu của Brief nằm ở `addendum[]` `topic: vision`/`goals`; lệnh sửa (`instruction`) ở pha Brief nhận thêm `brief_core` trong projection. Selector vô hướng `[=v]` khớp nhiều bản trùng thì lấy bản đầu.

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
| 422 | `OP_INVALID` | Op sai: `path_invalid`, `path_not_resolved`, `path_ambiguous`, `index_selector_forbidden`, `key_change_forbidden`, `duplicate_id`, `op_value_missing`, `op_not_allowed`, `schema_invalid`, `path_not_writable`, `revert_conflict`; khi model soạn: `op_out_of_scope`, `brief_extraction_incomplete` | `{ violations[], referrers[] }` |
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
| 4 | `POST /projects/:id/steps/:stepId/run` | T13 | `runStepRequestSchema` (thêm `reopen?: boolean` — chạy lại step đã `accepted`: BE đặt `revision_requested`, reset `first_seq/last_seq/accepted_at` như gate revision, B7; `message?: string` ≤ 4000 ký tự — tin chat khởi động lượt chạy, ghi vào transcript gắn step trước Intake; `intent?: "no_idea"` — user chưa có ý tưởng, B-0.1 hỏi gợi mở, FLF-221) | **SSE** (mục 2) — bước B-1.x (fast path, FLF-234) áp luật Elicit riêng ở cả lời gọi này: không tin user ⇒ không gọi Elicit; có tin ⇒ chỉ giữ câu `conflict` trên chủ đề đã chốt, lời AI không còn câu hỏi đã bị bỏ (xem 4a) | `NOT_PIPELINE_SESSION`, `STEP_NOT_FOUND`, `STEP_NOT_RUNNABLE`, `NEEDS_USER_INPUT`, `CALL_LIMIT`, `INSUFFICIENT_CREDIT`, `SPINE_VERSION_CONFLICT` |
| 4a | `POST /projects/:id/phases/:phase/run` | FLF-198 (FLF-234: fast path B-1) | `runPhaseRequestSchema` (cùng field với endpoint 4, gồm `message?`/`intent?` — gắn với step đầu sẽ chạy) | **SSE** (mục 2) — chạy liền cả giai đoạn | như endpoint 4 — **B-1 (fast path, FLF-234)**: lượt hỏi gộp đầu giai đoạn là lượt hỏi DUY NHẤT (thấy việc của cả 6 bước; trần câu theo `project.stakes`: `internal` 2, còn lại 4); B-1.x bên trong không gọi Elicit khi không có tin user mới, có tin mới thì chỉ câu `conflict` trên chủ đề đã chốt tới user; điều không hỏi được thành giả định và được nói ở `phase_gate` cuối. Bước đầu không nhận lại tin mở giai đoạn nếu lượt hỏi gộp đã đọc nó. Lượt hỏi gộp không hỏi gì vẫn phát lời AI (`elicit`) và ghi tin mở giai đoạn + lời AI vào transcript `step: "B-1"` — dấu "đã phỏng vấn": vào lại B-1 (kể cả "Mọi bước" sau mỗi lần duyệt, hoặc chuỗi bị ngắt rồi chạy tiếp) không gọi lại lượt hỏi gộp. Câu model hỏi mà server bỏ (đã chốt, quá trần, không `conflict`) ⇒ lời AI được cắt câu hỏi đó, hoặc thay bằng lời nhận tin không có câu hỏi khi không còn câu nào |
| 4b | `GET /projects/:id/steps/:stepId/run-state` | FLF-177 | — | `runStateResponseSchema` (null nếu step chưa chạy lần nào; FLF-234: thêm `phase_gate?: object | null` — sự kiện `phase_gate` của bước cuối giai đoạn đang chờ duyệt, để dựng lại đúng cổng chốt (tin nhắn + mọi giả định cả giai đoạn) sau reload; null với bước lẻ / bước im / project cũ) | `PROJECT_NOT_FOUND` |
| 4c | `POST /projects/:id/steps/:stepId/cancel` | FLF-177 | `cancelRunRequestSchema` | `cancelRunResponseSchema` | `PROJECT_NOT_FOUND` |
| 4d | `GET /projects/:id/run-state/active` | FLF-177 | — | `runStateResponseSchema` hoặc `null` | `PROJECT_NOT_FOUND` |
| 5 | `POST /projects/:id/steps/:stepId/answer` | T13 | `stepAnswerRequestSchema` (≤ 20 answer, mỗi chuỗi ≤ 4000 ký tự; `message?` ≤ 4000 ký tự — chat tự do khi đang chờ trả lời: một lượt `elicit` (tính credit) đọc tin, chỉ chốt câu được trả lời đúng ý — câu có lựa chọn phải khớp nhãn, câu mở ghi nguyên văn tin — rồi phát lại `answer_needed` với câu còn chờ; hết ngân sách chat (chừa Draft + Review trong trần 8 lượt) thì AI tự giả định phần còn lại. `answers` được rỗng khi có `message`, thiếu cả hai ⇒ 400, FLF-221) | `{ accepted: true }`, luồng SSE của `/run` tiếp tục. Không còn luồng nghe (reload, BE restart): lượt chờ ở run-state (`waiting_answer`, cùng `session_id`, mọi `question_id` là câu đã hỏi) chạy tiếp ở nền từ sau Elicit, không hỏi lại — client theo dõi qua 4b tới `gate`/`interrupted`; lượt hỏi gộp đầu giai đoạn (`stepId` là đơn vị giai đoạn `S-4`, `S-5@S03`) chỉ ghi câu trả lời, run-state `done`, client chạy lại 4a (FLF-222) | `NOT_PIPELINE_SESSION`, `STEP_NOT_RUNNABLE` (không có lượt chờ khớp, hoặc `/answer` khác đang chạy tiếp lượt đó) |
| 6 | `POST /projects/:id/steps/:stepId/gate` | T13 | `gateRequestSchema` (`session_id` bắt buộc; `note` ≤ 2000 ký tự) | `gateResponseSchema` | `NOT_PIPELINE_SESSION`, `STEP_NOT_RUNNABLE`, `REGENERATE_LIMIT`, `CALL_LIMIT`, `NEEDS_USER_INPUT`, `INSUFFICIENT_CREDIT`, `SPINE_VERSION_CONFLICT` |
| 7 | `POST /projects/:id/changes` | T08 ✔ (`ops`) · T17 (`instruction`) | `changesRequestSchema` (`session_id?`: ghi tin `change_applied` vào phiên) | `applyResultResponseSchema` | `SPINE_VERSION_CONFLICT`, `OP_INVALID`, `INVARIANT_VIOLATION`, `NEEDS_CLARIFICATION`, `INSUFFICIENT_CREDIT`, `NOT_IMPLEMENTED`, `CHAT_SESSION_NOT_FOUND` |
| 8 | `POST /projects/:id/changes/preview` | T08 ✔ (`ops`) · T17 | `changesRequestSchema` (`session_id?` + `instruction`: model đọc 12 tin cuối phiên; lệnh và tin `change_preview`/`change_clarification`/`change_error` được ghi vào phiên) | `changesPreviewResponseSchema` (200 cả khi `ok=false`) | `SPINE_VERSION_CONFLICT`, `INSUFFICIENT_CREDIT`, `CHAT_SESSION_NOT_FOUND` |
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
| 24 | `POST /projects/:id/resume` | T13 | — | `resumeResponseSchema` `{ reverted_step, spine_version, progress }` — step `in_progress` dang dở bị revert về `pending`: revert nội dung step ghi trong vòng (kể cả phần lượt chạy lại ghi sau `last_seq`), không revert sổ sách `progress.*`, `steps[…]`, `decisions[…]`, `flags[…]`. Step đang chờ user — chờ trả lời (run-state `waiting_answer`, FLF-222) hoặc chờ duyệt ở cổng chốt (run-state `gate`, FLF-221) — không bị revert, `reverted_step: null`. Step đã rời registry (B-0.4 cũ) không revert (FLF-221) | `SPINE_NOT_FOUND`, `STEP_NOT_RUNNABLE` (step đang chạy ở request khác), `CHANGE_RANGE_INVALID`, `OP_INVALID` (`revert_conflict`), `SPINE_VERSION_CONFLICT` |
| 25 | `PATCH /projects/:id/assumptions/:assumptionId` | FLF-221 | `assumptionEditRequestSchema` `{ statement_vi, base_version }` — một lượt gọi model `translate` (tính credit) dịch sang tiếng Anh; ghi `statement` + `statement_vi` và **xác nhận** giả định (`status: "confirmed"`, `confirmed_at` giờ server) trong một transaction, model lỗi ⇒ không ghi gì | `{ spine_version, spine }` | `ASSUMPTION_NOT_FOUND` (404), `SPINE_VERSION_CONFLICT`, `INSUFFICIENT_CREDIT`, `CHANGE_REQUIRES_CR` (mode 1 sau v0) |

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

Response `Content-Type: text/event-stream`. Mỗi sự kiện có dạng `event: <type>` rồi `data: <JSON>`; phần JSON đúng `stepEventSchema` (có trường `type` trùng tên event). Luồng đóng sau `gate_ready` hoặc `error`. Nếu gặp `answer_needed`, client gửi `/answer` và giữ kết nối để nhận các sự kiện tiếp theo. Đóng kết nối (hoặc chờ quá 15 phút) trong lúc chờ trả lời **không** huỷ step: luồng đóng không kèm `error`, câu hỏi nằm ở run-state và `/answer` vẫn nhận (FLF-222). Đóng kết nối ở mọi lúc khác vẫn huỷ lượt như cũ; `POST /cancel` huỷ cả lượt đang chờ.

| `type` | Khi | `data` |
| --- | --- | --- |
| `intake` | Đầu mỗi step (từ FLF-221; trước đó chỉ khi vào phase mới): liệt kê field còn trống | `{ step_id, phase, empty_fields[] }` |
| `stage` | Runner chuyển giai đoạn (đọc → hỏi → soạn → kiểm → vẽ → duyệt) hoặc sang lô function kế | `{ step_id, stage, label_vi, detail_vi?, batch?, est_ms? }` |
| `heartbeat` | Mỗi 10 giây trong lúc chờ model/render — để FE biết lượt còn sống | `{ step_id, stage, elapsed_ms }` |
| `elicit` | Model đang hỏi/giải thích (stream chữ) | `{ step_id, delta }` |
| `answer_needed` | Cần user trả lời trước khi Draft | `{ step_id, questions[] }` — xem 2.1 |
| `answer_received` | Ngay khi `/answer` tới — trạng thái đổi luôn, không chờ lượt Draft | `{ step_id, count }` |
| `draft` | Bắt đầu một lượt Draft (kể cả retry schema) | `{ step_id, attempt }` |
| `draft_retry` | Model trả kết quả không hợp lệ, đang thử lại | `{ step_id, attempt, max, reason_vi }` — lời thường, không mã lỗi |
| `ops_applied` | Transaction của step đã ghi | `{ step_id, txn, spine_version, changes[], summary[]? }` |
| `render` | Mỗi diagram render xong | `{ step_id, diagram_id, render_status, error? }` |
| `flags` | Deterministic check chạy lại | `{ step_id, red_open, yellow_open, red_delta?, yellow_delta?, new_assumptions[]? }` — `new_assumptions[]` = `{ id, text, text_vi?, conflict? }` (`text` = `statement` EN, `text_vi` = `statement_vi`; cũng dùng ở `gate_ready`, `phase_gate`) |
| `gate_ready` | Chờ user chọn ở cổng chốt | `{ step_id, actions[], regenerate_used, calls_used, spine_version, wrote_ops, empty_sections[], summary[]?, new_assumptions[]?, flags?, duration_ms?, credits_used?, doc_progress?, no_change_reason?, message_vi?, auto? }` — `auto: true` (FLF-234) = bước chạy trong `phases/:phase/run` mà server tự Accept ngay (bước im): KHÔNG phải cổng chờ user, FE không dựng thẻ cổng/chip; run-state của bước là `done`, không `gate`. Thiếu ⇒ cổng thật. Trước đó:  `message_vi` (FLF-232) là tin nhắn AI của cổng, 2–4 câu bằng ngôn ngữ user (tóm những gì vừa làm, điều AI đang tạm hiểu, lời mời duyệt), lấy từ `notes` của lượt Draft (điều trong `new_assumptions[]` mà `notes` chưa nhắc thì server nối thêm một câu nói nó); thiếu `notes` thì dựng tất định từ `summary[]`. **`new_assumptions[]` của cổng chính là danh sách mà `message_vi` đã nói ra** — chip "Đúng rồi" chỉ nên xác nhận đúng các id này; thiếu hẳn ở project cũ ⇒ client tự dựng như trước; `spine_version` là version CUỐI của lượt chạy, cao hơn `ops_applied` vì render + recompute cờ chạy sau (L11); `wrote_ops=false` nghĩa là model trả lô op rỗng; `empty_sections[{section_id,title}]` là mục step nuôi mà chạy xong vẫn trống, accept cũng không đóng được cờ `section_empty` (L11b) |
| `auto_accepted` | Step "yên lặng" được tự Accept (chế độ duyệt "Cuối giai đoạn": `fast`, hoặc `balanced` xử lý như `fast`) | `{ step_id, reason_vi }` |
| `phase_gate` | Cổng chốt cuối giai đoạn: tóm tắt cả giai đoạn, gồm cả bước đã tự Accept | `{ step_id, phase, reason_vi, summary[], new_assumptions[], steps[], flags?, message_vi? }` — `message_vi` (FLF-232) = tin của bước cuối + MỌI điều còn tạm hiểu của giai đoạn (kể cả bước tự Accept), không giới hạn số lượng, ghép tại server, không gọi thêm model. `new_assumptions[]` của `phase_gate` = đúng các giả định còn `unconfirmed` của giai đoạn mà `message_vi` đã nói ra (không còn danh sách giả định đã xác nhận/bác bỏ). B-1 (FLF-234): `review_mode` "Cuối giai đoạn" có đúng một `phase_gate` ở B-1.6, dựng từ Spine nên vẫn nói đủ giả định của B-1.1…B-1.5 kể cả khi chuỗi từng dừng rồi chạy tiếp; "Mọi bước" dừng ở từng B-1.x với tin cùng kiểu, không Elicit ở B-1.x và không gọi lại lượt hỏi gộp khi vào lại giai đoạn |
| `phase_progress` | Chạy liền cả phase: đang ở step thứ mấy | `{ step_id, phase, step_index, step_total, needs_user }` |
| `error` | Dừng step | `{ step_id, code, message, retryable }` — `code` thuộc bảng 0.3 |

Gate (`accept` · `revision` · `regenerate` · `accept_as_is`):
- Trần **8 lượt gọi model/step** và **3 lần Regenerate/step**.
- `accept_as_is` chỉ có trong `actions[]` khi đã hết Regenerate, hoặc khi `revision` không giải quyết được. Hành động này bắt buộc `note`.
- Refund do `SPINE_VERSION_CONFLICT` **không** tính vào trần Regenerate.
- `revision` (FLF-232): lời sửa của user có thể đổi hoặc bác bỏ một giả định đang hiện ở cổng. Server nhận, trong CÙNG một lô, `set` trường thật tại `assumptions[id].path` + `statement`/`statement_vi` mới + `status` (`confirmed`, hoặc `rejected` khi bỏ giả định); `confirmed_at` do server đặt. Lô đổi câu giả định mà không ghi trường thật của nó bị từ chối (`assumption_path_mismatch`, retry như op sai). Response của `revision` có thêm `message_vi?` = lời AI xác nhận điều vừa sửa.

### 2.1 `Question` trong `answer_needed`

Theo mẫu AskUserQuestion: mặc định AI hỏi bằng văn xuôi (câu **không** có `options`, user trả lời bằng ô chat);
chỉ đưa lựa chọn khi thật sự cần user quyết.

```json
{ "id": "Q1", "text": "Hệ thống cần sẵn sàng tới mức nào?", "header": "Uptime", "multiple": false,
  "options": [
    { "label": "99.9% (Khuyến nghị)", "description": "Chuẩn SaaS; cần 2 máy chủ dự phòng" },
    { "label": "99%", "description": "Rẻ hơn; chấp nhận ~7 giờ gián đoạn/tháng" }
  ] }
```

- `header` ≤ 12 ký tự (nhãn tab); `options` 2–4 phần tử `{ label, description?, preview? }`; `preview` là chuỗi monospace so bố cục màn/cấu trúc bảng.
- Server ép luật, không tin prompt: tối đa **4 câu/lượt**; câu còn 1 option ⇒ thành câu mở; > 4 option ⇒ cắt; bỏ option model tự viết kiểu "Khác"/"Other"; `header` cắt ≤ 12.
- Phương án khuyến nghị đứng đầu, `label` có đuôi ` (Khuyến nghị)` (project EN: ` (Recommended)`). "Khác…" **không** nằm trong `options` — client tự thêm.
- `inline` (FLF-232, tuỳ chọn, chỉ với câu không có `options`): câu mở AI đã hỏi ngay trong lời (`elicit.delta`); client không vẽ thẻ cho câu này — user vẫn trả lời bằng ô chat, server vẫn theo dõi qua `topic_key`. Thiếu ⇒ `false` (client cũ vẽ như câu mở thường).
- `id` ổn định theo chủ đề: `Q_<topic_key>` (FLF-221; câu không có chủ đề vẫn `Q<n>`). Server vẫn nhận `Q<n>` theo vị trí cho lượt chờ lưu trước đó.
- Tương thích ngược: `options` có thể là `string[]` ở run-state `waiting_answer` lưu trước 2026-09-27; client đọc cả hai dạng.
- `POST /answer` không đổi: `answer` là `label` đã chọn (không kèm đuôi khuyến nghị — server vẫn tự bỏ đuôi này khi ghi `decisions`) hoặc chữ user gõ.

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
| 2026-09-27 | contract-change FLF-220 | `Question` (sự kiện `answer_needed`, `run-state.questions`) thêm `header` (≤ 12 ký tự); `options` thành `{ label, description?, preview? }[]` (vẫn nhận `string[]` cũ khi đọc). Server tối đa 4 câu/lượt, 2–4 option/câu, bỏ option "Khác" do model viết. `project.working_mode` giữ trong schema nhưng không còn được đọc; `review_mode` `balanced` xử lý như `fast` ("Cuối giai đoạn") |
| 2026-09-28 | FLF-222 (hành vi, không đổi shape) | Lượt chờ trả lời sống qua reload/rớt kết nối/BE restart: `/answer` chạy tiếp từ run-state khi không còn luồng nghe; `/resume` bỏ qua step đang chờ và chỉ revert nội dung của step (hết 422 `revert_conflict` khi lượt chạy lại chết giữa chừng / sau gate revision). `step_runs` thêm field nội bộ `pending_answer` (không trả qua 4b/4d) |
| 2026-09-28 | contract-change FLF-221 | `step-registry.json` bỏ B-0.4 "Cách làm việc" (chỉ ghi `working_mode` đã nghỉ) ⇒ `50 + 5 × N` step; project cũ còn B-0.4 trong `steps[]`/run-state vẫn mở được: không tính tiến độ, không dựng lại cổng (`/run-state/active` bỏ qua), `/resume` không revert. `reads`/`writes` B-0…B-2 thu hẹp theo field của từng step (`reads` dùng selector `project:a,b`, `writes` dạng dot-path, vd B-0.2 chỉ `project.form_factor`); step cuối mỗi giai đoạn giữ `writes` rộng cho revision ở phase gate. `assumptions[]` thêm `statement_vi` (tuỳ chọn); `new_assumptions[]` của `flags`/`gate_ready`/`phase_gate` thêm `text_vi?`. `/run` và `/phases/:phase/run` thêm `message?`, `intent?: "no_idea"`; `/answer` thêm `message?` (được gửi `answers: []`). Endpoint mới 25 `PATCH /assumptions/:assumptionId` + `call_kind` `translate`. `intake` phát ở mọi step; `run-state.events` lưu cả `stage` và mỗi sự kiện kèm `at` (ISO) |
| 2026-09-28 | contract-change ERD Chen | `entities[]` thêm `relation_verbs` (tuỳ chọn, `{ <id trong relations>: "<động từ viết thường>" }`, vd `{ "E02": "contains" }`) và `relation_cardinality` (tuỳ chọn, `{ <id>: "1" | "N" }`, bản số phía con, thiếu ⇒ `N`), `relation_optional` (tuỳ chọn, mảng id con có liên kết tuỳ chọn tới cha), `root` (tuỳ chọn, `true` = dữ liệu chủ được phép không có cha); Spine cũ vẫn hợp lệ, không migrate. `step-registry.json` S-4.5 `reads` thêm `project:name,system_name,release_scope`, `actors:id,name,kind`, `use_cases:id,name`, `screens:id,name`, `functions:id,name,screen_id,description`, `assumptions[origin_step_id=S-4.5]:id,path,statement,status`, `business_rules:id,statement` (có khi S-4.5 chạy lại sau S-7.1 — bằng chứng bản số). Sơ đồ `erd` chuyển sang ký pháp Chen (`@startchen`, hình thoi chứa động từ, thiếu ⇒ `has`). Luật cờ mới: `orphan_entity` (ERD phải liên thông), `unresolved_many_to_many` (vàng, waive được, chờ S-4.5), `orphan_entity_at_baseline` (đỏ, waive được, chỉ ở S-9; mode 1 loại) |
| 2026-09-28 | contract-change (sửa tài liệu qua chat có lịch sử) | `changesRequestSchema` thêm `session_id?` (endpoint 7, 8): lệnh sửa đọc đuôi hội thoại (12 tin) của phiên, và lượt sửa được ghi vào phiên như tin nhắn — tin AI `kind` `change_preview`/`change_clarification`/`change_error`/`change_applied` (mới). Skill `apply-change-op` 1.2.0 thêm `{{chat_history}}`. Không gửi `session_id` ⇒ hành vi cũ |
| 2026-09-30 | FLF-231 (hành vi, không đổi shape) | `PATCH /assumptions/:assumptionId` xác nhận luôn giả định đã sửa. Transcript: tin user của lượt trả lời trên thẻ chỉ còn đáp án (mỗi đáp án một dòng); lượt hỏi đầu giai đoạn ghi một bản `{reply, questions}`. `addendum[].captured_at` của op model do server đặt |
| 2026-09-30 | contract-change FLF-232 | Additive: `gate_ready.message_vi?`, `phase_gate.message_vi?` (tin nhắn AI của cổng), `Question.inline?` (câu mở đã hỏi trong lời AI), `gateResponseSchema.message_vi?` (lời AI sau `revision`). Hành vi: `revision` được đổi `status` giả định và sửa `statement`, kèm luật `assumption_path_mismatch`; `project.system_name` chỉ được hỏi ở B-2.3 (B-0.1 hỏi `form_factor` + `stakes` bằng một lượt hai thẻ); prompt hỏi tối đa 2 câu/lượt (trần server vẫn 4). Vòng sửa 1: `new_assumptions[]` của `gate_ready`/`phase_gate` = điều `message_vi` đã nói (chip xác nhận đúng danh sách này); `revision` chỉ đổi `status` của giả định trong danh sách đó và được ghi `path` thật của chúng dù ngoài `writes` của bước; `gateResponse.message_vi` luôn có khi revision đã ghi op; `Question.inline` được giữ trong transcript; `system_name_missing` trỏ B-2.3. Project cũ: `gate_ready` không có `message_vi`, câu hỏi không có `inline`, project đã qua B-0.1 vẫn chạy. |
| 2026-09-30 | contract-change FLF-233 | `step-registry.json`: B-1.1 `writes` bỏ `project.vision`, `project.goals` (còn `addendum`, `other_requirements`, `assumptions`); S-1.1 `writes` thêm `addendum` (server chỉ cho entry `topic` `vision`/`goals`, ngoài đó `op_out_of_scope`) và `description` mới. Brief ghi tầm nhìn thành 1 entry addendum `topic: vision`, mỗi mục tiêu thành 1 entry `topic: goals`, `target_section: fixed:1`, `content` ngôn ngữ user, `content_en` tiếng Anh; không đổi shape Spine. Step `B-*` (op-validator) và `POST /changes` khi `current_phase` là `B-*` ghi `project.vision`/`project.goals` ⇒ 422 `path_not_writable`. S-1.1 luôn dựng `project.vision` + `project.goals` (EN, 1:1 với entry `goals` theo thứ tự id) khi có addendum lõi: lô `draft`/`regenerate` (và `revision` có đụng addendum) thiếu `set project.vision` hoặc `set project.goals` đủ số mục ⇒ lỗi `brief_extraction_incomplete`, tính vào vòng retry của bước; project cũ không có addendum lõi giữ hành vi cũ. S-1.1 thuộc `ALWAYS_GATE` (luôn dừng ở cổng, kể cả khi chạy liền giai đoạn, mọi `review_mode`) và `gate_ready.table` (shape sẵn có) có cột `Mục` · `Brief của bạn` · `Bản đưa vào SRS` (dòng Tầm nhìn + Mục tiêu 1…n). Op engine: một lô đổi `addendum[]` khi `steps[id=S-1.1].status = accepted` tự thêm `set steps[id=S-1.1].status = revision_requested` (phủ gate revision, mở lại bước, `/changes`; không áp cho op `migrate`). Cờ `non_english_content` của `project.vision`/`goals` có `remediation_step` S-1.1. Vòng sửa 1: chặn Brief chỉ áp khi giá trị `project.vision`/`goals` ĐỔI (`set project` cả object giữ nguyên hai field, null/[] thì qua) và chạy trước check `writes` để message luôn chỉ sang addendum; với `project` mới (`current_phase` null, chưa step accepted) `/changes` cũng bị chặn. `project.vision`/`goals` không bao giờ là field "thiếu" (`empty_fields`/`missing`) của step `B-*`. Giả định Brief trỏ `addendum[id=…]` (topic vision/goals); giả định cũ có `path` `project.vision|goals` được sửa ở Brief bằng `set addendum[id=…].content(_en)` cùng topic (thoả `assumption_path_mismatch`). S-1.1 chỉ đòi `set project.vision` khi có entry `vision` và `set project.goals` khi có entry `goals`; mọi lô S-1.1 đặt `project.goals` (draft, regenerate, revision) bị so 1:1 với entry `goals` sau lô. Mục tiêu 1:1 theo thứ tự mảng `addendum[]` (id server cấp tăng dần, entry mới nối cuối, nên trùng thứ tự số của id; FE dùng cùng luật). Quyết định: MỌI thay đổi `addendum[]` (kể cả `/changes` ở pha S-*, không chỉ entry lõi) khi S-1.1 đã `accepted` đều đặt S-1.1 `revision_requested`. |
| 2026-09-30 | FLF-234 (hành vi, không đổi shape) | Không thêm field/endpoint. Vòng sửa 1: lượt hỏi gộp không hỏi gì ghi tin mở giai đoạn + lời AI vào transcript `step: "B-1"` (không gọi lại khi vào lại giai đoạn; mọi B-1.x đọc được tin mở), biến prompt `elicit_policy` / `fast_path` (luật fast path chỉ vào prompt của B-1), lời AI không còn nêu câu hỏi server đã bỏ. Fast path cho giai đoạn B-1: `runStep` bỏ Elicit ở B-1.x khi lượt chạy không mang tin user (0 lượt gọi model, không tin AI, không `elicit_turns_this_phase`); có tin user thì Elicit chạy nhưng server chỉ giữ câu có `conflict` trên chủ đề đã có trong sổ quyết định; lượt chờ trả lời cũ (`/answer`) chạy tiếp như trước. Lượt hỏi gộp của B-1 nhận projection hợp + việc từng bước, `max_questions` và trần server theo `project.stakes` (`internal` 2, còn lại 4); giai đoạn khác giữ nguyên. Bước đầu không nhận lại tin mở giai đoạn khi lượt hỏi gộp đã gọi model với tin đó. `conflictsWithLedger` xét cả `text_vi`. `phase_gate.message_vi` / `new_assumptions[]` không đổi (FLF-232/233 đã dựng từ Spine). Project cũ: không migration. |
| 2026-09-30 | contract-change FLF-234 vòng sửa 2 | Additive: `runStateResponseSchema.phase_gate?` (sự kiện `phase_gate` của bước cuối giai đoạn, ghi vào run-state để cổng chốt cuối giai đoạn sống qua reload / SSE gãy); `gate_ready.auto?` (bước im trong `phases/:phase/run`: run-state `done`, không còn trạng thái `gate` / thẻ cổng có chip). Hai field tuỳ chọn, project cũ và lượt `/run` lẻ không đổi. |
