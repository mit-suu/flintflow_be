# Spec gaps

Thiếu sót / mâu thuẫn tài liệu phát hiện khi implement. Ai cũng được **thêm dòng**; không sửa dòng người khác.

| Ngày | Task | Tài liệu | Vấn đề | Cách xử lý tạm |
| --- | --- | --- | --- | --- |
| 2026-09-14 | T03 | Phases §8.2 vs `task-03-skill-assets.md` | Phases đếm 29 file (12 skill content). Task-03 liệt kê 13 content (thêm `product-brief` cho B-0…B-2, T20 sở hữu) ⇒ thực tế 30 SKILL.md (10 đủ nội dung, 20 stub). | Giữ 30; test `prompt-assets.test.ts` khoá số 30. Cần chốt lại con số trong Phases §8.2. |
| 2026-09-14 | T03 | Phases §8.2 | Tên file dạng `draft-to-ops.md` phẳng; task-03 chốt cấu trúc BMAD `action/draft-to-ops/SKILL.md` + `references/`. | Theo task-03. |
| 2026-09-14 | T08 | srs-spine §4.1 | Không nói "tồn tại" nghĩa là gì với khoá section (`sections[].id`, `addendum[].target_section`, `flags[].section_id`). Spine mới có `sections[]` rỗng nhưng addendum đã trỏ `fixed:5.4`. | Khoá section tồn tại khi phân giải được: `fixed:*` thuộc 20 section cố định, `feature:<id>`/`function:<id>` có phần tử. `reference-fields.ts` `sectionKeyExists`. Riêng `addendum[].target_section` chỉ cần đúng dạng (`sectionKeyWellFormed`): fixture minimal có entry trỏ `feature:F3` trước khi feature tồn tại. |
| 2026-09-14 | T08 | srs-spine §3 | Chỉ nêu cascade cho xoá màn/actor/feature. Chưa nói: xoá feature còn màn/function thì sao. | Không tự xoá (restrict): từ chối lô, trả `referrers`. Chính sách từng field ở `cascade.ts` `CASCADE_POLICY` và contract §0.2. |
| 2026-09-14 | T08 | srs-spine §6 | Bất biến 1, 2, 8 viết tuyệt đối thì Spine mới (mảng rỗng) bị từ chối mọi lô; 3–6 tuyệt đối thì Spine migrate có lỗi sẵn không sửa được gì. | 1, 2, 8 so trước/sau lô (chỉ chặn việc xoá); 3–6 chỉ chặn vi phạm mới. Lỗi có sẵn hiện qua cờ đỏ T09. |
| 2026-09-14 | T08 | srs-spine §6 bất biến 5 | `functions[].order` chỉ "duy nhất trong feature", không nói liên tục (fixture T02 lại kiểm liên tục). | Engine chỉ đòi duy nhất; xoá function không renumber (khớp case-03). `renumber functions[]` có sẵn nếu cần. |
| 2026-09-14 | T08 | srs-spine §2 `changes[]` | Không có chỗ lưu vị trí phần tử bị xoá và phân biệt "key không tồn tại" với `null` — revert không khôi phục deep-equal được. | Mã hoá trong `before`/`value`: `{_absent: true}` / `{_absent: true, index}` (op.types.ts `ABSENT`). |
