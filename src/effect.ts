import type {
  WatchdogQueuedJob,
  WatchdogStoredJob,
} from "@fungi.computer/watchdog";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  makePostOutbox,
  postOutboxPending,
} from "@fungi.computer/carrier/post";

import type {
  BirdDogAgentJobInput,
  BirdDogAgentJobPayload,
  BirdDogMail,
  BirdDogSettlement,
} from "./index.js";

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
);

/** The maximum UTF-8 size of one mail body. */
export const BIRD_DOG_MAIL_CONTENT_MAX_BYTES = 256 * 1024;

const MailContent = Schema.String.check(
  Schema.makeFilter(
    (content) =>
      new TextEncoder().encode(content).byteLength <=
      BIRD_DOG_MAIL_CONTENT_MAX_BYTES,
    {
      message: `Mail content must be at most ${String(BIRD_DOG_MAIL_CONTENT_MAX_BYTES)} UTF-8 bytes`,
    },
  ),
);

/** Parser for an ordinary agent Session address. */
export const BirdDogAgentReferenceSchema = Schema.Struct({
  kind: Schema.Literal("agent"),
  agentId: Identifier,
  sessionId: Identifier,
});

/** An addressed Agent may create its first Session when accepting this mail. */
export const BirdDogAgentRecipientReferenceSchema = Schema.Struct({
  kind: Schema.Literal("agent"),
  agentId: Identifier,
  sessionId: Schema.optionalKey(Identifier),
});

/** The most characters a reply's failure diagnostic may carry. */
export const BIRD_DOG_DIAGNOSTIC_MAX_LENGTH = 200;

/**
 * Parser for the settlement facts a reply carries beside its content: the
 * replying Session's command, its exact Watchdog outcome and, for work that did
 * not complete, the Session's bounded terminal diagnostic.
 */
export const SettledBirdDogReplySchema = Schema.Struct({
  commandId: Identifier,
  outcome: Schema.Literals([
    "completed",
    "failed",
    "interrupted",
    "cancelled",
    "outcome_unknown",
  ]),
  diagnostic: Schema.optionalKey(
    Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(BIRD_DOG_DIAGNOSTIC_MAX_LENGTH),
    ),
  ),
});

/** A terminal delivery failure, correlated by the original mail key only. */
export const BirdDogUndeliverableReasonSchema = Schema.Literals([
  "recipient_offline",
  "recipient_left",
]);

export const UndeliverableBirdDogReplySchema = Schema.Struct({
  outcome: Schema.Literal("undeliverable"),
  reason: BirdDogUndeliverableReasonSchema,
});

/** Recipient acceptance, before the command has settled. */
export const AcceptedBirdDogReplySchema = Schema.Struct({
  outcome: Schema.Literal("accepted"),
  commandId: Identifier,
});

export const BirdDogReplySchema = Schema.Union([
  SettledBirdDogReplySchema,
  UndeliverableBirdDogReplySchema,
  AcceptedBirdDogReplySchema,
]);

const REDACTED = "[redacted]";
// An authorization scheme's credential, e.g. `Bearer <token>`.
const schemeCredential = /\b(bearer|basic)\s+[^\s"',;]+/giu;
// A named credential's value, e.g. `api_key=<value>` or `"token": "<value>"`.
const namedCredential =
  /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization)["']?\s*[:=]\s*["']?)(?!(?:bearer|basic)\s)[^\s"',;&]+/giu;
// A long opaque run of letters and digits, the shape of a key or token.
const opaqueToken = /[A-Za-z0-9][\w-]{23,}/gu;

function redactCredentials(text: string): string {
  return text
    .replace(schemeCredential, `$1 ${REDACTED}`)
    .replace(namedCredential, `$1${REDACTED}`)
    .replace(opaqueToken, (token) =>
      /\d/u.test(token) && /[A-Za-z]/u.test(token) ? REDACTED : token,
    );
}

/**
 * One secret-safe line of at most `BIRD_DOG_DIAGNOSTIC_MAX_LENGTH` characters
 * from a Session's terminal diagnostic, or nothing when it is blank. Control
 * characters and line breaks become single spaces, so the text cannot shape
 * the reply around it, and credential-shaped values are masked before the
 * line is cut, so a cut never exposes part of one.
 */
export function boundedDiagnostic(text: string): string | undefined {
  const line = redactCredentials(
    text.replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, " ").trim(),
  )
    .slice(0, BIRD_DOG_DIAGNOSTIC_MAX_LENGTH)
    .trimEnd();
  return line.length === 0 ? undefined : line;
}

