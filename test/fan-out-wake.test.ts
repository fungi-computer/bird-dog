import { createMemoryOutbox } from "@fungi.computer/carrier/testing";
import { expect, it } from "vitest";
import { BirdDog } from "../src/index.js";

it("persists every reply before a fan-out wake failure", async () => {
  const rows = createMemoryOutbox();
  const address = {
    kind: "agent",
    agentId: "agent",
    sessionId: "session",
  } as const;
  const room = await BirdDog.make({
    outbox: rows,
    post: () => Promise.resolve(true),
    scheduleWake: () => Promise.reject(new Error("wake unavailable")),
    now: () => 100,
  });
  const job = BirdDog.agentJob({
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
  ).rejects.toThrow("wake scheduling failed");
  expect((await rows.list(1_000)).map(({ key }) => key)).toEqual([
    "outbox:request:reply:0",
    "outbox:request:reply:1",
  ]);
});
