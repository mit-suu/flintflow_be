# Prompt phẳng — chỉ cho action ngoài pipeline

> Pipeline B-0 → S-9 dùng **skill** ở `assets/skills/` (xem `assets/skills/README.md`). Thư mục này chỉ còn prompt cho action **ngoài pipeline** và action **legacy** chờ T21 gỡ.

**Nguồn sự thật là đĩa.** Runtime đọc thẳng file ở đây qua `src/shared/ai/prompt-assets.ts`; không còn override qua DB hay trang admin (trang admin prompt chỉ đọc, POST/PUT/PATCH trả 410). Sửa prompt = sửa file + commit + deploy.

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
| `generate_section.md` | `generate_section` | Deprecated → `draft` + skill nội dung (T14/T18) |
| `priority_ranking.md` | `priority_ranking` | Deprecated → S-9.4 (T19) |
| `scope_out_of_scope.md` | `scope_out_of_scope` | Deprecated → S-2.2 (T14) |
| `chat_discovery.md` | `chat_discovery` | Deprecated → `discovery_step` (T20) |

`_archive/` — không nạp: action đã ngừng (`drawtest/diagram_*` của pipeline Excalidraw, và các prompt cũ).

## Thêm action ngoài pipeline

1. Thêm giá trị vào `ActionType` (`src/shared/ai/ai-action.types.ts`).
2. Thêm Zod schema vào `SCHEMAS` (`src/shared/ai/response-parser.ts`) và giá vào `credit-reservation.service.ts`.
3. Tạo file `.md` ở đây. `npm test -- prompt-assets` bắt thiếu/trùng/mồ côi.

Action thuộc pipeline thì **không** tạo prompt phẳng — khai skill và thêm vào `SKILL_BY_ACTION_TYPE`.

## Seed (legacy)

`npm run seed:md` vẫn ghi các file ở đây vào collection `PromptTemplate`, nhưng runtime **không đọc** collection đó nữa. Giữ script cho tới T21.
