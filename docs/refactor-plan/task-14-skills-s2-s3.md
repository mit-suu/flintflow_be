# Task 14 — Content skill S-2 + S-3 end-to-end trên fixture

**Wave:** 3 · **Người phụ trách:** B · **Effort:** 9 điểm · **Trạng thái:** [ ] Chưa làm  [ ] Đang làm  [x] Xong (2026-09-15, nhánh `wave3/review`; bị chặn một phần: `stub: true` do test T03, `E2E_AI=1` chưa chạy — xem `flintflow/plans/reports/t14-report-260915-skills-s2-s3.md`)

## Mục tiêu
Phases §9.3 bước 2: chứng minh phần AI khó nhất (actors & use cases, gap BMAD không phủ) chạy trọn: từ Spine chỉ có `project{}` + addendum, S-2.1…S-2.5 (§1) và S-3.1…S-3.6 (§2) sinh op hợp lệ, 0 cờ đỏ, có hình use case.

## Lệch hướng audit cần đóng
B5/B6 phần nội dung (prompt generic `generate_section` thay bằng skill theo step ghi field), D4 (tiếng Anh cho nội dung render).

## File / module liên quan
### Hiện có (đọc / sửa / xoá)
- Đọc: `context/Product-Brief-to-SRS-Phases.md` §6.1, §6.4 (S-1.2, S-2.x, S-3.x), §8.1 (BMAD tái dùng), `context/srs-spine.md` §2.1, §4; `assets/skills/` (T03), `modules/pipeline/*` (T11, T13), `modules/diagram` (T10).
- Sửa: `assets/step-registry.json` nếu phát hiện `reads/writes` thiếu (PR `contract-change`).
### Tạo mới / điền
- `assets/skills/content/project-classifier/` (S-1.2: `project.type/domain/complexity`).
- `assets/skills/content/product-overview/` (S-2.1 vision/goals đoạn §1; S-2.2 `release_scope{in,out}`; S-2.3 `actors[kind=system]`).
- `assets/skills/content/high-level-rules/` (S-2.4 `business_rules[tier=high]`); S-2.5 chỉ gọi renderer context (không skill).
- `assets/skills/content/actors-and-usecases/` với `references/{actor-rules.md, usecase-naming.md, missing-usecase-checklist.md, include-extend.md}` và `assets/usecase-table-template.md`: S-3.1 (`actors[]` human/system/time, `roles[]`), S-3.2 (actor-goal thành `use_cases[]` tên động từ + tân ngữ, `actor_ids`), S-3.3 sweep (admin, support, notification, quên mật khẩu, audit, xử lý lỗi), S-3.4 (`includes/extends`), S-3.5 (bảng §2.2.2 `description`), S-3.6 renderer usecase.
- Mỗi `SKILL.md` ≤ 150 dòng: vai trò, input projection (theo `reads`), output là op batch theo `opTransactionSchema` chỉ ghi vào `writes`, luật tiếng Anh, ví dụ 1 op batch ngắn, checklist tự kiểm.
- `flintflow_be/src/modules/pipeline/skills/s2-s3.e2e.test.ts` — chạy step runner S-1.2 đến S-3.6 trên `spine-fixture-minimal.json`; mặc định mock provider trả op từ `fixtures/op-cases/s2-s3/*.json` (tạo thêm); `E2E_AI=1` gọi provider thật và chỉ assert bất biến + 0 cờ đỏ + số lượng tối thiểu.
- `docs/measurements.md` — mục "S-2/S-3 trên fixture minimal": token in/out từng step, tổng credit.

## Các bước implement
1. Viết skill S-1.2, S-2.x; chạy qua runner (mock), kiểm field §1.
2. Viết `actors-and-usecases` theo 6 step; chạy mock.
3. Chạy `E2E_AI=1` với provider thật ít nhất 3 lần; sửa prompt khi op sai path/schema quá 1 retry; ghi tỉ lệ retry.
4. Ghi measurements.
5. Đề xuất chỉnh `reads/writes` nếu thiếu.

## Dependency
- Phụ thuộc: T10, T11, T13 (có thể bắt đầu bằng gọi `draftOps` trực tiếp khi runner chưa xong), T03.
- Chặn: T18, M3.
- Chạy song song với: T13, T15, T16.

## Output kỳ vọng
- 4 skill content hoàn chỉnh + test e2e + số đo token.

## Tiêu chí hoàn thành (DoD)
- [x] Mock e2e xanh trên CI. (`src/modules/pipeline/skills/s2-s3.e2e.test.ts` qua runner T13 thật)
- [ ] `E2E_AI=1`: 3/3 lần đạt 0 cờ đỏ ở §1/§2, ≥ 5 actor, ≥ 12 use case, diagram usecase `render_status=ok`. (chưa chạy: không có provider thật; nội dung skill chưa tới model vì `stub: true` — XREQ T03 `prompt-assets.test.ts:97-107`)
- [ ] Field render không có ký tự có dấu (`non_english_content` = 0). (mock assert = 0 nhưng nội dung do fixture; chờ `E2E_AI=1`)
- [x] `docs/measurements.md` có số cho từng step. (số mock/ước lượng; cột số thật chờ `E2E_AI`)

## Ghi chú / rủi ro
- Nếu tỉ lệ op sai schema > 30% sau 2 vòng sửa prompt, báo A để xem lại định dạng op (rủi ro gốc §9.3).
