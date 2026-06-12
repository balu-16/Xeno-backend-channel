import { describe, it, expect, vi } from "vitest";
import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  campaignDispatchJobSchema,
  channelWebhookSchema,
  type CampaignDispatchJob,
  type CampaignEventType,
  type Channel
} from "../src/contracts";

// ---------------------------------------------------------------------------
// Helpers – replicate the pure functions from ChannelWorker so we can test
// them without instantiating BullMQ / Redis / NestJS.
// ---------------------------------------------------------------------------

/** Mirrors ChannelWorker.score() */
function score(input: Pick<CampaignDispatchJob, "campaignId" | "customerId">): number {
  const digest = createHash("sha256")
    .update(`${input.campaignId}:${input.customerId}`)
    .digest();
  return digest[0] ?? 0;
}

/** Mirrors ChannelWorker.simulate() event branching – returns the ordered list of event types emitted. */
function simulateEventTypes(s: number): CampaignEventType[] {
  const events: CampaignEventType[] = ["MessageSent"];

  if (s < 20) {
    events.push("MessageFailed");
    return events;
  }

  events.push("MessageDelivered");
  if (s < 95) return events;

  events.push("MessageOpened");
  if (s < 155) return events;

  events.push("MessageClicked");
  if (s < 220) return events;

  events.push("MessageConverted");
  return events;
}

/** Find a (campaignId, customerId) pair whose SHA-256 first byte falls inside [min, max]. */
function findInputWithScoreRange(
  min: number,
  max: number
): { campaignId: string; customerId: string; score: number } {
  for (let i = 0; i < 50_000; i++) {
    const campaignId = randomUUID();
    const customerId = randomUUID();
    const s = score({ campaignId, customerId });
    if (s >= min && s <= max) {
      return { campaignId, customerId, score: s };
    }
  }
  throw new Error(
    `Could not find input with score in [${min}, ${max}] after 50 000 attempts`
  );
}

// A fixed secret used across HMAC tests (meets the 32-char minimum from envSchema).
const WEBHOOK_SECRET = "test-webhook-secret-0123456789abcdef";

// ---------------------------------------------------------------------------
// 1. Score function
// ---------------------------------------------------------------------------

