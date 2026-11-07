import { BirdDog } from "@fungi.computer/bird-dog";

const address = {
  kind: "agent",
  agentId: "stranger-agent",
  sessionId: "stranger-session",
};
const job = BirdDog.agentJob({
  delivery: "followUp",
  work: {
    jobId: "job-stranger",
    sessionId: address.sessionId,
    commandFactId: "entry-stranger",
  },
  mail: {
    key: "mail-stranger",
    to: address,
    from: address,
    replyTo: [],
    content: "hello",
    createdAt: 1,
  },
});
const payload = BirdDog.decodeAgentJob(job);
if (payload.work.commandFactId !== "entry-stranger") {
  throw new Error("BirdDog stranger root lost accepted agent work");
}

const staged = [];
const room = await BirdDog.make({
  stage: async (mail) => {
    staged.push(...mail);
  },
  now: () => 2,
});
await room.fanOut({
  job: {
    ...job,
    payload: {
      ...job.payload,
      mail: { ...job.payload.mail, replyTo: [address] },
    },
    state: "settled",
    outcome: "completed",
  },
  content: "done",
});
if (staged.length !== 1 || staged[0].key !== "mail-stranger:reply:0")
  throw new Error("Packed BirdDog did not stage its reply");
