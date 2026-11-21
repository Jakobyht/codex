import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { startServer } from "../server.mjs";
import { withCloudDesktop } from "../cloud-desktop.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "human-workspace-test-"));
  const app = await startServer({ port: 0, directory });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const root = await fetch(app.origin); await root.text();
  const cookie = root.headers.get("set-cookie").split(";")[0];
  const get = (path) => fetch(app.origin + path, { headers: { Cookie: cookie } });
  const post = (path, data, headers = {}) => fetch(app.origin + path, { method: "POST", headers: { Cookie: cookie, Origin: app.origin, "X-Workspace-Request": "1", "Content-Type": "application/json", ...headers }, body: JSON.stringify(data) });
  const state = await (await get("/api/state")).json();
  const feedback = () => ({ clientRequestId: randomUUID(), anchor: { artifactId: "document", revision: state.document.revision, kind: "text", start: 0, end: 3, quote: state.document.text.slice(0, 3) }, comment: "Bitte ein Beispiel ergänzen.", attachmentIds: [] });
  return { app, directory, cookie, get, post, state, feedback };
}

test("feedback is durable, idempotent, and retries cannot change its content", async (t) => {
  const f = await fixture(t); const input = f.feedback();
  const first = await (await f.post("/api/feedback", input)).json();
  const again = await (await f.post("/api/feedback", input)).json();
  assert.equal(first.id, again.id);
  assert.equal((await f.post("/api/feedback", { ...input, comment: "Different" })).status, 409);
  const disk = JSON.parse(await readFile(join(f.directory, "state.json"), "utf8"));
  assert.equal(disk.feedback.length, 1); assert.equal(disk.sequence, 1);
});

test("document conflicts and stale selections cannot be silently applied", async (t) => {
  const f = await fixture(t); const input = f.feedback();
  assert.equal((await f.post("/api/document", { expectedRevision: f.state.document.revision, text: "Eine andere Version." })).status, 200);
  assert.equal((await f.post("/api/feedback", input)).status, 409);
  assert.equal((await f.post("/api/document", { expectedRevision: f.state.document.revision, text: "Lost update" })).status, 409);
  const state = await (await f.get("/api/state")).json(); assert.equal(state.document.text, "Eine andere Version."); assert.equal(state.feedback.length, 0);
});

test("old feedback remains readable but cannot generate a Codex request", async (t) => {
  const f = await fixture(t); const entry = await (await f.post("/api/feedback", f.feedback())).json();
  const packet = await (await f.post("/api/codex-packet", { feedbackId: entry.id, target: { threadId: "test-thread", expectedTurnId: "test-turn" } })).json();
  assert.equal(packet.method, "turn/steer"); assert.equal(packet.params.expectedTurnId, "test-turn");
  assert.match(packet.params.input[0].text, /Attachment bytes are NOT included/);
  await f.post("/api/document", { expectedRevision: f.state.document.revision, text: "New revision" });
  assert.equal((await f.post("/api/codex-packet", { feedbackId: entry.id, target: { threadId: "test-thread" } })).status, 409);
  assert.equal((await (await f.get("/api/state")).json()).feedback.length, 1);
});

test("API rejects unauthenticated reads, foreign origins and DNS rebinding hosts", async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(f.app.origin + "/api/state")).status, 401);
  assert.equal((await f.post("/api/feedback", f.feedback(), { Origin: "https://foreign.invalid" })).status, 403);
  // fetch normalizes Host on this Node version; use the HTTP client to exercise
  // the actual wire-level DNS-rebinding boundary.
  const badHostStatus = await new Promise((resolve, reject) => {
    const req = request(f.app.origin + "/api/state", { headers: { Cookie: f.cookie, Host: "foreign.invalid" } }, (res) => { res.resume(); resolve(res.statusCode); }); req.on("error", reject); req.end();
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await f.get("/api/state")).status, 200);
});

test("media are bounded, content-addressed and preserved with precise timestamps", async (t) => {
  const f = await fixture(t); const bytes = Buffer.from([0,0,0,24,102,116,121,112,105,115,111,109]);
  const upload = (body, name) => fetch(f.app.origin + `/api/assets?name=${name}`, { method: "POST", headers: { Cookie: f.cookie, Origin: f.app.origin, "X-Workspace-Request": "1" }, body });
  assert.equal((await upload(Buffer.from("<html>bad</html>"), "test.mp4")).status, 415);
  const asset = await (await upload(bytes, "clip.mp4")).json();
  const input = { ...f.feedback(), anchor: { artifactId: asset.id, revision: asset.id, kind: "video", timeSeconds: 12.345, point: { x: .25, y: .75 } }, attachmentIds: [asset.id] };
  const result = await (await f.post("/api/feedback", input)).json(); assert.equal(result.anchor.timeSeconds, 12.345); assert.deepEqual(result.anchor.point, { x: .25, y: .75 });
  assert.equal((await f.post("/api/feedback", { ...input, clientRequestId: randomUUID(), anchor: { ...input.anchor, timeSeconds: -1 } })).status, 400);
  const range = await fetch(f.app.origin + `/api/assets/${asset.id}`, { headers: { Cookie: f.cookie, Range: "bytes=4-7" } });
  assert.equal(range.status, 206); assert.equal(await range.text(), "ftyp");
  assert.deepEqual(await readFile(join(f.directory, "assets", asset.id)), bytes);
});

test("concurrent document writes produce one winner and a visible conflict", async (t) => {
  const f = await fixture(t);
  const results = await Promise.all(["one", "two"].map((text) => f.post("/api/document", { expectedRevision: f.state.document.revision, text })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
});

test("reopening the same reference publishes a fresh view event", async (t) => {
  const f = await fixture(t);
  const first = await (await f.post("/api/view", { artifactId: "document", timeSeconds: 0 })).json();
  const second = await (await f.post("/api/view", { artifactId: "document", timeSeconds: 0 })).json();
  assert.ok(second.sequence > first.sequence);
});

test("another view receives the committed feedback through SSE", async (t) => {
  const f = await fixture(t); const abort = new AbortController();
  const response = await fetch(f.app.origin + "/api/events", { headers: { Cookie: f.cookie }, signal: abort.signal });
  const reader = response.body.getReader(); await reader.read();
  const input = f.feedback(); await f.post("/api/feedback", input);
  const update = await reader.read(); const event = new TextDecoder().decode(update.value);
  assert.match(event, /event: state/); assert.ok(event.includes(input.comment));
  abort.abort(); await reader.cancel().catch(() => {});
});

test("cloud adapter authenticates the stream and cleans up even on failure", async () => {
  let killed = 0; let auth;
  const desktop = { stream: { start: async (options) => { auth = options; }, getAuthKey: () => "test-only-capability", getUrl: (args) => { assert.equal(args.viewOnly, false); return "https://example.invalid/test-only"; } }, kill: async () => { killed += 1; } };
  const Sandbox = { create: async (options) => { assert.equal(options.timeoutMs, 60000); return desktop; } };
  await assert.rejects(withCloudDesktop(Sandbox, { timeoutMs: 60000 }, async () => { throw new Error("Test failure"); }), /Test failure/);
  assert.deepEqual(auth, { requireAuth: true }); assert.equal(killed, 1);
  await assert.rejects(withCloudDesktop(Sandbox, { timeoutMs: 900000 }, async () => {}), /timeout/); assert.equal(killed, 1);
});
