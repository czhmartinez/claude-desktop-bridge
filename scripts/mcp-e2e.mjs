import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import electronPath from "electron";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  BridgeCrypto,
  BridgeSocket,
} from "../packages/protocol/dist/index.js";

const relayUrl = process.env.BRIDGE_QA_RELAY ?? "ws://127.0.0.1:8788/ws";
const mcpCommand = process.env.BRIDGE_MCP_COMMAND ?? electronPath;
const mcpArgs = process.env.BRIDGE_MCP_COMMAND
  ? ["--mcp"]
  : [resolve("apps/desktop"), "--mcp"];
const temporary = await mkdtemp(resolve(tmpdir(), "bridge-mcp-e2e-"));
const { crypto: desktopCrypto, pairing } = await BridgeCrypto.createDesktop(relayUrl, "MCP Test Computer");
const mobileCrypto = await BridgeCrypto.fromPairing(pairing, "mcp-test-phone");
const config = {
  version: 1,
  pairing: {
    version: pairing.version,
    roomId: pairing.roomId,
    relayUrl: pairing.relayUrl,
    desktopName: pairing.desktopName,
    createdAt: pairing.createdAt,
  },
  protectedSecret: `file:${Buffer.from(pairing.secret, "utf8").toString("base64")}`,
  deviceId: desktopCrypto.identity.deviceId,
  launchAtLogin: false,
};
await mkdir(temporary, { recursive: true });
await writeFile(resolve(temporary, "bridge-config.json"), JSON.stringify(config), { mode: 0o600 });

const desktopSocket = new BridgeSocket({ crypto: desktopCrypto, role: "desktop", createRoom: true, reconnect: false });
const mobileSocket = new BridgeSocket({ crypto: mobileCrypto, role: "mobile", reconnect: false });

function waitForConnected(socket) {
  if (socket.state === "connected") return Promise.resolve();
  return new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error("Bridge socket connection timed out")), 8_000);
    const off = socket.onState((state) => {
      if (state === "connected") {
        clearTimeout(timeout);
        off();
        resolveReady();
      }
    });
  });
}

function nextMessage(socket) {
  return new Promise((resolveMessage, reject) => {
    const timeout = setTimeout(() => reject(new Error("MCP update did not reach the mobile client")), 8_000);
    const off = socket.onMessage((message, encrypted) => {
      clearTimeout(timeout);
      socket.ack([encrypted.id]);
      off();
      resolveMessage(message);
    });
  });
}

desktopSocket.connect();
await waitForConnected(desktopSocket);
mobileSocket.connect();
await waitForConnected(mobileSocket);

const transport = new StdioClientTransport({
  command: mcpCommand,
  args: mcpArgs,
  env: {
    ...process.env,
    BRIDGE_USER_DATA: temporary,
    BRIDGE_RELAY_URL: relayUrl,
    BRIDGE_BACKGROUND_WORKER: "1",
  },
  stderr: "pipe",
});
const client = new Client({ name: "bridge-e2e", version: "0.1.0" });

try {
  await client.connect(transport);
  if (!client.getInstructions()?.includes("bridge_send_update")) {
    throw new Error("MCP workflow instructions were not advertised");
  }
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  for (const expected of ["bridge_send_update", "bridge_complete"]) {
    if (!names.includes(expected)) throw new Error(`Missing MCP tool: ${expected}`);
  }

  const update = nextMessage(mobileSocket);
  await client.callTool({
    name: "bridge_send_update",
    arguments: { message: "MCP 端到端测试通过", progress: 88, step: "验证" },
  });
  const updateMessage = await update;
  if (updateMessage.payload.kind !== "status" || updateMessage.payload.message !== "MCP 端到端测试通过") {
    throw new Error("MCP update payload did not round-trip");
  }

  process.stdout.write(`MCP E2E passed with ${names.length} tools.\n`);
} finally {
  await client.close().catch(() => undefined);
  desktopSocket.close();
  mobileSocket.close();
  await rm(temporary, { recursive: true, force: true });
}
