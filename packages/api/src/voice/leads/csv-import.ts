/**
 * CSV lead import — parse, map, preview, then (only then) write.
 *
 * Why this exists (2026-08-09): every lead source in the product spoke JSON.
 * `POST /leads/ingest` is JSON + API-key, the Leads page could only export.
 * So the one delivery format a real outbound account actually hands over — a
 * spreadsheet — had to be hand-converted before a single call could be dialled.
 *
 * The important half of this module is not the writer, it is the DRY RUN.
 * A CSV import fails in one specific way: the header row does not say what the
 * intake schema says. `Phone1`, `first_name`, `lead_type`, `FEX`. The old
 * failure mode was silent — `validateFields` drops unknown keys by design, so a
 * fully-mismatched file imports "successfully" as a list of bare phone numbers,
 * and you discover it when the agent opens with an improvised greeting on a
 * live call to a real consumer. The preview makes that mismatch visible in
 * seconds, per column, before anything is written.
 *
 * Nothing here touches the database. `planCsvImport` is pure so a mapping
 * question is answerable in a unit test rather than against production.
 *
 * COMPLIANCE: this is an ingest path, so it is behind the same chokepoint as
 * every other one — `validateFields` rejects regulated keys. A CSV is the most
 * likely place for an SSN or a date of birth column to arrive, because whoever
 * exported it exported everything they had. Regulated columns are named in the
 * preview and their VALUES are never echoed back, sampled, or logged.
 */
import { isRegulatedField, validateFields, type LeadFieldDef } from "./intake-schema";

/** How a source column was resolved against the intake schema. */
export type CsvColumnKind =
  /** Maps to the lead's phone number — the dedup key. Exactly one is required. */
  | "phone"
  /** Maps to `leads.name`. */
  | "name"
  /** Maps to a defined intake-schema field. */
  | "field"
  /** Names a regulated field. Rejected; values never read. */
  | "regulated"
  /** Not in the schema and not aliasable. Dropped, but reported. */
  | "unknown";

export type CsvColumnPlan = {
  /** Zero-based position in the header row. */
  index: number;
  /** The header exactly as it appeared in the file. */
  header: string;
  kind: CsvColumnKind;
  /** The canonical destination — an intake key, or `phone`/`name`. Null when dropped. */
  target: string | null;
  /** Set when the header matched via an alias rather than the key itself. */
  viaAlias?: boolean;
  /** Non-empty values seen in this column, used to show the mapping is plausible.
   * Always empty for a `regulated` column. */
  samples: string[];
};

export type CsvRowIssue = {
  /** 1-based row number as a human counts it in a spreadsheet (header = row 1). */
  row: number;
  reason: "missing-phone" | "invalid-phone" | "duplicate-in-file" | "empty-row";
  /** The offending phone as written, when showing it helps fix the file.
   * Never set for reasons that would echo a regulated value. */
  value?: string;
};

export type CsvImportPlan = {
  columns: CsvColumnPlan[];
  /** Data rows found (excludes the header). */
  totalRows: number;
  /** Rows that would produce a lead write. */
  importableRows: number;
  /** Rows that would be skipped, with the reason. */
  issues: CsvRowIssue[];
  /** Schema keys the file has no column for. Not an error — a lead may be partial. */
  missingSchemaKeys: string[];
  /** Regulated headers found, by name only. */
  rejectedRegulatedColumns: string[];
  /** Headers dropped as unknown. */
  droppedUnknownColumns: string[];
  /** The rows that would be written, ready for `upsertLead`. */
  rows: PlannedLeadRow[];
  /** Blocking problems — a plan with any of these must not be executed. */
  errors: string[];
  /** Non-blocking mapping problems worth a human's eyes before committing.
   * Chiefly: a value in an enum column that is not one of the declared options.
   * `validateFields` COERCES rather than drops those (it stores the raw string),
   * so without this the file imports clean and the field is quietly garbage. */
  warnings: string[];
};

export type PlannedLeadRow = {
  row: number;
  phone: string;
  name: string | null;
  fields: Record<string, string>;
};

/** E.164 — kept local rather than importing the voice validator so this module
 * stays dependency-light and testable on its own. Mirrors voice/validation.ts. */
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

/**
 * Header aliases → canonical target. Keyed by NORMALIZED header
 * (see `normalizeHeader`), so `First Name`, `FIRST-NAME` and `first_name` all
 * land on the same entry.
 *
 * This list is deliberately conservative. A wrong alias is worse than a missing
 * one: a missing alias shows up in `droppedUnknownColumns` and someone fixes it,
 * whereas a wrong alias silently writes the wrong value into a field the agent
 * reads aloud. Anything ambiguous is left unmapped on purpose.
 */
