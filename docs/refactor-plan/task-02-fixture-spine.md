# Task 02 — Fixture Spine 19 màn + seed script + 10 ca thử op

**Wave:** 1 · **Người phụ trách:** B · **Effort:** 6 điểm · **Trạng thái:** [ ] Chưa làm  [ ] Đang làm  [ ] Xong

## Mục tiêu
Thực hiện Phases §9.3 bước 0: một Spine seed đầy đủ viết tay (không qua AI) cho project mẫu 19 màn, dùng làm dữ liệu chuẩn cho op engine, deterministic check, renderer, assemble, export, đo token. Kèm 10 ca thử "model có sinh op đúng path/schema không".

## Lệch hướng audit cần đóng
Không đóng trực tiếp lệch nào; là điều kiện để kiểm chứng A1–A7, C5, D1 ở các wave sau.

## File / module liên quan
### Hiện có (đọc / sửa / xoá)
- Đọc: `context/srs-spine.md` §2, §4, §6, §7; `context/Product-Brief-to-SRS-Phases.md` §6.4, §7.2 (danh sách màn cốt lõi).
- Đọc: `flintflow_be/src/scripts/seed-test-uc34.ts` (mẫu tạo user/project + token) để tái dùng cách seed.
### Tạo mới
- `flintflow_be/fixtures/spine-fixture-19-screens.json` — project mẫu là chính FlintFlow.
- `flintflow_be/fixtures/spine-fixture-minimal.json` — chỉ `project{}` + `addendum[]` (đầu vào cho T14 chạy S-2/S-3).
- `flintflow_be/fixtures/op-cases/case-01…case-10.json` — mỗi ca `{name, step_id, spine_before_ref, prompt_context, expected_ops[], must_reject?: string}`.
- `flintflow_be/src/scripts/seed-fixture.ts` — `npm run seed:fixture -- --user <email> [--fixture minimal|full]`.
- `flintflow_be/fixtures/README.md`.

## Các bước implement
1. Liệt kê nội dung tối thiểu của fixture đầy đủ: ≥ 8 `actors[]` (gồm `kind=system` Payment Gateway, LLM provider, PlantUML; `kind=time` cron), `roles[]` nối actor, ≥ 20 `use_cases[]` có `actor_ids`, `function_ids`, ≥ 2 cặp include/extend; ≥ 6 `features[]` `order` 0..5; 19 `screens[]` (`feature_id`, `flow_to`, 2 màn `is_popup`, 1 màn có `tabs`, `primary_function_id`, `queue_order`, 5 màn `detail_status=signed_off`, còn lại `placeholder`), `functions[]` cho mọi màn (4–6/màn) + ≥ 6 non-screen (`screen_id=null`, `order` riêng), mỗi function có `normal[]`, `abnormal[]`, `validations[]` có `id`, `priority`; `permissions[]` đủ màn × vai trò; ≥ 10 `entities[]` có `relations[]`; `nfrs[]` đủ 5 category, reliability/performance có `metric`+`threshold`; `business_rules[]` cả `tier=high` và `detail` (`source_validation_ids`); `common_requirements[]`, `messages[]` (`function_ids`), `other_requirements[]` 4 kind; `glossary[]` ≥ 15; `addendum[]` ≥ 5 có `target_section`; 5 `diagrams[]` với `puml` viết tay và `render_status=ok`, `source_hash` tạm `"TBD"` (T09/T10 tính lại); `assumptions[]` ≥ 3 (`confirmed`); `steps[]` toàn bộ 38 + 5×N ở `accepted`; `progress` ở `S-9.5`; `sessions[]` một `is_pipeline=true`; `spine_version=1`; `flags[]` rỗng; `sections[]` đủ id với `asset_version`.
2. Kiểm tay 8 bất biến §6 trên fixture (không có id chết, `order` liên tục, mỗi màn thuộc đúng feature).
3. Viết fixture minimal.
4. Viết 10 ca op: add actor; set tên UC; remove screen có cascade; remove actor đang được tham chiếu (mong đợi cascade); renumber feature; add screen khi `current_phase=S-5` (phải append queue); op đổi khoá (must_reject); op path không phân giải (must_reject); xoá phần tử cuối `nfrs[category=reliability]` (must_reject bất biến 2); set `functions[].feature_id` lệch màn (must_reject bất biến 6).
5. Viết `seed-fixture.ts`: tạo/tìm user, tạo `Project`, tạo `Spine` (dùng model T01 khi đã merge; trước đó ghi JSON thẳng bằng `mongoose.connection.collection("spines")`), tạo `ChatSession` `is_pipeline`. In access token như `seed-test-uc34.ts`.
6. Tại M1: chạy `spineSchema.parse(fixture)`; sửa mọi lệch.

## Dependency
- Phụ thuộc: không (viết theo tài liệu); xác nhận với T01 tại M1.
- Chặn: T08, T09, T10, T14, T15, T22.
- Chạy song song với: T01, T03, T04, T05, T06, T07.

## Output kỳ vọng
- 2 fixture JSON + 10 ca op + script seed chạy được trên Mongo local.

## Tiêu chí hoàn thành (DoD)
- [ ] `spineSchema.parse(fixture)` không lỗi (sau M1).
- [ ] `npm run seed:fixture` tạo project mở được trên FE (dù FE chưa hiển thị Spine).
- [ ] 10 ca op có `expected_ops` hợp lệ theo `opTransactionSchema` (T03).
- [ ] README mô tả cách thêm ca thử mới.

## Ghi chú / rủi ro
- Không dùng AI để sinh fixture: sai lệch fixture sẽ làm sai mọi test phía sau.
- Nội dung field render phải tiếng Anh (Phases §1.3) để test `non_english_content` có ý nghĩa.
