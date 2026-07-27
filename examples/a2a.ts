/**
 * a2a.ts — Agent-to-Agent task lifecycle + checkpoints (#967).
 *
 * The A2A door (`.well-known/agent.json` + `/a2a/tasks/*` + `/a2a/checkpoints/*`)
 * lets one agent ask another agent to do work and track its progress.
 *
 * Flow demonstrated:
 *   1. Discover the agent card (GET /.well-known/agent.json)
 *   2. Submit a task (POST /a2a/tasks) with a JSON-RPC-style payload
 *   3. Poll task status (GET /a2a/tasks/:id)
 *   4. List LangGraph-style checkpoints for a thread
 *
 * Run:
 *   RELATA_TOKEN=secret node --experimental-strip-types examples/a2a.ts
 */

import { createClient, A2AClient } from "../src/index.ts";
import { banner, exitOnRelataError, loadEnv, out, step } from "./_helpers.ts";

const { url, token } = loadEnv();
const relata = createClient(url, { bearerToken: token, defaultPurpose: "agent" });
const a2a = A2AClient.fromClient(relata);

interface Skill { id?: string; name?: string }
interface AgentCard { name?: string; version?: string; description?: string; skills?: Skill[] }
interface TaskResp { result?: { id?: string }; id?: string }
interface StatusResp { result?: { status?: { state?: string } }; status?: { state?: string }; state?: string }

async function main(): Promise<void> {
  banner("1. GET /.well-known/agent.json");
  const card = (await a2a.agentCard()) as AgentCard;
  out(`name=${card.name}  version=${card.version}  description=${card.description}`);
  const skills = card.skills ?? [];
  out(`${skills.length} skill(s):`);
  for (const s of skills.slice(0, 5)) out(`  - ${s.id} : ${s.name}`);

  step("2. POST /a2a/tasks");
  const taskPayload = {
    jsonrpc: "2.0",
    method: "tasks/send",
    params: {
      id: `task-${Date.now()}`,
      message: {
        role: "user",
        parts: [{ type: "text", text: "Summarise the latest 5 audit entries." }],
      },
    },
  };
  const created = (await a2a.submitTask(taskPayload)) as TaskResp;
  const taskId = created.result?.id ?? created.id ?? "(unknown)";
  out(`task_id=${taskId}`);
  out(`response: ${JSON.stringify(created).slice(0, 200)}`);

  step(`3. GET /a2a/tasks/${taskId}`);
  const status = (await a2a.getTask(taskId)) as StatusResp;
  const state = status.result?.status?.state ?? status.status?.state ?? status.state ?? "unknown";
  out(`state=${state}`);

  step("4. List checkpoints");
  const threadId = process.env.THREAD_ID ?? taskId;
  const checkpoints = await a2a.listCheckpoints(threadId);
  out(`${Array.isArray(checkpoints) ? checkpoints.length : 0} checkpoint(s) for thread ${threadId}`);
}

await main().catch(exitOnRelataError);
