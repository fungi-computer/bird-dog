import { expect, it } from "vitest";
import { agentJobFromInput } from "../src/effect.js";

it("projects steers ahead of 28 accepted follow-ups in the Watchdog queue", () => {
  const work = (index: number) => ({
    sessionId: "session",
    commandFactId: `command-${String(index)}`,
    jobId: `job-${String(index)}`,
  });
  const followUps = Array.from({ length: 28 }, (_, index) =>
    agentJobFromInput({ work: work(index), delivery: "followUp" }),
  );
  const steer = agentJobFromInput({ work: work(28), delivery: "steer" });
  const first = [...followUps, steer].sort(
    (a, b) => b.priority - a.priority,
  )[0];
  expect(first?.jobId).toBe("job-28");
});