export const HEADER_ALIASES: Record<string, string> = {
  // phone — the dedup key
  phone: "phone",
  phone1: "phone",
  phone_number: "phone",
  phonenumber: "phone",
  primary_phone: "phone",
  mobile: "phone",
  mobile_number: "phone",
  cell: "phone",
  cell_phone: "phone",
  telephone: "phone",
  tel: "phone",
  contact_number: "phone",

  // name
  name: "name",
  full_name: "name",
  fullname: "name",
  first_name: "name",
  firstname: "name",
  customer_name: "name",
  lead_name: "name",
  client_name: "name",
  contact_name: "name",
  applicant_name: "name",

  // intake-schema fields
  city: "city",
  town: "city",
  state: "state",
  st: "state",
  state_region: "state",
  province: "state",
  region: "state",
  product_interest: "product_interest",
  product: "product_interest",
  lead_type: "product_interest",
  coverage_type: "product_interest",
  interest: "product_interest",
  interest_area: "interest_area",
  existing_policy: "existing_policy",
  already_covered: "existing_policy",
  has_coverage: "existing_policy",
  budget_band: "budget_band",
  budget: "budget_band",
  best_callback_time: "best_callback_time",
  callback_time: "best_callback_time",
  best_time_to_call: "best_callback_time",
  preferred_time: "best_callback_time",
  preferred_language: "preferred_language",
  language: "preferred_language",
  lead_notes: "lead_notes",
  notes: "lead_notes",
  note: "lead_notes",
  comments: "lead_notes",
  remarks: "lead_notes",
  email: "email",
  order_id: "order_id",
};

/**
 * Enum-value aliases, per intake key. Exports write shorthand a human reads
 * fine and an enum does not: `FEX` for final expense, `Y`/`N` for a boolean.
 * Unmapped values are left alone and let `validateFields` decide.
 */
export const VALUE_ALIASES: Record<string, Record<string, string>> = {
  product_interest: {
    fex: "final_expense",
    final_expense: "final_expense",
    finalexpense: "final_expense",
    final_expenses: "final_expense",
    burial: "final_expense",
    burial_insurance: "final_expense",
    term_life: "term",
    term: "term",
    whole_life: "life",
    life: "life",
    health: "health",
    medicare: "health",
    motor: "motor",
    auto: "motor",
    travel: "travel",
  },
  existing_policy: {
    y: "true",
    n: "false",
    yes: "true",
    no: "false",
    true: "true",
    false: "false",
  },
  preferred_language: {
    english: "en",
    en: "en",
    hindi: "hi",
    hi: "hi",
    hinglish: "hinglish",
  },
};

/** Lowercase, collapse any run of non-alphanumerics to a single underscore, trim them. */
export function normalizeHeader(header: string): string {
  return header
    .replace(/^﻿/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * RFC 4180-shaped CSV parser. Handles quoted fields, escaped `""`, embedded
 * commas and newlines, CRLF, and a UTF-8 BOM.
 *
 * Hand-written rather than a dependency: the input is a merchant's export, the
 * parse has to be predictable, and a 40-line state machine we can read beats a
 * transitive dependency tree on an ingest path.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");

  const endCell = () => {
    row.push(cell);
    cell = "";
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      endCell();
    } else if (ch === "\n") {
      endRow();
    } else if (ch === "\r") {
      // swallow; the \n that follows ends the row (a lone \r also ends it)
      if (src[i + 1] !== "\n") endRow();
    } else {
      cell += ch;
    }
  }
  // A trailing newline must not manufacture a phantom empty row.
  if (cell.length > 0 || row.length > 0) endRow();

  return rows;
}

/**
 * Normalize a phone to E.164, or return null.
 *
 * `defaultCountryCode` is REQUIRED to promote a bare national number (a US
 * export writes `5551234567` or `(555) 123-4567`). Without it, bare numbers are
 * reported as invalid rather than guessed — dialling a number we assembled from
 * an assumption is how you call a stranger in the wrong country.
 */
