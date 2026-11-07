# BirdDog (`@fungi.computer/bird-dog`)

BirdDog translates addressed Agent work into Watchdog jobs and builds replies
when that work settles. It owns envelope grammar, reply keys and settlement
content. The host stages each reply batch through its existing Carrier Post
owner; Watchdog owns delivery attempts and wakes.

Every sender and recipient is an ordinary Agent Session. Parent and child
relationships remain in the host's domain records.

## Install or set up

```sh
npm install @fungi.computer/bird-dog
```

BirdDog is ESM-only. It depends on `@fungi.computer/watchdog` and `effect`,
which npm installs for you. It does no I/O of its own, so it runs in Node,
Cloudflare Workers or any runtime that can stage a batch of mail in its existing
delivery owner.

Entrypoints:

- `@fungi.computer/bird-dog`: the Promise API on `BirdDog` and its types.
- `@fungi.computer/bird-dog/effect`: the Effect-native mail room (`make`),
  `settlementReplies`, the Effect Schema parsers and `BirdDogError`.
  `settlementReplies` builds the same reply envelopes for a host-owned Post
  transport.

## Quick start

This constructs a reply batch. The example prints it; a durable host stages the
batch in its existing Carrier Post transaction.

```ts
import { BirdDog, type BirdDogMail } from "@fungi.computer/bird-dog";

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
  stage: async (mail: readonly BirdDogMail[]) => {
    for (const reply of mail) console.log(reply.content);
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

// 3. When Watchdog settles the job, stage the replies.
await room.fanOut({
  job: { ...job, state: "settled", outcome: "completed" },
  content: "A test fixture was missing. Fixed it.",
});
```

In a real host, the settled job comes from Watchdog and `stage` commits the
whole batch before the settlement cursor advances. Replaying a stable reply key
retains the first staged letter, including its original timestamp.

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
content owed to correspondents and the Session's terminal diagnostic. It passes
one reply per `replyTo` address to `stage`, keyed `<mail key>:reply:<index>`.
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

**Host ports.** `BirdDog.make` takes `stage(mail)` and `now()`. Staging is one
batch operation so the host can commit all replies atomically. The host retains
stable keys, prepared delivery facts and receipts through Carrier Post. Watchdog
reserves attempts, resumes retries after reopen and reports the next wake.

## API reference

The generated reference is in [docs/api](docs/api/README.md).

- `@fungi.computer/bird-dog`: `BirdDog` with `agentJob`, `decodeAgentJob` and
  `make`, plus the `BirdDogMail`, `BirdDogAgentReference`, `BirdDogAgentWork`,
  `BirdDogAgentJobPayload`, `BirdDogReply`, `BirdDogOptions`,
  `BirdDogSettlement` and `BirdDogRuntime` types.
- `@fungi.computer/bird-dog/effect`: `make`, `agentJobFromInput`,
  `decodeAgentJob`, `settlementReplies`, `boundedDiagnostic`,
  `BIRD_DOG_DIAGNOSTIC_MAX_LENGTH`, `BirdDogError`, `EffectBirdDogOptions`,
  `BirdDogEffect` and the schemas `BirdDogAgentReferenceSchema`,
  `BirdDogReplySchema`, `BirdDogMailSchema`, `BirdDogAgentWorkSchema`,
  `BirdDogAgentJobPayloadSchema` and `BirdDogAgentJobInputSchema`.

## Examples and checks

The Effect entrypoint takes the same ports as Effect values. Using `job` from
the quick start, this prints the settlement reply batch:

```ts
import * as Effect from "effect/Effect";
import { make } from "@fungi.computer/bird-dog/effect";

const room = await Effect.runPromise(
  make({
    stage: (mail) =>
      Effect.sync(() => {
        for (const reply of mail) console.log(reply.content);
      }),
    now: () => Date.now(),
  }),
);
await Effect.runPromise(
  room.fanOut({
    job: { ...job, state: "settled", outcome: "completed" },
    content: "A test fixture was missing. Fixed it.",
  }),
);
```

Use the schemas to parse mail that arrives from outside your process:

```ts
import * as Schema from "effect/Schema";
import { BirdDogMailSchema } from "@fungi.computer/bird-dog/effect";

const mail = Schema.decodeUnknownSync(BirdDogMailSchema)(JSON.parse(body));
```

The package tests cover job translation, typed settlement replies, bounded and
redacted diagnostics, and batch staging failures. Carrier and Local consumer
tests cover durable retries, receipt loss and physical reopen.

```sh
pnpm test
```

## Limits and errors

`agentJob` and `decodeAgentJob` reject invalid input using the maintained
schema. A failing Promise staging port becomes
`BirdDogError("mail staging failed")` with the original error as its `cause`.
The caller must retain the settlement cursor until staging succeeds. Delivery
remains at least once: receivers must admit a repeated mail key idempotently.

## Contribute and license

BirdDog is MIT licensed. See [LICENSE](./LICENSE).
