# When to offer choices — source: Phases §5.1, §5.3; FLF-220

The analyst asks the way a good consultant talks: in prose, and only puts a choice card in front of the
user when the user has to decide. The server enforces the card shape (≤ 4 questions per turn, 2–4
options, no model-written "Other", header ≤ 12 characters) — see `src/modules/pipeline/question-shape.ts`.

## Prose or card?

Whether to ask at all is decided in one place only — the **ask test** in `SKILL.md`. This table is examples of
what its three steps come out as; when a row and the ask test disagree, the ask test wins and the row is wrong.

| Situation | Form | Example |
| --- | --- | --- |
| Open description | prose **inside `reply`** (≤ 2 questions, each with the reason you need it) and `questions[]` with `inline: true` — no card | "Mô tả quy trình khách đặt lịch từ lúc chọn dịch vụ tới lúc nhận xác nhận?" |
| List in the user's own words | prose | "Những báo cáo nào quản lý cần xem hằng tuần?" |
| Domain-specific number, working hours, threshold, process step | **ask** (prose unless the answers are discrete) — a plausible default here is still a guess about the customer's business, and it goes on to decide business rules and NFR numbers | "Một bác sĩ khám tối đa bao nhiêu ca mỗi ngày?"; "Phòng khám mở cửa những giờ nào trong tuần?" |
| Discrete answer space | card, `multiple: true` when several apply — never an "all of the above" option, the user ticks what fits | form factor: Web / Mobile / Desktop / API |
| Approaches with trade-offs | card, `description` says gain/cost | đặt cọc giữ chỗ vs thanh toán khi đến |
| Confirm a settled value | card, first option keeps it — the **question** must name what is being reopened and why, never leave that to the options | "Uptime 99% đã chốt ở phần trước; con số này quyết định có cần máy chủ dự phòng, bạn giữ hay nâng?" → "Giữ 99% như đã chốt (Khuyến nghị)" / "99.9%" |
| Platform + compliance (B-0.1) | one turn, two cards ("Nền tảng", "Tuân thủ"), recommended first with a reason from the idea; skip what the user already said | "Ứng dụng web (Khuyến nghị)" / "Ứng dụng di động" / …; "Yếu tố tuân thủ, pháp lý của dự án này như thế nào?" → "Tuân thủ quy định nội bộ" / "Tuân thủ quy định nội bộ và pháp luật" |
| System name (B-2.3, only while `project.system_name` is null) | card, 3–4 names built from the settled vision/goals | "Minh An Booking (Khuyến nghị)" / "CarePoint" / … |
| A wrong guess still leaves the document right | **don't ask** — say it as a normal sentence in `reply` ("Tôi đoán…, nếu khác bạn cứ nói"), never with the word "giả định". This row never covers a number, an hour or a rule of the customer's business — that is the row above | ngôn ngữ giao diện tiếng Việt, định dạng ngày dd/mm/yyyy, đơn vị tiền VNĐ |
| User delegates ("bạn tự đề xuất", "hệ thống phải tự tìm hiểu", "tôi chưa biết, bạn nghĩ sao") | proposal + reason in `reply`, then a card confirming it (proposal first, `(Khuyến nghị)`) — never the open question again | "Mình đề xuất nhắc lịch qua SMS trước 24 giờ vì…" → card "SMS trước 24 giờ (Khuyến nghị)" / "Zalo" |
| Technical number a sponsor cannot give (concurrent users, uptime, security package, performance threshold) | card, recommendation sized to known scale/stakes — a bare number is not an option: every `description` says what that number buys or costs in business words | "Khoảng 50 người dùng cùng lúc (Khuyến nghị)" — *đủ cho một phòng khám, một máy chủ thường* / "200 người cùng lúc" — *chịu được giờ cao điểm nhiều cơ sở, cần thêm máy chủ* / "1.000 người cùng lúc" — *cỡ toàn tỉnh, chi phí hạ tầng tăng rõ* |
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
| `nfrs[category=reliability]` | "should be stable" | "What availability % do you need?" — one question only: downtime per month follows from the % (99% ≈ 7,2 h/month), so asking both invites two answers that contradict each other |
| `nfrs[category=performance]` | "fast" | "Which action has to feel instant?" — settle the action first; the concurrent-user count is a separate question, and a card (sponsors cannot give that number) |
| `project.release_scope.out` | empty | "What will you explicitly **not** build in 1.0?" |
| `functions[].abnormal[]` | none | "What happens when the input is invalid or the service is down?" |

## Stakes and complexity

`project.stakes` + `project.complexity` set how hard to push on §4.2.2 / §4.2.3 numbers. A system used
inside the team that builds it may accept `99%`; a system with real users outside it, and above all one
under legal requirements, should not accept "best effort". Never drop the section — the FPT template is a
contract.
