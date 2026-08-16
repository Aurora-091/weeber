/* eslint-disable unicorn/no-thenable */
import { mock, describe, it, expect, beforeEach } from "bun:test";

let selectCallCount = 0;
const capturedWhereConditions: any[] = [];

const dbLike = {
  select: (_fields?: any) => {
    const chain: any = {
      from: () => chain,
      where: (cond: any) => {
        capturedWhereConditions.push(cond);
        return chain;
      },
      limit: () => chain,
      then: (resolve: any) => {
        selectCallCount += 1;
        // Call 1: sendBroadcast's own lookup of the broadcast row by id.
        if (selectCallCount === 1) return resolve([{ id: 1, audience: "waitlist", status: "draft", title: "t", body: "b" }]);
        // Call 2: resolveAudienceEmails("waitlist") pulling recipient emails.
        return resolve([{ email: "still-subscribed@example.com" }]);
      },
    };
    return chain;
  },
  update: (_table: any) => ({
    set: (data: any) => ({
      where: () => ({ returning: () => Promise.resolve([{ id: 1, ...data }]) }),
    }),
  }),
};

// ADR-116 addendum: broadcasts.ts now imports `dbBackground` — both names
// must resolve here or the import throws.
mock.module("../database", () => ({ db: dbLike, dbBackground: dbLike }));

mock.module("../voice/integrations/resilient-fetch", () => ({
  resilientCall: async () => ({ ok: true, value: {} }),
}));

import { sendBroadcast } from "./broadcasts";
import { waitlistSignups } from "../database/schema";

describe("broadcasts — waitlist audience unsubscribe filtering", () => {
  beforeEach(() => {
    selectCallCount = 0;
    capturedWhereConditions.length = 0;
    process.env.RESEND_API_KEY = "test-key";
  });

  it("filters resolveAudienceEmails('waitlist') by unsubscribed = false — regression for the pre-fix bug where opted-out signups were re-emailed", async () => {
    await sendBroadcast(1);

    // The audience-resolution query for "waitlist" must include a WHERE
    // clause filtering on waitlistSignups.unsubscribed = false — not an
    // unfiltered select of every signup (the bug this test guards against).
    const unsubscribeFilterCondition = capturedWhereConditions.find(
      (cond) => cond?.queryChunks?.[1] === waitlistSignups.unsubscribed,
    );
    expect(unsubscribeFilterCondition).toBeDefined();
    expect(unsubscribeFilterCondition.queryChunks[3].value).toBe(false);
  });
});
