---
skill_id: product-brief
kind: content
version: 0.3.0
description: "B-0 Intake, B-1 Product Brief, B-2 Brief Finalize — adapted from BMAD bmad-product-brief"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.3
reads:
  - "project"
  - "addendum[]"
  - "assumptions[]"
  - "other_requirements[]"
writes:
  - "project"
  - "addendum[]"
  - "assumptions[]"
  - "other_requirements[]"
output_schema: opTransaction
language: user
stub: false
---
# Product Brief

Covers the whole Brief phase: **B-0.1…B-0.3 intake · B-1.1…B-1.6 the brief itself · B-2.1…B-2.3 finalize**.
The Brief writes **no SRS section**; it fills `project{}` and stores everything else as `addendum[]` aimed at the
section it will later feed. S-1 turns that into structure; S-2 onward writes the document.

Two habits decide whether this phase is useful:

- **Write as you go.** Every step ends with ops. A fact that stays in the chat transcript is lost — the
  transcript is not read by later steps, only the Spine is.
- **Record the unknown, do not invent it.** Anything the user has not said becomes an `assumptions[]`
  entry (`status: "unconfirmed"`) or an `other_requirements[kind=open_question]`, never a confident
  sentence in the brief. What the user **did** say or pick (chat, cards, decisions ledger) is a fact —
  never an assumption, and never an assumption about their answer ("the goal is qualitative"). A user "yes/xác nhận"
  to a proposal makes it a fact: never re-add an existing assumption and never set its `status` (the user confirms at the gate); each assumption's `path` is the field it is about.

`references/*.md` are **not loaded at runtime** — the rules below are what you get.

## B-0 — Intake (3 steps)

- **B-0.1 Brain Dump — listen first.** The user's chat message is the idea; uploaded documents (if any)
  arrive in the content guidance. In one pass: write **one `addendum[]` entry per distinct topic** —
  `{id, topic, content (user's own words/language), content_en (English, for rendering), target_section,
  captured_at}`; set **`project.system_name`** (English name on diagrams and cover, never `project.name`)
  only if the user already gave one — otherwise leave it null (B-2.3 asks; never suggest a name here);
  set **`project.form_factor` and `project.stakes`** from what the user picked on the cards or said — no
  assumption for a value they chose; infer only what was neither picked nor said, **with an `assumptions[]`
  entry** and its reason. `notes`: the gate message (`draft-to-ops` rule 15: "tôi" not "mình", no "bước/giai đoạn/giả định/addendum/brief"), not a field list.
- **B-0.2 `project.form_factor`** — `web_app`, `mobile_app`, `desktop_app`, `api_service`, `cli`,
  `embedded`. Runs only when B-0.1 could not infer it (or on a revision).
- **B-0.3 `project.stakes`** — `internal` | `production` | `regulated`. Drives NFR defaults at S-6; a
  guess comes with an `assumptions[]` entry. B-0.3 closes B-0: on a revision it may fix any B-0 field.
- Never ask how the user wants to work and never write `project.working_mode` (retired): how much to ask
  is your call, and where the run stops for review is the AI settings menu.

### Write the rule the user actually stated (B-0.1, B-1.x)

A policy sentence has three parts: **the trigger, the window, and the consequence**. Keep them apart, and
never merge two policies into one rule. Lượt test: "huỷ hoặc đổi lịch sau hạn 2 giờ thì mất cọc" was
written down as a *no-show* rule — two different triggers (the customer cancelled late vs the customer
never showed up) collapsed into one, so the document stated a policy nobody agreed to.

When the user gives a number (2 hours, 15 minutes, 50.000đ), it belongs in the rule verbatim. When they
give a policy you are not sure how to classify, write it with the user's own trigger wording and ask at
the next turn — do not pick the neighbouring concept because it sounds close.

## B-1 — The brief (6 steps)

