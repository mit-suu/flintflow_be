# Fixtures — Spine mẫu 19 màn + ca thử op (T02)

Dữ liệu chuẩn cho op engine (T08), deterministic check (T09), renderer (T10), assemble/export (T15), đo token (T14/T22). Nguồn spec: `context/srs-spine.md` và `context/Product-Brief-to-SRS-Phases.md` §6.4, §7.2, §9.3.

## File

| File | Nội dung |
| --- | --- |
| `spine-fixture-19-screens.json` | Spine đầy đủ của project mẫu — chính FlintFlow: 9 actor, 4 role, 23 use case, 6 feature, 19 màn, 89 function (83 màn + 6 non-screen), 51 permission, 12 entity, 11 NFR, 9 business rule, 8 message, 16 glossary, 5 addendum, 5 diagram (`.puml` viết tay), 68 step `accepted` (38 SRS cố định + 5×6), progress ở `S-9.5`, `spine_version=1`. |
| `spine-fixture-minimal.json` | Chỉ `project{}` + `addendum[]` (+ khung mảng rỗng để parse được schema) — đầu vào cho T14 chạy S-2/S-3. |
| `op-cases/case-01…10.json` | 10 ca thử "model có sinh op đúng path/schema không". |

## Quy ước trong fixture

- **5 màn `signed_off`** (S01, S05, S07, S09, S10 — các màn cốt lõi theo Phases §7.2), 14 màn còn lại `placeholder` (cắt theo độ sâu, Phases §9.1). Không màn nào `pending` vì progress đã qua S-5.
- **Steps** chỉ gồm 38 step SRS cố định + 5×N với N=6 (5 màn signed_off + 1 vòng `@nonscreen`), đúng câu chữ task 02. 13 step Brief không nằm trong fixture.
- `first_seq`/`last_seq` của step là dải **tượng trưng** (mỗi step 3 seq); `baselines[]` rỗng.
- **Không có** `sessions`, `changes`, `usage` trong fixture: `spineSchema` (T01) là strict và tách chúng ra collection riêng — `changes`/`usage` là collection, `sessions[]` thành cờ `ChatSession.is_pipeline` (seed script tạo).
- `diagrams[].source_hash = "TBD"`: T09/T10 tính lại theo `source_fields` (srs-spine.md §7.1). `diagrams[].error` bỏ hẳn key khi `render_status=ok` (schema là `optional`, không nhận `null`).
- `entities[].relations[]` là mảng id entity đích (`["E02", "E05"]`) theo `spineSchema`; bản số quan hệ (1–n, n–1) chỉ thể hiện trong ERD `.puml` (D04).
- Mọi `fixtures/**/spine*.json` phải parse qua `spineSchema` — test `src/modules/spine/spine.schema.test.ts` (T01) chạy trong CI.
- Nội dung render vào SRS là tiếng Anh (Phases §1.3); `addendum[].content` cố ý để tiếng Việt kèm `content_en` — để test cờ vàng `non_english_content` có ý nghĩa.
- `baselines[]` rỗng dù S-9.5 `accepted`: fixture dùng cho kiểm thử **trước** khi ký baseline; T19 sẽ có fixture snapshot riêng nếu cần.

## Ca thử op

Mỗi ca: `{name, step_id, spine_before_ref, spine_before_overrides?, prompt_context, expected_ops[], must_reject?}`.

- `spine_before_ref` trỏ tới fixture làm trạng thái gốc; `spine_before_overrides` (chỉ case-06) ghi đè vài path dạng chấm trước khi áp (đưa progress về giữa S-5).
- `expected_ops` là **lô op chuẩn** một transaction: op `{op: add|set|remove, path, value?, reason}`. Path theo khoá, không theo chỉ số (srs-spine.md §1); phần tử vô hướng trong mảng dùng `arr[=value]` — quy ước tạm, chốt cùng `opTransactionSchema` của T03 tại M1.
- `must_reject` là mã lỗi kỳ vọng khi op engine áp lô: `key_change_forbidden` (07), `path_not_resolved` (08), `invariant_2_last_element` (09), `invariant_6_feature_mismatch` (10). Các ca này kiểm **đầu vào bị từ chối**, không kiểm op sinh ra.

| Ca | Kịch bản |
| --- | --- |
| 01 | Thêm actor mới (S-3.1) |
| 02 | Đổi tên use case (S-3.5) |
| 03 | Xoá màn S08 → cascade functions, permissions, `flow_to`, `use_cases[].function_ids`, `sections[function:*]` |
| 04 | Xoá actor A08 đang được UC01/UC03 tham chiếu → cascade gỡ `actor_ids` |
| 05 | Dời feature F3 → lô renumber `features[].order` (bất biến 5 kiểm cuối lô) |
| 06 | Thêm màn khi `current_phase=S-5` → phải kèm op append `screen_queue[]`, `detail_status=pending` (bất biến 8) |
| 07 | Op đổi khoá `glossary[].id` → reject |
| 08 | Path không phân giải (`actors[id=A99]`) → reject |
| 09 | Xoá cả hai NFR reliability → rỗng mảng bảo vệ → reject (bất biến 2) |
| 10 | Set `functions[].feature_id` lệch feature của màn → reject (bất biến 6) |

### Thêm ca thử mới

1. Tạo `op-cases/case-NN.json` theo đúng shape trên; đánh số tiếp, không xen giữa.
2. Path phải theo khoá và mọi id nhắc tới phải tồn tại trong `spine_before_ref` (sau khi áp overrides) — trừ ca `must_reject` cố ý sai.
3. Ca hợp lệ: `expected_ops` là **trọn lô** kể cả cascade — thiếu op cascade là ca sai.
4. Cập nhật `src/scripts/fixture-spine.test.ts` nếu thêm quá case-10 (danh sách file đang cố định 10) và chạy `npm test`.

## Seed vào Mongo local

```bash
npm run seed:fixture -- --user you@example.com            # fixture đầy đủ
npm run seed:fixture -- --user you@example.com --fixture minimal
```

Script tạo/tìm user, tạo project, ghi Spine **thẳng vào collection `spines`** (T01 chưa merge — tại M1 đổi sang model + `spineSchema.parse`), tạo chat session và set `is_pipeline=true`, rồi in access token để test API/FE. Chạy lại là idempotent (spine bị ghi đè).

## Kiểm định

`src/scripts/fixture-spine.test.ts` kiểm 8 bất biến (srs-spine.md §6), các yêu cầu đếm của task 02 và cấu trúc/độ phân giải path của 10 ca op — chạy trong `npm test`. Tại M1 bổ sung `spineSchema.parse(fixture)`.
