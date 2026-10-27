import { expect, it } from "vitest";
import * as Schema from "effect/Schema";

import { acceptedNotice, BirdDogMailSchema } from "../src/effect.js";
import { undeliverableReply } from "../src/index.js";

it("parses a Hub/system offline reply without a command ID", () => {
  const mail = {
    key: "mail-1:reply:0",
    to: { kind: "agent", agentId: "sender", sessionId: "sender-session" },
    from: { kind: "system", systemId: "hub" },
    replyTo: [],
    content: "Not delivered: recipient offline.",
    createdAt: 0,
    reply: { outcome: "undeliverable", reason: "recipient_offline" },
  };
  expect(
    Schema.decodeUnknownSync(BirdDogMailSchema, {
      onExcessProperty: "error",
    })(mail).reply,
  ).toEqual(mail.reply);
  expect(() =>
    Schema.decodeUnknownSync(BirdDogMailSchema, {
      onExcessProperty: "error",
    })({ ...mail, reply: { ...mail.reply, commandId: "wrong-contract" } }),
  ).toThrow();
});
it("rejects recipient-authored offline replies", () => {
  const impersonated = {
    key: "mail-1:reply:0",
    to: { kind: "agent", agentId: "sender", sessionId: "sender-session" },
    from: {
      kind: "agent",
      agentId: "recipient",
      sessionId: "recipient-session",
    },
    replyTo: [],
    content: "Not delivered: recipient offline.",
    createdAt: 0,
    reply: { outcome: "undeliverable", reason: "recipient_offline" },
  };
  expect(() =>
    Schema.decodeUnknownSync(BirdDogMailSchema, {
      onExcessProperty: "error",
    })(impersonated),
  ).toThrow();
});
it("accepts addressed mail whose recipient Session will be created at acceptance", () => {
  const mail = {
    key: "mail-without-session",
    to: { kind: "agent", agentId: "recipient" },
    from: {
      kind: "agent",
      agentId: "sender",
      sessionId: "sender-session",
    },
    replyTo: [],
    content: "Work once",
    createdAt: 0,
  };
  expect(
    Schema.decodeUnknownSync(BirdDogMailSchema, {
      onExcessProperty: "error",
    })(mail).to,
  ).toEqual(mail.to);
  expect(() =>
    Schema.decodeUnknownSync(BirdDogMailSchema, {
      onExcessProperty: "error",
    })({ ...mail, from: { kind: "agent", agentId: "sender" } }),
  ).toThrow();
});

it("builds a stable accepted notice carrying the recipient's real Session", () => {
  const original = {
    key: "mail-1",
    to: { kind: "agent" as const, agentId: "recipient" },
    from: {
      kind: "agent" as const,
      agentId: "sender",
      sessionId: "sender-session",
    },
    replyTo: [],
    content: "hello",
    createdAt: 0,
  };
  expect(acceptedNotice(original, "real-session", "command-1", 1)).toEqual({
    key: "mail-1:accepted",
    to: original.from,
    from: {
      kind: "agent",
      agentId: "recipient",
      sessionId: "real-session",
    },
    replyTo: [],
    content: "Work accepted.",
    createdAt: 1,
    reply: { outcome: "accepted", commandId: "command-1" },
  });
});

it("builds a system offline reply correlated to the original mail key", () => {
  const original = {
    key: "mail-1",
    to: { kind: "agent" as const, agentId: "recipient" },
    from: {
      kind: "agent" as const,
      agentId: "sender",
      sessionId: "sender-session",
    },
    replyTo: [],
    content: "hello",
    createdAt: 0,
  };
  expect(undeliverableReply(original, 1)).toEqual({
    key: "mail-1:reply:0",
    from: { kind: "system", systemId: "hub" },
    to: original.from,
    replyTo: [],
    content: "undeliverable",
    createdAt: 1,
    reply: { outcome: "undeliverable", reason: "recipient_offline" },
  });
});
