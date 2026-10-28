import type * as Schema from "effect/Schema";
import type {
  WatchdogQueuedJob,
  WatchdogSettledJob,
  WatchdogStoredJob,
} from "@fungi.computer/watchdog";

import { agentJobFromInput, decodeAgentJob } from "./effect.js";
import { createPromiseBirdDog } from "./internal/promise-mail-room.js";

/** An ordinary agent Session address. Relationships between agents live elsewhere. */
export type BirdDogAgentReference = Readonly<{
  kind: "agent";
  agentId: string;
  sessionId: string;
}>;

/** An addressed Agent whose first Session may be created on acceptance. */
export type BirdDogAgentRecipientReference = Readonly<{
  kind: "agent";
  agentId: string;
  sessionId?: string;
}>;

/** The Hub's stable system identity for a terminal offline disposition. */
export type BirdDogSystemIdentity = Readonly<{
  kind: "system";
  systemId: "hub";
}>;

/**
 * What a reply reports about the settled work beside its content. The
 * recipient's host trusts these facts only after it authenticates the reply
 * against the mail it sent.
 */
export type BirdDogReply =
  | Readonly<{
      /** The recipient accepted the work into the named Session. */
      commandId: string;
      outcome: "accepted";
    }>
  | Readonly<{
      /** The replying Session's accepted command: the sender's receipt `commandId`. */
      commandId: string;
      /** The exact Watchdog outcome; failures are never collapsed. */
      outcome:
        | "completed"
        | "failed"
        | "interrupted"
        | "cancelled"
        | "outcome_unknown";
      /** Bounded terminal diagnostic for work that did not complete or cancel. */
      diagnostic?: string;
      /** Open items of the replying Session that now wait on this recipient. */
      waitingOnYou?: readonly BirdDogWaitingItem[];
    }>
  | Readonly<{
      outcome: "undeliverable";
      reason: "recipient_offline" | "recipient_left";
    }>;

/** Facts an Agent may author; the Hub owns recipient-offline disposition. */
export type BirdDogAgentReply =
  | Exclude<BirdDogReply, { outcome: "undeliverable" }>
  | Readonly<{ outcome: "undeliverable"; reason: "recipient_left" }>;

/**
 * Addressed correspondence. Agents author ordinary replies and recipient-left
 * notices; only the Hub system authors recipient-offline dispositions.
 */
export type BirdDogMail =
  | Readonly<{
      key: string;
      to: BirdDogAgentRecipientReference;
      replyTo: readonly BirdDogAgentReference[];
      content: string;
      createdAt: number;
      /** The sender's opaque host metadata; BirdDog never reads it. */
      meta?: BirdDogMeta;
      from: BirdDogAgentReference;
      /** Settlement or acceptance facts, present only on a reply. */
      reply?: BirdDogAgentReply;
    }>
  | Readonly<{
      key: string;
      to: BirdDogAgentRecipientReference;
      replyTo: readonly BirdDogAgentReference[];
      content: string;
      createdAt: number;
      /** The sender's opaque host metadata; BirdDog never reads it. */
      meta?: BirdDogMeta;
      /** The Hub owns offline disposition authorship, not the recipient. */
      from: BirdDogSystemIdentity;
      reply: Readonly<{
        outcome: "undeliverable";
        reason: "recipient_offline";
      }>;
    }>;

/** Construct the one stable system reply correlated to the exact sent letter. */
export function undeliverableReply(
  original: BirdDogMail,
  createdAt: number,
): BirdDogMail {
  if (original.reply !== undefined || original.from.kind !== "agent")
    throw new Error("A reply cannot receive another undeliverable disposition");
  return {
    key: `${original.key}:reply:0`,
    from: { kind: "system", systemId: "hub" },
    to: original.from,
    replyTo: [],
    content: "undeliverable",
    createdAt,
    reply: { outcome: "undeliverable", reason: "recipient_offline" },
  };
}

/** Opaque JSON a host attached to the work; BirdDog only carries it. */
export type BirdDogMeta = typeof Schema.Json.Type;

/** The accepted Session work BirdDog points at from an opaque Watchdog job. */
export type BirdDogAgentWork = Readonly<{
  jobId: string;
  sessionId: string;
  commandFactId: string;
  recovery?: Readonly<{ maxRecoveries: number }> | undefined;
}>;

