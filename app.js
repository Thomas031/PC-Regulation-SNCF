/* ============
   PC Régulation SNCF (RP) - Top 1% + Sauvegarde
   - Autosave (debounced)
   - Snapshots (sauvegardes nommées)
   - Export / Import JSON
   - Data versioning + migrations
============ */

const APP = {
  storageKey: "PCREG_SNCF_RP_STATE_V2",
  snapshotKey: "PCREG_SNCF_RP_SNAPSHOTS_V2",
  schemaVersion: 2,
  autosaveDelayMs: 500,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const nowISO = () => new Date().toISOString();
const fmtTime = (d=new Date()) => d.toLocaleTimeString("fr-FR", { hour:"2-digit", minute:"2-digit", second:"2-digit" });
const fmtDateTime = (iso) => {
  try { return new Date(iso).toLocaleString("fr-FR"); } catch { return iso; }
};

function uid(prefix="ID"){
  return `${prefix}_${Math.random().toString(16).slice(2,10)}${Date.now().toString(16).slice(-4)}`;
}

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function defaultState(){
  return {
    schemaVersion: APP.schemaVersion,
    meta: {
      createdAt: nowISO(),
      updatedAt: nowISO(),
      lastSavedAt: null,
      lastSavedBy: "local",
    },
    settings: {
      networkStatus: "Normal",     // Normal / Perturbé / Incident majeur
      zoneName: "CCR / PC Régulation",
      rpOffsetMinutes: 0,          // Heure RP = réelle + offset
      operatorName: "Régulateur",
      autosave: true,
    },
    trains: [
      {
        id: uid("TRN"),
        number: "SD92",
        mission: "TER",
        line: "L1",
        od: "STRASBOURG → SAVERNE",
        position: "Strasbourg (départ)",
        delayMin: 0,
        priority: 2, // 1 haut, 3 bas
        status: "En circulation", // En circulation / À quai / Retenu / Supprimé / Détourné
        decision: "",
        regulator: "PC",
        updatedAt: nowISO()
      }
    ],
    incidents: [],
    logs: [
      { id: uid("LOG"), at: nowISO(), type:"Information", text:"Prise de service PC Régulation (RP).", trainId:null, incidentId:null, author:"PC" }
    ]
  };
}

/* ============
   SAVE SYSTEM
============ */

let STATE = null;
let autosaveTimer = null;

function migrateState(raw){
  // migrations ici si tu changes le modèle plus tard
  if (!raw || typeof raw !== "object") return defaultState();

  const v = raw.schemaVersion ?? 1;

  // v1 -> v2
  if (v === 1){
    raw.schemaVersion = 2;
    raw.meta = raw.meta || { createdAt: nowISO(), updatedAt: nowISO(), lastSavedAt: null, lastSavedBy: "local" };
    raw.settings = raw.settings || {};
    raw.settings.rpOffsetMinutes = raw.settings.rpOffsetMinutes ?? 0;
    raw.settings.autosave = raw.settings.autosave ?? true;
  }

  // normalisation
  raw.meta = raw.meta || {};
  raw.meta.updatedAt = nowISO();
  raw.meta.lastSavedAt = raw.meta.lastSavedAt ?? null;
  raw.meta.lastSavedBy = raw.meta.lastSavedBy ?? "local";

  raw.settings = raw.settings || {};
  raw.settings.networkStatus = raw.settings.networkStatus || "Normal";
  raw.settings.zoneName = raw.settings.zoneName || "CCR / PC Régulation";
  raw.settings.operatorName = raw.settings.operatorName || "Régulateur";
  raw.settings.rpOffsetMinutes = Number(raw.settings.rpOffsetMinutes ?? 0);
  raw.settings.autosave = raw.settings.autosave !== false;

  raw.trains = Array.isArray(raw.trains) ? raw.trains : [];
  raw.incidents = Array.isArray(raw.incidents) ? raw.incidents : [];
  raw.logs = Array.isArray(raw.logs) ? raw.logs : [];

  return raw;
}

function loadState(){
  const s = localStorage.getItem(APP.storageKey);
  if (!s){
    STATE = defaultState();
    saveState("local:init");
    return;
  }
  try {
    STATE = migrateState(JSON.parse(s));
  } catch {
    STATE = defaultState();
    saveState("local:recover");
  }
}

function saveState(source="local"){
  if (!STATE) return;

  STATE.meta.updatedAt = nowISO();
  STATE.meta.lastSavedAt = nowISO();
  STATE.meta.lastSavedBy = source;

  localStorage.setItem(APP.storageKey, JSON.stringify(STATE));
  updateSaveIndicator();
}

function scheduleAutosave(){
  if (!STATE?.settings?.autosave) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => saveState("autosave"), APP.autosaveDelayMs);
}

