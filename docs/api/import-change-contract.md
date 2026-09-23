# Import + Change Request API contract (mode 1)

> **Trạng thái:** FLF-171 (plan mode 1, P1 §5.6). **Đã đóng băng 2026-09-18** (nhóm chốt). Từ nay mọi thay đổi phải qua PR nhãn `contract-change` được 4/4 duyệt, và sửa các file zod bên dưới trong cùng PR.
> **Nguồn:** `claude_plan/plan-mode1-import-edit-srs.md` §1–§5, `doc/flintflow-business-flow (1).bpmn` (Flow 1, 3, 4, 5, 6), `doc/actors-and-use-cases.md`.
> **Schema zod:** `src/modules/import/import.dto.ts`, `src/modules/doc-version/doc-version.dto.ts`, `src/modules/change-request/change-request.dto.ts`, `src/modules/project/project.validation.ts`; mã lỗi `src/modules/import/mode1.errors.ts`; đầu ra AI `src/shared/ai/response-parser.ts` (`importExtract`, `findings`, `crClarify`, `crPropose`).
> **Hiện thực:** P2 (BE), P3 (FE). Trước khi P2 merge, FE mock bằng msw theo đúng hình ở đây (`flintflow_fe/mocks/mode1/handlers.ts`).

> **⚠ Mode 1 v2 (FLF-181/182, 2026-09-19):** hướng mode 1 đổi — Spine là nguồn sự thật, workspace như mode 2, step theo template người dùng, CR sau baseline v1. Phần thay đổi hợp đồng ở **§4** (contract-change, chờ 4/4). Các quy ước G2/G3/BR-03 bên dưới được thay theo §4 khi V1–V4 hiện thực xong.

## 0. Quy ước chung

- Giống `pipeline-contract.md` §0: base URL `/api/v1`, Bearer token, envelope `{ data, meta?, error }`. Project không thuộc user trả `404 PROJECT_NOT_FOUND`.
- Mọi endpoint ở đây chỉ dùng cho project `mode = "import"`. Gọi trên project mode khác trả `409 PROJECT_MODE_MISMATCH` `{ mode, expected: "import" }`.
- **Nguồn sự thật là file .docx + bảng block** (G2). Spine chỉ là chỉ mục: request nào ghi Spine (finalize, quyết định group cuối, release) thì mang `base_version` như pipeline.
- **Neo block** (G3): mỗi block có `block_id` ổn định (`B0001`…), neo bằng bookmark ẩn `_ff_<block_id>` trong file lưu, neo phụ `w14:paraId`, dự phòng `text_hash` + `heading_path`.
- **Version tài liệu** (G4): import `0.0`; mỗi CR ghi xong lên minor (`0.1`, `0.2`…); release lên major (`1.0`, `2.0`…). Khác `v1.N` của mode 2.
- **BR-03:** khi đã có baseline v0 thì mọi sửa phải qua CR. Ở project mode 1, chat ra lệnh sửa, `POST /changes`, `POST /reconcile` và `POST /undo` đều trả `409 CHANGE_REQUIRES_CR` (G9). Mode 1 v3 (§4.8): không tự tạo CR, không chạy step, không ký baseline v1, không waive cờ.
- **Gọi AI** (Flow 4/5): giữ credit trước, quyết toán sau. Lỗi AI thì tự retry 2 lần; vẫn lỗi thì hoàn credit và đặt `paused: { reason: "resume_later" }`. Hết credit thì đặt `paused: { reason: "credits" }`. Resume qua endpoint `…/resume`. `step_id` trong usage (UC-79): `I-4:<section_id>`, `I-1.11`, `C-2:<cr_id>`, `C-4:<cr_id>`, `C-5:<cr_id>`.

### 0.1 Máy trạng thái import (`import.state.ts`)

```
uploaded ─┬─ preflight_rejected
          ├─ awaiting_latest_confirm ─► parsing
          └─ parsing ─► mapping_review? ─► extracting ─► fields_review? ─► baselining ─► checking ─► gap_review ─► delivered | change_requested
delivered ─► change_requested
```

`paused` chỉ đặt được ở `extracting` và `checking`. Chuyển trạng thái sai trả `409 IMPORT_INVALID_STATE` `{ status, to, allowed }`.

### 0.2 Máy trạng thái change request (`change-request.state.ts`)

```
draft ─► clarifying ⇄ awaiting_answers
clarifying ─► impact_review ─► proposing ─► verifying ─┬─► ready_to_submit ─► in_review ─┬─► written
                                                      ├─► proposing (AI làm lại, ≤ 2)  ├─► proposing (revise)
                                                      └─► manual_fix ─► verifying      └─► rejected (close)
ready_to_submit ─► verifying (sửa đề xuất sau khi đã đạt)
mọi trạng thái chưa kết thúc ─► cancelled
```

- `paused` chỉ đặt được ở `clarifying`, `proposing`, `verifying`.
- CR giữ khoá block từ `impact_review` tới `in_review`. Group bị từ chối được mở khoá ngay; mọi khoá được mở khi CR `written`, `rejected` hoặc `cancelled`.
- Làm rõ tối đa 3 vòng. Chuyển trạng thái sai trả `409 CR_INVALID_TRANSITION`.

### 0.3 Lỗi riêng mode 1 (`mode1.errors.ts`)

