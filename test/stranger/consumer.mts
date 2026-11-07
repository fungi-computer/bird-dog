import * as Effect from "effect/Effect";
import { BirdDog, type BirdDogMail } from "@fungi.computer/bird-dog";
import { make as makeEffectBirdDog } from "@fungi.computer/bird-dog/effect";

const address = {
  kind: "agent",
  agentId: "stranger-agent",
  sessionId: "stranger-session",
} as const;
const mail: BirdDogMail = {
  key: "mail-stranger",
  to: address,
  from: address,
  replyTo: [],
  content: "hello",
  createdAt: 1,
};
const job = BirdDog.agentJob({
  delivery: "followUp",
  work: {
    jobId: "job-stranger",
    sessionId: address.sessionId,
    commandFactId: "entry-stranger",
  },
  mail,
});
const payload = BirdDog.decodeAgentJob(job);

const promiseRuntime = await BirdDog.make({
  stage: () => Promise.resolve(),
  now: () => 1,
});
const effectRuntime = await Effect.runPromise(
  makeEffectBirdDog({
    stage: () => Effect.void,
    now: () => 1,
  }),
);

void payload;
void promiseRuntime;
void effectRuntime;
