import { readFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexRpc } from "../codex-rpc.mjs";
import { codexRequest, hash } from "../model.mjs";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const value = (flag) => { const index = process.argv.indexOf(flag); return index < 0 ? undefined : process.argv[index + 1]; };
const directory = resolve(value("--data-dir") || join(here, ".local"));
const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
const feedbackId = value("--feedback-id");
const feedback = state.feedback.find((f) => f.id === feedbackId);
if (!feedback) throw new Error("Choose a saved --feedback-id. No request was sent.");
// Validate the pinned artifact before any external or model action.
codexRequest(state, feedback, { threadId: "plan-only" });
if (!process.argv.includes("--execute")) {
  console.log(JSON.stringify({ action: "plan-only", modelTurnsStarted: 0, feedbackId, kind: feedback.anchor.kind, imageAttachments: feedback.attachmentIds.filter((id) => state.assets[id].mime.startsWith("image/")).length, note: "--execute sends this feedback, its source text and selected pixels to Codex using the existing local login. A new read-only review thread is created; no desktop is controlled." }, null, 2));
} else {
  const imagePaths = [];
  const ids = [...new Set([feedback.anchor.artifactId, ...feedback.attachmentIds])].filter((id) => state.assets[id]);
  for (const id of ids) {
    const asset = state.assets[id]; const filename = join(directory, "assets", id);
    const bytes = await readFile(filename);
    if (hash(bytes) !== id) throw new Error("The media content no longer matches its revision. No model turn was started.");
    if (asset.mime.startsWith("image/")) imagePaths.push(filename);
    if (asset.mime.startsWith("video/") && id === feedback.anchor.artifactId) {
      const frames = join(directory, "frames"); await mkdir(frames, { recursive: true, mode: 0o700 });
      const frame = join(frames, `${id}-${feedback.anchor.timeSeconds}.png`);
      await new Promise((done, reject) => {
        const child = spawn("ffmpeg", ["-nostdin", "-v", "error", "-ss", String(feedback.anchor.timeSeconds), "-i", filename, "-frames:v", "1", "-y", frame], { stdio: "ignore" });
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Video extraction timed out. No model turn was started.")); }, 15000);
        child.on("error", () => { clearTimeout(timer); reject(new Error("Install ffmpeg to extract the selected video frame.")); });
        child.on("exit", (code) => { clearTimeout(timer); code === 0 ? done() : reject(new Error("Could not extract this video frame. No model turn was started.")); });
      });
      const frameBytes = await readFile(frame);
      if (!frameBytes.length) throw new Error("No frame exists at the selected timestamp.");
      imagePaths.push(frame);
    }
  }
  const client = new CodexRpc();
  try {
    await client.initialize();
    const { thread } = await client.request("thread/start", { cwd: here, sandbox: "read-only", approvalPolicy: "on-request", ephemeral: true });
    const packet = codexRequest(state, feedback, { threadId: thread.id });
    packet.params.input.push({ type: "text", text: `Visual input delivery: ${imagePaths.length} image items follow. These contain the primary image or the selected primary video frame and attached still images. Other attached videos are metadata only. A single frame cannot establish motion or audio. Review and propose; do not claim edits were applied.`, text_elements: [] });
    packet.params.input.push(...imagePaths.map((path) => ({ type: "localImage", path })));
    const completion = client.waitForTurn(thread.id);
    completion.catch(() => {});
    const acknowledgement = await client.request(packet.method, packet.params);
    const review = await completion;
    console.log(JSON.stringify({ acknowledged: true, threadId: thread.id, turnId: acknowledgement.turn.id, status: review.turn.status, review: review.text, note: "Read-only review result. No document or desktop change was applied." }, null, 2));
  } finally { await client.close(); }
}
