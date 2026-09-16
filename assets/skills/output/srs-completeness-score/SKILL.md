---
skill_id: srs-completeness-score
kind: output
version: 0.2.0
description: "S-9.1 Completeness & Assumption Sweep — readiness feedback, never a gate threshold"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 1024
temperature: 0.1
reads:
  - "sections[]"
  - "steps[]"
  - "changes[]"
  - "flags[]"
  - "assumptions[]"
  - "glossary[]"
writes:
  - "flags[]"
output_schema: none
language: user
stub: false
---
# SRS Completeness Score

Định nghĩa **điểm sẵn sàng** hiển thị ở S-9.1 và ở thanh Verification. Đây là tài liệu công thức, không
phải prompt: S-9.1 chạy **tất định** trong `modules/pipeline/s9/completeness-sweep.ts`, không gọi model,
không Meter — hết credit vẫn quét được.

## Điểm sẵn sàng

```
accepted_pct = count(section accepted) / count(section bắt buộc, không suy dẫn) × 100
```

- Mẫu số bỏ `fixed:I` và `fixed:5.5` (suy dẫn — render lại từ Spine mỗi lần, không có khái niệm "chấp
  nhận") và bỏ `fixed:4.2.4` (không bắt buộc).
- `status(section)` là hàm tính (`section-status.ts`), không lưu DB: `accepted` khi mọi step sở hữu
  section đó đã accepted và không có change nào nuôi nó đến sau mốc accept.
- Làm tròn về số nguyên. Hiển thị kèm ba con số thô để người đọc không phải tin một số duy nhất:
  `awaiting_reaccept`, `stale`, `red_open`.

## Điều kiện chốt baseline — KHÔNG phải điểm này

Baseline chỉ có **một** điều kiện: `count(cờ đỏ resolved_at = null và chưa waive) = 0` trên đúng
`spine_version` đang ký (`baseline.service.ts`). Không có ngưỡng phần trăm nào, ở đâu cả. Tài liệu 100 %
section accepted mà còn một `dead_reference` thì không ký được; tài liệu 82 % mà sạch cờ đỏ thì ký được.

Lý do: phần trăm section đo *đã đi qua bao nhiêu bước*, còn cờ đỏ đo *có gì đang gãy*. Chỉ cái thứ hai
mới là thứ làm tài liệu sai.

## S-9.1 quét những gì

1. **Deterministic check với `atBaseline: true`** — bật thêm 4 luật chỉ chạy ở S-9:
   `unconfirmed_assumption`, `section_stale_at_baseline`, `section_awaiting_reaccept`,
   `screen_pending_at_baseline`. Bốn luật này đều **waive được** (có lý do ≥ 20 ký tự), khác với
   `array_empty` / `dead_reference` / `render_error` là lỗi kỹ thuật, không bao giờ waive.
2. **Giả định chưa xác nhận sinh trong pha SRS** (`origin_step_id` bắt đầu bằng `S-`) — user duyệt lẻ
   hoặc duyệt cả lô. Giả định pha Brief đã qua B-2.1 Assumption Sweep, không hỏi lại.
3. **Glossary có lạc hậu không** — `fixed:5.5` là section suy dẫn nên `status()` không bao giờ ra
   `stale`; phải so mốc accept của S-8.1 với các change đến sau. Có thì nên quay lại S-8.1
   (gate `revision`) trước khi ký, vì thuật ngữ mới thêm ở S-4…S-7 chưa vào glossary.

## Đọc kết quả

| Thấy gì | Nghĩa là |
| --- | --- |
| `red_open > 0` | Chưa ký được. Sửa dữ liệu, hoặc waive kèm lý do nếu luật cho phép |
| `waived > 0` | Ký được, nhưng baseline sẽ mang hậu tố `-conditional` |
| `stale > 0` | Có section nuôi bởi thay đổi đến sau lúc chấp nhận — cân nhắc hoà giải (UC 6.10) |
| `awaiting_reaccept > 0` | Hoà giải đã sửa nội dung, đang chờ chấp nhận lại ở gate |
| `glossary_needs_rerun` | Chạy lại S-8.1 rồi hãy ký |
