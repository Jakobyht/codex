import { createServer } from "node:http";
import { withCloudDesktop } from "../cloud-desktop.mjs";

if (!process.argv.includes("--start")) {
  console.log(JSON.stringify({
    action: "plan-only", resourcesCreated: 0, provider: "E2B Desktop (optional)",
    requirements: ["Approved provider account and spending limit", "E2B_API_KEY supplied to the local process", "@e2b/desktop installed in this package", "Explicit --start --max-minutes 1..5"],
    scope: "One blank Linux desktop with authenticated interactive mirroring. No model calls, connectors, local files or existing browser sign-ins are transferred.",
    cost: "Timeout limits duration, not the provider invoice. Confirm current rates and an account spending limit before --start.",
  }, null, 2));
} else {
  const index = process.argv.indexOf("--max-minutes");
  const minutes = index < 0 ? NaN : Number(process.argv[index + 1]);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 5) throw new Error("An explicit --max-minutes value from 1 to 5 is required.");
  if (!process.env.E2B_API_KEY) throw new Error("E2B_API_KEY is missing. Do not put credentials in chat or the repository.");
  const { Sandbox } = await import("@e2b/desktop");
  await withCloudDesktop(Sandbox, { timeoutMs: minutes * 60000 }, async ({ viewerUrl }) => {
    const url = new URL(viewerUrl);
    if (url.protocol !== "https:") throw new Error("The provider did not return an HTTPS viewer.");
    let origin;
    const escapedUrl = viewerUrl.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
    const server = createServer((req, res) => {
      res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (req.headers.host !== new URL(origin).host || req.url !== "/" || req.method !== "GET") { res.writeHead(404); res.end(); return; }
      res.setHeader("Content-Security-Policy", `default-src 'none'; frame-src ${url.origin}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Gemeinsamer Cloud-Desktop</title><body><h1>Gemeinsamer Cloud-Desktop</h1><p>Dieser Linux-Desktop endet nach spätestens ${minutes} Minuten. Es ist keine KI verbunden.</p><iframe title="Privater Cloud-Desktop" src="${escapedUrl}" width="1440" height="900" allow="clipboard-read; clipboard-write"></iframe></body></html>`);
    });
    await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
    origin = `http://127.0.0.1:${server.address().port}`;
    console.log(`Local viewer: ${origin} (the provider credential is kept in process memory)`);
    try {
      await new Promise((done) => {
        const finish = () => { clearTimeout(timer); process.off("SIGINT", finish); process.off("SIGTERM", finish); done(); };
        const timer = setTimeout(finish, Math.max(1000, minutes * 60000 - 10000));
        process.on("SIGINT", finish); process.on("SIGTERM", finish);
      });
    } finally { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
  });
}
