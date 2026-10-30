# BirdDog (`@fungi.computer/bird-dog`)

BirdDog is a durable mail room for AI agents. One agent sends work to another
agent's session, the work runs as a [Watchdog](../watchdog/README.md) job, and
when that job settles BirdDog delivers the reply to everyone on the envelope's
`replyTo` list. Replies sit in a durable outbox and retry on a bounded schedule
until the recipient accepts them.

It does two jobs:

- It translates addressed agent work into an opaque Watchdog job, and decodes
  that job's payload back after Watchdog claims it.
- It fans out replies when the job settles, stores them in your outbox, and
  delivers them with retries through Carrier's Post outbox
  ([`@fungi.computer/carrier/post`](../carrier/README.md)).

Every sender and recipient is an ordinary agent session. A parent and a child
agent are both plain agents to BirdDog. Their relationship lives in your code,
and all agent work uses Watchdog's `default` lane. You own storage, transport,
the clock and wake scheduling. BirdDog owns the envelope format, the reply keys
and the retry schedule.

## Install or set up

```sh
npm install @fungi.computer/bird-dog
```

BirdDog is ESM-only. It depends on `@fungi.computer/watchdog`,
`@fungi.computer/carrier` and `effect`, which npm installs for you. It does no
I/O of its own, so it runs in Node, Cloudflare Workers or any runtime that can
give it an outbox and a `post` function.

Entrypoints:

- `@fungi.computer/bird-dog`: the Promise API on `BirdDog` and its types.
- `@fungi.computer/bird-dog/effect`: the Effect-native mail room (`make`),
  `settlementReplies`, the Effect Schema parsers and `BirdDogError`.
  `settlementReplies` builds the same reply envelopes for a host-owned Post
  transport.

## Quick start

This sends work from a parent agent to a child agent, settles it, and delivers
the reply. The outbox uses Carrier’s deterministic memory helper, and `post`
prints the reply instead of sending it anywhere.

```ts
import { BirdDog, type BirdDogMail } from "@fungi.computer/bird-dog";
import { createMemoryOutbox } from "@fungi.computer/carrier/testing";

const parent = {
  kind: "agent",
  agentId: "parent",
  sessionId: "parent-session",
} as const;
const child = {
  kind: "agent",
  agentId: "child",
  sessionId: "child-session",
} as const;

const room = await BirdDog.make({
  outbox: createMemoryOutbox(),
  post: async (mail: BirdDogMail) => {
    console.log(`to ${mail.to.agentId}:\n${mail.content}`);
    return true; // the recipient accepted it
  },
  scheduleWake: async (at) => {
    console.log(`wake me at ${at}`);
  },
  now: () => Date.now(),
});

// 1. Turn accepted work into a Watchdog job. Hand this to Watchdog's ingest.
const job = BirdDog.agentJob({
  delivery: "followUp",
  work: {
    jobId: "job-1",
    sessionId: child.sessionId,
    commandFactId: "command-1",
  },
  mail: {
    key: "delegation-1",
    to: child,
    from: parent,
    replyTo: [parent],
    content: "Find out why the build is red",
    createdAt: Date.now(),
  },
});

// 2. Your Watchdog executor decodes the payload and runs the child's work.
const payload = BirdDog.decodeAgentJob(job);
console.log(payload.work.commandFactId); // "command-1"

// 3. When Watchdog settles the job, queue the replies, then deliver them.
await room.fanOut({
  job: { ...job, state: "settled", outcome: "completed" },
  content: "A test fixture was missing. Fixed it.",
});
await room.drainOutbox();
```

In a real host, the settled job comes from Watchdog's `tick()` result and
`drainOutbox()` runs from the wake you scheduled.

## Core concepts

**Addresses.** An agent address is `{ kind: "agent", agentId, sessionId }`. IDs
are 1 to 256 characters. There is no special kind for subagents.

**Mail.** A `BirdDogMail` has a stable `key`, a `to` and `from` address, a
`replyTo` list, string `content` and a `createdAt` time in milliseconds. The key
must identify the request across retries. BirdDog derives every reply key from
it.

**Agent jobs.** `BirdDog.agentJob({ work, delivery, mail? })` validates the
input and returns a queued Watchdog job. The job's `queue` is the target
`sessionId`, its lane is `default`, its priority is `0`, and its payload carries
the `sessionId`, the `commandFactId` and the optional mail. `work.recovery`
passes straight through to Watchdog's recovery policy. Because it is
synchronous, you can call it inside an owner transaction and pass the result to
Watchdog's `transactional.enqueueAcceptedJob`. `BirdDog.decodeAgentJob(job)`
parses the payload back on the executor side. Watchdog never reads it.

**Fan-out.** `fanOut({ job, content, diagnostic? })` takes a settled job, the
content owed to correspondents and the Session's terminal diagnostic. It writes
one reply per `replyTo` address into the outbox, keyed
`outbox:<mail key>:reply:<index>`, then schedules one wake for the earliest.
Each reply's `from` is the mail's recipient, its `content` is your content
verbatim (or, when it is empty,
`The delegated work ended <outcome> without reply text.`, so a reply is always
admissible text), and its typed `reply` field carries the settlement facts:

```ts
{
  commandId: "command-1", // the settled work's commandFactId
  outcome: "failed", // the exact Watchdog outcome
  diagnostic: "provider_error: 401 Authorization: Bearer [redacted]",
}
```

