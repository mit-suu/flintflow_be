# Import + Change Request API contract (mode 1)

> **Trạng thái:** FLF-171 (plan mode 1, P1 §5.6). **Đã đóng băng 2026-09-18** (nhóm chốt). Từ nay mọi thay đổi phải qua PR nhãn `contract-change` được 4/4 duyệt, và sửa các file zod bên dưới trong cùng PR.
> **Nguồn:** `claude_plan/plan-mode1-import-edit-srs.md` §1–§5, `doc/flintflow-business-flow (1).bpmn` (Flow 1, 3, 4, 5, 6), `doc/actors-and-use-cases.md`.
> **Schema zod:** `src/modules/import/import.dto.ts`, `src/modules/doc-version/doc-version.dto.ts`, `src/modules/change-request/change-request.dto.ts`, `src/modules/project/project.validation.ts`; mã lỗi `src/modules/import/mode1.errors.ts`; đầu ra AI `src/shared/ai/response-parser.ts` (`importExtract`, `findings`, `crClarify`, `crPropose`).
> **Hiện thực:** P2 (BE), P3 (FE). Trước khi P2 merge, FE mock bằng msw theo đúng hình ở đây (`flintflow_fe/mocks/mode1/handlers.ts`).

## 0. Quy ước chung

- Giống `pipeline-contract.md` §0: base URL `/api/v1`, Bearer token, envelope `{ data, meta?, error }`. Project không thuộc user trả `404 PROJECT_NOT_FOUND`.
- Mọi endpoint ở đây chỉ dùng cho project `mode = "import"`. Gọi trên project mode khác trả `409 PROJECT_MODE_MISMATCH` `{ mode, expected: "import" }`.
- **Nguồn sự thật là file .docx + bảng block** (G2). Spine chỉ là chỉ mục: request nào ghi Spine (finalize, quyết định group cuối, release) thì mang `base_version` như pipeline.
- **Neo block** (G3): mỗi block có `block_id` ổn định (`B0001`…), neo bằng bookmark ẩn `_ff_<block_id>` trong file lưu, neo phụ `w14:paraId`, dự phòng `text_hash` + `heading_path`.
- **Version tài liệu** (G4): import `0.0`; mỗi CR ghi xong lên minor (`0.1`, `0.2`…); release lên major (`1.0`, `2.0`…). Khác `v1.N` của mode 2.
- **BR-03:** khi đã có baseline v0 thì mọi sửa phải qua CR. Ở project mode 1, chat ra lệnh sửa, `POST /changes` và `POST /undo` đều trả `409 CHANGE_REQUIRES_CR` (G9).
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
| 409 | `BLOCK_LOCKED` | CR cần khoá block đang bị CR khác giữ (3.5), hoặc sửa tay block không thuộc CR | `{ locked: [{ block_id, cr_id }] }` |
| 409 | `CR_LOCATION_UNCONCLUDED` | Nộp CR khi còn vị trí chưa có kết luận | `{ location_ids[] }` |
| 409 | `CR_OLD_TEXT_MISMATCH` | Text block đã đổi so với `proposal.old_text` (verify hoặc ghi) | `{ location_id, block_id }` |
| 409 | `CHANGE_REQUIRES_CR` | Chat sửa / `POST /changes` / `POST /undo` ở project mode 1 | `{ prefill: { title, description } }` |
| 422 | `IMPORT_FILE_REJECTED` | Preflight từ chối file (1.2); bản ghi import vẫn được tạo với `status = preflight_rejected` | `{ import_id, issues[] }` |
| 422 | `IMPORT_STAMP_FOREIGN_PROJECT` | File mang stamp của project khác | `{ stamp }` |
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
| 6 | `POST /projects/:id/import/extract` | 1.8 | `extractRequestSchema` | `extractResponseSchema` (kể cả khi pause) | `IMPORT_INVALID_STATE`, `INSUFFICIENT_CREDIT` |
| 7 | `PATCH /projects/:id/import/fields` | UC-22, 1.9 | `fieldsPatchRequestSchema` | `importStateResponseSchema` | `IMPORT_INVALID_STATE` |
| 8 | `POST /projects/:id/import/finalize` | 1.10–1.12 | `finalizeRequestSchema` | `finalizeResponseSchema` | `IMPORT_INVALID_STATE`, `SPINE_VERSION_CONFLICT`, `INSUFFICIENT_CREDIT` |
| 9 | `GET /projects/:id/gap-report?format=json\|docx` | UC-23, 1.13 | `gapReportQuerySchema` | `gapReportSchema`; `docx` trả file, không bọc envelope | `IMPORT_INVALID_STATE` (chưa tới `gap_review`) |
| 10 | `POST /projects/:id/import/resume` | UC-61, UC-75 | `importResumeRequestSchema` | `extractResponseSchema` | `IMPORT_INVALID_STATE`, `INSUFFICIENT_CREDIT` |
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
| 21 | `POST …/:crId/impact` | UC-50, 3.4–3.5 | `{}` | `changeRequestDetailSchema` (`locations[]`, block đã khoá) | `BLOCK_LOCKED`, `CR_INVALID_TRANSITION` |
| 22 | `POST …/:crId/propose` | UC-81, 3.6 | `{}` | `changeRequestDetailSchema` (`groups[]`) | `CR_INVALID_TRANSITION`, `INSUFFICIENT_CREDIT` |
| 23 | `PATCH …/:crId/locations/:locId` | UC-81, 3.9 | `patchLocationRequestSchema` | `changeRequestDetailSchema` (vị trí `manual = true`) | `CR_LOCATION_NOT_FOUND`, `CR_INVALID_TRANSITION` |
| 24 | `POST …/:crId/verify` | UC-82, 3.7–3.8 | `{}` | `changeRequestDetailSchema` (`ready_to_submit`, `proposing` hoặc `manual_fix`) | `CR_INVALID_TRANSITION`, `CR_OLD_TEXT_MISMATCH`, `INSUFFICIENT_CREDIT` |
| 25 | `POST …/:crId/submit` | UC-51, 3.11 | `{}` | `changeRequestDetailSchema` (`in_review`) | `CR_LOCATION_UNCONCLUDED`, `CR_INVALID_TRANSITION` |
| 26 | `POST …/:crId/groups/:gid/decision` | UC-52, 3.12–3.14 | `groupDecisionRequestSchema` | `changeRequestDetailSchema`; khi group cuối được quyết mà có group duyệt ⇒ `written` kèm `result_doc_version` | `CR_GROUP_NOT_FOUND`, `CR_INVALID_TRANSITION`, `CR_OLD_TEXT_MISMATCH`, `SPINE_VERSION_CONFLICT` |
| 27 | `POST …/:crId/revise` | UC-52 | `{}` | `changeRequestDetailSchema` (khoá lại block, về `proposing`) | `BLOCK_LOCKED`, `CR_INVALID_TRANSITION` |
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

