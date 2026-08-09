# ADR-089: An import that cannot be previewed is tested on a live call

- Status: Accepted
- Date: 2026-08-09
- Supersedes: none
- Amends: none
- Related: ADR-085 (lead greeting binding), ADR-087 (intake schema binding), ADR-088 (capture guard), native-leads-layer-plan-2026-07-19 §4/§5/§7

## Context

Every lead source in the product spoke JSON. `POST /api/leads/ingest` is
JSON + API-key; the Leads page could export a CSV and not import one. The only
occurrence of the string `csv` in the API package was a comment.

The delivery format a real outbound account actually hands over is a
spreadsheet. So the path to a first dial was: open the file, hand-map the
columns, hand-write JSON, POST it. Once. Per file.

The mechanical gap is not the interesting part. The interesting part is **how a
CSV import fails**, given the layers ADR-087 and ADR-088 put in:

- `validateFields` is allowlist-shaped and drops unknown keys **silently, by
  design** — that is correct for a webhook that over-sends, and catastrophic for
  a spreadsheet whose header row says `Phone1`, `First Name`, `ST`, `Lead Type`.
- A file where every column is unmapped therefore imports **successfully**, as a
  list of bare phone numbers with empty `fields`.
- An outbound template opens with `{{lead_name}}` / `{{interest_area}}`. With
  empty fields the unresolved-tag guard rejects the opener and the agent
  improvises a greeting — ADR-085's exact failure, arriving through a new door.

Which means the report of the defect is a live call to a real consumer. That is
the wrong test environment.

## Decision

Add `POST /api/leads/ingest/csv`, and make **dry run the default**.

`dryRun` is only false when the caller sends the literal string `false`. Absent,
empty, `0`, `no`, misspelled — all preview. The safe branch has to be the one you
get by accident.

The preview is a per-column mapping table, not a row count:

| reported | why it is there |
| --- | --- |
| `kind` + `target` per column | shows `ST -> state` and `Lead Type -> product_interest` before the write, so a mismatch is a five-second read |
| `viaAlias` | distinguishes "matched the schema key" from "we guessed via an alias" |
| `samples` | proves the mapping is plausible; a `state` column full of phone numbers is obvious here and invisible in a count |
| `droppedUnknownColumns` | the silent drop, made loud |
| `rejectedRegulatedColumns` | names only — see below |
| `missingSchemaKeys` | the schema fields this file cannot fill, e.g. `interest_area` |
| `issues` | per-row skips with a **spreadsheet line number** |
| `warnings` | out-of-options enum values |
| `errors` | blocking — a plan carrying one is refused even with `dryRun=false` |

`planCsvImport` is pure and DB-free, and the executor consumes the same plan
object the preview summarizes — so what was approved is literally what runs, and
"will this export map correctly?" is answerable in a unit test rather than
against production.

### Specific decisions worth their own line

**A bare national number is refused, not guessed.** `normalizePhone` promotes
`(555) 123-4567` only when the caller supplies `defaultCountryCode`. There is no
inferred default. Assembling a dialable number out of an assumption is how you
place an outbound call to a stranger in the wrong country, on an account whose
whole compliance story is that it knows who it is calling.

**Two phone columns is an error, not a preference.** Picking the leftmost would
work most of the time, and the times it did not would be undiscoverable.

**Regulated columns are named, never read.** A CSV is the most likely place an
SSN or DOB column arrives, because whoever ran the export exported everything
they had. Regulated columns collect no samples, contribute no fields, and their
values appear nowhere in the plan — asserted by serializing the whole plan and
grepping it for the secrets. The row still imports; a regulated column is
dropped, not fatal.

**Out-of-options enum values warn instead of dropping.** `validateFields`
*coerces* an unknown enum value to the raw string rather than rejecting it
(verified, not assumed). So `Lead Type = mystery-product` lands in
`product_interest` as-is and nothing can group by it. Changing that coercion is a
change to every ingest path and out of scope here; naming it in the preview is
not. `VALUE_ALIASES` covers the shorthand exports actually use — `FEX` →
`final_expense`, `Y`/`N` → boolean — and a test asserts every aliased value is
one the schema's `options` allows, so the alias table cannot drift out of the
enum.

**Blank lines are skipped during iteration, not filtered beforehand.** Filtering
first renumbers every row after the blank, and a row number that does not match
what the operator sees in their spreadsheet is worse than no row number.

**The alias list is deliberately short.** A missing alias surfaces in
`droppedUnknownColumns` and someone adds it. A wrong alias silently writes the
wrong value into a field the agent reads aloud to a consumer. Ambiguous headers
are left unmapped. A test asserts every alias target exists in a real schema, so
the table cannot point at a key that no longer exists.

**One failed row does not abandon the file.** Each `upsertLead` is
try/caught and failures are returned as row numbers, so a partial import is
re-sendable rather than a mystery about where it stopped.

**A hand-rolled RFC-4180 parser**, not a dependency: quoted fields, `""`
escapes, embedded commas and newlines, CRLF, BOM. A 40-line state machine on an
ingest path beats a transitive dependency tree, and the input is untrusted
merchant data.

## Consequences

- The enum warning is load-bearing, not cosmetic. `interest_area` is derived at
  greeting time from `product_interest` via `SPOKEN_INTEREST`, so a file with only
  `Lead Type = FEX` binds the opener correctly even though `interest_area` shows
  in `missingSchemaKeys`. But an out-of-options value misses `SPOKEN_INTEREST`,
  yields no `interest_area`, and the opener falls back to an improvised greeting —
  the warning is the only place that shows up before the call.
- A mismatched header row is now discovered in the preview instead of on a live
  call. That is the whole return on this ADR.
- Import is API-key authed and org-scoped by the key, same as JSON ingest — a
  CSV cannot name an org.
- 5MB ceiling; past that the answer is a streamed importer, not a bigger string.
- Not decided here: a UI. The Leads page still has Download and no Upload, so
  today this is a `curl`. The preview payload is shaped to render as a table when
  that lands.
- Not decided here: per-column manual override. Today a column that does not
  match an alias is dropped and the fix is to rename the header or add an alias.
  An explicit mapping object is the natural next step once a real export shows
  headers worth mapping but not worth aliasing globally.
- Still open: no real Peterson export header row has been seen. The alias list
  covers the shapes vendor exports commonly use, which is an educated guess, not
  evidence. The preview is what converts that guess into a two-minute check.

## Verification

- `bun test src/voice/leads/csv-import.test.ts` → 28 pass / 0 fail / 148
  expect(). Covers the parser (quotes, embedded newlines, CRLF, BOM, trailing
  newline), header normalization, phone promotion and refusal, a realistic vendor
  export mapping end to end, schema-key-beats-alias precedence, regulated columns
  with a whole-plan secret grep, both blocking errors, row-number alignment
  across a blank line, enum warnings, and two drift guards on the alias tables.
- `bun test src/voice/leads/csv-ingest-route.test.ts` → 16 pass / 0 fail / 53
  expect(). Covers auth, the dry-run default across five malformed flags,
  multipart and raw bodies, org scoping, source defaulting, partial-failure
  reporting, and that a preview writes nothing.
- Full gate: `bun run typecheck` clean, `bun run lint` 0 warnings / 0 errors,
  `bun run test` → 1242 pass / 0 fail (1097 api + 71 compliance + 74 web), up
  from 1198.