/** Parser for addressed agent correspondence. */
const BirdDogMailFields = {
  key: Identifier,
  to: BirdDogAgentRecipientReferenceSchema,
  replyTo: Schema.Array(BirdDogAgentReferenceSchema),
  content: MailContent,
  createdAt: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  /** The sender's opaque host metadata; BirdDog never reads it. */
  meta: Schema.optionalKey(Schema.Json),
};

export const BirdDogMailSchema = Schema.Union([
  Schema.Struct({
    ...BirdDogMailFields,
    from: BirdDogAgentReferenceSchema,
    /** Settlement or acceptance facts, present only on a reply. */
    reply: Schema.optionalKey(BirdDogReplySchema),
  }),
  Schema.Struct({
    ...BirdDogMailFields,
    from: BirdDogAgentRecipientReferenceSchema,
    /** An unstarted recipient can only author an undeliverable reply. */
    reply: UndeliverableBirdDogReplySchema,
  }),
]);

/** Parser for accepted Session work. */
export const BirdDogAgentWorkSchema = Schema.Struct({
  jobId: Identifier,
  sessionId: Identifier,
  commandFactId: Identifier,
  recovery: Schema.optional(
    Schema.Struct({
      maxRecoveries: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
});

/** Parser for the payload that Watchdog stores without interpretation. */
export const BirdDogAgentJobPayloadSchema = Schema.Struct({
  work: Schema.Struct({
    sessionId: Identifier,
    commandFactId: Identifier,
  }),
  mail: Schema.optional(BirdDogMailSchema),
});

/** Parser for accepted work entering BirdDog's transactional projection. */
export const BirdDogAgentJobInputSchema = Schema.Struct({
  work: BirdDogAgentWorkSchema,
  mail: Schema.optional(BirdDogMailSchema),
});

/** BirdDog could not complete one owned store or transport operation. */
export class BirdDogError extends Error {
  /** Stable discriminator for BirdDog-owned effect failures. */
  public readonly _tag = "BirdDogError" as const;

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BirdDogError";
  }
}

/** Effect host ports for the durable mail room. */
export type EffectBirdDogOptions = Readonly<{
  outbox: Readonly<{
    /** Store one encoded mail row under its durable key. */
    put: (key: string, value: string) => Effect.Effect<void, BirdDogError>;
    /** Read one encoded mail row, if it exists. */
    read: (key: string) => Effect.Effect<string | undefined, BirdDogError>;
    /** Read an ordered page of encoded mail rows. */
    list: (
      limit: number,
      afterKey?: string,
    ) => Effect.Effect<
      readonly Readonly<{ key: string; value: string }>[],
      BirdDogError
    >;
    /** Remove an invalid encoded row; completed deliveries retain receipts. */
    delete: (key: string) => Effect.Effect<void, BirdDogError>;
  }>;
  /** Deliver one reply mail and report whether it was accepted. */
  post: (mail: BirdDogMail) => Effect.Effect<boolean, BirdDogError>;
  /** Arrange a future wake for pending delivery work. */
  scheduleWake: (at: number) => Effect.Effect<void, BirdDogError>;
  /** Return the host's current wall-clock time in milliseconds. */
  now: () => number;
}>;

/** Effect-native durable reply delivery. */
export type BirdDogEffect = Readonly<{
  /** Queue replies owed by a settled agent job. */
  fanOut: (settlement: BirdDogSettlement) => Effect.Effect<void, BirdDogError>;
  /** Durably queue one authored mail item in this Agent's existing outbox. */
  postMail?:
    ((mail: BirdDogMail) => Effect.Effect<void, BirdDogError>) | undefined;
  /** Deliver due replies and schedule any required retry wake. */
  drainOutbox: () => Effect.Effect<void, BirdDogError>;
  /** Earliest owed reply delivery, including retries; absent after delivery. */
  nextWakeAt: () => Effect.Effect<number | undefined, BirdDogError>;
}>;

/** Validate and translate agent work into Watchdog's opaque job grammar. */
export const agentJobFromInput = (
  input: BirdDogAgentJobInput,
): WatchdogQueuedJob => {
  const accepted = Schema.decodeUnknownSync(BirdDogAgentJobInputSchema)(input);
  const work = {
    sessionId: accepted.work.sessionId,
    commandFactId: accepted.work.commandFactId,
  };
  const payload =
    accepted.mail === undefined ? { work } : { work, mail: accepted.mail };
  const job = {
    jobId: accepted.work.jobId,
    queue: accepted.work.sessionId,
    lane: "default",
    priority: 0,
    payload,
    state: "queued",
  } as const;
  return accepted.work.recovery === undefined
    ? job
    : { ...job, recovery: accepted.work.recovery };
};

/** Decode the opaque payload at BirdDog's side of the Watchdog seam. */
export const decodeAgentJob = (
  job: WatchdogStoredJob,
): BirdDogAgentJobPayload =>
  Schema.decodeUnknownSync(BirdDogAgentJobPayloadSchema)(job.payload);

/**
 * Build the replies owed by one settlement for a host-owned Post transport.
 * Each reply carries the settled content verbatim (or, when there is none, one
 * sentence naming the outcome, so the reply is always admissible text) and its
 * settlement facts as typed fields; the recipient's host authenticates them and decides how they
 * are presented. A reply never carries the settled work's host metadata.
 */
export function settlementReplies(
  settlement: BirdDogSettlement,
  createdAt: number,
): readonly BirdDogMail[] {
  const { work, mail } = decodeAgentJob(settlement.job);
  if (mail === undefined) return [];
  const outcome = settlement.job.outcome;
  const diagnostic =
    outcome === "completed" ||
    outcome === "cancelled" ||
    settlement.diagnostic === undefined
      ? undefined
      : boundedDiagnostic(settlement.diagnostic);
  const reply = Schema.decodeUnknownSync(BirdDogReplySchema)(
    diagnostic === undefined
      ? { commandId: work.commandFactId, outcome }
      : { commandId: work.commandFactId, outcome, diagnostic },
  );
  return mail.replyTo.map((destination, index) => ({
    key: `${mail.key}:reply:${String(index)}`,
    to: destination,
    from: { ...mail.to, sessionId: work.sessionId },
    replyTo: [],
    content:
      settlement.content.length > 0
        ? settlement.content
        : `The delegated work ended ${outcome} without reply text.`,
    createdAt,
    reply,
  }));
}

/** Build the recipient's one stable acceptance notice for one original mail. */
export function acceptedNotice(
  mail: BirdDogMail,
  sessionId: string,
  commandId: string,
  createdAt: number,
): BirdDogMail {
  const recipientSession = Schema.decodeUnknownSync(Identifier)(sessionId);
  const sender = Schema.decodeUnknownSync(BirdDogAgentReferenceSchema)(
    mail.from,
  );
  const reply = Schema.decodeUnknownSync(AcceptedBirdDogReplySchema)({
    outcome: "accepted",
    commandId,
  });
  return {
    key: `${mail.key}:accepted`,
    to: sender,
    from: { ...mail.to, sessionId: recipientSession },
    replyTo: [],
    content: "Work accepted.",
    createdAt,
    reply,
  };
}

/**
 * Whether this mail room's outbox still owes any reply a delivery attempt.
 * Delivered receipts and exhausted dead letters stay but owe nothing.
 */
export const hasPendingDelivery = (
  outbox: Pick<EffectBirdDogOptions["outbox"], "list">,
): Effect.Effect<boolean, BirdDogError> =>
  postOutboxPending({ message: BirdDogMailSchema, outbox });

/** Construct BirdDog's Effect-native mail room over Post's shared outbox. */
export const make = (
  options: EffectBirdDogOptions,
): Effect.Effect<BirdDogEffect> => {
  const post = makePostOutbox({
    message: BirdDogMailSchema,
    key: (mail: BirdDogMail) => `outbox:${mail.key}`,
    outbox: options.outbox,
    deliver: options.post,
    scheduleWake: options.scheduleWake,
    now: options.now,
    invalidRow: () => new BirdDogError("invalid outbox row"),
    encodingFailed: () => new BirdDogError("could not encode outbox row"),
  });
  const fanOut = (settlement: BirdDogSettlement) =>
    Effect.gen(function* () {
      const createdAt = options.now();
      const replies = yield* Effect.try({
        try: () => settlementReplies(settlement, createdAt),
        catch: () => new BirdDogError("invalid agent job payload"),
      });
      let wake: number | undefined;
      for (const reply of replies) {
        const hint = yield* post.enqueue(reply, createdAt);
        if (hint !== undefined)
          wake = wake === undefined ? hint : Math.min(wake, hint);
      }
      if (wake !== undefined) yield* options.scheduleWake(wake);
    });
  const postMail = (mail: BirdDogMail) =>
    Effect.gen(function* () {
      const createdAt = options.now();
      const hint = yield* post.enqueue(mail, createdAt);
      if (hint !== undefined) yield* options.scheduleWake(hint);
      return;
    });
  return Effect.succeed({
    fanOut,
    postMail,
    drainOutbox: post.drain,
    nextWakeAt: post.nextWakeAt,
  });
};