Nạp credit rồi gọi #10 để chạy tiếp từ `fixed:3.1.2`; section đã `done` không bị trích lại.

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
{ "data": null, "meta": { "locked": [{ "block_id": "B0005", "cr_id": "CR-001" }] }, "error": { "code": "BLOCK_LOCKED", "message": "Block B0005 đang được CR-001 sửa" } }
```

### 2.6 Quyết định group (#26)

`{ "decision": "rejected", "reason": "Ngoài phạm vi bản 1.0", "base_version": 7 }` → group đó được mở khoá ngay. Khi group cuối được quyết, nếu có ít nhất một group được duyệt thì server ghi Track Changes + comment (author `CR-001`) lên bản sao của version mới nhất và tạo `0.1`. CR chuyển `written` với `result_doc_version: "0.1"`.

### 2.7 Chat ở project mode 1

```json
{ "data": null, "meta": { "prefill": { "title": "Đổi tên actor Learner thành Student", "description": "Rename actor Learner to Student in every section" } }, "error": { "code": "CHANGE_REQUIRES_CR", "message": "Tài liệu đã có baseline — mọi sửa phải qua change request" } }
```

## 3. Lịch sử thay đổi contract

| Ngày | PR | Thay đổi |
| --- | --- | --- |
| 2026-09-18 | FLF-171 (P1) | Bản đầu tiên, nhóm chốt và đóng băng cùng ngày. Đi kèm contract-change `Baseline.type` + `doc_version` trong `pipeline-contract.md` §3 (nhóm duyệt 4/4) |
