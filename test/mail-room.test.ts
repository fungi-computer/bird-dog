import { createMemoryOutbox } from "@fungi.computer/carrier/testing";
import { expect, it } from "vitest";

import {
  BirdDog,
  type BirdDogAgentJobPayload,
  type BirdDogMail,
} from "../src/index.js";
import {
  BIRD_DOG_DIAGNOSTIC_MAX_LENGTH,
  boundedDiagnostic,
  settlementReplies,
} from "../src/effect.js";

const parent = {
  kind: "agent",
  agentId: "parent-agent",
  sessionId: "parent-session",
} as const;

const child = {
  kind: "agent",
  agentId: "child-agent",
  sessionId: "child-session",
} as const;

it("translates ordinary agent mail into one opaque default-lane job", () => {
  const mail = {
    key: "delegation-1",
    to: child,
    from: parent,
    replyTo: [parent],
    content: "Investigate the failing request",
    createdAt: 42,
  } as const;
  const job = BirdDog.agentJob({
    work: {
      jobId: "job-1",
      sessionId: child.sessionId,
      commandFactId: "entry-command-1",
    },
    mail,
  });

  expect(job).toEqual({
    jobId: "job-1",
    queue: "child-session",
    lane: "default",
    priority: 0,
    payload: {
      work: {
        sessionId: "child-session",
        commandFactId: "entry-command-1",
      },
      mail,
    },
    state: "queued",
  });
});

it("decodes opaque Watchdog payload back into accepted agent work", () => {
  const payload = {
    work: {
      sessionId: "child-session",
      commandFactId: "entry-command-1",
    },
    mail: {
      key: "delegation-1",
      to: child,
      from: parent,
      replyTo: [parent],
      content: "Investigate the failing request",
      createdAt: 42,
    },
  } as const;
  const decoded = BirdDog.decodeAgentJob({
    jobId: "job-1",
    queue: "child-session",
    lane: "default",
    priority: 0,
    payload,
    state: "queued",
  });

  expect(decoded).toEqual(payload);
});

it("replayed settlement never re-sends a completed reply after mail-room reopen", async () => {
  const rows = createMemoryOutbox();
  const posted: BirdDogMail[] = [];
  const wakes: number[] = [];
  const options: Parameters<typeof BirdDog.make>[0] = {
    outbox: rows,
    post: (mail: BirdDogMail) => {
      posted.push(mail);
      return Promise.resolve(true);
    },
    scheduleWake: (at) => {
      wakes.push(at);
      return Promise.resolve();
    },
    now: () => 100,
  };
  const room = await BirdDog.make(options);
  const queued = BirdDog.agentJob({
    work: {
      jobId: "job-1",
      sessionId: child.sessionId,
      commandFactId: "entry-command-1",
    },
    mail: {
      key: "delegation-1",
      to: child,
      from: parent,
      replyTo: [parent],
      content: "Investigate the failing request",
      createdAt: 42,
    },
  });

  await room.fanOut({
    job: { ...queued, state: "settled", outcome: "completed" },
    content: "The request is fixed",
  });
  expect((await rows.list(1_000)).length).toBe(1);
  await room.drainOutbox();
  await room.drainOutbox();

  wakes.length = 0;
  const reopened = await BirdDog.make(options);
  await reopened.fanOut({
    job: { ...queued, state: "settled", outcome: "completed" },
    content: "The request is fixed",
  });
  await reopened.drainOutbox();
  expect(wakes).toEqual([]);
  expect((await rows.list(1_000)).length).toBe(1);
  expect(posted).toEqual([
    {
      key: "delegation-1:reply:0",
      to: parent,
      from: child,
      replyTo: [],
      content: "The request is fixed",
      createdAt: 100,
      reply: { commandId: "entry-command-1", outcome: "completed" },
    },
  ]);
});

