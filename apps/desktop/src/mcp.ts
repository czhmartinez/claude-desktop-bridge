import { BridgeCrypto, BridgeSocket } from "@bridge/protocol";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ClaudeBackgroundWorker } from "./claude-background-worker.js";
import { bridgeLocalToken, DesktopConfigRepository } from "./config.js";

function waitForConnected(socket: BridgeSocket, timeoutMs = 8_000): Promise<void> {
  if (socket.state === "connected") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Bridge is offline. Open the Bridge desktop app and try again."));
    }, timeoutMs);
    const unsubscribe = socket.onState((state) => {
      if (state === "connected") {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      }
    });
  });
}

export async function runMcpServer(repository: DesktopConfigRepository): Promise<void> {
  const config = await repository.load();
  if (!config) throw new Error("Bridge has not been set up. Open the Bridge desktop app first.");
  const crypto = await BridgeCrypto.fromPairing(config.pairing, config.deviceId);
  const socket = new BridgeSocket({ crypto, role: "agent" });
  socket.connect();
  const authorization = `Bearer ${bridgeLocalToken(config.pairing.secret)}`;
  const backgroundWorker = process.env.BRIDGE_BACKGROUND_WORKER === "1"
    ? undefined
    : new ClaudeBackgroundWorker({ authorization });
  backgroundWorker?.start();

  const server = new McpServer(
    { name: "claude-bridge", version: "0.1.0" },
    {
      instructions: [
        "The user has paired a phone through Bridge.",
        "Call bridge_send_update after meaningful milestones, using a concise message and progress when it is reasonably known.",
        "Call bridge_complete once when the requested task is genuinely finished.",
        "Do not send hidden chain-of-thought, secrets, credentials, or raw private file contents to the phone.",
      ].join(" "),
    },
  );
  server.registerTool(
    "bridge_send_update",
    {
      title: "Send progress to phone",
      description: "Send a concise work update to the user's paired phone. Use after meaningful steps and when the task finishes.",
      inputSchema: {
        message: z.string().min(1).max(2_000),
        progress: z.number().min(0).max(100).optional(),
        step: z.string().max(100).optional(),
        level: z.enum(["info", "success", "warning", "error"]).optional(),
      },
    },
    async ({ message, progress, step, level }) => {
      await waitForConnected(socket);
      await socket.send({
        kind: "status",
        message,
        ...(progress === undefined ? {} : { progress }),
        ...(step === undefined ? {} : { step }),
        ...(level === undefined ? {} : { level }),
      }, "mobile");
      return { content: [{ type: "text", text: "Update delivered to the paired phone." }] };
    },
  );
  server.registerTool(
    "bridge_complete",
    {
      title: "Send completion to phone",
      description: "Notify the paired phone that the current task is complete.",
      inputSchema: { summary: z.string().min(1).max(2_000) },
    },
    async ({ summary }) => {
      await waitForConnected(socket);
      await socket.send({ kind: "completion", summary }, "mobile");
      return { content: [{ type: "text", text: "Completion delivered to the paired phone." }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  const close = () => {
    socket.close();
    void backgroundWorker?.close();
    void server.close();
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}
