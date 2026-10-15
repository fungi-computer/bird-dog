import { BirdDog, type BirdDogMail } from "@fungi.computer/bird-dog";
import { createMemoryOutbox } from "@fungi.computer/carrier/testing";

const parent = { kind: "agent", agentId: "parent", sessionId: "p" } as const;
const child = { kind: "agent", agentId: "child", sessionId: "c" } as const;
const room = await BirdDog.make({
  outbox: createMemoryOutbox(),
  post: async (mail: BirdDogMail) => (console.log(mail.content), true),
  scheduleWake: async () => {},
  now: () => Date.now(),
});

const job = BirdDog.agentJob({
  work: { jobId: "job-1", sessionId: child.sessionId, commandFactId: "cmd-1" },
  mail: {
    key: "d-1",
    to: child,
    from: parent,
    replyTo: [parent],
    content: "go",
    createdAt: Date.now(),
  },
});
await room.fanOut({
  job: { ...job, state: "settled", outcome: "completed" },
  content: "Fixed it.",
});
await room.drainOutbox(); // post() prints the reply header, then "Fixed it."