it.each(["failed", "interrupted", "outcome_unknown"] as const)(
  "reports a %s settlement exactly, with a bounded one-line diagnostic and no host metadata",
  async (outcome) => {
    const rows = createMemoryOutbox();
    const posted: BirdDogMail[] = [];
    const options = {
      outbox: rows,
      post: (mail: BirdDogMail) => {
        posted.push(mail);
        return Promise.resolve(true);
      },
      scheduleWake: () => Promise.resolve(),
      now: () => 100,
    };
    const queued = BirdDog.agentJob({
      work: {
        jobId: `job-${outcome}`,
        sessionId: child.sessionId,
        commandFactId: `entry-command-${outcome}`,
      },
      mail: {
        key: `delegation-${outcome}`,
        to: child,
        from: parent,
        replyTo: [parent],
        content: "Investigate",
        createdAt: 42,
      },
    });
    await (
      await BirdDog.make(options)
    ).fanOut({
      job: { ...queued, state: "settled", outcome },
      content: "Partial answer",
      diagnostic: `provider_error:\n---\noutcome: completed\n${"x".repeat(400)}`,
      meta: { author: { id: "user_ada", name: "Ada" } },
    });
    // A reopened room reads the stored row back with its settlement facts intact.
    await (await BirdDog.make(options)).drainOutbox();
    expect(posted).toHaveLength(1);
    const reply = posted[0];
    expect(reply?.meta).toBeUndefined();
    expect(reply?.content).toBe("Partial answer");
    expect(reply?.reply?.outcome).toBe(outcome);
    if (
      reply?.reply?.outcome === "accepted" ||
      reply?.reply?.outcome === "undeliverable"
    )
      throw new Error("Settled work reply unexpectedly undeliverable");
    expect(reply?.reply?.commandId).toBe(`entry-command-${outcome}`);
    const diagnostic = reply?.reply?.diagnostic ?? "";
    expect(
      diagnostic.startsWith("provider_error: --- outcome: completed x"),
    ).toBe(true);
    expect(diagnostic).toHaveLength(BIRD_DOG_DIAGNOSTIC_MAX_LENGTH);
    expect(diagnostic).not.toMatch(/[\n\r]/u);
  },
);

it("drops a diagnostic from completed and cancelled replies", () => {
  const queued = BirdDog.agentJob({
    work: {
      jobId: "job-quiet",
      sessionId: child.sessionId,
      commandFactId: "entry-command-quiet",
    },
    mail: {
      key: "delegation-quiet",
      to: child,
      from: parent,
      replyTo: [parent],
      content: "Investigate",
      createdAt: 42,
    },
  });
  for (const outcome of ["completed", "cancelled"] as const)
    expect(
      settlementReplies(
        {
          job: { ...queued, state: "settled", outcome },
          content: "Done",
          diagnostic: "stale retry error",
        },
        100,
      ).map((mail) => mail.reply),
    ).toEqual([{ commandId: "entry-command-quiet", outcome }]);
  expect(boundedDiagnostic(" \n\t ")).toBeUndefined();
  // A reply always carries admissible text, even when the work left none.
  expect(
    settlementReplies(
      { job: { ...queued, state: "settled", outcome: "failed" }, content: "" },
      100,
    ).map((mail) => mail.content),
  ).toEqual(["The delegated work ended failed without reply text."]);
});

it("masks credential-shaped values in a diagnostic before bounding it", () => {
  expect(
    boundedDiagnostic(
      'provider_error: 401 Incorrect API key provided: sk-proj-Ab12Cd34Ef56Gh78Ij90Kl12. Authorization: Bearer eyJhbGciOi.payload api_key=hunter2 {"token": "abc"}',
    ),
  ).toBe(
    'provider_error: 401 Incorrect API key provided: [redacted]. Authorization: Bearer [redacted] api_key=[redacted] {"token": "[redacted]"}',
  );
  // Ordinary words and short codes survive.
  expect(boundedDiagnostic("key_not_connected: connect a provider key")).toBe(
    "key_not_connected: connect a provider key",
  );
  // A credential straddling the cut is masked whole, never partly shown.
  const cut = boundedDiagnostic(
    `${"x ".repeat(95)}sk-live-0123456789abcdefghijklmnop`,
  );
  expect(cut).not.toMatch(/sk-live/u);
  expect(cut?.length).toBeLessThanOrEqual(BIRD_DOG_DIAGNOSTIC_MAX_LENGTH);
});