/** Typed payload whose meaning belongs to BirdDog, never Watchdog. */
export type BirdDogAgentJobPayload = Readonly<{
  work: Readonly<{
    sessionId: string;
    commandFactId: string;
  }>;
  mail?: BirdDogMail | undefined;
}>;

/** Input for projecting accepted agent work into Watchdog's generic grammar. */
export type BirdDogAgentJobInput = Readonly<{
  work: BirdDogAgentWork;
  mail?: BirdDogMail | undefined;
}>;

/** String-backed durable outbox owned by the BirdDog host. */
export type BirdDogOutbox = Readonly<{
  /** Store one encoded mail row under its durable key. */
  put: (key: string, value: string) => Promise<void>;
  /** Read one encoded mail row, if it exists. */
  read: (key: string) => Promise<string | undefined>;
  /** Read an ordered page of encoded mail rows. */
  list: (
    limit: number,
    afterKey?: string,
  ) => Promise<readonly Readonly<{ key: string; value: string }>[]>;
  /** Remove an invalid encoded row; completed deliveries retain receipts. */
  delete: (key: string) => Promise<void>;
}>;

/** Host ports for BirdDog's durable mail delivery. */
export type BirdDogOptions = Readonly<{
  /** Durable store for pending reply mail. */
  outbox: BirdDogOutbox;
  /** Deliver one reply mail and report whether it was accepted. */
  post: (mail: BirdDogMail) => Promise<boolean>;
  /** Arrange a future wake for pending delivery work. */
  scheduleWake: (at: number) => Promise<void>;
  /** Return the host's current wall-clock time in milliseconds. */
  now: () => number;
}>;

/**
 * Who sent a Session its work first: the mail that opened the relationship.
 * `agentId` is the Session's own Agent, the author of every report.
 */
export type BirdDogDelegator = Readonly<{
  key: string;
  agentId: string;
  replyTo: readonly BirdDogAgentReference[];
}>;

/** Completed generic work plus the content owed to its correspondents. */
export type BirdDogSettlement = Readonly<{
  job: WatchdogSettledJob;
  content: string;
  /**
   * The Session's delegator of record, named only when this settlement leaves
   * the Session idle. Work without a replying mail of its own reports to it.
   */
  delegator?: BirdDogDelegator;
  /**
   * The Session's recorded terminal diagnostic. Replies carry it, bounded by
   * `boundedDiagnostic`, only for failed, interrupted and outcome_unknown work.
   */
  diagnostic?: string;
  /**
   * The settled work's host metadata, for the host's own fan-out wrapper (for
   * example, naming who cancelled). Replies never carry it.
   */
  meta?: BirdDogMeta;
  /**
   * Open items of the settled Session that now wait on the correspondent this
   * work came from. Replies carry them beside the settlement facts.
   */
  waitingOnYou?: readonly BirdDogWaitingItem[];
}>;

/** One open item named by a reply as waiting on its recipient. */
export type BirdDogWaitingItem = Readonly<{
  itemId: string;
  kind: string;
  summary: string;
}>;

/** Durable reply delivery behind the mail-room interface. */
export type BirdDogRuntime = Readonly<{
  /** Queue replies owed by a settled agent job. */
  fanOut: (settlement: BirdDogSettlement) => Promise<void>;
  /** Deliver due replies and schedule any required retry wake. */
  drainOutbox: () => Promise<void>;
}>;

/** BirdDog's small synchronous translation interface for owner transactions. */
export type BirdDogApi = Readonly<{
  /** Validate and translate accepted agent work into one opaque Watchdog job. */
  agentJob: (input: BirdDogAgentJobInput) => WatchdogQueuedJob;
  /** Decode one generic Watchdog job into BirdDog-owned agent work. */
  decodeAgentJob: (job: WatchdogStoredJob) => BirdDogAgentJobPayload;
  /** Construct the durable reply mail room. */
  make: (options: BirdDogOptions) => Promise<BirdDogRuntime>;
}>;

/** Agent-aware mail translation over Watchdog's payload-blind job grammar. */
export const BirdDog: BirdDogApi = Object.freeze({
  agentJob: agentJobFromInput,
  decodeAgentJob,
  make: createPromiseBirdDog,
});
