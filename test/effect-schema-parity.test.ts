import type {
  BirdDogAgentJobInput,
  BirdDogAgentJobPayload,
  BirdDogAgentReference,
  BirdDogAgentRecipientReference,
  BirdDogAgentWork,
  BirdDogMail,
} from "@fungi.computer/bird-dog";
import {
  BirdDogAgentJobInputSchema,
  BirdDogAgentJobPayloadSchema,
  BirdDogAgentReferenceSchema,
  BirdDogAgentRecipientReferenceSchema,
  BirdDogAgentWorkSchema,
  BirdDogMailSchema,
} from "../src/effect.js";
import * as Schema from "effect/Schema";
import { expectTypeOf, it } from "vitest";
import { describe, expect } from "vitest";

describe("BirdDog mail content bound", () => {
  const maxBytes = 256 * 1024;
  const mail = {
    key: "mail-1",
    to: { kind: "agent", agentId: "to", sessionId: "session-to" },
    from: { kind: "agent", agentId: "from", sessionId: "session-from" },
    replyTo: [],
    content: "é".repeat(maxBytes / 2) + "x",
    createdAt: 0,
  };

  it("rejects content over 256 KiB and accepts the exact byte limit", () => {
    expect(() => Schema.decodeUnknownSync(BirdDogMailSchema)(mail)).toThrow();
    for (const content of ["é".repeat(maxBytes / 2), "😀".repeat(maxBytes / 4)])
      expect(() =>
        Schema.decodeUnknownSync(BirdDogMailSchema)({ ...mail, content }),
      ).not.toThrow();
    for (const content of [
      "é".repeat(maxBytes / 2) + "x",
      "😀".repeat(maxBytes / 4) + "x",
    ])
      expect(() =>
        Schema.decodeUnknownSync(BirdDogMailSchema)({ ...mail, content }),
      ).toThrow();
  });
});

it("keeps Effect schemas aligned with the public domain types", () => {
  expectTypeOf<
    Schema.Schema.Type<typeof BirdDogAgentReferenceSchema>
  >().toEqualTypeOf<BirdDogAgentReference>();
  expectTypeOf<
    Schema.Schema.Type<typeof BirdDogAgentRecipientReferenceSchema>
  >().toEqualTypeOf<BirdDogAgentRecipientReference>();
  type Mail = Schema.Schema.Type<typeof BirdDogMailSchema>;
  expectTypeOf<Mail["key"]>().toEqualTypeOf<BirdDogMail["key"]>();
  expectTypeOf<Mail["from"]>().toEqualTypeOf<BirdDogMail["from"]>();
  expectTypeOf<Mail["to"]>().toEqualTypeOf<BirdDogMail["to"]>();
  expectTypeOf<Mail["replyTo"]>().toEqualTypeOf<BirdDogMail["replyTo"]>();
  expectTypeOf<Mail["reply"]>().toEqualTypeOf<BirdDogMail["reply"]>();
  expectTypeOf<Mail["content"]>().toEqualTypeOf<BirdDogMail["content"]>();
  expectTypeOf<Mail["createdAt"]>().toEqualTypeOf<BirdDogMail["createdAt"]>();
  expectTypeOf<
    Schema.Schema.Type<typeof BirdDogAgentWorkSchema>
  >().toEqualTypeOf<BirdDogAgentWork>();
  type Payload = Schema.Schema.Type<typeof BirdDogAgentJobPayloadSchema>;
  type Input = Schema.Schema.Type<typeof BirdDogAgentJobInputSchema>;
  expectTypeOf<Payload["work"]>().toEqualTypeOf<
    BirdDogAgentJobPayload["work"]
  >();
  expectTypeOf<Input["work"]>().toEqualTypeOf<BirdDogAgentJobInput["work"]>();
  // Effect normalizes optional mail keys to a required union with undefined.
});
