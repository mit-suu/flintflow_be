---
skill_id: references-list
kind: content
version: 0.1.0
description: "IEEE 29148 References - list the documents the SRS actually depends on into references[] (Mode 1 slot:references)"
provider: anthropic
aiModel: claude-haiku-5-5
maxTokens: 4096
temperature: 0.2
reads:
  - "references[]"
  - "business_rules[]"
  - "nfrs[]"
  - "other_requirements[]"
  - "project"
writes:
  - "references[]"
  - "assumptions[]"
output_schema: opTransaction
language: en
stub: false
---
# References

Covers the **References** section of an ISO/IEC/IEEE 29148 template (jam01 §1.4, IEEE 830 §1.4) - feeds
`slot:references`, which exists only for uploaded templates (Mode 1). It renders as a table: ID · Title · Owner ·
Version · Date · Location · Kind. `references/*.md` are **not loaded at runtime**; rules are inlined.

Shape: `{ id, title, owner?, version?, date?, location?, kind: "normative" | "informative" }`.

## Sources - and only these

1. Documents the analyst attached or quoted in the change request / instruction (`documents`, `materials`).
2. Standards, laws and policies the Spine already names: in `business_rules[].statement`, `nfrs[].statement`,
   `other_requirements[].statement` (e.g. "GDPR", "ISO 27001", "Thông tư 08/2021/TT-BGDĐT", "WCAG 2.1 AA").
3. The template's own guidance for this section (`Template guidance:` in the target sections) - it says what
   kind of documents belong here, never which ones.

If a document is not in one of these sources it does not exist for this SRS. Never invent a code, date, version,
owner or URL to make a row look complete.

## Writing a row

- `title`: the document's name as the source writes it ("ISO/IEC/IEEE 29148:2018 Systems and software engineering -
  Requirements engineering"); keep codes and years that are part of the name.
- `owner` / `version` / `date` / `location`: only when the source states them; otherwise **omit the field** (do not
  write `""`, "N/A" or "TBD"). A missing field the reader needs ⇒ one `assumptions[]` entry
  (`status: "unconfirmed"`) naming the document and the missing field.
- `kind`: `normative` when the Spine or the source says the product **must comply** ("phải tuân", "shall comply",
  "bắt buộc", a law or regulation); `informative` for background reading, prior versions, vendor guides.
- `location`: document code, URL or repository path exactly as given.

## Rules

1. Ids continue `REF-NN` from the projection (`draft-to-ops` rule 5); never renumber or reuse an existing id.
2. One row per document. Same document cited twice (by short and long name) ⇒ one row with the full title.
3. Do not edit `business_rules[]`, `nfrs[]` or `other_requirements[]` - if a standard is cited wrongly there, say
   so in `notes`.
4. A row whose document is no longer cited anywhere is removed only when the instruction asks for it.
5. English `title` unless the document's official title is in another language - then keep the official title.

## Example

```json
{
  "ops": [
    { "op": "add", "path": "references[]", "value": { "id": "REF-01", "title": "ISO/IEC/IEEE 29148:2018 Requirements engineering", "version": "2018", "kind": "normative" }, "reason": "Template follows 29148; NFR-03 requires the SRS to comply" },
    { "op": "add", "path": "references[]", "value": { "id": "REF-02", "title": "Thông tư 08/2021/TT-BGDĐT", "owner": "Bộ Giáo dục và Đào tạo", "kind": "normative" }, "reason": "BR-04 cites it for grade rules" },
    { "op": "add", "path": "assumptions[]", "value": { "id": "AS01", "path": "references[id=REF-02].date", "statement": "Issue date of the cited circular is not stated.", "rationale": "No source gives the date; it was not invented.", "origin_step_id": "C-4", "status": "unconfirmed", "confirmed_at": null }, "reason": "Date unknown - not invented" }
  ],
  "notes": "Did not add the vendor API guide - mentioned in chat but no title or link given."
}
```

## Self-check

- [ ] Every standard, law or policy named in the Spine has exactly one row.
- [ ] No row without a source; no invented code, date, version or URL.
- [ ] `kind` is normative only where compliance is required.
- [ ] Ids continue the existing `REF-NN` sequence; no duplicate titles.