| HTTP | `code` | Khi | `meta` |
| --- | --- | --- | --- |
| 400 | `CR_SOURCE_REQUIRED` | Tạo CR thiếu `source` hoặc `requester` | — |
| 404 | `IMPORT_NOT_FOUND` · `DOC_VERSION_NOT_FOUND` · `CR_NOT_FOUND` · `CR_LOCATION_NOT_FOUND` · `CR_GROUP_NOT_FOUND` | Không tồn tại / không thuộc project | — |
| 409 | `PROJECT_MODE_MISMATCH` | Gọi API mode 1 trên project mode khác | `{ mode, expected }` |
| 409 | `IMPORT_NEEDS_LATEST_CONFIRM` | Gọi bước sau khi file không có stamp mà user chưa xác nhận "bản mới nhất" (1.3) | `{ import_id }` |
| 409 | `IMPORT_INVALID_STATE` | Hành động không hợp lệ với trạng thái import hiện tại | `{ status, to, allowed[] }` |
| 409 | `CR_REQUIRES_BASELINE` | Tạo CR khi chưa có baseline v0 | — |
| 409 | `CR_INVALID_TRANSITION` | Hành động không hợp lệ với trạng thái CR | `{ status, to, allowed[] }` |
| 409 | `PATH_LOCKED` (FLF-186, thay `BLOCK_LOCKED`) | CR cần khoá phần tử Spine đang bị CR khác giữ (3.5), hoặc sửa tay vị trí không thuộc CR | `{ locked: [{ path, cr_id }] }` |
| 409 | `CR_NO_OWNER_STEP` | 3.9 sửa trong step sở hữu (§4.9) cho vị trí thuộc mục riêng (`custom:*`) | `{ location_id }` |
| 409 | `CR_LOCATION_UNCONCLUDED` | Nộp CR khi còn vị trí chưa có kết luận | `{ location_ids[] }` |
| 409 | `CR_VALUE_CHANGED` (FLF-186, thay `CR_OLD_TEXT_MISMATCH`) | Giá trị phần tử tại `path` đã đổi so với `proposal.old_text` (verify hoặc ghi) | `{ location_id, path }` |
| 409 | `CHANGE_REQUIRES_CR` | Chat sửa / `POST /changes` / `POST /reconcile` / `POST /undo` ở project mode 1 đã có baseline v0 (§4.8) | `{ prefill: { title, description, source?: { kind, ref } } }` — nội dung điền sẵn cho form 3.1; BE không tạo CR |
| 409 | `MODE1_NO_STEPS` · `MODE1_NO_SIGNOFF` · `MODE1_NO_WAIVE` | Project mode 1: chạy step / trả lời step / gate / resume pipeline / `PATCH step-plan` · `POST /baseline` · waive cờ (§4.8) | — |
| 422 | `IMPORT_FILE_REJECTED` | Preflight từ chối file (1.2); bản ghi import vẫn được tạo với `status = preflight_rejected` | `{ import_id, issues[] }` |
| 422 | `IMPORT_STAMP_FOREIGN_PROJECT` | File mang stamp của project khác | `{ stamp }` |
| 422 | `IMPORT_REUPLOAD_NO_STAMP` | Re-upload (#11) file không mang stamp của project (§4.8) | — |
| 422 | `RELEASE_RED_FLAGS_OPEN` | Release khi còn cờ đỏ (BR-04, mode 1 không waive) | `{ flags[] }` |

Mã chung vẫn dùng như pipeline: `400 VALIDATION_ERROR`, `401 UNAUTHORIZED`, `402 INSUFFICIENT_CREDIT` (`{ required, balance }`), `404 PROJECT_NOT_FOUND`, `409 SPINE_VERSION_CONFLICT`, `501 NOT_IMPLEMENTED`.

`issues[]` của preflight là `{ code, message, location? }`, với `code` ∈ `NOT_DOCX`, `CORRUPT_ZIP`, `LEGACY_DOC`, `FILE_ENCRYPTED`, `FILE_TOO_LARGE`, `EMPTY_DOCUMENT`, `FOREIGN_TRACK_CHANGE`, `FOREIGN_COMMENT`. Loại file nhận theo magic bytes, không theo đuôi (spike P0 §4.6). Track Changes/comment có author khớp `^CR-\d{3,}$` (do FlintFlow ghi) được chấp nhận.

## 1. Endpoint

| # | Method + path | UC / nút | Request | Response `data` | Lỗi riêng |
| --- | --- | --- | --- | --- | --- |
| 1 | `POST /projects` | UC-13 | `{ name, domain?, mode? }` — `mode` ∈ `import \| fpt \| customer_template`, mặc định `fpt` | `Project` (thêm `mode`, `import_state`) | `VALIDATION_ERROR`, `501 NOT_IMPLEMENTED` (`customer_template`) |
| 2 | `POST /projects/:id/import` | UC-20, 1.1–1.2 | multipart, field `file` (.docx ≤ 10MB) | `importStateResponseSchema` | `IMPORT_FILE_REJECTED`, `IMPORT_STAMP_FOREIGN_PROJECT`, `IMPORT_INVALID_STATE` (đã có baseline ⇒ dùng `/reupload`) |
| 3 | `POST /projects/:id/import/confirm-latest` | 1.3 | `confirmLatestRequestSchema` | `importStateResponseSchema` | `IMPORT_INVALID_STATE` |
| 4 | `GET /projects/:id/import` | UC-19 | — | `getImportResponseSchema` | — |
| 5 | `PATCH /projects/:id/import/mapping` | UC-21, 1.7 | `mappingPatchRequestSchema` | `importStateResponseSchema` | `IMPORT_INVALID_STATE`, `IMPORT_NEEDS_LATEST_CONFIRM` |
| 6 | `POST /projects/:id/import/extract` | 1.8 | `extractRequestSchema` | `extractResponseSchema` — **trả ngay** (`status = extracting`, `paused = null`), I-4 chạy nền; FE poll #4 tới khi rời `extracting` hoặc có `paused` | `IMPORT_INVALID_STATE` |
| 7 | `PATCH /projects/:id/import/fields` | UC-22, 1.9 | `fieldsPatchRequestSchema` | `importStateResponseSchema` | `IMPORT_INVALID_STATE` |
| 8 | `POST /projects/:id/import/finalize` | 1.10–1.12 | `finalizeRequestSchema` | `finalizeResponseSchema` | `IMPORT_INVALID_STATE`, `SPINE_VERSION_CONFLICT`, `INSUFFICIENT_CREDIT` |
| 9 | `GET /projects/:id/gap-report?format=json\|docx` | UC-23, 1.13 | `gapReportQuerySchema` | `gapReportSchema`; `docx` trả file, không bọc envelope | `IMPORT_INVALID_STATE` (chưa tới `gap_review`) |
| 10 | `POST /projects/:id/import/resume` | UC-61, UC-75 | `importResumeRequestSchema` | `extractResponseSchema` — ở `extracting`: trả ngay, chạy nền như #6; ở `checking`: chạy xong mới trả | `IMPORT_INVALID_STATE` |
| 11 | `POST /projects/:id/reupload` | UC-24, 1.4 | multipart như #2 | `reuploadDiffDtoSchema` — **không** tạo version | `IMPORT_FILE_REJECTED`, `IMPORT_STAMP_FOREIGN_PROJECT`, `IMPORT_INVALID_STATE` (chưa có baseline) |
| 12 | `GET /projects/:id/versions` | UC-54 | — | `DocVersion[]`, mới nhất trước | — |
| 13 | `GET /projects/:id/versions/:v/blocks` | UC-54 | — | `DocBlock[]` theo thứ tự tài liệu; bản draft có `revisions[]` | `DOC_VERSION_NOT_FOUND` |
| 14 | `GET /projects/:id/versions/:v/download?variant=auto\|tracked` | UC-57 | `downloadQuerySchema` | file `.docx`: release ⇒ bản sạch; draft ⇒ Track Changes + watermark DRAFT, tên `…_v0.2_DRAFT.docx` | `DOC_VERSION_NOT_FOUND` |
| 15 | `GET /projects/:id/versions/compare?from=&to=` | UC-55 | `compareQuerySchema` | `compareResponseSchema` | `DOC_VERSION_NOT_FOUND`, `VALIDATION_ERROR` |
| 16 | `POST /projects/:id/change-requests` | UC-48, 3.1 | `createChangeRequestSchema` | `changeRequestDetailSchema` (`status = draft`) | `CR_SOURCE_REQUIRED`, `CR_REQUIRES_BASELINE` |
| 17 | `GET /projects/:id/change-requests?status=` | UC-48 | `listChangeRequestsQuerySchema` | `ChangeRequest[]`, mới nhất trước | — |
| 18 | `GET /projects/:id/change-requests/:crId` | UC-48 | — | `changeRequestDetailSchema` | `CR_NOT_FOUND` |
| 19 | `POST …/:crId/clarify` | UC-49, 3.2 | `{}` | `changeRequestDetailSchema` (`awaiting_answers` kèm `pending_questions`, hoặc `impact_review`) | `CR_INVALID_TRANSITION`, `INSUFFICIENT_CREDIT` |
| 20 | `POST …/:crId/answers` | UC-49, 3.3 | `answersRequestSchema` | `changeRequestDetailSchema` (chạy lại C-2) | `CR_INVALID_TRANSITION`, `VALIDATION_ERROR` (số câu trả lời ≠ số câu hỏi) |
| 21 | `POST …/:crId/impact` | UC-50, 3.4–3.5 | `{}` | `changeRequestDetailSchema` (`locations[]`, phần tử đã khoá) | `PATH_LOCKED`, `CR_INVALID_TRANSITION` |
| 22 | `POST …/:crId/propose` | UC-81, 3.6 | `{}` | `changeRequestDetailSchema` (`groups[]`) | `CR_INVALID_TRANSITION`, `INSUFFICIENT_CREDIT` |
| 23 | `PATCH …/:crId/locations/:locId` | UC-81, 3.9 | `patchLocationRequestSchema` | `changeRequestDetailSchema` (vị trí `manual = true`) | `CR_LOCATION_NOT_FOUND`, `CR_INVALID_TRANSITION` |
| 24 | `POST …/:crId/verify` | UC-82, 3.7–3.8 | `{}` | `changeRequestDetailSchema` (`ready_to_submit`, `proposing` hoặc `manual_fix`) | `CR_INVALID_TRANSITION`, `CR_VALUE_CHANGED`, `INSUFFICIENT_CREDIT` |
| 25 | `POST …/:crId/submit` | UC-51, 3.11 | `{}` | `changeRequestDetailSchema` (`in_review`) | `CR_LOCATION_UNCONCLUDED`, `CR_INVALID_TRANSITION` |
| 26 | `POST …/:crId/groups/:gid/decision` | UC-52, 3.12–3.14 | `groupDecisionRequestSchema` | `changeRequestDetailSchema`; khi group cuối được quyết mà có group duyệt ⇒ `written` kèm `result_doc_version` | `CR_GROUP_NOT_FOUND`, `CR_INVALID_TRANSITION`, `CR_VALUE_CHANGED`, `SPINE_VERSION_CONFLICT` |
| 27 | `POST …/:crId/revise` | UC-52 | `{}` | `changeRequestDetailSchema` (khoá lại phần tử, về `proposing`) | `PATH_LOCKED`, `CR_INVALID_TRANSITION` |
| 28 | `POST …/:crId/close` | 3.13 | `closeRequestSchema` | `changeRequestDetailSchema` (`rejected`) | `CR_INVALID_TRANSITION` |
| 29 | `POST …/:crId/cancel` | UC-53, 3.10 | `closeRequestSchema` | `changeRequestDetailSchema` (`cancelled`, mở khoá) | `CR_INVALID_TRANSITION` |
| 30 | `POST …/:crId/resume` | UC-75 | `{}` | `changeRequestDetailSchema` | `CR_INVALID_TRANSITION`, `INSUFFICIENT_CREDIT` |
| 31 | `POST /projects/:id/release` | Flow 6 | `releaseRequestSchema` | `releaseResponseSchema` | `RELEASE_RED_FLAGS_OPEN`, `SPINE_VERSION_CONFLICT` |

Mọi endpoint còn có thể trả `401 UNAUTHORIZED`, `404 PROJECT_NOT_FOUND`, `400 VALIDATION_ERROR`, `409 PROJECT_MODE_MISMATCH`.

Endpoint pipeline bị ảnh hưởng ở project mode 1 (không đổi hình, chỉ thêm nhánh lỗi): `POST /changes`, `POST /changes/preview`, `POST /reconcile`, `POST /undo` và chat ra lệnh sửa đều trả `409 CHANGE_REQUIRES_CR`. `POST /baseline` (S-9.5) không dùng cho mode 1: baseline mode 1 do #8 và #31 tạo.

## 2. Ví dụ

### 2.1 Upload bị từ chối (#2)

```http
POST /api/v1/projects/66f0…02/import
Content-Type: multipart/form-data; boundary=…   (file = SRS_Lumen.docx)
```

```json
{
  "data": null,
  "meta": {
    "import_id": "66f0…01",
    "issues": [
      { "code": "FOREIGN_TRACK_CHANGE", "message": "Track Changes (ins) của \"Nguyen Van A\" chưa được Accept/Reject", "location": { "block_ord": 5, "text": "3.2.5 Create SRS project" } },
      { "code": "FOREIGN_COMMENT", "message": "Comment của \"Nguyen Van A\" chưa được xử lý", "location": { "block_ord": 6, "text": "3.2.6 View list of SRS projects" } }
    ]
  },
  "error": { "code": "IMPORT_FILE_REJECTED", "message": "File chưa nhập được: còn Track Changes/comment của người khác" }
}
```

### 2.2 Xác nhận mapping (#5)

```json
{
  "import_id": "66f0…01",
  "headings": [
    { "block_id": "B0012", "section_id": "fixed:2.1" },
    { "block_id": "B0040", "section_id": "unmapped" }
  ],
  "tables": [{ "block_id": "B0020", "column_index": 3, "field_path": null }],
  "confirm_all": true
}
```

→ `200 { "data": { "import": { "status": "extracting", … } } }`

### 2.3 Trích field bị dừng vì hết credit (#6)

```json
{
  "data": {
    "import": { "status": "extracting", "paused": { "reason": "credits", "at": "2026-09-18T08:10:00.000Z" }, "extract_cursor": "fixed:3.1.2", … },
    "sections": [
      { "section_id": "fixed:1", "status": "done", "fields_total": 6, "fields_needing_review": 1, "error": null },
      { "section_id": "fixed:2.1", "status": "done", "fields_total": 4, "fields_needing_review": 0, "error": null },
      { "section_id": "fixed:3.1.2", "status": "pending", "fields_total": 0, "fields_needing_review": 0, "error": null }
    ]
  },
  "error": null
}
```

Trạng thái trên là kết quả **poll #4** sau khi job nền dừng vì hết credit (#6 trả ngay `extracting` + `paused: null`). Nạp credit rồi gọi #10 để chạy tiếp từ `fixed:3.1.2`; section đã `done` không bị trích lại. Máy chủ khởi động lại giữa chừng ⇒ lần gọi #4 kế tiếp thấy import `extracting` không có job và đặt `paused: { reason: "resume_later" }` để FE hiện nút tiếp tục.

### 2.4 Finalize (#8)

Request `{ "import_id": "66f0…01", "base_version": 3 }` →

```json
{
  "data": {
    "import": { "status": "gap_review", … },
    "doc_version": "0.0",
    "baseline": { "id": "BL001", "version": "0.0", "type": "imported", "doc_version": "0.0", "at": "2026-09-18T08:20:00.000Z", "snapshot_ref": "66f0…09", "checked_at_version": 4, "waived_count": 0 },
    "spine_version": 4,
    "flags": { "red": 1, "yellow": 6 }
  },
  "error": null
}
```

### 2.5 Tạo CR (#16) và khoá bị trùng (#21)

```json
{
  "title": "Đăng xuất mọi thiết bị",
  "description": "Logging out must sign the user out of all devices, not only the current browser.",
  "source": { "kind": "stakeholder_email", "ref": "Email PM 2026-09-17" },
  "requester": "PM Lan"
}
```

→ `201`, `change_request.cr_id = "CR-001"`, `status = "draft"`.

Nếu CR-002 cần block `B0005` mà CR-001 đang giữ:

```json
{ "data": null, "meta": { "locked": [{ "path": "nfrs[id=NFR-01]", "cr_id": "CR-001" }] }, "error": { "code": "PATH_LOCKED", "message": "nfrs[id=NFR-01] đang được CR-001 sửa" } }
```

### 2.6 Quyết định group (#26)

`{ "decision": "rejected", "reason": "Ngoài phạm vi bản 1.0", "base_version": 7 }` → group đó được mở khoá ngay. Khi group cuối được quyết, nếu có ít nhất một group được duyệt thì server ghi Track Changes + comment (author `CR-001`) lên bản sao của version mới nhất và tạo `0.1`. CR chuyển `written` với `result_doc_version: "0.1"`.

### 2.7 Chat ở project mode 1

```json
{ "data": null, "meta": { "prefill": { "title": "Đổi tên actor Learner thành Student", "description": "Rename actor Learner to Student in every section", "source": { "kind": "verbal", "ref": "chat:66f0c1…" } } }, "error": { "code": "CHANGE_REQUIRES_CR", "message": "Tài liệu đã import — mọi sửa phải qua change request" } }
```

## 4. Mode 1 v2 — contract-change (FLF-182)

Plan: `claude_plan/plan-mode1-v2-workspace.md` §1, §4. PR nhãn `contract-change`, cần 4/4 duyệt. V0 chỉ đổi **hình**; hành vi hiện thực ở V1–V4.

### 4.1 Spine (`spine.schema.ts`)
- `steps[].status` thêm `skipped` — step không áp dụng cho template của project (ẩn, không tính tiến độ).
- Thêm `custom_sections[]` `{ id, heading, level, blocks: [{ kind: paragraph|list_item|table|image, text, rows, image_ref }], source: import|manual }` — mục ngoài mẫu FPT và văn xuôi không trích được, render nguyên văn ở section `custom:<id>`, sửa qua `/changes`. Spine cũ đọc ra `[]`.
- Khoá section `custom:<id>` hợp lệ ở `flags[].section_id`, `addendum[].target_section`, `sections[].id`; `sectionsOfPath("custom_sections[id=X]…")` ⇒ `custom:X`.

### 4.2 RenderedDocument
- `RenderedSection.id` có thể là `custom:<id>` (mục riêng render nguyên văn). Hình không đổi.

### 4.3 Endpoint mới
| # | Method + path | Request | Response `data` | Lỗi riêng |
| --- | --- | --- | --- | --- |
| 32 | `GET /projects/:id/step-plan` | — | `stepPlanResponseSchema` — mỗi step: `state` (`applied` | `hidden` | `enabled`), `missing` (đầu mục mẫu FPT mà file không có ⇒ "Thiếu" + cờ đỏ `section_empty` (hồ sơ luật mode 1 giữ đỏ — FLF-183)), `section_ids`, `reason` | `IMPORT_INVALID_STATE` (chưa finalize) |
| 33 | `PATCH /projects/:id/step-plan` | `stepPlanPatchRequestSchema` `{ step_id, enabled }` | `stepPlanResponseSchema` | `STEP_NOT_IN_PLAN` (404), `CORE_STEP_REQUIRED` (409 — tắt step của đầu mục FPT hoặc step đã có dữ liệu) |

### 4.4 Thay đổi khác
- `templateProfileDtoSchema` thêm `layout[]` `{ order, heading_text, level, section_id }` — thứ tự + tiêu đề mục của file upload (`section_id` = section FPT hoặc `custom:<id>`). Import cũ ⇒ `[]`.
- CR `source.kind` thêm `chat` — CR tạo từ lệnh sửa trong chat sau baseline v1.
- `CHANGE_REQUIRES_CR`: **chỉ** trả khi project đã có baseline v1 (sign-off) hoặc release — trước đó `/changes`, `/undo`, chat sửa chạy như mode 2 (D3). Hiện thực ở V1.
- **Chưa đổi ở V0** — đã làm ở V4 (§4.6): vị trí CR theo path Spine thay `block_id`, khoá theo path (`PATH_LOCKED`), so giá trị tại path (`CR_VALUE_CHANGED`), #13 blocks đọc từ file render của version.

### 4.5 V2 — render theo template người dùng (FLF-184, chỉ thêm field)
- `RenderedDocument` của project có layout (mode 1 sau finalize): `sections[]` theo **thứ tự + tiêu đề file upload** (bỏ số gõ tay, `number` đánh lại theo cấp; heading không gõ số trong file gõ số tay ⇒ `number: ""`). Section FPT file không có ⇒ chèn cạnh mục cùng nhóm, tiêu đề mẫu FPT theo `TemplateProfile.language`. `group:<id>` lấy theo `section_id` của layout (vd `group:4`), không còn là số hiệu. Văn xuôi không trích được nằm ở đầu `blocks` của section chủ. Hình `RenderedSection` không đổi. Project mode 2 không đổi.
- #14 `download?variant=` thêm `original` — file người dùng upload (chỉ bản `0.0`; version khác ⇒ `DOC_VERSION_NOT_FOUND`), tên `…_v0.0_original.docx`. Bản `0.0` mặc định giờ là **bản render từ Spine** (+ stamp, + DRAFT khi tải).
- `DocVersionDto` thêm `has_original_file: boolean`.
- `gapReportSchema` thêm `totals.missing_fpt_sections`, `missing_fpt_sections[]` `{ section_id, title, step_id, in_layout }` (đầu mục FPT thiếu — D6, đứng đầu báo cáo; `feature:*` = chức năng chương 3), `layout[]` `{ order, section_id, heading, level, kind: fpt|group|custom, red, yellow }`; `sections[]` xếp theo layout.
- **Tạm tới V4:** #13 blocks, re-upload diff và CR ghi file vẫn chạy trên **file gốc** (`original_ref`) của `0.0`.

### 4.6 V4 — CR trên Spine, điều khiển bằng chat (FLF-186, contract-change — chờ 4/4)
- **Vị trí CR = phần tử Spine** (`project`, `actors[id=A01]`, `custom_sections[id=CS02]`…) thay block docx. `changeLocationDtoSchema`: bỏ `block_id`, `block`; thêm `path`, `section_id`, `section_title`, `current_text` (giá trị hiện tại — JSON khoá sắp xếp). `proposal.old_text` / `new_text` = giá trị phần tử trước / sau khi chạy khô op của vị trí; `edit` ⇒ `spine_ops` bắt buộc (output C-4 `crProposeSchema`).
- **Khoá theo path** (collection `SpineLock`, unique `(projectId, path)`): `BLOCK_LOCKED` ⇒ `PATH_LOCKED` `{ locked: [{ path, cr_id }] }`; op của vị trí chỉ được chạm phần tử CR đang khoá (thêm phần tử mới `arr[]` thì được).
- **C-5**: `CR_OLD_TEXT_MISMATCH` ⇒ `CR_VALUE_CHANGED` `{ location_id, path }` — giá trị tại path đổi kể từ lúc đề xuất. Nhận xét AI gắn theo `section_id`.
- **#28 PATCH vị trí**: bỏ `new_text`; `edit` cần `new_value` (giá trị mới của cả phần tử ⇒ op `set` tại `path`) hoặc `spine_ops`.
- **C-7 (D4)**: duyệt group cuối ⇒ op của CR vào Spine (`by = cr_id`) + version minor = **bản render** từ Spine (stamp `cr_revision`, §I có dòng CR), ghép lại bản làm việc. Vị trí `comment` không đổi Spine (ghi chú nằm ở CR). Bản tải "có đánh dấu" theo section: **để sau** (plan v2 §11 cắt giảm) — `variant=tracked` trả bản render — **đã làm ở §4.9**.
- **Release**: bản sạch = render snapshot Spine (`file_ref` = `clean_file_ref`).
- **#13 blocks, #15 compare, re-upload (#11)**: đọc block từ **file render** của version (id theo thứ tự đọc, không neo; `revisions` không còn); diff khớp theo text (trùng text ngoài thứ tự ⇒ `moved`, giống từ ≥ 50% giữa cùng hai khối đã khớp ⇒ `modified`), `block_id = null`.
- **3.1 từ chat**: sau baseline v1, lệnh sửa trong chat ⇒ BE tạo CR nguồn `chat` (requester = người gửi) rồi trả `409 CHANGE_REQUIRES_CR` kèm `meta.change_request { cr_id, status }` (+ `prefill` như cũ). `/changes`, `/undo` giữ 409 chỉ `prefill` — **đổi ở §4.7**.

### 4.7 Dọn nợ kỹ thuật sau V4 (chỉ thêm field / nới rộng, không phá tương thích)
- **`/changes`, `/reconcile`, `/undo` sau baseline v1** cũng tạo CR như lệnh sửa trong chat — nguồn `verbal`, `ref: null`, mô tả = `instruction` (không có ⇒ "Sửa tài liệu"; `/undo` ⇒ "Hoàn tác thay đổi gần nhất") — rồi trả `409 CHANGE_REQUIRES_CR` kèm `meta.change_request`. `/changes/preview` (chỉ xem trước) giữ nguyên: chỉ `prefill`. Dự án chưa có baseline v0 (dữ liệu cũ) ⇒ vẫn chỉ `prefill`.
- **`gapReportSchema`** thêm `totals.unrendered_diagrams` và `unrendered_diagrams[]` `{ diagram_id, kind, section_id, title, reason: not_rendered|error }` — hình dựng được từ Spine nhưng chưa có bản vẽ (lúc import PlantUML vắng mặt) hoặc vẽ lỗi. Chỉ để báo: không sinh cờ, không chặn ký v1.
- **`section_title` của vị trí CR và tiêu đề change group**: phần nối (mục riêng tiêu đề rỗng) hiện `Phần nối của "<mục chủ>"` thay cho mã `custom:<id>`. Hình DTO không đổi.
- **`found_by` của vị trí CR**: phần tử đã tham chiếu đích bằng field chỉ còn `spine_link`, không kèm `mention` cho cùng đích đó (nhắc một đích khác thì vẫn có `mention`).
- **C-3 nhận đích là mã section** (`targets.entity_paths` chứa `fixed:5.1`, `feature:F-01`, `custom:CS02`…): mọi phần tử section đó sở hữu thành vị trí `spine_link` (`entity_paths` của vị trí ghi mã section). Trước đây loại đích này bị bỏ im lặng.
- **Vị trí CR kiểu "mục trống"** (phương án B): đích là mã section mà Spine chưa có phần tử nào ⇒ `path` là **cả mảng** nuôi mục đó (`other_requirements[]`, `business_rules[]`… theo bảng `SECTION_FILL_ARRAYS`), `current_text` = JSON của mảng (thường `[]`). C-4 chỉ được kết luận `edit` bằng op `add` vào đúng mảng đó (vi phạm ⇒ `op_outside_section`), hoặc `not_related`. Khoá theo path mảng. Section không có mảng nào nuôi (vd `fixed:1`, `fixed:3.1.1`) vẫn ra `CR_NO_LOCATIONS` — **đổi ở §4.8** (`fixed:1` là phần tử `project`, `fixed:3.1.1` có vị trí).
- **Mã lỗi mới `409 CR_NOTHING_TO_APPROVE`** (#24 `/submit`): mọi vị trí kết luận `not_related` ⇒ `regroup` ra 0 group, nộp vào `in_review` thì không có gì để duyệt và CR kẹt vĩnh viễn. `meta { location_count }`. CR giữ `ready_to_submit`; đổi kết luận hoặc huỷ CR.
- **Mã lỗi mới `409 CR_NO_LOCATIONS`** (#19 `/impact`): C-3 ra 0 vị trí — thay vì đứng im ở `impact_review`. `meta { targets: { entity_paths, keywords }, empty_sections: [{ section_id, title, step_id | null }] }` — `empty_sections` là đích dạng section chưa có phần tử nào (mục còn trống ⇒ chạy `step_id` để soạn, không đi CR). CR giữ `impact_review`; sửa mô tả rồi `/clarify` lại được.

### 4.8 Mode 1 v3 — bám BPMN 2026-09-22 (contract-change — chờ 4/4)

Plan: `claude_plan/mode1-v3/` (`00-quyet-dinh.md` F1–F4, `phase-1-be-flow1.md`). BPMN Flow 1 kết thúc ở gap report (1.13) hoặc đi sang 3.1 — không có workspace sửa tự do, không có baseline v1.

- **Mốc CR đổi từ baseline v1 sang v0**: project mode 1 có baseline bất kỳ (kể cả `imported`) ⇒ `/changes`, `/reconcile`, `/undo`, chat lệnh sửa trả `409 CHANGE_REQUIRES_CR`.
- **Không tự tạo CR** (bỏ hành vi §4.6 "3.1 từ chat" và §4.7 "tạo CR nguồn verbal"): 3.1 là việc của BA (nguồn + người yêu cầu bắt buộc). `meta` chỉ còn `prefill { title, description, source? }` — **bỏ `change_request`**. `source` là gợi ý cho form: lệnh sửa trong chat ⇒ `{ kind: "verbal", ref: "chat:<chat_id>" }`; `/changes` · `/reconcile` · `/undo` ⇒ `{ kind: "verbal", ref: null }`. CR mới không dùng nguồn `chat` nữa (giữ trong enum để đọc CR cũ).
- **`POST /changes/preview` luôn chạy** (chỉ đọc) — mode 1 đã import thêm `meta.requires_cr: true` (bản xem trước dùng để soạn CR, không áp).
- **Mã lỗi mới** (409, không `meta`), áp cho mọi project mode 1 (đã import hay chưa):
  - `MODE1_NO_STEPS`: `POST /steps/:id/run`, `POST /steps/:id/answer`, `POST /steps/:id/gate`, `POST /resume`, `PATCH /step-plan` (#33). `GET /steps`, `GET /step-plan` vẫn đọc được (kế hoạch step còn dùng để biết step sở hữu field — C-4).
  - `MODE1_NO_SIGNOFF`: `POST /baseline`. Khoá duy nhất sau v0 là release (Flow 6).
  - `MODE1_NO_WAIVE`: `POST /flags/:id/waive` (G5). Cờ chỉ đóng bằng CR.
- **Mọi cờ đỏ mode 1 đóng được bằng CR** (chỉ nới rộng C-3):
  - "Mục trống" của C-3 dùng cùng tiêu chí với luật `section_empty` (`SECTION_HAS_DATA`): mục có phần tử mà cờ vẫn coi là chưa có dữ liệu (vd 5.1 chỉ có rule `tier=high`) cũng có vị trí thêm mới `arr[]`.
  - `fixed:3.1.1` (Screens Flow) và `fixed:2.2.1` (Use Case Diagram): mọi `screens[id=…]` / `use_cases[id=…]` là vị trí của mục đó (`section_id` = mục được nhắm, step sở hữu S-4.2 / S-3.6); mảng rỗng ⇒ `screens[]` / `use_cases[]`. Không còn `CR_NO_LOCATIONS` cho hai mục này.
  - `assumptions[id=…]` làm được vị trí (xác nhận giả định ⇒ đóng `unconfirmed_assumption`).
  - `CR_NO_LOCATIONS` giữ hình `meta`; `empty_sections[].step_id` chỉ còn để tham khảo (mode 1 không chạy step).
- **Tính cờ ở mode 1 bật luật S-9** (`atBaseline`) tại 1.12 (import check), 3.14 (ghi CR), 6.1 (release): `unconfirmed_assumption` hiện từ lúc import và đóng ngay khi CR xác nhận giả định.
- **Re-upload (#11) đòi stamp của project** (BPMN: "Has version stamp? Yes" mới đi 1.4): file không stamp ⇒ `422 IMPORT_REUPLOAD_NO_STAMP`, không lưu diff/file. Kiểm sau preflight (file bị từ chối vẫn ra `IMPORT_FILE_REJECTED` trước). Bỏ hành vi "bản gốc sửa ngoài vẫn so theo text".
- **3.14 vẽ lại hình**: ghi CR xong vẽ lại hình lệch dữ liệu (PlantUML có mặt); có hình đổi thì file của version minor được in lại để nhúng hình mới.

### 4.9 Mode 1 v3 — Flow 3 đủ từng nút (phase 2, contract-change — chờ 4/4, gom với §4.8)

Plan: `claude_plan/mode1-v3/phase-2-be-flow3.md`.

- **3.1 tạo CR (#16)**: `source.kind` chỉ nhận 6 nguồn BPMN — `stakeholder_email`, `meeting_minutes`, `gap_report`, `reupload`, `viewer_comment`, `verbal`. **`chat` ⇒ 400** (lệnh sửa trong chat là yêu cầu miệng, `ref: "chat:<id>"`); CR nguồn `chat` cũ vẫn đọc được. `requester` bắt buộc như cũ.
- **Đính kèm bản xem trước**: body #16 thêm `preview_id?` (từ `POST /changes/preview` — chỉ của chính người tạo, còn hạn 15 phút). CR lưu `seed { instruction | null, ops[], targets[] }` (`targets` = phần tử bị op chạm). Hết hạn / của người khác ⇒ CR vẫn tạo, `seed: null`, `meta.seed_dropped: true`. `changeRequestDtoSchema` thêm `seed`.
- **Seed chỉ là gợi ý, không bỏ nút nào**: C-2 (3.2) và C-4/C-5 thấy bản xem trước trong mô tả CR; C-3 (3.4) thêm `seed.targets` vào đích — vị trí đến từ đó có `found_by` chứa **`preview`** (giá trị mới của `LOCATION_FOUND_BY`); C-4 (3.6) thấy op gợi ý của đúng vị trí.
- **3.9 endpoint mới**: `POST /projects/:id/change-requests/:crId/locations/:locId/owner-step-draft` `{ instruction }` — chỉ khi CR `manual_fix`. Chạy skill của **step sở hữu** vị trí (như C-4, một vị trí, kèm hướng của BA); kết quả chỉ ghi vào đề xuất (`manual: true`, `verify: null`), không ghi Spine; CR giữ `manual_fix`, kiểm lại bằng #22 `/verify`. Lỗi: `CR_INVALID_TRANSITION` (không ở `manual_fix`), `CR_NO_OWNER_STEP` (409, mục riêng — dùng #28 PATCH), `CR_LOCATION_NOT_FOUND`, `PATH_LOCKED`, `402 INSUFFICIENT_CREDIT`, `502 AI_PROVIDER_ERROR` (`manual_fix` không pause được).
- **3.12 (#26)**: `reason` **bắt buộc cả khi duyệt** (≥ 10 ký tự) — BPMN "quyết định từng group, kèm lý do".
- **3.5 khi Revise (#25)**: giữ nguyên — revise đã khoá lại đúng các phần tử (3.5) rồi về `proposing` (3.6); giá trị gốc chụp lại khi đề xuất mới. Không đổi máy trạng thái.
- **3.14 bản có đánh dấu (T6/T7)**: CR ghi xong, version minor có thêm file **Track Changes** so với version trước (so theo đoạn; `w:ins`/`w:del` tác giả = CR id) + comment Word của vị trí `comment` ở tiêu đề mục. `DocVersionDto` thêm `has_tracked_file`. #14 `download?variant=tracked` trả file đó (bản nháp vẫn kèm DRAFT); version không có (`0.0`, release, dựng lỗi) ⇒ bản render như cũ. Accept-all bản có đánh dấu ra đúng bản sạch. Release (6.2) vẫn chỉ bản sạch.

### 4.10 Mode 1 v3 — đọc ảnh diagram + giữ ảnh gốc (phase 5, FLF-187 — contract-change, chờ 4/4)

Plan: `claude_plan/mode1-v3/phase-5-vision.md`.

- **Ảnh gốc (T3)**: block ảnh của file upload giữ `image_ref` (part `word/media/*`). Ảnh dưới mục FPT không được thay bằng diagram ⇒ phần nối nguyên văn của mục (`custom_sections[].blocks[].image_ref`); bản render (0.0, bản làm việc, version CR) nhúng lại **đúng ảnh gốc** (PNG/JPEG). EMF/WMF / file gốc không còn ⇒ chỗ giữ ảnh + chú thích `original image could not be embedded (<part>)`.
- **I-4 phần ảnh (1.8)**: `call_kind` mới **`import_extract_diagram`** (2 credit/ảnh, Gemini) — chỉ cho ảnh ở mục diagram (`fixed:1`, `2.1`, `2.2.1`, `2.2.2`, `3.1.1`, `3.1.5`), sau bảng tất định, trước lô chữ; `step_id` usage vẫn `I-4:<section>`. Hết credit / lỗi ⇒ `paused` như lô chữ.
  Môi trường không có vision (`GEMINI_KEY_MISSING`, `AI_PROVIDER_NO_VISION`) ⇒ không dừng: ảnh coi như định dạng không hỗ trợ (giữ ảnh + cờ vàng).
- **Field từ ảnh**: `ReviewField.origin` thêm **`vision`**. Độ tin ≤ 0.7 và **luôn** vào `review_fields` (1.9) kể cả bằng ngưỡng — chưa xác nhận thì finalize bỏ. Danh sách tham chiếu (`actor_ids`, `includes`, `extends`, `relations`, `flow_to`) từ nhiều nguồn gộp hợp. `screens.flow_to` được trích.
- **Finalize (1.10)**: ảnh đọc được (use case / ERD / luồng màn / ngữ cảnh) ⇒ bỏ ảnh gốc, diagram PlantUML vẽ từ Spine thay; ảnh ở mục diagram không đọc được (`other` / định dạng không hỗ trợ) ⇒ giữ ảnh gốc + **cờ vàng `rule_id: import_image_unread`** (model-owned, recompute không đóng).

## 3. Lịch sử thay đổi contract

| Ngày | PR | Thay đổi |
| --- | --- | --- |
| 2026-09-22 | mode 1 v3 — phase 5 (FLF-187) | §4.10: `call_kind` `import_extract_diagram`, `ReviewField.origin` thêm `vision`, cờ `import_image_unread`, ảnh gốc giữ trong bản render (`image_ref`) — contract-change, chờ 4/4 |
| 2026-09-22 | mode 1 v3 — phase 2 | §4.9: tạo CR bỏ nguồn `chat`, `preview_id` + `seed`, `found_by: preview`, endpoint `owner-step-draft` (3.9), `CR_NO_OWNER_STEP`, lý do bắt buộc khi duyệt, bản có đánh dấu `variant=tracked` + `has_tracked_file` — contract-change, chờ 4/4 (gom với §4.8) |
| 2026-09-22 | mode 1 v3 — phase 1 | §4.8: `CHANGE_REQUIRES_CR` từ baseline v0, bỏ `meta.change_request` (không tự tạo CR), `prefill.source`, preview `meta.requires_cr`, `MODE1_NO_STEPS` · `MODE1_NO_SIGNOFF` · `MODE1_NO_WAIVE`, `IMPORT_REUPLOAD_NO_STAMP`, C-3 cho mọi mục FPT trống + `assumptions`, luật S-9 khi tính cờ mode 1 — contract-change, chờ 4/4 |
| 2026-09-20 | Dọn nợ sau V4 | §4.7: `/changes`, `/reconcile`, `/undo` sau v1 tạo CR nguồn `verbal` kèm `meta.change_request`; gap report `unrendered_diagrams`; `section_title` của phần nối; `found_by` bỏ `mention` trùng `spine_link` — chỉ thêm field / nới rộng |
| 2026-09-19 | FLF-186 (mode 1 v2, V4) | §4.6: vị trí CR theo path Spine (DTO location), `PATH_LOCKED`, `CR_VALUE_CHANGED`, PATCH vị trí `new_value`/`spine_ops`, version/release = render Spine, blocks/compare/re-upload từ file render, chat sau v1 tạo CR (`meta.change_request`) — contract-change, chờ 4/4 |
| 2026-09-19 | FLF-184 (mode 1 v2, V2) | §4.5: `RenderedDocument` theo layout file upload, #14 `variant=original`, `has_original_file`, gap report `missing_fpt_sections` + `layout[]` — chỉ thêm field, kèm lô contract-change V0 |
| 2026-09-19 | FLF-182 (mode 1 v2, V0) | §4: `steps[].status = skipped`, `custom_sections[]`, section `custom:<id>`, `layout[]`, #32–#33 step-plan, CR nguồn `chat`, `CORE_STEP_REQUIRED`, `STEP_NOT_IN_PLAN`, `CHANGE_REQUIRES_CR` chỉ sau baseline v1 — chờ 4/4 |
| 2026-09-19 | FLF-171 (việc A sau P2) | #6, #10: I-4 chạy nền, trả ngay `extracting`; FE poll #4. Hình request/response không đổi, chỉ đổi thời điểm trả — cần nhóm duyệt như contract-change |
| 2026-09-18 | FLF-171 (P1) | Bản đầu tiên, nhóm chốt và đóng băng cùng ngày. Đi kèm contract-change `Baseline.type` + `doc_version` trong `pipeline-contract.md` §3 (nhóm duyệt 4/4) |
