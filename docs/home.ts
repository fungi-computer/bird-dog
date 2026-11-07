import { BirdDog, type BirdDogMail } from "@fungi.computer/bird-dog";

const parent = { kind: "agent", agentId: "parent", sessionId: "p" } as const;
const child = { kind: "agent", agentId: "child", sessionId: "c" } as const;
const room = await BirdDog.make({
  // The host stages this batch in its existing Carrier Post transaction.
  stage: async (mail: readonly BirdDogMail[]) => {
    for (const reply of mail) console.log(reply.content);
  },
  now: () => Date.now(),
});

const job = BirdDog.agentJob({
  delivery: "followUp",
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
