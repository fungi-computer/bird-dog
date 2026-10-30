import * as Effect from "effect/Effect";
import {
  BirdDog,
  type BirdDogMail,
  type BirdDogOutbox,
} from "@fungi.computer/bird-dog";
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

const outbox: BirdDogOutbox = {
  put: async () => Promise.resolve(),
  read: async () => Promise.resolve(undefined),
  list: async () => Promise.resolve([]),
  delete: async () => Promise.resolve(),
};
const promiseRuntime = await BirdDog.make({
  outbox,
  post: async () => Promise.resolve(true),
  scheduleWake: async () => Promise.resolve(),
  now: () => 1,
});
const effectRuntime = await Effect.runPromise(
  makeEffectBirdDog({
    outbox: {
      put: () => Effect.void,
      read: () => Effect.succeed(undefined),
      list: () => Effect.succeed([]),
      delete: () => Effect.void,
    },
    post: () => Effect.succeed(true),
    scheduleWake: () => Effect.void,
    now: () => 1,
  }),
);

void payload;
void promiseRuntime;
void effectRuntime;
