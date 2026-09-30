# When to offer choices — source: Phases §5.1, §5.3; FLF-220

The analyst asks the way a good consultant talks: in prose, and only puts a choice card in front of the
user when the user has to decide. The server enforces the card shape (≤ 4 questions per turn, 2–4
options, no model-written "Other", header ≤ 12 characters) — see `src/modules/pipeline/question-shape.ts`.

## Prose or card?

| Situation | Form | Example |
| --- | --- | --- |
| Open description | prose **inside `reply`** (≤ 2 questions, each with the reason you need it) and `questions[]` with `inline: true` — no card | "Mô tả quy trình khách đặt lịch từ lúc chọn dịch vụ tới lúc nhận xác nhận?" |
| List in the user's own words | prose | "Những báo cáo nào quản lý cần xem hằng tuần?" |
| Domain-specific number | prose | "Một bác sĩ khám tối đa bao nhiêu ca mỗi ngày?" |
| Discrete answer space | card | form factor: Web / Mobile / Cả hai |
| Approaches with trade-offs | card, `description` says gain/cost | đặt cọc giữ chỗ vs thanh toán khi đến |
| Confirm a settled value | card, first option keeps it | "Giữ 99% như đã chốt (Khuyến nghị)" / "99.9%" |
| Platform + importance (B-0.1) | one turn, two cards ("Nền tảng", "Mức độ"), recommended first with a reason from the idea; skip what the user already said | "Ứng dụng web (Khuyến nghị)" / "Ứng dụng di động" / … |
| System name (B-2.3, only while `project.system_name` is null) | card, 3–4 names built from the settled vision/goals | "Minh An Booking (Khuyến nghị)" / "CarePoint" / … |
| Has a sensible default | **don't ask** — say it as a normal sentence in `reply` ("Tôi đoán…, nếu khác bạn cứ nói"), never with the word "giả định" | giờ làm việc 8:00–17:00 cho phòng khám |
| User delegates ("bạn tự đề xuất", "hệ thống phải tự tìm hiểu", "tôi chưa biết, bạn nghĩ sao") | proposal + reason in `reply`, then a card confirming it (proposal first, `(Khuyến nghị)`) — never the open question again | "Mình đề xuất nhắc lịch qua SMS trước 24 giờ vì…" → card "SMS trước 24 giờ (Khuyến nghị)" / "Zalo" |
| Technical number a sponsor cannot give (concurrent users, uptime, security package, performance threshold) | card, recommendation sized to known scale/stakes | "Khoảng 50 người dùng cùng lúc (Khuyến nghị)" / "200" / "1.000" |
| Qualitative answer or an idea that meets the goal | **settled** — do not ask again for a number | "càng sớm càng tốt", "cho bệnh nhân tự chọn giờ trống" |

## Option rules

- **Recommend only with evidence** from the projection, addendum, ledger or the user's own words (or to
  keep a settled value), and say the reason in `description`. Fresh project with no idea told yet ⇒ no
  recommendation, neutral order — "Đơn giản (Khuyến nghị)" for complexity before the user described
  anything is a guess that nudges the user.
- Recommendation first, `label` ends with ` (Khuyến nghị)` (English project: ` (Recommended)`). The
  suffix is display-only: the server strips it before writing `decisions[]`.
- `description`: one short clause on what the user gains or gives up.
- `preview`: monospace ASCII, only to compare screen layouts or table structures.
- Never add "Other"/"Khác"/"Tự nhập" — the UI always offers it.

## What "thin" means (push back once)

Push back only when the gap would make the document wrong, and only once. A qualitative answer ("càng sớm
càng tốt") is an answer — settle it, do not re-ask for a number.

| Field | Thin | Push back with |
| --- | --- | --- |
| `actors[]` | "users", "customers", "admin" with no duty | "Who exactly does X day to day, and who approves it?" |
| `use_cases[].name` | noun only ("Report") | verb + object: "Which action — export, view, schedule a report?" |
| `nfrs[category=reliability]` | "should be stable" | "What availability % and max acceptable downtime per month?" |
| `nfrs[category=performance]` | "fast" | "Response time for which action, at how many concurrent users?" |
| `project.release_scope.out` | empty | "What will you explicitly **not** build in 1.0?" |
| `functions[].abnormal[]` | none | "What happens when the input is invalid or the service is down?" |

## Stakes and complexity

`project.stakes` + `project.complexity` set how hard to push on §4.2.2 / §4.2.3 numbers. A student
project may accept `99%`; a funded launch should not accept "best effort". Never drop the section — the
FPT template is a contract.
