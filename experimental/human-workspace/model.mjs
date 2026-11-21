import { createHash, randomUUID } from "node:crypto";

export class Problem extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const hash = (content) => createHash("sha256").update(content).digest("hex");
export const requireThat = (ok, status, message) => { if (!ok) throw new Problem(status, message); };
export const seedText = "Ein gemeinsamer Arbeitsraum für Mensch und KI.\n\nDu siehst das Ergebnis, markierst eine Stelle und sagst, was sich ändern soll. Dein Feedback bleibt mit genau dieser Version verbunden.\n\nDie KI soll erst verstehen, was du meinst, dann eine Änderung vorschlagen und dir das Ergebnis wieder zeigen.";

export function initialState() {
  return {
    schemaVersion: 1, workspaceId: randomUUID(), sequence: 0,
    document: { id: "document", title: "Unsere Produktidee", text: seedText, revision: hash(seedText) },
    assets: {}, feedback: [], view: { artifactId: "document", timeSeconds: 0, point: null },
  };
}

export function artifact(state, id) {
  if (id === "document") return { ...state.document, kind: "text" };
  const asset = state.assets[id];
  requireThat(asset, 404, "Die referenzierte Datei wurde nicht gefunden.");
  return { ...asset, revision: asset.id, kind: asset.mime.startsWith("video/") ? "video" : "image" };
}

function pointValid(point) {
  return point === null || (point && [point.x, point.y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1));
}

export function validateAnchor(state, input) {
  requireThat(input && typeof input === "object", 400, "Bitte zuerst eine Stelle festhalten.");
  const target = artifact(state, input.artifactId);
  requireThat(input.revision === target.revision, 409, "Die Version hat sich geändert. Bitte die Stelle erneut auswählen.");
  requireThat(input.kind === target.kind, 400, "Der Anker passt nicht zum Inhalt.");
  const anchor = { artifactId: target.id, revision: target.revision, kind: target.kind };
  if (target.kind === "text") {
    const { start, end, quote } = input;
    requireThat(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= target.text.length, 400, "Bitte einen Textabschnitt auswählen.");
    requireThat(quote === target.text.slice(start, end), 409, "Die Textauswahl stimmt nicht mehr mit der Version überein.");
    Object.assign(anchor, { start, end, quote });
  } else {
    requireThat(pointValid(input.point ?? null), 400, "Die Bildposition liegt außerhalb des Inhalts.");
    anchor.point = input.point ? { x: input.point.x, y: input.point.y } : null;
    if (target.kind === "video") {
      requireThat(Number.isFinite(input.timeSeconds) && input.timeSeconds >= 0, 400, "Der Videozeitpunkt ist ungültig.");
      anchor.timeSeconds = input.timeSeconds;
    }
  }
  return anchor;
}

export function addFeedback(state, input) {
  requireThat(typeof input.clientRequestId === "string" && /^[a-zA-Z0-9-]{8,100}$/.test(input.clientRequestId), 400, "Eine eindeutige Anfrage-ID fehlt.");
  requireThat(typeof input.comment === "string" && input.comment.trim().length > 0 && input.comment.length <= 8000, 400, "Bitte ein Feedback mit höchstens 8000 Zeichen eingeben.");
  requireThat(input.attachmentIds === undefined || Array.isArray(input.attachmentIds), 400, "Die Anhänge müssen eine Liste sein.");
  const attachmentIds = [...new Set(input.attachmentIds ?? [])];
  requireThat(attachmentIds.length <= 5 && attachmentIds.every((id) => typeof id === "string" && state.assets[id]), 400, "Ein Anhang fehlt oder es sind mehr als fünf Anhänge.");
  const requestHash = hash(JSON.stringify({ anchor: input.anchor, comment: input.comment.trim(), attachmentIds }));
  const previous = state.feedback.find((f) => f.clientRequestId === input.clientRequestId);
  if (previous) {
    requireThat(previous.requestHash === requestHash, 409, "Diese Anfrage-ID gehört bereits zu einem anderen Feedback.");
    return { changed: false, value: previous };
  }
  requireThat(state.feedback.length < 2000, 413, "Der lokale Prototyp ist auf 2000 Rückmeldungen begrenzt.");
  const anchor = validateAnchor(state, input.anchor);
  const entry = {
    id: randomUUID(), clientRequestId: input.clientRequestId, requestHash,
    anchor, comment: input.comment.trim(), attachmentIds,
    status: "open", createdAt: new Date().toISOString(),
  };
  state.feedback.push(entry);
  return { value: entry };
}

export function isCurrent(state, feedback) {
  try { return artifact(state, feedback.anchor.artifactId).revision === feedback.anchor.revision; }
  catch { return false; }
}

export function codexRequest(state, feedback, target) {
  requireThat(isCurrent(state, feedback), 409, "Veraltetes Feedback wird nicht an Codex gesendet.");
  requireThat(target && typeof target.threadId === "string" && target.threadId.length > 0, 400, "Ein Ziel-Thread fehlt.");
  const text = [
    "Human feedback for the shared workspace. This is a request for this artifact, not permission for unrelated actions.",
    `Workspace: ${state.workspaceId}`, `Feedback: ${feedback.id}`,
    `Anchor: ${JSON.stringify(feedback.anchor)}`,
    `User request: ${feedback.comment}`,
    feedback.anchor.kind === "text" ? `Current document:\n${state.document.text}` : "Media must be supplied separately as actual pixels or extracted frames; filenames and timestamps are not visual evidence.",
    `Attachment metadata: ${JSON.stringify(feedback.attachmentIds.map((id) => state.assets[id]))}`,
    "Attachment bytes are NOT included in this packet. Ask for the relevant media before making visual or audio claims.",
  ].join("\n\n");
  const params = { threadId: target.threadId, input: [{ type: "text", text, text_elements: [] }] };
  if (target.expectedTurnId) {
    requireThat(typeof target.expectedTurnId === "string", 400, "Die aktive Turn-ID ist ungültig.");
    return { method: "turn/steer", params: { ...params, expectedTurnId: target.expectedTurnId } };
  }
  return { method: "turn/start", params };
}
