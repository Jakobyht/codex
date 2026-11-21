import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createStore } from "./store.mjs";
import { Problem, addFeedback, artifact, codexRequest, hash, requireThat } from "./model.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const MAX_FILE = 25 * 1024 * 1024;
const staticFiles = { "/": ["index.html", "text/html; charset=utf-8"], "/app.mjs": ["app.mjs", "text/javascript; charset=utf-8"], "/style.css": ["style.css", "text/css; charset=utf-8"] };

async function body(req, limit) {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    requireThat(length <= limit, 413, "Die Datei ist zu groß (maximal 25 MiB)." );
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function detectMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (bytes.toString("ascii", 4, 8) === "ftyp") return "video/mp4";
  if (bytes.subarray(0, 4).equals(Buffer.from([26,69,223,163]))) return "video/webm";
  throw new Problem(415, "Unterstützt: PNG, JPEG, WebP, MP4 und WebM. Andere Formate bitte zuerst umwandeln.");
}

export async function startServer({ port = 4381, directory = join(here, ".local"), host = "127.0.0.1" } = {}) {
  requireThat(host === "127.0.0.1", 400, "Dieser Prototyp darf nur auf 127.0.0.1 lauschen.");
  const store = await createStore(directory);
  const session = randomBytes(32).toString("hex");
  const clients = new Set();
  let origin;
  const json = (res, status, value) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value)); };
  const broadcast = (result) => {
    if (result.changed === false) return;
    for (const res of clients) res.write(`id: ${result.state.sequence}\nevent: state\ndata: ${JSON.stringify(result.state)}\n\n`);
  };
  const mutate = async (fn) => { const result = await store.transact(fn); broadcast(result); return result; };
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      requireThat(req.headers.host === new URL(origin).host, 403, "Unbekannter Host.");
      const url = new URL(req.url, origin);
      const cookie = req.headers.cookie?.split(";").map((s) => s.trim()).find((s) => s.startsWith("workspace_session="))?.slice(18) || "";
      const authenticated = /^[a-f0-9]{64}$/.test(cookie) && timingSafeEqual(Buffer.from(cookie), Buffer.from(session));
      if (req.method === "GET" && staticFiles[url.pathname]) {
        if (url.pathname === "/") res.setHeader("Set-Cookie", `workspace_session=${session}; HttpOnly; SameSite=Strict; Path=/`);
        const [file, mime] = staticFiles[url.pathname];
        res.writeHead(200, { "Content-Type": mime }); res.end(await readFile(join(here, "public", file))); return;
      }
      requireThat(authenticated, 401, "Bitte den lokalen Arbeitsraum zuerst im Browser öffnen.");
      if (req.method !== "GET") {
        requireThat(req.headers.origin === origin && req.headers["x-workspace-request"] === "1", 403, "Die Anfrage muss aus dem lokalen Arbeitsraum kommen.");
      }
      if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, store.snapshot());
      if (req.method === "GET" && url.pathname === "/api/events") {
        requireThat(clients.size < 20, 429, "Zu viele offene Ansichten.");
        res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
        clients.add(res);
        res.write(`event: state\ndata: ${JSON.stringify(store.snapshot())}\n\n`);
        const keepalive = setInterval(() => res.write(": heartbeat\n\n"), 20000);
        req.on("close", () => { clearInterval(keepalive); clients.delete(res); });
        return;
      }
      const assetMatch = /^\/api\/assets\/([a-f0-9]{64})$/.exec(url.pathname);
      if (req.method === "GET" && assetMatch) {
        const asset = artifact(store.snapshot(), assetMatch[1]);
        const bytes = await readFile(join(directory, "assets", asset.id));
        const range = req.headers.range;
        if (range) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(range);
          const start = Number(match?.[1]); const end = match?.[2] ? Number(match[2]) : bytes.length - 1;
          requireThat(match && Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && end < bytes.length, 416, "Ungültiger Medienbereich.");
          res.writeHead(206, { "Content-Type": asset.mime, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${bytes.length}`, "Accept-Ranges": "bytes" });
          res.end(bytes.subarray(start, end + 1)); return;
        }
        res.writeHead(200, { "Content-Type": asset.mime, "Content-Length": bytes.length, "Accept-Ranges": "bytes" }); res.end(bytes); return;
      }
      if (req.method === "POST" && url.pathname === "/api/assets") {
        const bytes = await body(req, MAX_FILE); const mime = detectMime(bytes); const id = hash(bytes);
        const name = (url.searchParams.get("name") || "Anhang").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 160);
        const result = await mutate(async (state) => {
          if (state.assets[id]) return { changed: false, value: state.assets[id] };
          const total = Object.values(state.assets).reduce((n, a) => n + a.size, 0);
          requireThat(total + bytes.length <= 250 * 1024 * 1024, 413, "Der lokale Speicher ist auf 250 MiB begrenzt.");
          await writeFile(join(directory, "assets", id), bytes, { mode: 0o600 });
          state.assets[id] = { id, name, mime, size: bytes.length, createdAt: new Date().toISOString() };
          return { value: state.assets[id] };
        });
        return json(res, 201, result.value);
      }
      requireThat(req.method === "POST", 404, "Nicht gefunden.");
      let input;
      try { input = JSON.parse((await body(req, 256 * 1024)).toString("utf8")); }
      catch (error) { if (error instanceof Problem) throw error; throw new Problem(400, "Ungültige JSON-Anfrage."); }
      requireThat(input && typeof input === "object" && !Array.isArray(input), 400, "Ungültige Anfrage.");
      if (url.pathname === "/api/document") {
        const result = await mutate((state) => {
          requireThat(input.expectedRevision === state.document.revision, 409, "Eine andere Ansicht hat den Text geändert. Bitte zuerst die aktuelle Version laden.");
          requireThat(typeof input.text === "string" && input.text.length > 0 && input.text.length <= 100000, 400, "Der Text muss zwischen 1 und 100000 Zeichen enthalten.");
          state.document.text = input.text; state.document.revision = hash(input.text);
          return { value: state.document };
        });
        return json(res, 200, result.value);
      }
      if (url.pathname === "/api/view") {
        const result = await mutate((state) => {
          const target = artifact(state, input.artifactId);
          requireThat(Number.isFinite(input.timeSeconds ?? 0) && (input.timeSeconds ?? 0) >= 0, 400, "Ungültiger Zeitpunkt.");
          state.view = { artifactId: target.id, timeSeconds: target.kind === "video" ? input.timeSeconds ?? 0 : 0, sequence: state.sequence + 1 };
          return { value: state.view };
        });
        return json(res, 200, result.value);
      }
      if (url.pathname === "/api/feedback") {
        const result = await mutate((state) => addFeedback(state, input));
        return json(res, 201, result.value);
      }
      if (url.pathname === "/api/codex-packet") {
        const state = store.snapshot(); const feedback = state.feedback.find((f) => f.id === input.feedbackId);
        requireThat(feedback, 404, "Feedback nicht gefunden.");
        return json(res, 200, codexRequest(state, feedback, input.target));
      }
      throw new Problem(404, "Nicht gefunden.");
    } catch (error) {
      if (!res.headersSent) json(res, error instanceof Problem ? error.status : 500, { error: error instanceof Problem ? error.message : "Lokaler Fehler. Die Aktion wurde nicht bestätigt." });
      else res.destroy();
    }
  });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(port, host, done); });
  origin = `http://${host}:${server.address().port}`;
  return { origin, store, async close() { for (const client of clients) client.end(); server.closeAllConnections(); await new Promise((done) => server.close(done)); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.WORKSPACE_PORT || 4381);
  const app = await startServer({ port });
  console.log(`Human Workspace — local prototype: ${app.origin}`);
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => { if (!closing) { closing = true; await app.close(); process.exit(0); } });
}