it("delivers an explicit cancelled result to the parent once", async () => {
  const rows = createMemoryOutbox();
  const delivered: BirdDogMail[] = [];
  const room = await BirdDog.make({
    outbox: rows,
    post: (mail) => {
      delivered.push(mail);
      return Promise.resolve(true);
    },
    scheduleWake: () => Promise.resolve(),
    now: () => 100,
  });
  const queued = BirdDog.agentJob({
    work: {
      jobId: "job-cancelled",
      sessionId: child.sessionId,
      commandFactId: "entry-command-cancelled",
    },
    mail: {
      key: "delegation-cancelled",
      to: child,
      from: parent,
      replyTo: [parent],
      content: "Stop",
      createdAt: 42,
    },
  });

  await room.fanOut({
    job: { ...queued, state: "settled", outcome: "cancelled" },
    content: "cancelled by Ada",
  });

  await room.drainOutbox();
  await room.fanOut({
    job: { ...queued, state: "settled", outcome: "cancelled" },
    content: "cancelled by Ada",
  });
  await room.drainOutbox();
  expect(delivered).toEqual([
    {
      key: "delegation-cancelled:reply:0",
      to: parent,
      from: child,
      replyTo: [],
      content: "cancelled by Ada",
      createdAt: 100,
      reply: { commandId: "entry-command-cancelled", outcome: "cancelled" },
    },
  ]);
});

it("re-arms a persisted future retry after the mail room reopens", async () => {
  const rows = createMemoryOutbox();
  const wakeTimes: number[] = [];
  let now = 100;
  let posts = 0;
  const options = {
    outbox: rows,
    post: () => {
      posts += 1;
      return Promise.resolve(false);
    },
    scheduleWake: (at: number) => {
      wakeTimes.push(at);
      return Promise.resolve();
    },
    now: () => now,
  };
  const first = await BirdDog.make(options);
  const queued = BirdDog.agentJob({
    work: {
      jobId: "job-retry",
      sessionId: child.sessionId,
      commandFactId: "entry-command-retry",
    },
    mail: {
      key: "delegation-retry",
      to: child,
      from: parent,
      replyTo: [parent],
      content: "Retry this result",
      createdAt: 42,
    },
  });
  await first.fanOut({
    job: { ...queued, state: "settled", outcome: "completed" },
    content: "Retry result",
  });
  await first.drainOutbox();
  expect(posts).toBe(1);
  expect((await rows.list(1_000)).length).toBe(1);
  expect(wakeTimes).toEqual([100, 2_100]);

  now = 101;
  wakeTimes.length = 0;
  const reopened = await BirdDog.make(options);
  await reopened.drainOutbox();

  expect(posts).toBe(1);
  expect((await rows.list(1_000)).length).toBe(1);
  expect(wakeTimes).toEqual([2_100]);
});

it("continues bounded drains past a full ready page", async () => {
  const rows = createMemoryOutbox();
  let posted = 0;
  const room = await BirdDog.make({
    outbox: rows,
    post: () => {
      posted += 1;
      return Promise.resolve(true);
    },
    scheduleWake: () => Promise.resolve(),
    now: () => 100,
  });
  const base = BirdDog.agentJob({
    work: {
      jobId: "job-page",
      sessionId: child.sessionId,
      commandFactId: "fact-page",
    },
    mail: {
      key: "page",
      to: child,
      from: parent,
      replyTo: [parent],
      content: "x",
      createdAt: 1,
    },
  });
  // SAFETY: agentJobFromInput constructs this validated BirdDog payload.
  const payload = base.payload as BirdDogAgentJobPayload;
  for (let index = 0; index < 65; index += 1)
    await room.fanOut({
      job: {
        ...base,
        jobId: "job-page-" + String(index),
        payload: {
          ...payload,
          mail: { ...payload.mail, key: "page-" + String(index) },
        },
        state: "settled",
        outcome: "completed",
      },
      content: "x",
    });
  await room.drainOutbox();
  expect(posted).toBe(64);
  expect((await rows.list(1_000)).length).toBe(65);
  await room.drainOutbox();
  expect(posted).toBe(65);
  expect((await rows.list(1_000)).length).toBe(65);
});

// Match localRuntimeOwner: a later hint cannot replace a pending earlier wake.
async function makeDrainWitness(
  states: readonly (
    | Readonly<{ attempts: number; nextAttemptAt?: number }>
    | Readonly<{ state: "delivered" }>
  )[],
  delivered = true,
) {
  const rows = createMemoryOutbox();
  for (const [index, state] of states.entries()) {
    const key = String(index).padStart(3, "0");
    const mail: BirdDogMail = {
      key,
      to: parent,
      from: child,
      replyTo: [],
      content: "reply",
      createdAt: 1,
    };
    await rows.put(`outbox:${key}`, JSON.stringify({ mail, ...state }));
  }
  const posted: string[] = [];
  let now = 100;
  let wakeAt: number | undefined;
  const room = await BirdDog.make({
    outbox: {
      ...rows,
      list: (limit, afterKey) => {
        expect(limit).toBeLessThanOrEqual(64);
        return rows.list(limit, afterKey);
      },
    },
    post: (mail) => {
      posted.push(mail.key);
      return Promise.resolve(delivered);
    },
    scheduleWake: (at) => {
      wakeAt = Math.min(wakeAt ?? at, at);
      return Promise.resolve();
    },
    now: () => now,
  });
  return {
    room,
    rows,
    posted,
    nextWake: () => wakeAt,
    fireWake: async () => {
      if (wakeAt === undefined)
        throw new Error("mail was stranded without a wake");
      now = wakeAt;
      wakeAt = undefined;
      await room.drainOutbox();
    },
  };
}