function getSnapshots(){
  try { return JSON.parse(localStorage.getItem(APP.snapshotKey) || "[]"); }
  catch { return []; }
}
function setSnapshots(list){
  localStorage.setItem(APP.snapshotKey, JSON.stringify(list));
}

function createSnapshot(name){
  const snaps = getSnapshots();
  snaps.unshift({
    id: uid("SNAP"),
    name: (name || "Snapshot").slice(0, 60),
    createdAt: nowISO(),
    state: STATE
  });
  // garder max 20
  setSnapshots(snaps.slice(0, 20));
}

function restoreSnapshot(snapshotId){
  const snaps = getSnapshots();
  const snap = snaps.find(x => x.id === snapshotId);
  if (!snap) return false;
  STATE = migrateState(structuredClone(snap.state));
  saveState("snapshot:restore");
  return true;
}

function deleteSnapshot(snapshotId){
  const snaps = getSnapshots().filter(x => x.id !== snapshotId);
  setSnapshots(snaps);
}

/* ============
   RP TIME
============ */
function getRPDate(){
  const offset = Number(STATE.settings.rpOffsetMinutes || 0);
  return new Date(Date.now() + offset*60*1000);
}

/* ============
   LOG / INCIDENT HELPERS
============ */
function addLog({type="Information", text="", trainId=null, incidentId=null, author=null}){
  STATE.logs.unshift({
    id: uid("LOG"),
    at: nowISO(),
    type,
    text,
    trainId,
    incidentId,
    author: author || STATE.settings.operatorName || "PC"
  });
  scheduleAutosave();
}

function addIncident({kind, location, severity, description, trainId=null}){
  const inc = {
    id: uid("INC"),
    createdAt: nowISO(),
    status: "Ouvert", // Ouvert / En cours / Clos
    kind, location, severity,
    description,
    trainId,
    assignedTo: STATE.settings.operatorName || "PC"
  };
  STATE.incidents.unshift(inc);

  addLog({
    type:"Incident",
    text:`Incident déclaré: ${kind} • ${location} • Gravité: ${severity}`,
    trainId,
    incidentId: inc.id
  });

  scheduleAutosave();
  return inc;
}

function findTrainById(id){ return STATE.trains.find(t => t.id === id) || null; }
function findIncidentById(id){ return STATE.incidents.find(i => i.id === id) || null; }

/* ============
   UI CORE
============ */

function updateTopbar(){
  const zone = $("#zoneName");
  const status = $("#networkStatus");
  if (zone) zone.textContent = STATE.settings.zoneName;
  if (status) status.textContent = STATE.settings.networkStatus;

  const statusPill = $("#statusPill");
  if (statusPill){
    statusPill.classList.remove("ok","warn","bad");
    const val = STATE.settings.networkStatus;
    if (val === "Normal") statusPill.classList.add("ok");
    if (val === "Perturbé") statusPill.classList.add("warn");
    if (val === "Incident majeur") statusPill.classList.add("bad");
    statusPill.querySelector("strong").textContent = val;
  }
}

function updateSaveIndicator(){
  const el = $("#savePill");
  if (!el) return;
  const last = STATE.meta.lastSavedAt;
  el.querySelector("strong").textContent = last ? fmtDateTime(last) : "—";
}

function tickClocks(){
  const real = $("#realClock");
  const rp = $("#rpClock");
  if (real) real.textContent = fmtTime(new Date());
  if (rp) rp.textContent = fmtTime(getRPDate());
}
setInterval(tickClocks, 500);

/* ============
   MODAL
============ */
function openModal(id){
  const back = $("#modalBackdrop");
  const modal = $(`#${id}`);
  if (!back || !modal) return;
  back.style.display = "flex";
  $$(".modal").forEach(m => m.style.display = "none");
  modal.style.display = "block";
}
function closeModal(){
  const back = $("#modalBackdrop");
  if (back) back.style.display = "none";
}
window.addEventListener("keydown", (e)=>{ if(e.key==="Escape") closeModal(); });