export function normalizePhone(raw: string, defaultCountryCode?: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Strip formatting but keep a leading +.
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  if (hasPlus) {
    const candidate = `+${digits}`;
    return E164_PATTERN.test(candidate) ? candidate : null;
  }

  // 00-prefixed international form.
  if (digits.startsWith("00")) {
    const candidate = `+${digits.slice(2)}`;
    return E164_PATTERN.test(candidate) ? candidate : null;
  }

  if (!defaultCountryCode) return null;
  const cc = defaultCountryCode.replace(/\D/g, "");
  if (!cc) return null;

  // A national number that already carries the trunk/country digit (US
  // `15551234567`) must not become `+115551234567`.
  const national = digits.startsWith(cc) && digits.length > cc.length ? digits.slice(cc.length) : digits;
  const candidate = `+${cc}${national}`;
  return E164_PATTERN.test(candidate) ? candidate : null;
}

function applyValueAlias(target: string, value: string): string {
  const table = VALUE_ALIASES[target];
  if (!table) return value;
  const normalized = normalizeHeader(value);
  return table[normalized] ?? value;
}

/** Resolve one header against the schema. Order matters: schema key first, then
 * alias, then regulated, then unknown. */
function planColumn(header: string, index: number, schemaKeys: Set<string>): CsvColumnPlan {
  const normalized = normalizeHeader(header);
  const base: CsvColumnPlan = { index, header, kind: "unknown", target: null, samples: [] };

  if (!normalized) return base;

  // A regulated header is regulated regardless of how it would otherwise map.
  // Checked before aliasing so `dob` can never alias its way into a text field.
  if (isRegulatedField(normalized, header)) {
    return { ...base, kind: "regulated" };
  }

  if (normalized === "phone") return { ...base, kind: "phone", target: "phone" };
  if (normalized === "name") return { ...base, kind: "name", target: "name" };
  if (schemaKeys.has(normalized)) return { ...base, kind: "field", target: normalized };

  const alias = HEADER_ALIASES[normalized];
  if (alias === "phone") return { ...base, kind: "phone", target: "phone", viaAlias: true };
  if (alias === "name") return { ...base, kind: "name", target: "name", viaAlias: true };
  if (alias && schemaKeys.has(alias)) return { ...base, kind: "field", target: alias, viaAlias: true };

  return base;
}

export type PlanCsvImportInput = {
  text: string;
  schema: LeadFieldDef[];
  /** Dial code used to promote bare national numbers, e.g. "+1". */
  defaultCountryCode?: string;
  /** How many example values to show per mapped column. */
  sampleSize?: number;
};

/**
 * Build the full import plan without writing anything. This is the preview the
 * operator reads before committing, and the same structure the writer consumes —
 * so what you approved is literally what runs.
 */