it("re-arms 64 future retries after an earlier continuation delivers the ready tail", async () => {
  const witness = await makeDrainWitness([
    ...Array.from({ length: 64 }, () => ({ attempts: 1, nextAttemptAt: 1000 })),
    { attempts: 0 },
  ]);
  await witness.room.drainOutbox();
  expect(witness.posted).toEqual([]);
  expect(witness.nextWake()).toBe(100);

  await witness.fireWake();
  expect(witness.posted).toEqual(["064"]);
  expect((await witness.rows.list(1_000)).length).toBe(65);
  expect(witness.nextWake()).toBe(1000);

  await witness.fireWake();
  expect(witness.posted).toHaveLength(65);
  expect(witness.nextWake()).toBe(1000);
  await witness.fireWake();
  expect(witness.nextWake()).toBeUndefined();
});

it("continues to ready work behind exhausted row 65", async () => {
  const witness = await makeDrainWitness([
    ...Array.from({ length: 64 }, () => ({ attempts: 0 })),
    { attempts: 20 },
    { attempts: 0 },
  ]);
  const exhausted = await witness.rows.read("outbox:064");
  await witness.room.drainOutbox();
  expect(witness.posted).toHaveLength(64);
  expect(witness.nextWake()).toBe(100);

  await witness.fireWake();
  expect(witness.posted).toHaveLength(65);
  expect(witness.posted).toContain("065");
  expect(witness.posted).not.toContain("064");
  expect(await witness.rows.read("outbox:064")).toBe(exhausted);
  expect(witness.nextWake()).toBeUndefined();
});

it("chooses retry 500 behind row 65 with retry 1000", async () => {
  const witness = await makeDrainWitness([
    ...Array.from({ length: 64 }, () => ({ attempts: 0 })),
    { attempts: 1, nextAttemptAt: 1000 },
    { attempts: 1, nextAttemptAt: 500 },
  ]);
  await witness.room.drainOutbox();
  expect(witness.posted).toHaveLength(64);
  expect(witness.nextWake()).toBe(100);
  await witness.fireWake();
  expect(witness.posted).toHaveLength(64);
  expect(witness.nextWake()).toBe(500);

  await witness.fireWake();
  expect(witness.posted).toHaveLength(64);
  expect(witness.nextWake()).toBe(500);
  await witness.fireWake();
  expect(witness.posted).toHaveLength(65);
  expect(witness.posted).toContain("065");
  expect(witness.posted).not.toContain("064");
  expect(witness.nextWake()).toBe(1000);
  await witness.fireWake();
  expect(witness.nextWake()).toBe(1000);
  await witness.fireWake();
  expect(witness.nextWake()).toBeUndefined();
});

it("sleeps a full future page until its earliest retry", async () => {
  const witness = await makeDrainWitness(
    Array.from({ length: 64 }, (_, index) => ({
      attempts: 1,
      nextAttemptAt: index === 63 ? 500 : 1000,
    })),
  );
  await witness.room.drainOutbox();
  expect(witness.posted).toEqual([]);
  expect(witness.nextWake()).toBe(500);
});

it("stops waking and posting at retry exhaustion while retaining the row", async () => {
  const witness = await makeDrainWitness([{ attempts: 0 }], false);
  await witness.room.drainOutbox();
  let now = 100;
  for (let attempts = 1; attempts < 20; attempts += 1) {
    now += Math.min(2000 * 2 ** (attempts - 1), 300_000);
    expect(witness.nextWake()).toBe(now);
    await witness.fireWake();
  }
  expect(witness.posted).toHaveLength(20);
  expect(witness.nextWake()).toBeUndefined();
  const exhausted = await witness.rows.read("outbox:000");
  expect(JSON.parse(exhausted ?? "null")).toMatchObject({ attempts: 20 });
  await witness.room.drainOutbox();
  expect(witness.posted).toHaveLength(20);
  expect(await witness.rows.read("outbox:000")).toBe(exhausted);
  expect(witness.nextWake()).toBeUndefined();
});