/* ============
   EXPORT / IMPORT
============ */
function downloadJSON(filename, obj){
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type:"application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
function importJSONFile(file, onDone){
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      onDone(null, data);
    } catch (err){
      onDone(err, null);
    }
  };
  reader.readAsText(file);
}

/* ============
   PAGE: INDEX (REGULATION)
============ */
function renderIndex(){
  const tbody = $("#trafficBody");
  if (!tbody) return;

  // KPI
  const trainsCount = STATE.trains.length;
  const openInc = STATE.incidents.filter(i => i.status !== "Clos").length;
  const avgDelay = trainsCount ? Math.round(STATE.trains.reduce((a,t)=>a+(Number(t.delayMin)||0),0)/trainsCount) : 0;
  const detained = STATE.trains.filter(t => t.status === "Retenu").length;

  $("#kpiTrains").textContent = String(trainsCount);
  $("#kpiIncidents").textContent = String(openInc);
  $("#kpiDelay").textContent = `${avgDelay} min`;
  $("#kpiRetenus").textContent = String(detained);

  // filters
  const q = ($("#searchTrain")?.value || "").toLowerCase().trim();
  const status = $("#filterStatus")?.value || "Tous";
  const line = ($("#filterLine")?.value || "Toutes").trim();

  let trains = [...STATE.trains];
  if (q){
    trains = trains.filter(t =>
      (t.number||"").toLowerCase().includes(q) ||
      (t.mission||"").toLowerCase().includes(q) ||
      (t.line||"").toLowerCase().includes(q) ||
      (t.od||"").toLowerCase().includes(q) ||
      (t.position||"").toLowerCase().includes(q)
    );
  }
  if (status !== "Tous") trains = trains.filter(t => t.status === status);
  if (line !== "Toutes") trains = trains.filter(t => (t.line||"") === line);

  // line options (dynamic)
  const lines = [...new Set(STATE.trains.map(t=>t.line).filter(Boolean))].sort();
  const lineSelect = $("#filterLine");
  if (lineSelect && lineSelect.dataset.built !== "1"){
    lineSelect.innerHTML = `<option value="Toutes">Toutes</option>` + lines.map(l=>`<option>${l}</option>`).join("");
    lineSelect.dataset.built = "1";
  }

  tbody.innerHTML = "";
  for (const t of trains){
    const delay = Number(t.delayMin || 0);
    const delayTagClass = delay <= 0 ? "ok" : delay <= 10 ? "warn" : "bad";

    const prioTag = t.priority === 1 ? "ok" : t.priority === 2 ? "warn" : "bad";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <div style="font-weight:800">${escapeHtml(t.number)}</div>
        <div class="muted">${escapeHtml(t.id)}</div>
      </td>
      <td><span class="tag info">${escapeHtml(t.mission)}</span></td>
      <td>
        <span class="tag">${escapeHtml(t.line || "-")}</span>
        <span class="tag ${prioTag}">P${escapeHtml(String(t.priority||2))}</span>
      </td>
      <td>${escapeHtml(t.od)}</td>
      <td contenteditable="true" data-edit="position" data-id="${t.id}">${escapeHtml(t.position)}</td>
      <td>
        <span class="tag ${delayTagClass}">${delay >= 0 ? "+" : ""}${escapeHtml(String(delay))} min</span>
        <div class="muted">MAJ: ${fmtDateTime(t.updatedAt)}</div>
      </td>
      <td>
        <select data-edit="status" data-id="${t.id}">
          ${["En circulation","À quai","Retenu","Supprimé","Détourné"].map(s=>`<option ${t.status===s?"selected":""}>${s}</option>`).join("")}
        </select>
      </td>
      <td contenteditable="true" data-edit="decision" data-id="${t.id}">${escapeHtml(t.decision || "")}</td>
      <td>
        <div class="row-actions">
          <button class="btn small" data-action="delay" data-id="${t.id}">Retard</button>
          <button class="btn small" data-action="incident" data-id="${t.id}">Incident</button>
          <button class="btn small danger" data-action="delete" data-id="${t.id}">Suppr.</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  }

  // bind editable cells
  $$("[contenteditable][data-edit]").forEach(el => {
    el.onblur = () => {
      const id = el.dataset.id;
      const field = el.dataset.edit;
      const train = findTrainById(id);
      if (!train) return;
      train[field] = el.textContent.trim();
      train.updatedAt = nowISO();
      scheduleAutosave();
      renderIndex();
    };
  });

  $$("select[data-edit='status']").forEach(sel => {
    sel.onchange = () => {
      const train = findTrainById(sel.dataset.id);
      if (!train) return;
      train.status = sel.value;
      train.updatedAt = nowISO();
      addLog({ type:"Décision", text:`Statut ${train.number}: ${train.status}`, trainId: train.id });
      scheduleAutosave();
      renderIndex();
    };
  });

  $$("button[data-action]").forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      if (action === "delete") return deleteTrain(id);
      if (action === "delay") return openDelayModal(id);
      if (action === "incident") return openIncidentModal(id);
    };
  });
}