**Draft first, ask last.** Each step writes from what is already known — vision, goals, every addendum, the
decisions ledger, the user's answers — and records what it inferred as `assumptions[]` the user confirms at the
gate. A step with a draft to confirm asks **one** card ("Tôi đề xuất: … — đúng chưa?"), not a list of open questions.
Ask only what cannot be reasonably assumed **and** would make the document wrong; never re-ask what an
addendum or decision already holds, never ask what a later B-1 step owns (risks ⇒ B-1.6), never interview for a
section the product does not need. B-1 never writes `project.vision`/`project.goals` — vision and goals are addendum entries `topic: "vision"` / `"goals"`; S-1.1 turns them into the English SRS fields. Everything else is an addendum aimed at a section.

| Step | Writes | `target_section` |
| --- | --- | --- |
| B-1.1 Vision, problem, opportunity | addendum `vision` (ONE entry: who, what changes, why it matters) + addendum `goals` (ONE entry PER goal, 3–6, outcome-shaped — exactly the goals stated in `notes`, same count and wording) + problem/why-now; `content` in the user's language, `content_en` English | `fixed:1` |
| B-1.2 Target users & jobs-to-be-done | addendum per persona/stakeholder, with the job each one needs done | `fixed:2.1` |
| B-1.3 Value proposition & differentiation | addendum: what makes this worth using over the current way, per user group, drawn from vision/goals/B-1.2 — never invent a moat; no competitor questions or competitor assumptions for internal or public-sector projects | `fixed:1` |
| B-1.4 MVP scope & feature hypotheses | addendum per capability, and the explicit not-now list | `fixed:1`, `fixed:3.1.2` |
| B-1.5 Success metrics & learning goals | addendum per metric, with a number where the user gave one | `fixed:4.2.2`, `fixed:4.2.3` |
| B-1.6 Risks, assumptions, open questions | `other_requirements[]` (`kind` = `risk` / `assumption` / `open_question`) **and** `assumptions[]` for anything you filled in yourself | `fixed:5.4` |

Goal entries are outcomes, not features: "cut the time to a first usable SRS from weeks to a day",
not "add an export button". 3–6 of them; more than that and none of them is a goal.

## B-2 — Finalize (3 steps)

- **B-2.1 Assumption Sweep.** Present every `assumptions[status=unconfirmed]` gathered so far. The user
  confirms or rejects, one by one or the whole batch. Write `status` + `confirmed_at`; a rejected
  assumption means the underlying value is wrong — say what needs to change rather than leaving it.
- **B-2.2 Addendum Triage.** Go through `addendum[]`: **keep** (fix `target_section` if it is aimed at the
  wrong place), **park** (true but not this release — retarget it to `fixed:5.4` so S-7.4 picks it up as
  an Other Requirement), or **drop** (only when the content is *wrong*, never when it is merely deferred).
  May write `addendum[]` and `assumptions[]` only — parking is a retarget, not a move into
  `other_requirements[]`. `vision`/`goals` entries are always **keep** at `fixed:1`. Last cheap moment to fix a `target_section`.
- **B-2.3 Three-Lens Review.** Read the brief back through three lenses, one short paragraph each:
  **Skeptic** (what would make this fail, what is asserted without evidence), **Opportunity** (what the
  brief is under-claiming, what adjacent value is one step away), **Contextual** (what the domain,
  `stakes` and `form_factor` imply that nobody said out loud). Anything the lenses surface becomes an
  `other_requirements[]` or an `assumptions[]` entry — a lens finding with no op is a lens finding that
  never happened. `project.system_name` still null ⇒ if the answers hold a name the user picked, `set` it; none
  picked ⇒ leave it null, never invent one. Then hand over: accepting this gate opens S-1.

## Rules

1. Ids continue the existing sequence (`draft-to-ops` rule 5) — check the projection first.
2. `addendum[].target_section` must be a real section key (`fixed:*`, or `feature:<id>` / `function:<id>`
   once those exist). Unsure ⇒ `fixed:5.4`, and say so in `notes`.
