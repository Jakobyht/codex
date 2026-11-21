const $ = (id) => document.getElementById(id);
let state, anchor = null, attachmentIds = [], editing = false, editRevision, mediaId = null, lastView = "", point = null;
let requestId = crypto.randomUUID();
let busy = false;

function notice(text, error = false) { $("notice").textContent = text; $("notice").className = `notice${error ? " error" : ""}`; }
async function api(path, data, options = {}) {
  const response = await fetch(path, {
    method: data === undefined ? "GET" : "POST",
    headers: data === undefined ? {} : { "X-Workspace-Request": "1", "Content-Type": options.binary ? "application/octet-stream" : "application/json" },
    body: data === undefined ? undefined : options.binary ? data : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Die Anfrage konnte nicht bestätigt werden.");
  return result;
}
function target(id = state.view.artifactId) {
  return id === "document" ? { ...state.document, kind: "text" } : { ...state.assets[id], revision: id, kind: state.assets[id].mime.startsWith("video/") ? "video" : "image" };
}
const time = (seconds) => `${Math.floor(seconds / 60).toString().padStart(2,"0")}:${Math.floor(seconds % 60).toString().padStart(2,"0")}.${Math.floor(seconds % 1 * 1000).toString().padStart(3,"0")}`;
function anchorLabel(a) {
  if (a.kind === "text") return `Text · Zeichen ${a.start + 1}–${a.end}`;
  const position = a.point ? ` · Position ${Math.round(a.point.x * 100)} %, ${Math.round(a.point.y * 100)} %` : "";
  return a.kind === "video" ? `Video · ${time(a.timeSeconds)}${position}` : `Bild${position}`;
}
function showAnchor() {
  const card = $("anchor-card");
  const stale = anchor && target(anchor.artifactId).revision !== anchor.revision;
  card.className = `anchor-card${anchor ? "" : " empty"}${stale ? " stale" : ""}`;
  card.querySelector(".anchor-label").textContent = anchor ? anchorLabel(anchor) : "Noch keine Stelle ausgewählt";
  $("anchor-detail").textContent = anchor ? `${stale ? "Version geändert. Bitte erneut auswählen.\n" : ""}${anchor.quote || target(anchor.artifactId).name || ""}` : "Wähle links eine Stelle aus.";
}
function renderPin() {
  document.querySelector(".pin")?.remove();
  if (point) {
    const pin = document.createElement("span"); pin.className = "pin"; pin.style.left = `${point.x * 100}%`; pin.style.top = `${point.y * 100}%`;
    $("media-stage").append(pin);
  }
}
function mediaElement(asset) {
  const element = document.createElement(asset.kind === "video" ? "video" : "img");
  element.id = "active-media"; element.src = `/api/assets/${asset.id}`;
  if (asset.kind === "video") { element.controls = true; element.preload = "metadata"; }
  else element.alt = asset.name;
  element.addEventListener("click", (event) => {
    const bounds = element.getBoundingClientRect();
    point = { x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)), y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)) };
    renderPin();
  });
  return element;
}
function renderView() {
  const asset = target(); const text = asset.kind === "text";
  $("artifact-title").textContent = text ? state.document.title : asset.name;
  $("revision").textContent = `Version ${asset.revision.slice(0, 8)}`;
  $("show-text").classList.toggle("active", text);
  $("text-view").hidden = !text; $("media-view").hidden = text;
  $("asset-select").value = asset.id;
  $("capture-hint").textContent = text ? "Text auswählen und die Auswahl festhalten." : asset.kind === "video" ? "Video pausieren, bei Bedarf ins Bild klicken und den Moment festhalten." : "Ins Bild klicken und die Position festhalten.";
  const viewKey = JSON.stringify(state.view);
  if (!text && mediaId !== asset.id) {
    mediaId = asset.id; point = null; lastView = "";
    $("media-stage").replaceChildren(mediaElement(asset));
  }
  if (!text && asset.kind === "video" && viewKey !== lastView) {
    const element = $("active-media"); const seek = () => { element.pause(); element.currentTime = state.view.timeSeconds || 0; };
    if (element.readyState >= 1) seek(); else element.addEventListener("loadedmetadata", seek, { once: true });
  }
  lastView = viewKey;
  if (!editing && $("document").value !== state.document.text) $("document").value = state.document.text;
}
function renderHistory() {
  $("feedback-count").textContent = state.feedback.length;
  if (!state.feedback.length) return;
  const cards = [...state.feedback].reverse().map((entry) => {
    const card = document.createElement("article"); card.className = "feedback-item";
    const top = document.createElement("div"); top.className = "feedback-item-top";
    const label = document.createElement("span"); label.textContent = anchorLabel(entry.anchor);
    const stamp = document.createElement("span"); stamp.textContent = new Date(entry.createdAt).toLocaleTimeString("de-AT", { hour: "2-digit", minute: "2-digit" });
    top.append(label, stamp); card.append(top);
    const stale = target(entry.anchor.artifactId).revision !== entry.anchor.revision;
    const quote = document.createElement("blockquote"); quote.textContent = entry.anchor.quote || target(entry.anchor.artifactId).name; card.append(quote);
    const comment = document.createElement("p"); comment.textContent = entry.comment; card.append(comment);
    if (entry.attachmentIds.length) {
      const files = document.createElement("div"); files.className = "attachments";
      for (const id of entry.attachmentIds) { const link = document.createElement("a"); link.href = `/api/assets/${id}`; link.target = "_blank"; link.rel = "noopener"; link.textContent = state.assets[id].name; files.append(link); }
      card.append(files);
    }
    if (stale) { const label = document.createElement("span"); label.className = "stale-label"; label.textContent = "Bezieht sich auf eine ältere Version"; card.append(label); }
    else {
      const reveal = document.createElement("button"); reveal.className = "subtle"; reveal.textContent = "Zur Stelle";
      reveal.addEventListener("click", async () => {
        try {
          if (editing) throw new Error("Bitte die aktuelle Textbearbeitung zuerst speichern oder verwerfen.");
          await api("/api/view", { artifactId: entry.anchor.artifactId, timeSeconds: entry.anchor.timeSeconds ?? 0 });
          state = await api("/api/state"); render();
          if (entry.anchor.kind === "text") { $("document").focus(); $("document").setSelectionRange(entry.anchor.start, entry.anchor.end); }
          else { point = entry.anchor.point; renderPin(); }
          $("artifact-title").scrollIntoView({ block: "center", behavior: "smooth" });
        } catch (error) { notice(error.message, true); }
      }); card.append(reveal);
    }
    return card;
  });
  $("feedback-list").replaceChildren(...cards);
}
function render() {
  $("session-id").textContent = `Sitzung ${state.workspaceId.slice(0, 8)}`;
  const options = [new Option("Unsere Produktidee", "document"), ...Object.values(state.assets).map((a) => new Option(a.name, a.id))];
  $("asset-select").replaceChildren(...options);
  renderView(); showAnchor(); renderHistory(); renderAttachments();
}
function renderAttachments() {
  $("draft-attachments").replaceChildren(...attachmentIds.map((id) => {
    const li = document.createElement("li"); const label = document.createElement("span"); label.textContent = state.assets[id]?.name || "Datei";
    const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×"; remove.setAttribute("aria-label", `${label.textContent} aus Feedback entfernen`);
    remove.addEventListener("click", () => { attachmentIds = attachmentIds.filter((a) => a !== id); renderAttachments(); }); li.append(label, remove); return li;
  }));
}
async function switchArtifact(id) {
  if (editing) return notice("Bitte den Text zuerst speichern oder die Bearbeitung verwerfen.", true);
  try { await api("/api/view", { artifactId: id, timeSeconds: 0 }); state = await api("/api/state"); render(); }
  catch (error) { notice(error.message, true); }
}
$("show-text").addEventListener("click", () => switchArtifact("document"));
$("asset-select").addEventListener("change", (event) => switchArtifact(event.target.value));
function editingMode(on) { editing = on; $("document").readOnly = !on; $("save-text").hidden = !on; $("cancel-edit").hidden = !on; $("edit-text").hidden = on; }
$("edit-text").addEventListener("click", () => { editRevision = state.document.revision; editingMode(true); $("document").focus(); });
$("cancel-edit").addEventListener("click", () => { editingMode(false); render(); });
$("save-text").addEventListener("click", async () => {
  try { await api("/api/document", { expectedRevision: editRevision, text: $("document").value }); editingMode(false); state = await api("/api/state"); render(); notice("Neue Version gespeichert. Frühere Rückmeldungen behalten ihre ursprüngliche Version."); }
  catch (error) { notice(error.message, true); }
});
$("capture").addEventListener("click", async () => {
  try {
    if (editing) throw new Error("Bitte zuerst die neue Textversion speichern.");
    const asset = target(); const next = { artifactId: asset.id, revision: asset.revision, kind: asset.kind };
    if (asset.kind === "text") {
      const input = $("document"); const start = input.selectionStart, end = input.selectionEnd;
      if (end <= start) throw new Error("Bitte links zuerst die Textstelle auswählen, die du meinst.");
      Object.assign(next, { start, end, quote: asset.text.slice(start, end) });
    } else {
      next.point = point;
      if (asset.kind === "video") { const video = $("active-media"); video.pause(); next.timeSeconds = video.currentTime; await api("/api/view", { artifactId: asset.id, timeSeconds: next.timeSeconds }); }
    }
    anchor = next; requestId = crypto.randomUUID(); showAnchor(); notice("Stelle festgehalten. Dein Kommentar bezieht sich auf diese Version."); $("comment").focus();
  } catch (error) { notice(error.message, true); }
});
async function upload(file) {
  if (file.size > 25 * 1024 * 1024) throw new Error("Diese Datei ist größer als 25 MiB.");
  return api(`/api/assets?name=${encodeURIComponent(file.name)}`, file, { binary: true });
}
$("open-file").addEventListener("change", async (event) => {
  try {
    if (editing) throw new Error("Bitte den Text zuerst speichern oder die Bearbeitung verwerfen.");
    const file = event.target.files[0]; if (!file) return;
    notice("Datei wird lokal geöffnet …"); const asset = await upload(file); state = await api("/api/state"); await switchArtifact(asset.id); notice("Datei geöffnet. Wähle jetzt die Stelle aus.");
  } catch (error) { notice(error.message, true); } finally { event.target.value = ""; }
});
$("attach-file").addEventListener("change", async (event) => {
  try {
    const files = [...event.target.files]; if (attachmentIds.length + files.length > 5) throw new Error("Pro Rückmeldung sind höchstens fünf Anhänge möglich.");
    $("submit-feedback").disabled = true;
    for (const file of files) { const asset = await upload(file); if (!attachmentIds.includes(asset.id)) attachmentIds.push(asset.id); }
    state = await api("/api/state"); render(); notice("Anhänge liegen im lokalen Arbeitsraum.");
  } catch (error) { notice(error.message, true); } finally { $("submit-feedback").disabled = false; event.target.value = ""; }
});
$("feedback-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (busy) return;
  try {
    if (!anchor) throw new Error("Bitte zuerst links eine Stelle festhalten.");
    busy = true; $("submit-feedback").disabled = true;
    await api("/api/feedback", { clientRequestId: requestId, anchor, comment: $("comment").value, attachmentIds });
    anchor = null; attachmentIds = []; requestId = crypto.randomUUID(); $("comment").value = "";
    state = await api("/api/state"); render(); notice("Feedback samt Referenz gespeichert und mit allen Ansichten abgeglichen.");
  } catch (error) { notice(error.message, true); } finally { busy = false; $("submit-feedback").disabled = false; }
});
$("export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ ...state, exportNote: "Metadata and text only. Media bytes remain in the local assets directory." }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "arbeitsraum-feedback.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
try {
  state = await api("/api/state"); render();
  const events = new EventSource("/api/events");
  events.addEventListener("state", (event) => { const next = JSON.parse(event.data); if (next.sequence >= state.sequence) { state = next; render(); } $("connection").textContent = "Sitzung verbunden"; });
  events.onerror = () => { $("connection").textContent = "Verbindung unterbrochen · wird erneut versucht"; };
} catch (error) { notice(error.message, true); $("connection").textContent = "Sitzung nicht verbunden"; }
