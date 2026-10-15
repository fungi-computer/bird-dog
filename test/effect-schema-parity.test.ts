import type {
  BirdDogAgentJobInput,
  BirdDogAgentJobPayload,
  BirdDogAgentReference,
  BirdDogAgentWork,
  BirdDogMail,
} from "@fungi.computer/bird-dog";
import {
  BirdDogAgentJobInputSchema,
  BirdDogAgentJobPayloadSchema,
  BirdDogAgentReferenceSchema,
  BirdDogAgentWorkSchema,
  BirdDogMailSchema,
} from "../src/effect.js";
import * as Schema from "effect/Schema";
import { expectTypeOf, it } from "vitest";

it("keeps Effect schemas aligned with the public domain types", () => {
  expectTypeOf<
    Schema.Schema.Type<typeof BirdDogAgentReferenceSchema>
  >().toEqualTypeOf<BirdDogAgentReference>();
  expectTypeOf<
    Schema.Schema.Type<typeof BirdDogMailSchema>
  >().toEqualTypeOf<BirdDogMail>();
  expectTypeOf<
    Schema.Schema.Type<typeof BirdDogAgentWorkSchema>
  >().toEqualTypeOf<BirdDogAgentWork>();
  expectTypeOf<
    Schema.Schema.Type<typeof BirdDogAgentJobPayloadSchema>
  >().toEqualTypeOf<BirdDogAgentJobPayload>();
  expectTypeOf<
    Schema.Schema.Type<typeof BirdDogAgentJobInputSchema>
  >().toEqualTypeOf<BirdDogAgentJobInput>();
});
