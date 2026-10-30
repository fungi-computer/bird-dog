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
