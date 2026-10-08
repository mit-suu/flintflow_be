# Knowledge RAG (FLF-267)

Hỏi đáp có căn cứ trong chat: người dùng bật cờ `knowledge: true` khi gửi tin, server truy hồi chunk từ **kho tri thức**
(phase 1: chính các skill nội bộ `assets/skills/**/SKILL.md`; phase 2: chuẩn ngoài như ISO 29148, mỗi chuẩn là một thư
mục file điều khoản + `index.md`), rồi model trả lời **chỉ từ các chunk đó**, mỗi ý kèm nhãn trích dẫn. Không đủ căn
cứ ⇒ câu từ chối cố định, không gọi model, không trừ credit. Hợp đồng HTTP: `docs/api/pipeline-contract.md` §1.2.

Code: `src/modules/knowledge/` · vận hành: `docs/ops.md` "Knowledge RAG" · eval: `npm run eval:knowledge`.

## 1. Corpus đo được (assets/skills, lúc thiết kế)

| Số đo | Giá trị |
| --- | --- |
| File `SKILL.md` | 39 (skill `knowledge-answer` của chính tính năng này bị loại: `knowledge_index: false`) |
| Section `##` / `###` | 244, ~69k token |
| Token / section | trung vị 203, p90 543, max 1857 |
| Section < 80 token | 18 |
| Section > 800 token | 9 — phần lớn là danh sách "Rules" đánh số |
| Heading lặp | "Rules" ở 27 file, "Self-check" 16, "Output" 15 |
| Block | 916 mục danh sách, 155 dòng bảng, 40 code block |

## 2. Chunking — vì sao theo section

- **Đơn vị = section dưới `##`/`###`**, giữ `heading_path` (`["Lenses","Ambiguity"]`); chữ trước `##` đầu là `Overview`.
  Skill được viết theo section có chủ đề rõ (Rules, Lenses, Output) — cắt theo section giữ nguyên một ý trọn; cửa sổ cố
  định cắt ngang luật đánh số và bảng.
- **Tách block bằng tokenizer theo dòng** (không thêm dependency): code fence và bảng không bao giờ bị cắt; một mục danh
  sách (kể cả dòng nối tiếp thụt lề, danh sách con, code fence thụt lề) là một khối nguyên tử; dòng chú thích HTML
  (`<!-- voice:shared:start -->`) bị bỏ, chữ giữa hai mốc giữ.
- **Token ước lượng = ceil(ký tự / 3,5)** — chữ tiếng Anh nhiều ký hiệu markdown ra ~3,5–4 ký tự/token; lấy 3,5 để nghiêng
  về phía nhiều token. Mục tiêu 150–500, trần cứng 800.
- **Gộp**: section < 80 token (18 section) gộp vào section kế tiếp (cuối file ⇒ section trước), nhãn nối heading
  (`Context + Rules`). Chunk quá nhỏ embed ra vector nhiễu và tốn một hạng trong top-K.
- **Cắt**: section > 800 token chỉ cắt ở ranh giới block, nhồi tham lam tới ~500; danh sách đánh số mang dải luật trong
  nhãn và id (`Rules (4–6)`, `draft-to-ops#rules/4-6`); phần không đánh số mang `part n`. Một block > 800 (bảng / code
  khổng lồ) giữ nguyên, ghi cảnh báo.
- **Header ngữ cảnh** nối trước chữ khi embed và khi index từ khoá (`embed_text`), không có trong chữ hiển thị (`text`):
  `Skill: <skill_id> (<kind>) — <description>` · `Section: <nhãn>` · `---`. Lý do: 27 skill có section "Rules"; không có
  header thì 27 chunk "Rules" gần như cùng chủ đề trong không gian vector, và câu hỏi "luật đặt tên use case" không biết
  rơi vào skill nào.
- **Id ổn định**: `<source>#<slug heading>[/<dải luật | part-n>]`, duy nhất trên corpus (có test). `parent_id` = id cả
  section để mở rộng small-to-big.

Số chunk hiện tại: `npm run ingest:knowledge -- --dir assets/skills --corpus skills --dry-run`.

## 3. Truy hồi

1. **Lọc metadata trước**: `corpus`, `status = verified` (chunk `placeholder` — chuẩn chưa ai xác minh — không bao giờ tới
   prompt), `applies_to` giao với step nếu người gọi đưa.
2. **Vector**: `atlas` = `$vectorSearch` trên index `knowledge_chunks_vector` (score Atlas `(1+cos)/2` đổi về cosine);
   `memory` = nạp embedding của corpus một lần (cache 5 phút), cosine vét cạn — corpus ~250 chunk × 768 chiều thì vét cạn
   rẻ hơn một round-trip mạng. `KNOWLEDGE_VECTOR_BACKEND=atlas` mà Mongo không có `$vectorSearch` (local / in-memory) thì tự
   lùi về `memory` (thăm dò một lần, nhớ cho cả process — cách làm của C-3 hybrid retrieval).