3. `content` keeps the user's own words and language; `content_en` is the English version that will be
   rendered. Both are required, never empty. A vision/goals correction at any Brief gate ⇒ `set addendum[id=…].content` + `.content_en` (`add`/`remove` a `goals` entry), never `project.vision`/`project.goals`. An `assumptions[]` entry about vision/goals gets `path: "addendum[id=<that vision/goals entry>]"`, never `project.vision`/`project.goals`.
4. Never write `actors[]`, `use_cases[]`, `screens[]`, `functions[]` or any section here — the Brief is
   input to the SRS, not the SRS. Those come from S-2 onward.
5. Ask what changes the brief; fill the rest with the most reasonable reading plus `assumptions[]`
   entries — the user reviews them at B-2.1.
6. `reply` to the user is in **their language**; `content_en` and anything destined for the document is
   English (`draft-to-ops` rules 6–7).

## Example (B-1.1)

```json
{
  "ops": [
    { "op": "add", "path": "addendum[]", "value": { "id": "AD10", "topic": "vision", "content": "Giúp người sáng lập một mình biến ý tưởng thô thành SRS đầy đủ, nhất quán qua một cuộc trò chuyện có hướng dẫn.", "content_en": "Let a solo founder turn a raw product idea into a complete, internally consistent SRS through a guided conversation.", "target_section": "fixed:1", "captured_at": "2026-09-16T00:00:00.000Z" }, "reason": "B-1.1 vision" },
    { "op": "add", "path": "addendum[]", "value": { "id": "AD11", "topic": "goals", "content": "Rút thời gian có SRS đạt chuẩn từ vài tuần xuống một ngày.", "content_en": "Cut time to a baseline-quality SRS from weeks to one day", "target_section": "fixed:1", "captured_at": "2026-09-16T00:00:00.000Z" }, "reason": "B-1.1 goal 1 of 3 (goals 2 and 3 are their own entries)" },
    { "op": "add", "path": "addendum[]", "value": { "id": "AD13", "topic": "Why now", "content": "Đội nhỏ không thuê được BA, tài liệu viết tay lệch nhau giữa các phần.", "content_en": "Small teams cannot hire a requirements engineer, and hand-written documents drift between sections.", "target_section": "fixed:1", "captured_at": "2026-09-16T00:00:00.000Z" }, "reason": "B-1.1 problem statement" },
    { "op": "add", "path": "assumptions[]", "value": { "id": "AS01", "path": "addendum[id=AD11]", "statement": "The first release serves one team of up to 10 people.", "statement_vi": "Bản đầu phục vụ một nhóm tối đa 10 người.", "rationale": "Team size was never mentioned; it sets the scale the goals are measured at.", "rationale_vi": "User chưa nói quy mô nhóm; quy mô quyết định mục tiêu đo ở mức nào.", "origin_step_id": "B-1.1", "status": "unconfirmed", "confirmed_at": null }, "reason": "B-1.1 scale nobody stated" }
  ],
  "notes": "Tôi đã ghi lại tầm nhìn và ba mục tiêu của bạn, còn lý do cần làm ngay thì để ở phần tổng quan."
}
```

## Self-check

- [ ] Every step ended with at least one op — nothing important left only in the chat.
- [ ] `form_factor`, `stakes` set by the end of B-0; `system_name` (English, user-picked only) by the end of B-2.
- [ ] Addendum `vision` + 3–6 `goals` (each `content` + `content_en`) by the end of B-1.1; no `project.vision`/`goals`.
- [ ] Every addendum has `content`, `content_en` and a real `target_section`.
- [ ] Everything you filled in yourself has an `assumptions[]` entry, not a confident sentence.
- [ ] B-2.1 left no `unconfirmed` assumption unasked; B-2.2 left no addendum untriaged, and parked ones
      point at `fixed:5.4`.
- [ ] B-2.3 produced ops, not just three paragraphs.
- [ ] No `actors[]`, `use_cases[]`, `screens[]`, `functions[]` or `sections[]` written anywhere.