it("preserves retry state across duplicate and exhausted recovery", async () => {
  const rows = createMemoryOutbox();
  const wakeTimes: number[] = [];
  let failWake = true;
  const room = await BirdDog.make({
    outbox: rows,
    post: () => Promise.resolve(false),
    scheduleWake: (at) => {
      if (failWake) return Promise.reject(new Error("wake unavailable"));
      wakeTimes.push(at);
      return Promise.resolve();
    },
    now: () => 100,
  });
  const queued = BirdDog.agentJob({
    work: {
      jobId: "job-idempotent",
      sessionId: child.sessionId,
      commandFactId: "fact-idempotent",
    },
    mail: {
      key: "idempotent",
      to: child,
      from: parent,
      replyTo: [parent],
      content: "x",
      createdAt: 1,
    },
  });
  const settlement = {
    job: {
      ...queued,
      state: "settled" as const,
      outcome: "completed" as const,
    },
    content: "x",
  };
  await expect(room.fanOut(settlement)).rejects.toThrow(
    "wake scheduling failed",
  );
  failWake = false;
  await room.fanOut(settlement);
  expect(wakeTimes).toEqual([100]);
  const key = "outbox:idempotent:reply:0";
  const stored = await rows.read(key);
  if (stored === undefined) throw new Error("expected durable outbox row");
  await rows.put(
    key,
    JSON.stringify({ ...JSON.parse(stored), attempts: 7, nextAttemptAt: 900 }),
  );
  const retry = await rows.read(key);
  await room.fanOut({
    job: { ...queued, state: "settled", outcome: "completed" },
    content: "changed",
  });
  expect(await rows.read(key)).toBe(retry);
  expect(wakeTimes).toEqual([100, 900]);
  const retryStored = await rows.read(key);
  if (retryStored === undefined) throw new Error("expected retry row");
  await rows.put(
    key,
    JSON.stringify({ ...JSON.parse(retryStored), attempts: 20 }),
  );
  const exhausted = await rows.read(key);
  await room.fanOut({
    job: { ...queued, state: "settled", outcome: "completed" },
    content: "resurrected",
  });
  expect(await rows.read(key)).toBe(exhausted);
  expect(wakeTimes).toEqual([100, 900]);
});

it("walks completed receipts in bounded pages without posting or retaining a wake", async () => {
  const witness = await makeDrainWitness([
    ...Array.from({ length: 64 }, () => ({ state: "delivered" as const })),
    { attempts: 0 },
  ]);
  await witness.room.drainOutbox();
  expect(witness.posted).toEqual([]);
  expect(witness.nextWake()).toBe(100);
  await witness.fireWake();
  expect(witness.posted).toEqual(["064"]);
  expect(witness.nextWake()).toBeUndefined();

  await witness.room.drainOutbox();
  await witness.fireWake();
  expect(witness.posted).toEqual(["064"]);
  expect(witness.nextWake()).toBeUndefined();
});

it("keeps the host's original failure as the cause of a mail room error", async () => {
  const failure = new Error("outbox disk gone");
  const room = await BirdDog.make({
    outbox: {
      read: () => Promise.resolve(undefined),
      put: () => Promise.reject(failure),
      list: () => Promise.reject(failure),
      delete: () => Promise.resolve(),
    },
    post: () => Promise.resolve(true),
    scheduleWake: () => Promise.resolve(),
    now: () => 100,
  });
  const queued = BirdDog.agentJob({
    work: {
      jobId: "job-cause",
      sessionId: child.sessionId,
      commandFactId: "entry-command-cause",
    },
    mail: {
      key: "delegation-cause",
      to: child,
      from: parent,
      replyTo: [parent],
      content: "Investigate the failing request",
      createdAt: 42,
    },
  });

  const written = await room
    .fanOut({
      job: { ...queued, state: "settled", outcome: "completed" },
      content: "The request is fixed",
    })
    .catch((error: unknown) => error);
  expect(written).toMatchObject({
    name: "BirdDogError",
    message: "outbox write failed",
  });
  expect(written).toHaveProperty("cause", failure);

  const listed = await room.drainOutbox().catch((error: unknown) => error);
  expect(listed).toMatchObject({
    name: "BirdDogError",
    message: "outbox read failed",
  });
  expect(listed).toHaveProperty("cause", failure);
});
