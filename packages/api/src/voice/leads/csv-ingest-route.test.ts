import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * POST /api/leads/ingest/csv — the HTTP behavior of the spreadsheet import.
 *
 * The invariant that matters most: **dry run is the default**. A caller who
 * forgets the flag, sends it misspelled, or sends nothing at all gets a preview,
 * not a write. Mapping correctness itself is covered by csv-import.test.ts;
 * this file covers auth, the default, multipart vs raw body, and that a preview
 * genuinely writes nothing.
 */

process.env.DATABASE_URL ??= "file:./.test-lead-csv.db";

import { defaultIntakeSchema } from "./intake-schema";

let resolveResult: { id: number; orgId: string } | null = { id: 1, orgId: "org_1" };
const upsertCalls: Array<Record<string, unknown>> = [];
let upsertThrowsFor: string | null = null;

mock.module("./api-keys", () => ({
  resolveLeadApiKey: async () => resolveResult,
}));

mock.module("../org-queries", () => ({
  getOrg: async () => ({ id: "org_1", vertical: "insurance" }),
}));

mock.module("./leads", () => ({
  upsertLead: async (input: Record<string, unknown>) => {
    if (upsertThrowsFor && input.phone === upsertThrowsFor) throw new Error("db down");
    upsertCalls.push(input);
    return { id: upsertCalls.length, created: true };
  },
}));

mock.module("./schema-store", () => ({
  resolveIntakeSchema: async (_orgId: string, vertical: string | null | undefined) =>
    defaultIntakeSchema(vertical),
}));

const { leadsIngest } = await import("./ingest");

const CSV = ["First Name,Phone1,ST,Lead Type,Notes", "Ann,+15551234567,TX,FEX,small policy", "Bob,+15559998888,CA,FEX,"].join(
  "\n",
);

function postRaw(csv: string, query = "", headers: Record<string, string> = {}) {
  return leadsIngest.request(`/ingest/csv${query}`, {
    method: "POST",
    headers: { "Content-Type": "text/csv", Authorization: "Bearer wlk_good", ...headers },
    body: csv,
  });
}

function postMultipart(csv: string, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.set("file", new File([csv], "leads.csv", { type: "text/csv" }));
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return leadsIngest.request("/ingest/csv", {
    method: "POST",
    headers: { Authorization: "Bearer wlk_good" },
    body: form,
  });
}

type CsvJson = {
  ok?: boolean;
  dryRun?: boolean;
  applied?: boolean;
  created?: number;
  updated?: number;
  failedRows?: number[];
  note?: string;
  error?: string;
  preview?: {
    totalRows: number;
    importableRows: number;
    skippedRows: number;
    columns: Array<{ header: string; kind: string; target: string | null; samples: string[] }>;
    rejectedRegulatedColumns: string[];
    droppedUnknownColumns: string[];
    errors: string[];
    warnings: string[];
  };
};

beforeEach(() => {
  resolveResult = { id: 1, orgId: "org_1" };
  upsertCalls.length = 0;
  upsertThrowsFor = null;
});

describe("auth", () => {
  it("401s with no key and writes nothing", async () => {
    const res = await postRaw(CSV, "", { Authorization: "" });
    expect(res.status).toBe(401);
    expect(upsertCalls).toHaveLength(0);
  });

  it("401s on a revoked key", async () => {
    resolveResult = null;
    const res = await postRaw(CSV);
    expect(res.status).toBe(401);
    expect(upsertCalls).toHaveLength(0);
  });
});

describe("dry run is the default", () => {
  it("previews when no flag is sent", async () => {
    const res = await postRaw(CSV);
    const json = (await res.json()) as CsvJson;
    expect(res.status).toBe(200);
    expect(json.dryRun).toBe(true);
    expect(json.applied).toBe(false);
    expect(json.preview?.importableRows).toBe(2);
    expect(upsertCalls).toHaveLength(0);
    expect(json.note).toContain("dryRun=false");
  });

  it("previews when the flag is anything other than an explicit false", async () => {
    for (const q of ["?dryRun=true", "?dryRun=", "?dryRun=0", "?dryRun=no", "?dryrun=false"]) {
      upsertCalls.length = 0;
      const json = (await (await postRaw(CSV, q)).json()) as CsvJson;
      expect(json.applied, q).toBe(false);
      expect(upsertCalls, q).toHaveLength(0);
    }
  });

  it("shows the per-column mapping so a bad header row is visible before any write", async () => {
    const json = (await (await postRaw(CSV)).json()) as CsvJson;
    const byHeader = Object.fromEntries((json.preview?.columns ?? []).map((c) => [c.header, c]));
    expect(byHeader["Phone1"]?.kind).toBe("phone");
    expect(byHeader["ST"]?.target).toBe("state");
    expect(byHeader["Lead Type"]?.target).toBe("product_interest");
    expect(byHeader["ST"]?.samples).toEqual(["TX", "CA"]);
  });
});

