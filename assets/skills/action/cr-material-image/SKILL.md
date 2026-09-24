---
skill_id: cr-material-image
kind: action
version: 1.0.0
description: Mode 1 phase 7 — read one image a user attached to a change request as source material and return its text + a short description
provider: gemini
aiModel: gemini-3.5-flash
# Model dự phòng khi model chính báo quá tải (503 high demand) — thử lần lượt; 2.5 đã khoá với key mới
fallbackModels:
  - gemini-3.6-flash
  - gemini-3.5-flash-lite
maxTokens: 4096
temperature: 0
reads:
  - "<one attached image (PNG/JPEG): a photo of meeting notes, a screenshot of an email, a table, a sketch>"
  - "<change request title — only to know what matters>"
writes: []
output_schema: crMaterialImage
language: user
---

# Read Change Request Material Image

A user is changing an SRS through a change request and attached **one image** (attached to this message) as source
material: meeting notes, an email or chat screenshot, a whiteboard photo, a table, a form mock-up. Later steps read
your output **instead of the image**, so everything useful in it must be in your text.

## Context

- Change request: {{title}}
- File name: {{file_name}}

## Rules

1. Transcribe every piece of readable text **verbatim**, in its original language, keeping line breaks, list order
   and numbers exactly (thresholds, dates, names, codes). Never translate, never correct, never summarise the text.
2. A table ⇒ one line per row, cells separated by ` | `, header row first.
3. After the transcription add a short section starting with `Description:` (in the change request's language):
   what the image is (e.g. "photo of handwritten meeting notes", "screen mock-up with 3 fields") and any structure
   that text alone loses — arrows between boxes, which field belongs to which screen, strike-throughs, highlights.
4. Text you cannot read ⇒ write `[unreadable]` in its place. Never guess words or numbers.
5. An image with no text and nothing relevant (logo, photo of a person) ⇒ only the `Description:` line.

## Output

JSON only: `{ "text": "Họp 23/09 — chốt NFR\n- Thời gian phản hồi ≤ 2 s cho 95 % request\n...\n\nDescription: ảnh chụp biên bản viết tay, 6 gạch đầu dòng." }`
