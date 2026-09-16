# Prompt phẳng — chỉ cho action ngoài pipeline

> Pipeline B-0 → S-9 dùng **skill** ở `assets/skills/` (xem `assets/skills/README.md`). Thư mục này chỉ còn prompt cho action **ngoài pipeline** (`chat`, `summarize_document`).

**Nguồn sự thật là đĩa.** Runtime đọc thẳng file ở đây qua `src/shared/ai/prompt-assets.ts`; không có override qua DB (collection `PromptTemplate` và trang admin prompt đã bỏ). Sửa prompt = sửa file + commit + deploy.

## Cấu trúc 1 file `.md`

```
---
actionType: <tên action>       # BẮT BUỘC — khớp ActionType enum
provider: glm                  # BẮT BUỘC — glm | openai | anthropic | gemini
aiModel: zai-org/GLM-5.3-Flash # BẮT BUỘC
maxTokens: 1024                # BẮT BUỘC
temperature: 0.3               # BẮT BUỘC
isActive: true                 # tùy chọn, mặc định true
description: Mô tả ngắn        # tùy chọn
---

Nội dung prompt... {{variable_name}} được thay lúc chạy.
```

## Các file hiện có

| File | actionType | Trạng thái |
|------|-----------|-----------|
| `chat.md` | `chat` | Dùng |
| `summarize_document.md` | `summarize_document` | Dùng |

`_archive/` — không nạp: prompt của action đã ngừng từ trước refactor, giữ để tra cứu.

Prompt section-based cũ (`generate_section`, `priority_ranking`, `scope_out_of_scope`, `chat_discovery`) đã **xoá ở T21** — thay bằng skill `draft-to-ops` + skill nội dung của từng step (S-2.2 cho scope, S-9.4 cho MoSCoW, B-* cho Discovery).

## Thêm action ngoài pipeline

1. Thêm giá trị vào `ActionType` (`src/shared/ai/ai-action.types.ts`).
2. Thêm Zod schema vào `SCHEMAS` (`src/shared/ai/response-parser.ts`) và giá vào `credit-reservation.service.ts`.
3. Tạo file `.md` ở đây. `npm test -- prompt-assets` bắt thiếu/trùng/mồ côi.

Action thuộc pipeline thì **không** tạo prompt phẳng — khai skill và thêm vào `SKILL_BY_ACTION_TYPE`.
