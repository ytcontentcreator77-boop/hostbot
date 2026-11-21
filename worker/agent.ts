import { createHash, createHmac, randomUUID } from "node:crypto";

export interface AgentEnv {
  AGENT_SHARED_SECRET?: string;
}
export interface AgentActionInput {
  endpoint: string;
  projectId: string;
  action: "start" | "stop" | "restart" | "delete" | "status";
  payload?: Record<string, unknown>;
  secret: string;
}
export async function callVpsAgent(input: AgentActionInput) {
  if (!input.secret) throw new Error("AGENT_NOT_CONFIGURED");
  const endpoint = new URL(input.endpoint);
  if (endpoint.protocol !== "https:" && endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "localhost") {
    throw new Error("AGENT_ENDPOINT_MUST_USE_HTTPS");
  }
  const path = `/v1/projects/${input.projectId}/${input.action}`;
  const body = JSON.stringify(input.payload || {});
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID();
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const signature = createHmac("sha256", input.secret)
    .update([timestamp, nonce, "POST", path, bodyHash].join("\n"))
    .digest("hex");
  const response = await fetch(new URL(path, endpoint), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hostpilot-timestamp": timestamp,
      "x-hostpilot-nonce": nonce,
      "x-hostpilot-signature": signature
    },
    body,
    signal: AbortSignal.timeout(15000)
  });
  const result = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(result.error || `AGENT_HTTP_${response.status}`));
  return result;
}
