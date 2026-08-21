-- ADR-120: a captured field must name the utterance it came from.
--
-- `calls.captured_state` and `caller_memory.facts` used to hold bare strings
-- (`{"tobacco": "no"}`). They now hold provenance entries:
--
--   {"tobacco": {"value": "no", "heard": "...", "transcriptId": 44, "turn": 12}}
--
-- Both columns are already `jsonb`, so there is no DDL here and `db:generate`
-- produces nothing — the change is entirely in the shape of the documents, and
-- a hand-written data migration is the honest way to say that.
--
-- Why the backfill sets `heard` to the empty string rather than inventing one:
-- ADR-120 treats a value with no utterance behind it as *declared-not-heard*.
-- Every pre-migration row is exactly that — nobody recorded which caller line
-- the value came from, and reconstructing one from the transcript afterwards
-- would be manufacturing the provenance this whole mechanism exists to make
-- unmanufacturable. An empty `heard` reads as "unknown", never as a quote, and
-- `heardInCallerSpeech("")` is false by construction, so no backfilled row can
-- later be mistaken for a verified capture.
--
-- Scope, as of 2026-08-21: two `calls` rows and two `caller_memory` rows in
-- production, both calls from 2026-08-20 and both closed. Per the audit
-- (docs/audits/2026-08-21-first-two-production-calls.md, finding 2) neither
-- captured state was delivered anywhere, so this is a rewrite of four JSON
-- blobs, not a data-preservation problem.
--
-- Idempotent: an entry that is already an object carrying `value` is left
-- exactly as it is, so re-running this cannot double-wrap.

UPDATE "calls"
SET "captured_state" = (
  SELECT jsonb_object_agg(
    entry.key,
    CASE
      WHEN jsonb_typeof(entry.value) = 'object' AND entry.value ? 'value' THEN entry.value
      ELSE jsonb_build_object(
        -- `#>> '{}'` unwraps a JSON string to text; a non-string legacy value
        -- (a number a model once passed for `delivery_rating`) casts to its
        -- text form rather than being dropped.
        'value', CASE WHEN jsonb_typeof(entry.value) = 'string' THEN entry.value #>> '{}' ELSE entry.value::text END,
        'heard', '',
        'transcriptId', NULL,
        'turn', 0
      )
    END
  )
  FROM jsonb_each("calls"."captured_state") AS entry
)
WHERE "captured_state" IS NOT NULL
  AND "captured_state" <> '{}'::jsonb;
--> statement-breakpoint
UPDATE "caller_memory"
SET "facts" = (
  SELECT jsonb_object_agg(
    entry.key,
    CASE
      WHEN jsonb_typeof(entry.value) = 'object' AND entry.value ? 'value' THEN entry.value
      ELSE jsonb_build_object(
        'value', CASE WHEN jsonb_typeof(entry.value) = 'string' THEN entry.value #>> '{}' ELSE entry.value::text END,
        'heard', '',
        'transcriptId', NULL,
        'turn', 0
      )
    END
  )
  FROM jsonb_each("caller_memory"."facts") AS entry
)
WHERE "facts" <> '{}'::jsonb;
