import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initialState } from "./model.mjs";

export async function createStore(directory) {
  await mkdir(join(directory, "assets"), { recursive: true, mode: 0o700 });
  const filename = join(directory, "state.json");
  let state;
  try { state = JSON.parse(await readFile(filename, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    state = initialState();
    await writeFile(filename, JSON.stringify(state), { mode: 0o600, flag: "wx" });
  }
  if (state.schemaVersion !== 1) throw new Error("Unsupported workspace schema; data has not been changed.");
  let queue = Promise.resolve();
  return {
    directory,
    snapshot: () => structuredClone(state),
    transact(fn) {
      const task = queue.then(async () => {
        const next = structuredClone(state);
        const result = await fn(next);
        if (result?.changed === false) return { ...result, state: structuredClone(state) };
        next.sequence += 1;
        await writeFile(filename + ".tmp", JSON.stringify(next), { mode: 0o600 });
        await rename(filename + ".tmp", filename);
        state = next;
        return { ...result, state: structuredClone(state) };
      });
      queue = task.catch(() => {});
      return task;
    },
  };
}