function escapeHtml(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function addTrainFromModal(){
  const number = $("#mTrainNumber").value.trim();
  const mission = $("#mTrainMission").value.trim();
  const line = $("#mTrainLine").value.trim();
  const od = $("#mTrainOD").value.trim();
  const position = $("#mTrainPosition").value.trim();
  const priority = Number($("#mTrainPriority").value);
  const regulator = $("#mTrainRegulator").value.trim() || "PC";

  if (!number || !mission || !od) return;

  STATE.trains.unshift({
    id: uid("TRN"),
    number, mission, line,
    od,
    position: position || "-",
    delayMin: 0,
    priority: clamp(priority,1,3),
    status: "En circulation",
    decision: "",
    regulator,
    updatedAt: nowISO()
  });

  addLog({ type:"Information", text:`Mise en circulation: ${number} (${mission})`, trainId: STATE.trains[0].id });
  scheduleAutosave();
  closeModal();
  renderIndex();
}

function deleteTrain(trainId){
  const t = findTrainById(trainId);
  if (!t) return;
  if (!confirm(`Supprimer ${t.number} du tableau ?`)) return;
  STATE.trains = STATE.trains.filter(x => x.id !== trainId);
  addLog({ type:"Information", text:`Train supprimé du suivi: ${t.number}`, trainId });
  scheduleAutosave();
  renderIndex();
}

function openDelayModal(trainId){
  const t = findTrainById(trainId);
  if (!t) return;
  $("#mDelayTrain").textContent = t.number;
  $("#mDelayValue").value = String(t.delayMin || 0);
  $("#mDelayCause").value = "";
  $("#mDelayTrainId").value = trainId;
  openModal("modalDelay");
}
function applyDelay(){
  const trainId = $("#mDelayTrainId").value;
  const t = findTrainById(trainId);
  if (!t) return;

  const val = Number($("#mDelayValue").value || 0);
  const cause = $("#mDelayCause").value.trim();

  t.delayMin = clamp(val, -120, 999);
  t.updatedAt = nowISO();

  addLog({ type:"Décision", text:`Retard ${t.number}: ${t.delayMin >= 0 ? "+" : ""}${t.delayMin} min${cause ? " • Cause: "+cause : ""}`, trainId: t.id });
  scheduleAutosave();
  closeModal();
  renderIndex();
}

function openIncidentModal(trainId){
  const t = findTrainById(trainId);
  $("#mIncTrain").textContent = t ? t.number : "—";
  $("#mIncKind").value = "Panne matériel";
  $("#mIncLoc").value = t ? t.position : "";
  $("#mIncSev").value = "Mineur";
  $("#mIncDesc").value = "";
  $("#mIncTrainId2").value = trainId || "";
  openModal("modalIncident");
}
function createIncidentFromModal(){
  const trainId = $("#mIncTrainId2").value || null;
  const kind = $("#mIncKind").value;
  const location = $("#mIncLoc").value.trim();
  const severity = $("#mIncSev").value;
  const description = $("#mIncDesc").value.trim();
  if (!location || !description) return;

  addIncident({ kind, location, severity, description, trainId });
  scheduleAutosave();
  closeModal();
  renderIndex();
}

/* ============
   PAGE: INCIDENTS
============ */
function renderIncidents(){
  const wrap = $("#incidentList");
  if (!wrap) return;

  const q = ($("#searchIncident")?.value || "").toLowerCase().trim();
  const st = $("#filterIncidentStatus")?.value || "Tous";

  let list = [...STATE.incidents];
  if (q){
    list = list.filter(i =>
      (i.kind||"").toLowerCase().includes(q) ||
      (i.location||"").toLowerCase().includes(q) ||
      (i.description||"").toLowerCase().includes(q)
    );
  }
  if (st !== "Tous") list = list.filter(i => i.status === st);

  wrap.innerHTML = "";
  for (const i of list){
    const train = i.trainId ? findTrainById(i.trainId) : null;
    const sevTag = i.severity === "Mineur" ? "ok" : i.severity === "Majeur" ? "warn" : "bad";
    const stTag = i.status === "Clos" ? "ok" : i.status === "En cours" ? "warn" : "bad";

    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div class="top">
        <div>
          <div class="title">${escapeHtml(i.kind)} <span class="tag ${sevTag}">${escapeHtml(i.severity)}</span> <span class="tag ${stTag}">${escapeHtml(i.status)}</span></div>
          <div class="meta">Créé: ${fmtDateTime(i.createdAt)} • Lieu: ${escapeHtml(i.location)} ${train ? " • Train: <span class='tag info'>"+escapeHtml(train.number)+"</span>" : ""}</div>
        </div>
        <div class="row-actions">
          <button class="btn small" data-action="toggle" data-id="${i.id}">Statut</button>
          <button class="btn small" data-action="linklog" data-id="${i.id}">Main courante</button>
          <button class="btn small danger" data-action="del" data-id="${i.id}">Suppr.</button>
        </div>
      </div>
      <div class="text">${escapeHtml(i.description)}</div>
    `;
    wrap.appendChild(div);
  }

  $$("button[data-action='toggle']").forEach(b=>{
    b.onclick = ()=> toggleIncidentStatus(b.dataset.id);
  });
  $$("button[data-action='linklog']").forEach(b=>{
    b.onclick = ()=> { location.href = `journal.html#incident=${encodeURIComponent(b.dataset.id)}`; };
  });
  $$("button[data-action='del']").forEach(b=>{
    b.onclick = ()=> deleteIncident(b.dataset.id);
  });
}

