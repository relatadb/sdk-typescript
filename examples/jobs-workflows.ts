/**
 * Example: jobs & workflows client methods (#723).
 *
 * Shows the 8 canonical system methods. Requires a running Relata server
 * (``cargo run -p relata-cli -- serve``).
 */

import { SystemClient } from "../src/system.ts";

const sys = new SystemClient({ baseUrl: "http://localhost:9090", bearerToken: "demo" });

const jobs = await sys.jobsStatus();
console.log("jobs:", jobs);

const c2 = await sys.jobStatus("c2_beacon_detect");
console.log("job/c2:", c2);

const workflows = await sys.listWorkflows();
console.log("workflows:", workflows);

await sys.registerWorkflow("demo_flow", [{ name: "s1", kind: "query", sql: "SELECT 1" }]);
console.log("get_workflow:", await sys.getWorkflow("demo_flow"));

const run = await sys.runWorkflow("demo_flow");
console.log("run:", run);
console.log("workflow_status:", await sys.workflowStatus("demo_flow"));

const runId = run["run_id"] as string;
if (runId) {
  const detail = await sys.workflowRun(runId);
  console.log("workflow_run detail:", detail.attempt_count, detail.last_error);
}