`outcome` is exactly the job's: `completed`, `failed`, `interrupted`,
`cancelled` or `outcome_unknown`. Only `failed`, `interrupted` and
`outcome_unknown` replies carry a diagnostic. `boundedDiagnostic` makes it one
line, masks credential-shaped values (authorization-scheme credentials, named
keys, tokens, secrets and passwords, and long letter-and-digit runs), then cuts
it to `BIRD_DOG_DIAGNOSTIC_MAX_LENGTH` (200) characters. A `cancelled` job
delivers the supplied cancellation result as its content. A settlement's `meta`
is for your own fan-out wrapper, such as naming who cancelled; replies never
carry it. A job without mail sends nothing.

The recipient's host owns authentication and presentation. It trusts the `reply`
facts only after checking the reply against the mail it sent, then decides who
authors the line and how its model sees it.

**Draining.** `drainOutbox()` reads one page of up to 64 outbox rows and calls
`post` for each due reply. `post` returns `true` when the recipient accepts the
mail. A `false` or a throw schedules a retry. If more rows remain, BirdDog
schedules an immediate wake and continues from the same place on the next drain.

**Receipts.** A delivered reply's row is replaced by a compact completion
receipt under the same key. Replaying the same settlement after a restart finds
the receipt and does not post the reply again. Keep those receipts as long as
source settlements can replay. BirdDog does not expire them.
`hasPendingDelivery(outbox)` reads only whether any reply still awaits a
delivery attempt, so a host can tell retained receipts and dead letters from
owed mail.

The Effect mail room's `nextWakeAt()` reads Carrier's earliest owed delivery,
including future retries. Runtime hosts include that hint in their pending-work
answer rather than clearing a retry when other runtime work is idle.

**Host ports.** `BirdDog.make` takes four things:

- `outbox`: string rows with `put`, `read`, ordered `list(limit, afterKey?)` and
  `delete`. Use the same key ordering for sorting and the exclusive `afterKey`
  filter so paging cannot skip or repeat rows.
- `post(mail)`: delivers one reply and reports acceptance.
- `scheduleWake(at)`: arms a durable timer for `drainOutbox`.
- `now()`: the current time in milliseconds.

## API reference

The generated reference is in [docs/api](docs/api/README.md).

- `@fungi.computer/bird-dog`: `BirdDog` with `agentJob`, `decodeAgentJob` and
  `make`, plus the `BirdDogMail`, `BirdDogAgentReference`, `BirdDogAgentWork`,
  `BirdDogAgentJobPayload`, `BirdDogReply`, `BirdDogOutbox`, `BirdDogOptions`,
  `BirdDogSettlement` and `BirdDogRuntime` types.
- `@fungi.computer/bird-dog/effect`: `make`, `agentJobFromInput`,
  `decodeAgentJob`, `settlementReplies`, `hasPendingDelivery`,
  `boundedDiagnostic`, `BIRD_DOG_DIAGNOSTIC_MAX_LENGTH`, `BirdDogError`,
  `EffectBirdDogOptions`, `BirdDogEffect` and the schemas
  `BirdDogAgentReferenceSchema`, `BirdDogReplySchema`, `BirdDogMailSchema`,
  `BirdDogAgentWorkSchema`, `BirdDogAgentJobPayloadSchema` and
  `BirdDogAgentJobInputSchema`.

## Examples and checks

The Effect entrypoint takes the same ports as Effect values:

```ts
import * as Effect from "effect/Effect";
import { make } from "@fungi.computer/bird-dog/effect";

const room = await Effect.runPromise(
  make({
    outbox: {
      put: () => Effect.void,
      read: () => Effect.succeed(undefined),
      list: () => Effect.succeed([]),
      delete: () => Effect.void,
    },
    post: () => Effect.succeed(true),
    scheduleWake: () => Effect.void,
    now: () => Date.now(),
  }),
);
await Effect.runPromise(room.drainOutbox());
```

Use the schemas to parse mail that arrives from outside your process:

```ts
import * as Schema from "effect/Schema";
import { BirdDogMailSchema } from "@fungi.computer/bird-dog/effect";

const mail = Schema.decodeUnknownSync(BirdDogMailSchema)(JSON.parse(body));
```

The package tests cover job translation, payload decoding, replayed settlement
after a restart, explicit cancellation replies, exact failure outcomes with
bounded and redacted diagnostics, retry re-arming after reopen, bounded paging
past full pages, retry exhaustion, receipt walks, wake failure after fan-out,
and parity between the Promise and Effect schemas. From the package directory:

```sh
pnpm test
```

## Limits and errors

- **Retry schedule.** A failed delivery retries after 2 seconds, doubling each
  time, capped at 5 minutes. After 20 attempts the reply is exhausted. Its row
  stays in the outbox, and BirdDog stops posting it and stops waking for it.
- **At-least-once.** If the recipient accepts a reply but recording the receipt
  fails, the retry uses the same mail key. Recipients must admit a repeated key
  idempotently.
- **Malformed rows.** A row that does not parse is deleted during a drain. A
  malformed row met during fan-out fails that fan-out.
- **Fan-out writes first.** Every reply is persisted before the wake is
  scheduled. If `scheduleWake` fails, `fanOut` rejects but the replies are
  already in the outbox, so replaying the settlement is safe.
- **Invalid input.** `agentJob` and `decodeAgentJob` throw a schema error on
  input that does not match. `fanOut` rejects with
  `BirdDogError("invalid agent job payload")` for a job whose payload is not
  BirdDog's.
- **Host failures.** The Promise mail room wraps a failing port in a
  `BirdDogError` and keeps your original error as its `cause`. The messages are
  `outbox read failed`, `outbox write failed`, `outbox delete failed`,
  `mail transport failed` and `wake scheduling failed`. A `post` that throws
  during a drain is logged and retried, not rethrown.

## Contribute and license

BirdDog is MIT licensed. See [LICENSE](./LICENSE).