function toggleIncidentStatus(incidentId){
  const i = findIncidentById(incidentId);
  if (!i) return;
  i.status = (i.status === "Ouvert") ? "En cours" : (i.status === "En cours") ? "Clos" : "Ouvert";
  addLog({ type:"Décision", text:`Incident ${i.id}: statut → ${i.status}`, trainId: i.trainId, incidentId: i.id });
  scheduleAutosave();
  renderIncidents();
}

function deleteIncident(incidentId){
  const i = findIncidentById(incidentId);
  if (!i) return;
  if (!confirm("Supprimer cet incident ?")) return;
  STATE.incidents = STATE.incidents.filter(x => x.id !== incidentId);
  addLog({ type:"Information", text:`Incident supprimé: ${i.kind} • ${i.location}`, trainId: i.trainId });
  scheduleAutosave();
  renderIncidents();
}

/* ============
   PAGE: JOURNAL
============ */
function renderJournal(){
  const wrap = $("#logList");
  if (!wrap) return;

  const q = ($("#searchLog")?.value || "").toLowerCase().trim();
  const ty = $("#filterLogType")?.value || "Tous";

  // deep-link focus incident
  const hash = new URLSearchParams(location.hash.replace("#","?"));
  const focusIncident = hash.get("incident");

  let list = [...STATE.logs];
  if (q){
    list = list.filter(l =>
      (l.type||"").toLowerCase().includes(q) ||
      (l.text||"").toLowerCase().includes(q) ||
      (l.author||"").toLowerCase().includes(q)
    );
  }
  if (ty !== "Tous") list = list.filter(l => l.type === ty);
  if (focusIncident) list = list.filter(l => l.incidentId === focusIncident);

  wrap.innerHTML = "";
  for (const l of list){
    const train = l.trainId ? findTrainById(l.trainId) : null;
    const inc = l.incidentId ? findIncidentById(l.incidentId) : null;

    const tag = l.type === "Information" ? "info" : l.type === "Ordre" ? "warn" : l.type === "Incident" ? "bad" : "ok";

    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div class="top">
        <div>
          <div class="title">
            <span class="tag ${tag}">${escapeHtml(l.type)}</span>
            ${train ? `<span class="tag info">Train: ${escapeHtml(train.number)}</span>` : ""}
            ${inc ? `<span class="tag warn">Incident: ${escapeHtml(inc.kind)}</span>` : ""}
          </div>
          <div class="meta">${fmtDateTime(l.at)} • ${escapeHtml(l.author || "PC")}</div>
        </div>
        <div class="row-actions">
          <button class="btn small danger" data-del="${l.id}">Suppr.</button>
        </div>
      </div>
      <div class="text">${escapeHtml(l.text)}</div>
    `;
    wrap.appendChild(div);
  }

  $$("button[data-del]").forEach(b=>{
    b.onclick = ()=> deleteLog(b.dataset.del);
  });
}

function deleteLog(logId){
  if (!confirm("Supprimer cette entrée ?")) return;
  STATE.logs = STATE.logs.filter(x => x.id !== logId);
  scheduleAutosave();
  renderJournal();
}

function addLogFromForm(){
  const type = $("#logType").value;
  const text = $("#logText").value.trim();
  const trainId = $("#logTrain").value || null;
  const incidentId = $("#logIncident").value || null;
  if (!text) return;

  addLog({ type, text, trainId, incidentId });
  $("#logText").value = "";
  scheduleAutosave();
  renderJournal();
}

/* ============
   PAGE: SETTINGS (SAVE CENTER)
============ */
function renderSettings(){
  const snaps = getSnapshots();
  const list = $("#snapshotList");
  if (list){
    list.innerHTML = snaps.map(s=>`
      <div class="item">
        <div class="top">
          <div>
            <div class="title">${escapeHtml(s.name)}</div>
            <div class="meta">${fmtDateTime(s.createdAt)} • id: ${escapeHtml(s.id)}</div>
          </div>
          <div class="row-actions">
            <button class="btn small" data-restore="${s.id}">Restaurer</button>
            <button class="btn small danger" data-delsnap="${s.id}">Suppr.</button>
          </div>
        </div>
      </div>
    `).join("");
    $$("button[data-restore]").forEach(b=> b.onclick = ()=>{
      if (!confirm("Restaurer ce snapshot ? (écrase l'état actuel)")) return;
      restoreSnapshot(b.dataset.restore);
      location.href = "index.html";
    });
    $$("button[data-delsnap]").forEach(b=> b.onclick = ()=>{
      deleteSnapshot(b.dataset.delsnap);
      renderSettings();
    });
  }

  // settings
  $("#setZone").value = STATE.settings.zoneName;
  $("#setOperator").value = STATE.settings.operatorName;
  $("#setStatus").value = STATE.settings.networkStatus;
  $("#setOffset").value = String(STATE.settings.rpOffsetMinutes || 0);
  $("#setAutosave").checked = !!STATE.settings.autosave;

  $("#stateMeta").textContent =
    `Créé: ${fmtDateTime(STATE.meta.createdAt)} • Dernière sauvegarde: ${STATE.meta.lastSavedAt ? fmtDateTime(STATE.meta.lastSavedAt) : "—"} • Source: ${STATE.meta.lastSavedBy}`;
}

function applySettings(){
  STATE.settings.zoneName = $("#setZone").value.trim() || "CCR / PC Régulation";
  STATE.settings.operatorName = $("#setOperator").value.trim() || "Régulateur";
  STATE.settings.networkStatus = $("#setStatus").value;
  STATE.settings.rpOffsetMinutes = Number($("#setOffset").value || 0);
  STATE.settings.autosave = $("#setAutosave").checked;

  addLog({ type:"Information", text:`Paramètres modifiés: état réseau=${STATE.settings.networkStatus}, offset RP=${STATE.settings.rpOffsetMinutes} min.` });
  saveState("settings");
  updateTopbar();
  renderSettings();
}

/* ============
   GLOBAL BUTTONS
============ */
function wireGlobalActions(){
  // status select (index/settings)
  const statusSel = $("#statusSelect");
  if (statusSel){
    statusSel.value = STATE.settings.networkStatus;
    statusSel.onchange = ()=>{
      STATE.settings.networkStatus = statusSel.value;
      addLog({ type:"Information", text:`État réseau: ${STATE.settings.networkStatus}` });
      scheduleAutosave();
      updateTopbar();
    };
  }

  // save center buttons
  const btnExport = $("#btnExport");
  if (btnExport){
    btnExport.onclick = ()=>{
      downloadJSON(`pc-regulation-sncf-rp_${new Date().toISOString().slice(0,19).replaceAll(":","-")}.json`, STATE);
    };
  }
  const fileImport = $("#fileImport");
  if (fileImport){
    fileImport.onchange = ()=>{
      const f = fileImport.files?.[0];
      if (!f) return;
      importJSONFile(f, (err, data)=>{
        if (err) return alert("Import impossible (JSON invalide).");
        STATE = migrateState(data);
        saveState("import");
        alert("Import OK. Redirection vers le tableau.");
        location.href = "index.html";
      });
    };
  }

  const btnSnapshot = $("#btnSnapshot");
  if (btnSnapshot){
    btnSnapshot.onclick = ()=>{
      const name = prompt("Nom du snapshot (ex: Début service 07:00) :") || "";
      createSnapshot(name || `Snapshot ${new Date().toLocaleString("fr-FR")}`);
      saveState("snapshot:create");
      renderSettings?.();
      alert("Snapshot créé.");
    };
  }

  const btnReset = $("#btnReset");
  if (btnReset){
    btnReset.onclick = ()=>{
      if (!confirm("Réinitialiser TOUT le PC Régulation ?")) return;
      localStorage.removeItem(APP.storageKey);
      // on ne supprime pas forcément les snapshots, mais tu peux :
      // localStorage.removeItem(APP.snapshotKey);
      loadState();
      saveState("reset");
      alert("Réinitialisé.");
      location.href = "index.html";
    };
  }

  const btnSaveNow = $("#btnSaveNow");
  if (btnSaveNow){
    btnSaveNow.onclick = ()=> saveState("manual");
  }
}

/* ============
   BOOT
============ */
function boot(){
  loadState();
  updateTopbar();
  updateSaveIndicator();
  tickClocks();
  wireGlobalActions();

  // page routing
  const page = document.body.dataset.page;

  if (page === "index"){
    $("#searchTrain").oninput = ()=> renderIndex();
    $("#filterStatus").onchange = ()=> renderIndex();
    $("#filterLine").onchange = ()=> renderIndex();

    $("#btnAddTrain").onclick = ()=>{
      // preset
      $("#mTrainNumber").value = "";
      $("#mTrainMission").value = "TER";
      $("#mTrainLine").value = "L1";
      $("#mTrainOD").value = "";
      $("#mTrainPosition").value = "";
      $("#mTrainPriority").value = "2";
      $("#mTrainRegulator").value = STATE.settings.operatorName || "PC";
      openModal("modalTrain");
    };

    $("#mTrainSave").onclick = addTrainFromModal;
    $("#mDelayApply").onclick = applyDelay;
    $("#mIncCreate").onclick = createIncidentFromModal;
    $("#closeModal").onclick = closeModal;
    $("#modalBackdrop").onclick = (e)=>{ if(e.target.id==="modalBackdrop") closeModal(); };

    renderIndex();
  }

  if (page === "incidents"){
    $("#searchIncident").oninput = ()=> renderIncidents();
    $("#filterIncidentStatus").onchange = ()=> renderIncidents();
    renderIncidents();
  }

  if (page === "journal"){
    // build dropdowns
    const trainSel = $("#logTrain");
    const incSel = $("#logIncident");
    if (trainSel){
      trainSel.innerHTML = `<option value="">— Aucun train —</option>` + STATE.trains.map(t=>`<option value="${t.id}">${escapeHtml(t.number)}</option>`).join("");
    }
    if (incSel){
      incSel.innerHTML = `<option value="">— Aucun incident —</option>` + STATE.incidents.map(i=>`<option value="${i.id}">${escapeHtml(i.kind)} • ${escapeHtml(i.location)}</option>`).join("");
    }

    $("#btnAddLog").onclick = addLogFromForm;
    $("#searchLog").oninput = ()=> renderJournal();
    $("#filterLogType").onchange = ()=> renderJournal();
    renderJournal();
  }

  if (page === "settings"){
    $("#btnApplySettings").onclick = applySettings;
    renderSettings();
  }
}

boot();
