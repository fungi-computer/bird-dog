import { expect, it } from "vitest";
import { BirdDog, type BirdDogMail } from "../src/index.js";

it("passes the entire fan-out to one staging transaction and exposes failure", async () => {
  const batches: (readonly BirdDogMail[])[] = [];
  const address = {
    kind: "agent",
    agentId: "agent",
    sessionId: "session",
  } as const;
  const room = await BirdDog.make({
    stage: (mail) => {
      batches.push(mail);
      return Promise.reject(new Error("staging unavailable"));
    },
    now: () => 100,
  });
  const job = BirdDog.agentJob({
    delivery: "followUp",
    work: { jobId: "work", sessionId: "session", commandFactId: "command" },
    mail: {
      key: "request",
      to: address,
      from: address,
      replyTo: [address, address],
      content: "request",
      createdAt: 1,
    },
  });
  await expect(
    room.fanOut({
      job: { ...job, state: "settled", outcome: "completed" },
      content: "done",
    }),
  ).rejects.toThrow("mail staging failed");
  expect(batches).toHaveLength(1);
  expect(batches[0]?.map(({ key }) => key)).toEqual([
    "request:reply:0",
    "request:reply:1",
  ]);
});
