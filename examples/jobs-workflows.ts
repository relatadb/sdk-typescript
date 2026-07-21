/**
 * Example: jobs & workflows client methods (#723).
 *
 * Shows the 8 canonical system methods. Requires a running Relata server
 * (``cargo run -p relata-cli -- serve``).
 */

import { SystemClient } from "../src/system.ts";
import { banner, exitOnRelataError, loadEnv, ok, out, step } from "./_helpers.ts";

const { url, token } = loadEnv();
const sys = new SystemClient({
  baseUrl: url,
  bearerToken: token,
});

try {
  banner("Relata Jobs & Workflows Demo");

  step("jobs.list");
  const jobs = await sys.jobsStatus();
  out(`  ${JSON.stringify(jobs)}`);

  step("jobs.get(c2_beacon_detect)");
  const c2 = await sys.jobStatus("c2_beacon_detect");
  out(`  ${JSON.stringify(c2)}`);

  step("workflows.list");
  const workflows = await sys.listWorkflows();
  out(`  ${workflows.length} registered`);

  step("workflows.register(demo_flow)");
  await sys.registerWorkflow("demo_flow", [
    { name: "s1", kind: "query", sql: "SELECT 1" },
  ]);
  ok("registered");

  step("workflows.get(demo_flow)");
  out(`  ${JSON.stringify(await sys.getWorkflow("demo_flow"))}`);

  step("workflows.run(demo_flow)");
  const run = await sys.runWorkflow("demo_flow");
  out(`  run id: ${run["run_id"] ?? "(none)"}`);

  step("workflows.status(demo_flow)");
  out(`  ${JSON.stringify(await sys.workflowStatus("demo_flow"))}`);

  const runId = run["run_id"] as string;
  if (runId) {
    step("workflows.run_detail");
    const detail = await sys.workflowRun(runId);
    out(
      `  attempts: ${detail.attempt_count}, last_error: ${detail.last_error ?? "(none)"}`,
    );
  }
} catch (err) {
  exitOnRelataError(err);
}
