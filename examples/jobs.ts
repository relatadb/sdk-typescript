/**
 * Example: inspect Relata-managed background jobs.
 *
 * Application workflow definitions and execution live in application code;
 * the platform SDK exposes job status for Relata-managed work only.
 */

import { SystemClient } from "../src/system.ts";
import { banner, exitOnRelataError, loadEnv, out, step } from "./_helpers.ts";

const { url, token } = loadEnv();
const sys = new SystemClient({
  baseUrl: url,
  ...(token ? { bearerToken: token } : {}),
});

try {
  banner("Relata Jobs");

  step("jobs.list");
  out(`  ${JSON.stringify(await sys.jobsStatus())}`);

  step("jobs.get(c2_beacon_detect)");
  out(`  ${JSON.stringify(await sys.jobStatus("c2_beacon_detect"))}`);
} catch (err) {
  exitOnRelataError(err);
}
