import { describe, it, expect } from "bun:test";

/**
 * CSV lead import — the parser, the header/value mapping, and the dry-run plan.
 *
 * Pure module, no DB, no HTTP. That is deliberate: "will Peterson's export map
 * correctly?" is a question that must be answerable in a test rather than by
 * uploading a file to production and dialling a real consumer to find out.
 */
import {
  parseCsv,
  normalizeHeader,
  normalizePhone,
  planCsvImport,
  summarizePlan,
  HEADER_ALIASES,
  VALUE_ALIASES,
} from "./csv-import";
import { defaultIntakeSchema } from "./intake-schema";

const schema = defaultIntakeSchema("insurance");

describe("parseCsv", () => {
  it("parses a plain grid", () => {
    expect(parseCsv("a,b\n1,2\n3,4")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("handles quoted fields with commas, quotes and newlines", () => {
    const rows = parseCsv('name,notes\n"Doe, John","said ""call back"" later"\n"multi\nline",x');
    expect(rows[1]).toEqual(["Doe, John", 'said "call back" later']);
    expect(rows[2]).toEqual(["multi\nline", "x"]);
  });

  it("handles CRLF and a UTF-8 BOM without leaking either into the first header", () => {
    const rows = parseCsv("﻿phone,name\r\n+15551234567,Ann\r\n");
    expect(rows[0]).toEqual(["phone", "name"]);
    expect(rows).toHaveLength(2); // trailing CRLF must not add a phantom row
  });
});

describe("normalizeHeader", () => {
  it("collapses casing, spaces, dashes and punctuation to one shape", () => {
    for (const raw of ["First Name", "FIRST-NAME", "first_name", " first.name ", "First   Name"]) {
      expect(normalizeHeader(raw)).toBe("first_name");
    }
  });
});

describe("normalizePhone", () => {
  it("accepts an already-E.164 number and strips formatting", () => {
    expect(normalizePhone("+1 (555) 123-4567")).toBe("+15551234567");
  });

  it("converts a 00-prefixed international number", () => {
    expect(normalizePhone("0015551234567")).toBe("+15551234567");
  });

  it("REFUSES a bare national number when no country code was supplied", () => {
    // The whole point: we do not invent a country for a number we are about to
    // dial. A refusal shows up in the preview; a guess calls a stranger.
    expect(normalizePhone("5551234567")).toBeNull();
    expect(normalizePhone("(555) 123-4567")).toBeNull();
  });

  it("promotes a bare national number once a country code is given", () => {
    expect(normalizePhone("(555) 123-4567", "+1")).toBe("+15551234567");
    expect(normalizePhone("9876543210", "+91")).toBe("+919876543210");
  });

  it("does not double-prefix a number that already carries the country code", () => {
    expect(normalizePhone("15551234567", "+1")).toBe("+15551234567");
  });

  it("returns null for junk", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("n/a")).toBeNull();
    expect(normalizePhone("123", "+1")).toBeNull();
  });
});

describe("header mapping", () => {
  it("maps a realistic vendor export onto intake keys", () => {
    const csv = [
      "First Name,Phone1,ST,Lead Type,Best Time To Call,Notes",
      "Ann,(555) 123-4567,TX,FEX,evenings,wants small policy",
    ].join("\n");

    const plan = planCsvImport({ text: csv, schema, defaultCountryCode: "+1" });

    expect(plan.errors).toEqual([]);
    expect(plan.importableRows).toBe(1);

    const byHeader = Object.fromEntries(plan.columns.map((c) => [c.header, c]));
    expect(byHeader["First Name"]?.target).toBe("name");
    expect(byHeader["Phone1"]?.kind).toBe("phone");
    expect(byHeader["ST"]?.target).toBe("state");
    expect(byHeader["Lead Type"]?.target).toBe("product_interest");
    expect(byHeader["Best Time To Call"]?.target).toBe("best_callback_time");
    expect(byHeader["Notes"]?.target).toBe("lead_notes");
    // Every one of those matched via an alias, not a literal schema key.
    expect(byHeader["ST"]?.viaAlias).toBe(true);

    const row = plan.rows[0];
    expect(row?.phone).toBe("+15551234567");
    expect(row?.name).toBe("Ann");
    // FEX is meaningless to the enum until aliased.
    expect(row?.fields.product_interest).toBe("final_expense");
    expect(row?.fields.state).toBe("TX");
    expect(row?.fields.best_callback_time).toBe("evenings");
  });

  it("prefers a literal schema key over an alias table entry", () => {
    const plan = planCsvImport({
      text: "phone,interest_area\n+15551234567,final expense coverage",
      schema,
    });
    const col = plan.columns.find((c) => c.header === "interest_area");
    expect(col?.target).toBe("interest_area");
    expect(col?.viaAlias).toBeUndefined();
    expect(plan.rows[0]?.fields.interest_area).toBe("final expense coverage");
  });

  it("reports unknown columns instead of silently swallowing them", () => {
    const plan = planCsvImport({
      text: "phone,vendor_batch_ref,utm_source\n+15551234567,B-77,fb",
      schema,
    });
    expect(plan.droppedUnknownColumns).toEqual(["vendor_batch_ref", "utm_source"]);
    expect(plan.rows[0]?.fields).toEqual({});
  });

  it("names regulated columns and never reads their values", () => {
    const csv = ["phone,DOB,SSN,Medical Conditions,Bank Account Number", "+15551234567,1948-03-02,123-45-6789,COPD,000123456"].join(
      "\n",
    );
    const plan = planCsvImport({ text: csv, schema });

    expect(plan.rejectedRegulatedColumns).toEqual(["DOB", "SSN", "Medical Conditions", "Bank Account Number"]);
    // No regulated value may appear anywhere in the plan — not in a field, not
    // in a sample, not in an issue.
    const serialized = JSON.stringify(plan);
    for (const secret of ["1948-03-02", "123-45-6789", "COPD", "000123456"]) {
      expect(serialized).not.toContain(secret);
    }
    for (const col of plan.columns) {
      if (col.kind === "regulated") expect(col.samples).toEqual([]);
    }
    // The row still imports — a regulated column is dropped, not fatal.
    expect(plan.importableRows).toBe(1);
    expect(plan.rows[0]?.fields).toEqual({});
  });

  it("blocks the import when there is no phone column", () => {
    const plan = planCsvImport({ text: "name,city\nAnn,Dallas", schema });
    expect(plan.errors[0]).toContain("No phone column");
    expect(plan.rows).toEqual([]);
  });

  it("blocks the import when two columns both look like the phone", () => {
    const plan = planCsvImport({ text: "phone,mobile\n+15551234567,+15559998888", schema });
    expect(plan.errors[0]).toContain("phone columns");
  });

  it("lists schema keys the file has no column for", () => {
    const plan = planCsvImport({ text: "phone,name\n+15551234567,Ann", schema });
    expect(plan.missingSchemaKeys).toContain("interest_area");
    expect(plan.missingSchemaKeys).toContain("state");
    expect(plan.missingSchemaKeys).not.toContain("phone");
  });
});

describe("row-level issues", () => {
  const csv = [
    "phone,name",
    ",NoPhone",
    "not-a-number,Junk",
    "+15551234567,Ann",
    "+1 555 123 4567,Ann Again",
    "+15559998888,Bob",
  ].join("\n");

  const plan = planCsvImport({ text: csv, schema });

  it("counts only the rows that would actually be written", () => {
    expect(plan.totalRows).toBe(5);
    expect(plan.importableRows).toBe(2);
  });

  it("attributes each skip to a spreadsheet row number a human can find", () => {
    expect(plan.issues).toEqual([
      { row: 2, reason: "missing-phone" },
      { row: 3, reason: "invalid-phone", value: "not-a-number" },
      { row: 5, reason: "duplicate-in-file", value: "+15551234567" },
    ]);
  });

  it("skips fully blank lines rather than reporting them as broken rows", () => {
    const withBlanks = planCsvImport({ text: "phone,name\n\n+15551234567,Ann\n,,\n", schema });
    expect(withBlanks.totalRows).toBe(1);
    expect(withBlanks.issues).toEqual([]);
  });

  it("keeps row numbers aligned with the file even when a blank line precedes them", () => {
    // A blank line at line 2 must not renumber the rows after it: the operator
    // is going to open the file and look at that line.
    const withBlank = planCsvImport({ text: "phone,name\n\n,NoPhone\n+15551234567,Ann", schema });
    expect(withBlank.issues).toEqual([{ row: 3, reason: "missing-phone" }]);
    expect(withBlank.rows[0]?.row).toBe(4);
  });
});

describe("value aliasing", () => {
  it("maps yes/no shorthand onto the boolean field", () => {
    const plan = planCsvImport({ text: "phone,Already Covered\n+15551234567,N", schema });
    expect(plan.rows[0]?.fields.existing_policy).toBe("false");
  });

  it("warns loudly when an enum column carries a value outside its options", () => {
    const plan = planCsvImport({ text: "phone,Lead Type\n+15551234567,mystery-product", schema });
    // validateFields COERCES an out-of-options enum value rather than dropping
    // it, so the row imports and the field holds a string nothing can group by.
    // The import is not blocked — but it must not be silent either.
    expect(plan.rows[0]?.fields.product_interest).toBe("mystery-product");
    expect(plan.errors).toEqual([]);
    expect(plan.warnings[0]).toContain("Lead Type");
    expect(plan.warnings[0]).toContain("mystery-product");
  });

  it("does not warn on a value an alias resolved into the enum", () => {
    const plan = planCsvImport({ text: "phone,Lead Type\n+15551234567,FEX", schema });
    expect(plan.warnings).toEqual([]);
  });

  it("has no alias that points at a key outside the insurance/shopify schemas", () => {
    const known = new Set([
      "phone",
      "name",
      ...defaultIntakeSchema("insurance").map((f) => f.key),
      ...defaultIntakeSchema("shopify").map((f) => f.key),
    ]);
    for (const [header, target] of Object.entries(HEADER_ALIASES)) {
      expect(known.has(target), `${header} -> ${target}`).toBe(true);
    }
  });

  it("only aliases enum values that the schema actually allows", () => {
    const byKey = new Map(schema.map((f) => [f.key, f]));
    for (const [key, table] of Object.entries(VALUE_ALIASES)) {
      const field = byKey.get(key);
      if (!field || field.type !== "enum" || !field.options) continue;
      for (const value of Object.values(table)) {
        expect(field.options, `${key} -> ${value}`).toContain(value);
      }
    }
  });
});

describe("summarizePlan", () => {
  it("drops the row bodies but keeps the per-column evidence", () => {
    const plan = planCsvImport({ text: "phone,name,ST\n+15551234567,Ann,TX", schema });
    const summary = summarizePlan(plan);
    expect(summary).not.toHaveProperty("rows");
    expect(summary.importableRows).toBe(1);
    expect(summary.skippedRows).toBe(0);
    expect(summary.columns.find((c) => c.header === "ST")?.samples).toEqual(["TX"]);
  });

  it("reports an empty file as an error rather than a successful zero-row import", () => {
    const plan = planCsvImport({ text: "   ", schema });
    expect(plan.errors[0]).toContain("no rows");
    expect(summarizePlan(plan).importableRows).toBe(0);
  });
});