3. **Từ khoá**: Mongo `$text` trên `section` (×4) + `embed_text` (×1), ngôn ngữ english. Bắt được mã luật, tên field,
   id step (`S-3.2`, `dead_reference`) mà embedding hay làm nhoè.
4. **Gộp bằng Reciprocal Rank Fusion**: `rrf = Σ 1/(60 + rank)` trên hai danh sách (mỗi danh sách 20 ứng viên). Gộp theo
   hạng nên không phải chuẩn hoá cosine với textScore; k = 60 theo bài gốc — một hạng đầu ở MỘT danh sách không lấn át
   chunk đứng khá ở cả hai.
5. **Small-to-big**: chunk là một phần của section bị cắt và cả section ≤ 900 token ⇒ đưa cả section vào prompt.
6. **Từ chối**: cosine của chunk gần nhất < `KNOWLEDGE_MIN_SCORE` ⇒ không đủ căn cứ. Không có vector (embedding tắt) ⇒
   chỉ từ khoá, từ chối khi không có kết quả.

## 4. Trả lời có căn cứ

- Skill `action/knowledge-answer` (`ActionType.KNOWLEDGE_ANSWER`, 2 credit, output `knowledgeAnswer`
  `{ grounded, answer, claims: [{ text, refs }] }`). Prompt gắn nhãn chunk `K1..Kn` kèm `source`, `section`, `kind`;
  chunk `internal_skill` luôn ghi là **FlintFlow internal guideline** — model không được gọi nó là chuẩn ngành.
- Trả lời theo ngôn ngữ phiên chat (`replyLanguage`, FLF-260).
- **Hậu kiểm bằng code**: bỏ nhãn không có trong tập đã truy hồi, bỏ ý không còn nhãn hợp lệ, gỡ nhãn bịa khỏi câu trả
  lời; `grounded = false` hoặc hết ý ⇒ câu "không đủ căn cứ" (`ABSTAIN_REPLY`). `citations[]` chỉ gồm nhãn thật sự được trích.
- Một lượt hỏi = một câu, không đọc lịch sử chat (câu hỏi tri thức không phụ thuộc ngữ cảnh dự án).

## 5. Eval

`fixtures/knowledge-eval/questions.json`: 40 câu viết bằng cách đọc skill — 32 trong corpus (8 tra đúng luật, 7 diễn đạt
khác, 7 tiếng Việt hỏi nội dung tiếng Anh, 5 cần bảng/danh sách, 5 hỏi section "Rules" của các skill khác nhau), mỗi câu
2–4 `answer_points` và 1–2 `gold_chunk_ids` (id của chunker chính — test chặn id mất); 8 câu ngoài corpus (BABOK, ISO
29148, IEEE 829, Kano, IREB, giá gói…).

- `--retrieval-only` (chỉ embedding): ablation 3 chunker × 3 cách truy hồi. Chunker đối chứng có id khác id vàng nên
  **trúng** được định nghĩa theo khoảng chữ: chunk truy hồi chứa ≥ 50% chữ của chunk vàng (cùng tài liệu, cùng thân
  markdown). Từ khoá trong eval là **BM25 trong process** (chunker đối chứng không lưu DB), production là `$text` — số ô
  `lexical` là xấp xỉ. Sau đó quét ngưỡng 0,40–0,85 trên top cosine của cấu hình cuối, chọn ngưỡng F1 cao nhất.
- `--answers`: RAG vs no-RAG (cùng model, chỉ câu hỏi), judge LLM chấm đúng / trung thực / từ chối
  (`fixtures/knowledge-eval/judge.md` — prompt chỉ cho eval, không phải skill: không bao giờ chạy cho người dùng, không có
  `call_kind`, không trừ credit), cộng tỉ lệ nhãn hợp lệ đo bằng code.

### Kết quả (điền sau lượt eval thật)

| Chunker | Truy hồi | R@1 | R@3 | R@5 | MRR@10 |
| --- | --- | ---: | ---: | ---: | ---: |
| fixed-512/64 | lexical | | | | |
| fixed-512/64 | vector | | | | |
| fixed-512/64 | hybrid | | | | |
| heading-no-header | lexical | | | | |
| heading-no-header | vector | | | | |
| heading-no-header | hybrid | | | | |
| heading+header | lexical | | | | |
| heading+header | vector | | | | |
| heading+header | hybrid | | | | |

| Từ chối (heading+header · hybrid) | Ngưỡng chọn | F1 | Trong corpus được trả lời | Ngoài corpus bị từ chối |
| --- | ---: | ---: | ---: | ---: |
| | | | | |

| Câu trả lời | RAG | no-RAG |
| --- | ---: | ---: |
| Đúng (answer_points) | | |
| Trung thực | | — |
| Ảo giác ngoài corpus | | |
| Nhãn trích dẫn hợp lệ | | — |
