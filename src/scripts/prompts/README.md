# Prompt Templates — Hướng dẫn chỉnh sửa

Thư mục này chứa các file `.md` — mỗi file là một **prompt template** cho một AI action.

## Cách sử dụng

```bash
# Xem trước kết quả parse (KHÔNG ghi DB):
npx tsx src/scripts/seed-from-md.ts --dry-run

# Seed thật vào MongoDB:
npx tsx src/scripts/seed-from-md.ts
```

Chạy lại nhiều lần an toàn — script tự phát hiện thay đổi và chỉ cập nhật khi cần.

---

## Cấu trúc 1 file `.md`

```
---
actionType: <tên action>      # BẮT BUỘC — khớp với ActionType enum trong BE
provider: gemini              # BẮT BUỘC — openai | anthropic | gemini
aiModel: gemini-3.5-flash     # BẮT BUỘC — tên model cụ thể
maxTokens: 1024               # BẮT BUỘC — số token tối đa
temperature: 0.3              # BẮT BUỘC — 0.0 (deterministic) → 1.0 (creative)
isActive: true                # tùy chọn, mặc định true
description: Mô tả ngắn      # tùy chọn
---

Nội dung prompt gửi cho LLM...
Dùng {{variable_name}} cho các biến sẽ được thay thế lúc runtime.
```

---

## Các file hiện có

| File | actionType | Mô tả |
|------|-----------|-------|
| `summarize.md` | `summarize` | Tóm tắt văn bản đầu vào |
| `extract.md` | `extract` | Trích xuất thông tin có cấu trúc |
| `analysis.md` | `analysis` | Phân tích rủi ro, mục tiêu, ràng buộc |
| `clarification.md` | `clarification` | Soạn câu hỏi làm rõ |
| `generate_section.md` | `generate_section` | Viết tài liệu đặc tả cho một phần |
| `verification.md` | `verification` | Kiểm tra chất lượng tài liệu |
| `rewrite.md` | `rewrite` | Viết lại nội dung theo chuẩn kỹ thuật |

---

## Thêm actionType mới

1. Cập nhật `ActionType` enum trong `src/shared/ai/ai-action.types.ts`.
2. Cập nhật `SCHEMAS` trong `src/shared/ai/response-parser.ts` với Zod schema tương ứng.
3. Tạo file `.md` mới trong thư mục này theo format trên.
4. Chạy `--dry-run` kiểm tra, rồi seed thật.

> **Không cần sửa `seed-from-md.ts`** — script tự đọc tất cả file `.md` trong thư mục.

---

## Các biến placeholder thường dùng

| Biến | Dùng trong action |
|------|------------------|
| `{{input_text}}` | summarize, extract, analysis, clarification |
| `{{specification}}` | verification |
| `{{content}}` | rewrite |
| `{{context}}` + `{{section_name}}` | generate_section |