export function planCsvImport(input: PlanCsvImportInput): CsvImportPlan {
  const { text, schema, defaultCountryCode, sampleSize = 3 } = input;
  const errors: string[] = [];
  const warnings: string[] = [];
  // The grid keeps its original line positions. Blank lines are skipped during
  // iteration, NOT filtered out beforehand: filtering first renumbers every row
  // after the blank, and a row number that does not match what the operator
  // sees in their spreadsheet is worse than no row number at all.
  const rawGrid = parseCsv(text);
  const isBlank = (r: string[] | undefined) => !r || !r.some((cell) => cell.trim() !== "");
  const headerIndex = rawGrid.findIndex((r) => !isBlank(r));
  const grid = headerIndex === -1 ? [] : rawGrid;

  if (grid.length === 0) {
    return {
      columns: [],
      totalRows: 0,
      importableRows: 0,
      issues: [],
      missingSchemaKeys: schema.map((f) => f.key),
      rejectedRegulatedColumns: [],
      droppedUnknownColumns: [],
      rows: [],
      errors: ["The file has no rows. Expected a header row followed by at least one lead."],
      warnings: [],
    };
  }

  const headerRow = grid[headerIndex] ?? [];
  const schemaKeys = new Set(schema.map((f) => f.key));
  const columns = headerRow.map((h, i) => planColumn(h, i, schemaKeys));

  const phoneColumns = columns.filter((c) => c.kind === "phone");
  if (phoneColumns.length === 0) {
    errors.push(
      "No phone column found. A lead is identified and de-duplicated by phone number — rename the column to `phone` or map it explicitly.",
    );
  } else if (phoneColumns.length > 1) {
    errors.push(
      `Found ${phoneColumns.length} phone columns (${phoneColumns.map((c) => c.header).join(", ")}). Keep one — the rest are ambiguous.`,
    );
  }
  const phoneColumn = phoneColumns[0];
  const nameColumn = columns.find((c) => c.kind === "name");

  const issues: CsvRowIssue[] = [];
  const rows: PlannedLeadRow[] = [];
  const seenPhones = new Set<string>();
  const enumFields = new Map(schema.filter((f) => f.type === "enum" && f.options).map((f) => [f.key, f.options as string[]]));
  const badEnumValues = new Map<string, Set<string>>();
  let totalRows = 0;

  for (let r = headerIndex + 1; r < grid.length; r++) {
    const cells = grid[r] ?? [];
    if (isBlank(cells)) continue;
    totalRows++;
    const rowNumber = r + 1; // 1-based, as a spreadsheet numbers its lines

    const collect = (col: CsvColumnPlan | undefined) => (col ? (cells[col.index] ?? "").trim() : "");

    // Samples are gathered from every row so a column that is empty at the top
    // of the file does not look unmapped. Regulated columns are skipped
    // entirely — the point of rejecting them is to never read the value.
    for (const col of columns) {
      if (col.kind === "regulated" || col.kind === "unknown") continue;
      if (col.samples.length >= sampleSize) continue;
      const value = collect(col);
      if (value) col.samples.push(value);
    }

    if (!phoneColumn) continue;

    const rawPhone = collect(phoneColumn);
    if (!rawPhone) {
      issues.push({ row: rowNumber, reason: "missing-phone" });
      continue;
    }
    const phone = normalizePhone(rawPhone, defaultCountryCode);
    if (!phone) {
      issues.push({ row: rowNumber, reason: "invalid-phone", value: rawPhone });
      continue;
    }
    if (seenPhones.has(phone)) {
      // Not fatal — the upsert would merge them — but a duplicate inside one
      // file usually means the export was joined wrong, so it is surfaced.
      issues.push({ row: rowNumber, reason: "duplicate-in-file", value: phone });
      continue;
    }
    seenPhones.add(phone);

    const rawFields: Record<string, string> = {};
    for (const col of columns) {
      if (col.kind !== "field" || !col.target) continue;
      const value = collect(col);
      if (!value) continue;
      const mapped = applyValueAlias(col.target, value);
      rawFields[col.target] = mapped;

      // An enum column carrying a value outside its options is the quiet failure
      // this preview exists for: validateFields coerces it to the raw string
      // rather than dropping it, so the import looks clean and the field holds
      // something the reports cannot group and no alias can interpret.
      const options = enumFields.get(col.target);
      if (options && !options.includes(mapped)) {
        const bucket = badEnumValues.get(col.header) ?? new Set<string>();
        bucket.add(value);
        badEnumValues.set(col.header, bucket);
      }
    }

    // Same chokepoint as every other ingest path — no CSV-specific shortcut.
    const { accepted } = validateFields(rawFields, schema);

    rows.push({
      row: rowNumber,
      phone,
      name: collect(nameColumn) || null,
      fields: accepted,
    });
  }

  for (const [header, values] of badEnumValues) {
    const shown = [...values].slice(0, 5);
    warnings.push(
      `Column "${header}" has ${values.size} value(s) outside its allowed options (e.g. ${shown.map((v) => `"${v}"`).join(", ")}). These are stored as written — add an alias or fix the export.`,
    );
  }

  const mappedTargets = new Set(columns.filter((c) => c.kind === "field").map((c) => c.target as string));

  return {
    columns,
    totalRows,
    importableRows: rows.length,
    issues,
    missingSchemaKeys: schema.map((f) => f.key).filter((k) => !mappedTargets.has(k)),
    rejectedRegulatedColumns: columns.filter((c) => c.kind === "regulated").map((c) => c.header),
    droppedUnknownColumns: columns.filter((c) => c.kind === "unknown").map((c) => c.header),
    rows,
    errors,
    warnings,
  };
}

/** The preview payload — the plan minus the row bodies, which are the bulk and
 * are not useful to eyeball beyond the samples. */
export function summarizePlan(plan: CsvImportPlan) {
  return {
    totalRows: plan.totalRows,
    importableRows: plan.importableRows,
    skippedRows: plan.totalRows - plan.importableRows,
    columns: plan.columns.map((c) => ({
      header: c.header,
      kind: c.kind,
      target: c.target,
      viaAlias: c.viaAlias ?? false,
      samples: c.samples,
    })),
    missingSchemaKeys: plan.missingSchemaKeys,
    rejectedRegulatedColumns: plan.rejectedRegulatedColumns,
    droppedUnknownColumns: plan.droppedUnknownColumns,
    issues: plan.issues.slice(0, 50),
    issueCount: plan.issues.length,
    errors: plan.errors,
    warnings: plan.warnings,
  };
}