describe("applying the import", () => {
  it("writes only on an explicit dryRun=false", async () => {
    const res = await postRaw(CSV, "?dryRun=false");
    const json = (await res.json()) as CsvJson;
    expect(json.applied).toBe(true);
    expect(json.created).toBe(2);
    expect(upsertCalls).toHaveLength(2);
    expect(upsertCalls[0]!.phone).toBe("+15551234567");
    expect(upsertCalls[0]!.name).toBe("Ann");
    expect((upsertCalls[0]!.fields as Record<string, string>).product_interest).toBe("final_expense");
  });

  it("scopes every write to the key's org", async () => {
    await postRaw(CSV, "?dryRun=false");
    expect(upsertCalls.every((c) => c.orgId === "org_1")).toBe(true);
  });

  it("defaults the source to crm and honours a valid override", async () => {
    await postRaw(CSV, "?dryRun=false");
    expect(upsertCalls[0]!.source).toBe("crm");
    upsertCalls.length = 0;
    await postRaw(CSV, "?dryRun=false&source=manual");
    expect(upsertCalls[0]!.source).toBe("manual");
  });

  it("continues past a failed row and names it instead of stopping half-imported", async () => {
    upsertThrowsFor = "+15551234567";
    const json = (await (await postRaw(CSV, "?dryRun=false")).json()) as CsvJson;
    expect(json.ok).toBe(false);
    expect(json.created).toBe(1);
    expect(json.failedRows).toEqual([2]);
  });
});

describe("multipart upload", () => {
  it("accepts the file part and previews by default", async () => {
    const json = (await (await postMultipart(CSV)).json()) as CsvJson;
    expect(json.dryRun).toBe(true);
    expect(json.preview?.importableRows).toBe(2);
    expect(upsertCalls).toHaveLength(0);
  });

  it("reads dryRun and defaultCountryCode from the form fields", async () => {
    const national = ["Name,Phone", "Ann,(555) 123-4567"].join("\n");
    const json = (await (
      await postMultipart(national, { dryRun: "false", defaultCountryCode: "+1" })
    ).json()) as CsvJson;
    expect(json.created).toBe(1);
    expect(upsertCalls[0]!.phone).toBe("+15551234567");
  });

  it("400s when there is no file part", async () => {
    const form = new FormData();
    form.set("dryRun", "false");
    const res = await leadsIngest.request("/ingest/csv", {
      method: "POST",
      headers: { Authorization: "Bearer wlk_good" },
      body: form,
    });
    expect(res.status).toBe(400);
    expect(upsertCalls).toHaveLength(0);
  });
});

describe("refusals", () => {
  it("400s on a blocking plan error and writes nothing, even with dryRun=false", async () => {
    const noPhone = ["Name,City", "Ann,Dallas"].join("\n");
    const res = await postRaw(noPhone, "?dryRun=false");
    const json = (await res.json()) as CsvJson;
    expect(res.status).toBe(400);
    expect(json.applied).toBe(false);
    expect(json.preview?.errors[0]).toContain("No phone column");
    expect(upsertCalls).toHaveLength(0);
  });

  it("400s on an empty body", async () => {
    const res = await postRaw("   ");
    expect(res.status).toBe(400);
  });

  it("never echoes a regulated column's values in the preview", async () => {
    const withSsn = ["Phone,SSN,DOB", "+15551234567,123-45-6789,1948-03-02"].join("\n");
    const res = await postRaw(withSsn);
    const body = await res.text();
    expect(body).toContain("SSN");
    expect(body).not.toContain("123-45-6789");
    expect(body).not.toContain("1948-03-02");
  });

  it("refuses bare national numbers rather than guessing a country", async () => {
    const national = ["Name,Phone", "Ann,(555) 123-4567"].join("\n");
    const json = (await (await postRaw(national, "?dryRun=false")).json()) as CsvJson;
    expect(json.created).toBe(0);
    expect(upsertCalls).toHaveLength(0);
  });
});
