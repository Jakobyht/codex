import { CodexRpc } from "../codex-rpc.mjs";
const client = new CodexRpc();
try {
  await client.initialize();
  console.log(JSON.stringify({ initialized: true, modelTurnsStarted: 0, note: "Local protocol handshake only; no model quality, authentication or cloud desktop test." }));
} finally { await client.close(); }