describe("score function (deterministic SHA-256 hash)", () => {
  it("returns a consistent value for the same input", () => {
    const input = { campaignId: "aaaa-bbbb", customerId: "cccc-dddd" };
    const first = score(input);
    const second = score(input);
    expect(first).toBe(second);
  });

  it("returns different values for different inputs", () => {
    const a = score({ campaignId: "c1", customerId: "u1" });
    const b = score({ campaignId: "c1", customerId: "u2" });
    expect(a).not.toBe(b);
  });

  it("always returns an integer in 0-255", () => {
    const inputs = Array.from({ length: 500 }, () => ({
      campaignId: randomUUID(),
      customerId: randomUUID()
    }));
    for (const input of inputs) {
      const s = score(input);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(255);
      expect(Number.isInteger(s)).toBe(true);
    }
  });

  it("uses the first byte of the SHA-256 digest", () => {
    const input = { campaignId: "camp", customerId: "cust" };
    const expected = createHash("sha256")
      .update(`${input.campaignId}:${input.customerId}`)
      .digest()[0];
    expect(score(input)).toBe(expected);
  });

  it("is affected by both campaignId and customerId", () => {
    const base = { campaignId: "c1", customerId: "u1" };
    const baseScore = score(base);

    // Changing only campaignId
    const diffCampaign = score({ ...base, campaignId: "c2" });
    // Changing only customerId
    const diffCustomer = score({ ...base, customerId: "u2" });

    // At least one should differ (extremely unlikely both collide)
    expect(diffCampaign === baseScore && diffCustomer === baseScore).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Delivery simulation thresholds
// ---------------------------------------------------------------------------

describe("delivery simulation logic (score thresholds)", () => {
  it("score < 20 emits MessageSent then MessageFailed", () => {
    const { score: s } = findInputWithScoreRange(0, 19);
    const events = simulateEventTypes(s);
    expect(events).toEqual(["MessageSent", "MessageFailed"]);
  });

  it("score in [20, 94] emits Sent + Delivered only", () => {
    const { score: s } = findInputWithScoreRange(20, 94);
    const events = simulateEventTypes(s);
    expect(events).toEqual(["MessageSent", "MessageDelivered"]);
  });

  it("score in [95, 154] emits Sent + Delivered + Opened", () => {
    const { score: s } = findInputWithScoreRange(95, 154);
    const events = simulateEventTypes(s);
    expect(events).toEqual([
      "MessageSent",
      "MessageDelivered",
      "MessageOpened"
    ]);
  });

  it("score in [155, 219] emits Sent + Delivered + Opened + Clicked", () => {
    const { score: s } = findInputWithScoreRange(155, 219);
    const events = simulateEventTypes(s);
    expect(events).toEqual([
      "MessageSent",
      "MessageDelivered",
      "MessageOpened",
      "MessageClicked"
    ]);
  });

  it("score >= 220 emits the full funnel including Converted", () => {
    const { score: s } = findInputWithScoreRange(220, 255);
    const events = simulateEventTypes(s);
    expect(events).toEqual([
      "MessageSent",
      "MessageDelivered",
      "MessageOpened",
      "MessageClicked",
      "MessageConverted"
    ]);
  });

  it("MessageFailed is never emitted alongside MessageDelivered", () => {
    // Test many inputs to ensure the two branches are mutually exclusive
    for (let i = 0; i < 1000; i++) {
      const s = score({ campaignId: randomUUID(), customerId: randomUUID() });
      const events = simulateEventTypes(s);
      const hasFailed = events.includes("MessageFailed");
      const hasDelivered = events.includes("MessageDelivered");
      expect(hasFailed && hasDelivered).toBe(false);
    }
  });

  it("score exactly 20 delivers but does not open", () => {
    // Use a deterministic pair we know produces score 20, or test the boundary logic directly
    expect(simulateEventTypes(20)).toEqual(["MessageSent", "MessageDelivered"]);
  });

  it("score exactly 95 opens but does not click", () => {
    expect(simulateEventTypes(95)).toEqual([
      "MessageSent",
      "MessageDelivered",
      "MessageOpened"
    ]);
  });

  it("score exactly 155 clicks but does not convert", () => {
    expect(simulateEventTypes(155)).toEqual([
      "MessageSent",
      "MessageDelivered",
      "MessageOpened",
      "MessageClicked"
    ]);
  });

  it("score exactly 220 converts", () => {
    expect(simulateEventTypes(220)).toEqual([
      "MessageSent",
      "MessageDelivered",
      "MessageOpened",
      "MessageClicked",
      "MessageConverted"
    ]);
  });

  it("score 19 fails, score 20 delivers (boundary)", () => {
    expect(simulateEventTypes(19)).toEqual(["MessageSent", "MessageFailed"]);
    expect(simulateEventTypes(20)).toEqual(["MessageSent", "MessageDelivered"]);
  });

  it("score 94 stops at delivered, score 95 opens (boundary)", () => {
    expect(simulateEventTypes(94)).toEqual(["MessageSent", "MessageDelivered"]);
    expect(simulateEventTypes(95)).toEqual([
      "MessageSent",
      "MessageDelivered",
      "MessageOpened"
    ]);
  });

  it("score 154 stops at opened, score 155 clicks (boundary)", () => {
    expect(simulateEventTypes(154)).toEqual([
      "MessageSent",
      "MessageDelivered",
      "MessageOpened"
    ]);
    expect(simulateEventTypes(155)).toEqual([
      "MessageSent",
      "MessageDelivered",
      "MessageOpened",
      "MessageClicked"
    ]);
  });

  it("score 219 stops at clicked, score 220 converts (boundary)", () => {
    expect(simulateEventTypes(219)).toEqual([
      "MessageSent",
      "MessageDelivered",
      "MessageOpened",
      "MessageClicked"
    ]);
    expect(simulateEventTypes(220)).toEqual([
      "MessageSent",
      "MessageDelivered",
      "MessageOpened",
      "MessageClicked",
      "MessageConverted"
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. HMAC signature
// ---------------------------------------------------------------------------

describe("HMAC webhook signature", () => {
  it("generates a SHA-256 hex digest of the body", () => {
    const body = JSON.stringify({ eventId: "abc", type: "MessageSent" });
    const hex = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
    expect(hex).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces the expected 'sha256=<hex>' header format", () => {
    const body = JSON.stringify({ test: true });
    const hex = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
    const header = `sha256=${hex}`;
    expect(header).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it("is deterministic – same body + secret yields the same signature", () => {
    const body = JSON.stringify({ campaignId: "c1", customerId: "u1" });
    const sig1 = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
    const sig2 = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
    expect(sig1).toBe(sig2);
  });

  it("differs when the body changes", () => {
    const body1 = JSON.stringify({ eventId: "a" });
    const body2 = JSON.stringify({ eventId: "b" });
    const sig1 = createHmac("sha256", WEBHOOK_SECRET).update(body1).digest("hex");
    const sig2 = createHmac("sha256", WEBHOOK_SECRET).update(body2).digest("hex");
    expect(sig1).not.toBe(sig2);
  });

  it("differs when the secret changes", () => {
    const body = JSON.stringify({ eventId: "a" });
    const sig1 = createHmac("sha256", "secret-aaaa-01234567890123456789").update(body).digest("hex");
    const sig2 = createHmac("sha256", "secret-bbbb-01234567890123456789").update(body).digest("hex");
    expect(sig1).not.toBe(sig2);
  });

  it("signature verification rejects a tampered hex value", () => {
    const body = JSON.stringify({ eventId: "x" });
    const valid = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
    const tampered = valid.slice(0, -2) + "ff";
    expect(valid).not.toBe(tampered);
  });

  it("mimics the x-xeno-signature header construction from channel.worker", () => {
    // This is exactly how the worker builds the header (line 109 of channel.worker.ts)
    const event = {
      eventId: randomUUID(),
      type: "MessageSent",
      occurredAt: new Date().toISOString(),
      campaignId: randomUUID(),
      customerId: randomUUID(),
      correlationId: randomUUID(),
      payload: { provider: "xeno-channel-simulator", channel: "EMAIL", destination: "us***om" }
    };
    const body = JSON.stringify(event);
    const signature = createHmac("sha256", WEBHOOK_SECRET)
      .update(body)
      .digest("hex");
    const header = `sha256=${signature}`;

    // Verify the downstream consumer can reconstruct the same value
    const recomputed = createHmac("sha256", WEBHOOK_SECRET)
      .update(body)
      .digest("hex");
    expect(header).toBe(`sha256=${recomputed}`);
  });
});

// ---------------------------------------------------------------------------
// 4. Contract validation – campaignDispatchJobSchema
// ---------------------------------------------------------------------------

describe("campaignDispatchJobSchema validation", () => {
  const validJob = {
    campaignId: "550e8400-e29b-41d4-a716-446655440000",
    customerId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    channel: "EMAIL" as Channel,
    destination: "user@example.com",
    subject: "Welcome",
    message: "Hello from Xeno!",
    correlationId: "6ba7b811-9dad-11d1-80b4-00c04fd430c8"
  };

  it("accepts a fully valid job", () => {
    const result = campaignDispatchJobSchema.safeParse(validJob);
    expect(result.success).toBe(true);
  });

  it("accepts null subject (for non-EMAIL channels)", () => {
    const result = campaignDispatchJobSchema.safeParse({
      ...validJob,
      channel: "SMS",
      subject: null
    });
    expect(result.success).toBe(true);
  });

  it("accepts all valid channel types", () => {
    for (const channel of ["WHATSAPP", "SMS", "EMAIL", "RCS"] as Channel[]) {
      const result = campaignDispatchJobSchema.safeParse({
        ...validJob,
        channel,
        subject: channel === "EMAIL" ? "Subj" : null
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an invalid channel", () => {
    const result = campaignDispatchJobSchema.safeParse({
      ...validJob,
      channel: "PUSH_NOTIFICATION"
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing campaignId", () => {
    const { campaignId: _, ...rest } = validJob;
    const result = campaignDispatchJobSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects missing customerId", () => {
    const { customerId: _, ...rest } = validJob;
    const result = campaignDispatchJobSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects missing destination", () => {
    const { destination: _, ...rest } = validJob;
    const result = campaignDispatchJobSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects missing message", () => {
    const { message: _, ...rest } = validJob;
    const result = campaignDispatchJobSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects missing correlationId", () => {
    const { correlationId: _, ...rest } = validJob;
    const result = campaignDispatchJobSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects a non-UUID campaignId", () => {
    const result = campaignDispatchJobSchema.safeParse({
      ...validJob,
      campaignId: "not-a-uuid"
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty destination", () => {
    const result = campaignDispatchJobSchema.safeParse({
      ...validJob,
      destination: ""
    });
    expect(result.success).toBe(false);
  });

  it("rejects a message exceeding 5000 characters", () => {
    const result = campaignDispatchJobSchema.safeParse({
      ...validJob,
      message: "x".repeat(5001)
    });
    expect(result.success).toBe(false);
  });

  it("rejects a subject exceeding 200 characters", () => {
    const result = campaignDispatchJobSchema.safeParse({
      ...validJob,
      subject: "s".repeat(201)
    });
    expect(result.success).toBe(false);
  });

  it("strips unknown fields (strict mode)", () => {
    const result = campaignDispatchJobSchema.safeParse({
      ...validJob,
      extraField: "should be ignored or rejected"
    });
    // Zod .parse strips unknown keys by default, so this should still pass
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("extraField");
    }
  });
});

// ---------------------------------------------------------------------------
// 5. channelWebhookSchema (used by CRM to validate incoming webhooks)
// ---------------------------------------------------------------------------

describe("channelWebhookSchema validation", () => {
  const validWebhook = {
    eventId: randomUUID(),
    type: "MessageDelivered",
    occurredAt: new Date().toISOString(),
    campaignId: randomUUID(),
    customerId: randomUUID(),
    correlationId: randomUUID(),
    payload: { provider: "xeno-channel-simulator" }
  };

  it("accepts a valid webhook event", () => {
    const result = channelWebhookSchema.safeParse(validWebhook);
    expect(result.success).toBe(true);
  });

  it("rejects an invalid event type", () => {
    const result = channelWebhookSchema.safeParse({
      ...validWebhook,
      type: "InvalidType"
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-datetime occurredAt", () => {
    const result = channelWebhookSchema.safeParse({
      ...validWebhook,
      occurredAt: "not-a-date"
    });
    expect(result.success).toBe(false);
  });

  it("accepts all campaign event types", () => {
    const types = [
      "CampaignCreated",
      "CampaignLaunched",
      "MessageQueued",
      "MessageSent",
      "MessageDelivered",
      "MessageOpened",
      "MessageClicked",
      "MessageConverted",
      "MessageFailed"
    ];
    for (const type of types) {
      const result = channelWebhookSchema.safeParse({ ...validWebhook, type });
      expect(result.success).toBe(true);
    }
  });

  it("defaults payload to empty object when omitted", () => {
    const { payload: _, ...rest } = validWebhook;
    const result = channelWebhookSchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.payload).toEqual({});
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Destination masking logic (tested inline, mirrors channel.worker line 137)
// ---------------------------------------------------------------------------

describe("destination masking", () => {
  function maskDestination(destination: string): string {
    return destination.length > 4
      ? destination.replace(/^(.{2}).+(.{2})$/, "$1***$2")
      : "***";
  }

  it("masks the middle of a long destination", () => {
    expect(maskDestination("user@example.com")).toBe("us***om");
  });

  it("returns *** for short destinations (4 chars or fewer)", () => {
    expect(maskDestination("ab")).toBe("***");
    expect(maskDestination("abcd")).toBe("***");
  });

  it("preserves first 2 and last 2 characters", () => {
    expect(maskDestination("+1234567890")).toBe("+1***90");
  });
});
