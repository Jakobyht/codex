// Optional paid-provider boundary. No SDK import, account call or desktop is
// made by importing this module. The caller explicitly supplies the provider.
export async function withCloudDesktop(Sandbox, { timeoutMs }, use) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 60000 || timeoutMs > 300000) throw new Error("Use an explicit timeout between one and five minutes for the first pilot.");
  const desktop = await Sandbox.create({ resolution: [1440, 900], timeoutMs });
  try {
    await desktop.stream.start({ requireAuth: true });
    const authKey = desktop.stream.getAuthKey();
    const viewerUrl = desktop.stream.getUrl({ authKey, viewOnly: false });
    // viewerUrl is a short-lived credential. Keep it in memory; do not log or save it.
    return await use({ desktop, viewerUrl });
  } finally { await desktop.kill(); }
}
