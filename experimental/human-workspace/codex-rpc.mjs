import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

// This transport does not start a model turn on connection. Its callers own
// model access, budgets, media transfer consent and action permissions.
export class CodexRpc {
  constructor({ command = "codex", args = ["app-server", "--stdio"], cwd, timeoutMs = 15000 } = {}) {
    this.nextId = 1; this.pending = new Map(); this.timeoutMs = timeoutMs; this.events = new EventEmitter();
    this.child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    // Never echo child stderr: it can contain account or integration details.
    this.child.stderr.resume();
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.method && message.id === undefined) { this.events.emit("notification", message); return; }
      if (message.method && message.id !== undefined) {
        // An integration must render approvals and consent before it can enable
        // tool execution. This minimal transport rejects server requests.
        this.child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "Interactive request handling is not enabled in this prototype." } }) + "\n");
        return;
      }
      const pending = this.pending.get(message.id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`Codex rejected ${pending.method} (RPC ${message.error.code}).`));
      else pending.resolve(message.result);
    });
    const fail = () => { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Codex transport closed before acknowledgement.")); } this.pending.clear(); this.events.emit("closed"); };
    this.child.on("error", fail); this.child.on("exit", fail); this.child.stdin.on("error", fail);
  }
  request(method, params) {
    if (this.child.exitCode !== null || this.child.killed || this.child.stdin.destroyed) return Promise.reject(new Error("Codex transport is closed."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out; delivery is unknown. Do not retry a turn automatically.`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  async initialize() {
    const result = await this.request("initialize", { clientInfo: { name: "human_workspace_lab", title: "Human Workspace Lab", version: "0.1.0" } });
    this.child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    return result;
  }
  waitForTurn(threadId, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      let text = "";
      const cleanup = () => { clearTimeout(timer); this.events.off("notification", onNotification); this.events.off("closed", onClosed); };
      const onClosed = () => { cleanup(); reject(new Error("Codex closed before a review result was confirmed.")); };
      const onNotification = (message) => {
        if (message.params?.threadId !== threadId) return;
        if (message.method === "item/agentMessage/delta") text += message.params.delta || "";
        if (message.method === "turn/completed") { cleanup(); resolve({ turn: message.params.turn, text }); }
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error("Review timed out; no completed result was confirmed.")); }, timeoutMs);
      this.events.on("notification", onNotification); this.events.on("closed", onClosed);
    });
  }
  async close() {
    this.child.stdin.end(); this.child.kill("SIGTERM"); this.lines.close();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Codex transport closed.")); } this.pending.clear(); this.events.emit("closed");
  }
}
