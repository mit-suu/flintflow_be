# _archive — prompt của ActionType đã ngừng dùng

Thư mục này **không được loader quét** (`src/shared/ai/prompt-assets.ts` →
`IGNORED_DIRS`), nên các file ở đây **không** được seed vào DB và **không** tính
là asset mồ côi.

## Vì sao ở đây chứ không xoá

7 prompt dưới đây thuộc các `ActionType` đã bị bỏ khỏi enum ở Stage −1.5, vì
chúng chỉ xuất hiện trong bảng cấu hình (cost map, context-needs map, schema
map) mà **không luồng tính năng nào gọi tới** — chỉ tới được qua endpoint
generic `POST /api/v1/ai-actions/execute`.

Nhưng prompt là **nội dung đã viết ra**, không phải code chết: giá giữ lại gần
bằng 0, còn giá trị khi cần tra cứu hoặc hồi sinh thì có thật.

| File | ActionType cũ | Ghi chú |
| --- | --- | --- |
| `summarize.md` | `summarize` | Tóm tắt chung |
| `extract.md` | `extract` | Trích thông tin dạng JSON |
| `analysis.md` | `analysis` | Phân tích yêu cầu |
| `clarification.md` | `clarification` | Hỏi làm rõ |
| `verification.md` | `verification` | Kiểm tra chất lượng yêu cầu |
| `rewrite.md` | `rewrite` | Viết lại nội dung |
| `generate_diagram.md` | `generate_diagram` | **Sinh Mermaid** — lệch với pipeline thực tế (Excalidraw) và với hướng đã chốt (PlantUML render phía server, Phases §7.1) |

## Cách hồi sinh một prompt

1. Thêm lại member vào `ActionType` (`src/shared/ai/ai-action.types.ts`).
2. Thêm entry vào `DEFAULT_ACTION_COSTS` (`credit-reservation.service.ts`) và
   `ACTION_NEEDS_SOURCE_DOCUMENTS` (`document-context.service.ts`).
3. Thêm Zod schema vào `SCHEMAS` (`response-parser.ts`).
4. `git mv` file từ `_archive/` lên `assets/prompts/`.
5. `npm test` — test sẽ xác nhận asset ↔ ActionType khớp cả hai chiều.
