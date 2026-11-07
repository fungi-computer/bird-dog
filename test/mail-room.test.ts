import { expect, it } from "vitest";

import { BirdDog, type BirdDogMail } from "../src/index.js";
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
    delivery: "followUp",
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

it("stages a completed reply with the admitted command identity", async () => {
  const posted: BirdDogMail[] = [];
  const options: Parameters<typeof BirdDog.make>[0] = {
    stage: (mail: readonly BirdDogMail[]) => {
      posted.push(...mail);
      return Promise.resolve();
    },
    now: () => 100,
  };
  const room = await BirdDog.make(options);
  const queued = BirdDog.agentJob({
    delivery: "followUp",
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
    const posted: BirdDogMail[] = [];
    const options = {
      stage: (mail: readonly BirdDogMail[]) => {
        posted.push(...mail);
        return Promise.resolve();
      },
      now: () => 100,
    };
    const queued = BirdDog.agentJob({
      delivery: "followUp",
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
    delivery: "followUp",
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
      'provider_error: 401 Incorrect API key provided: sk-proj-Ab12Cd34Ef56Gh78Ij90Kl12. Authorization: Bearer eyJhbGciOi.payload api_key=hunter2 {"token": "abc"}', //gitleaks:allow
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

it("stages an explicit cancelled result for the parent", async () => {
  const delivered: BirdDogMail[] = [];
  const room = await BirdDog.make({
    stage: (mail) => {
      delivered.push(...mail);
      return Promise.resolve();
    },
    now: () => 100,
  });
  const queued = BirdDog.agentJob({
    delivery: "followUp",
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

it("keeps the host's original failure as the cause of a mail room error", async () => {
  const failure = new Error("outbox disk gone");
  const room = await BirdDog.make({
    stage: () => Promise.reject(failure),
    now: () => 100,
  });
  const queued = BirdDog.agentJob({
    delivery: "followUp",
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
    message: "mail staging failed",
  });
  expect(written).toHaveProperty("cause", failure);
});

const delegator = {
  key: "delegation-1",
  agentId: child.agentId,
  replyTo: [parent],
} as const;

it("a goal turn after the sent command reports to the sender when the Session goes idle", () => {
  const goalTurn = BirdDog.agentJob({
    delivery: "followUp",
    work: {
      jobId: "job-goal-2",
      sessionId: child.sessionId,
      commandFactId: "entry-goal-2",
    },
  });
  const settled = {
    ...goalTurn,
    state: "settled",
    outcome: "completed",
  } as const;
  expect(settlementReplies({ job: settled, content: "READY" }, 100)).toEqual(
    [],
  );
  expect(
    settlementReplies({ job: settled, content: "READY", delegator }, 100),
  ).toEqual([
    {
      key: "delegation-1:report:entry-goal-2:0",
      to: parent,
      from: child,
      replyTo: [],
      content: "READY",
      createdAt: 100,
      reply: { commandId: "entry-goal-2", outcome: "completed" },
    },
  ]);
  // A turn a reply mail started (replyTo empty) reports like any other turn.
  const replyTurn = BirdDog.agentJob({
    delivery: "steer",
    work: {
      jobId: "job-reply-3",
      sessionId: child.sessionId,
      commandFactId: "entry-reply-3",
    },
    mail: {
      key: "reply-3",
      to: child,
      from: parent,
      replyTo: [],
      content: "ack",
      createdAt: 42,
    },
  });
  expect(
    settlementReplies(
      {
        job: { ...replyTurn, state: "settled", outcome: "completed" },
        content: "READY",
        delegator,
      },
      100,
    ).map((mail) => mail.key),
  ).toEqual(["delegation-1:report:entry-reply-3:0"]);
});

it("work a delegating mail admitted replies under its own key, never also as a report", () => {
  const queued = BirdDog.agentJob({
    delivery: "followUp",
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
      content: "Investigate",
      createdAt: 42,
    },
  });
  expect(
    settlementReplies(
      {
        job: { ...queued, state: "settled", outcome: "completed" },
        content: "Done",
        delegator,
      },
      100,
    ).map((mail) => mail.key),
  ).toEqual(["delegation-1:reply:0"]);
});

it("an empty failed turn's report names its diagnostic", () => {
  const queued = BirdDog.agentJob({
    delivery: "followUp",
    work: {
      jobId: "job-fail",
      sessionId: child.sessionId,
      commandFactId: "entry-fail",
    },
  });
  const [report] = settlementReplies(
    {
      job: { ...queued, state: "settled", outcome: "failed" },
      content: "",
      diagnostic: "runtime:rejected: sandbox-busy",
      delegator,
    },
    100,
  );
  expect(report?.content).toBe(
    "The delegated work ended failed: runtime:rejected: sandbox-busy",
  );
  expect(report?.reply).toEqual({
    commandId: "entry-fail",
    outcome: "failed",
    diagnostic: "runtime:rejected: sandbox-busy",
  });
});

it("a report and a reply both name what waits on their recipient", () => {
  const waitingOnYou = [
    { itemId: "ask-1", kind: "question", summary: "Branch" },
  ];
  const goalTurn = BirdDog.agentJob({
    delivery: "followUp",
    work: {
      jobId: "job-goal-4",
      sessionId: child.sessionId,
      commandFactId: "entry-goal-4",
    },
  });
  const [report] = settlementReplies(
    {
      job: { ...goalTurn, state: "settled", outcome: "completed" },
      content: "Asked which branch",
      delegator,
      waitingOnYou,
    },
    100,
  );
  expect(report?.key).toBe("delegation-1:report:entry-goal-4:0");
  expect(report?.reply).toEqual({
    commandId: "entry-goal-4",
    outcome: "completed",
    waitingOnYou,
  });
  const sent = BirdDog.agentJob({
    delivery: "followUp",
    work: {
      jobId: "job-sent-5",
      sessionId: child.sessionId,
      commandFactId: "entry-sent-5",
    },
    mail: {
      key: "delegation-5",
      to: child,
      from: parent,
      replyTo: [parent],
      content: "Ask me",
      createdAt: 42,
    },
  });
  const [reply] = settlementReplies(
    {
      job: { ...sent, state: "settled", outcome: "completed" },
      content: "Asked",
      waitingOnYou,
    },
    100,
  );
  expect(reply?.key).toBe("delegation-5:reply:0");
  expect(reply?.reply).toMatchObject({ waitingOnYou });
});
