/* ─────────────────────────────────────────
   OpenCode Web – app.js v6
   · Multi-session độc lập: DOM container riêng cho mỗi session
   · Model per-session · Busy/spinner per-session
   · Switch session = toggle visibility, không clear DOM
   · Non-current session vẫn nhận streaming update (hidden)
───────────────────────────────────────── */

const $ = (s) => document.querySelector(s);

// ── State ──────────────────────────────
let ws, wsReady = false;
let currentSessionId = null;
let currentProjectPath = null;
const sessionBusy = new Map();       // sessionID → true/false
const sessionQueues = new Map();     // sessionID → [{text, model, agent, directory}]
const sessionContainers = new Map(); // sessionID → div.session-messages
const sessionContexts = new Map();   // sessionID → { msgEl, toolEls, partialText, streamStarted }
let sessionModels = {};              // sessionID → "provider/model" → persist localStorage
let sessions = [];
let unseenSessions = new Set();
let authState = "unauthenticated";
let reconnectTimer = null;
let reconnectCount = 0;
const MAX_RECONNECT = 10;
const RECONNECT_BASE_DELAY = 2000;
let autoScrollLocked = false;
let promptCards = new Map();         // promptID → DOM el (permission cards)
let questionCards = new Map();       // questionID → DOM el
let lastFinishedSessionId = null;

const AUTO_SCROLL_THRESHOLD = 96;

// ── Per-session helpers ─────────────────
function isSessionBusy(sid)       { return !!sessionBusy.get(sid); }
function isCurrentBusy()          { return !!sessionBusy.get(currentSessionId); }
function getSessionQueue(sid)     { let q = sessionQueues.get(sid); if (!q) { q = []; sessionQueues.set(sid, q); } return q; }
function getCurrentQueue()        { return getSessionQueue(currentSessionId); }
function setSessionBusy(sid, v)   { if (v) sessionBusy.set(sid, true); else sessionBusy.delete(sid); }

function getSessionContext(sid) {
  if (!sessionContexts.has(sid)) {
    sessionContexts.set(sid, { msgEl: null, toolEls: {}, partialText: "", streamStarted: false });
  }
  return sessionContexts.get(sid);
}

function getOrCreateContainer(sid) {
  if (sessionContainers.has(sid)) return sessionContainers.get(sid);
  const el = document.createElement("div");
  el.className = "session-messages" + (sid === currentSessionId ? " active" : "");
  el.dataset.session = sid;
  el.style.display = sid === currentSessionId ? "flex" : "none";
  messagesDiv.appendChild(el);
  sessionContainers.set(sid, el);
  return el;
}

function containerFor(sid) {
  return sessionContainers.get(sid) || getOrCreateContainer(sid);
}

function loadSessionModels() {
  try { sessionModels = JSON.parse(localStorage.getItem("oc_session_models") || "{}"); } catch { sessionModels = {}; }
}
function saveSessionModels() {
  localStorage.setItem("oc_session_models", JSON.stringify(sessionModels));
}

// Projects
let projects = [];

// ── DOM ────────────────────────────────
const sidebar        = $("#sidebar");
const sidebarOverlay = $("#sidebar-overlay");
const projList       = $("#proj-list");
const sessionList    = $("#session-list");
const sessProjName   = $("#sess-proj-name");
const sessProjPath   = $("#sess-proj-path");
const messagesDiv    = $("#messages");
const msgInput       = $("#msg-input");
const btnSend        = $("#btn-send");
const btnAbort       = $("#btn-abort");
const btnMode        = $("#btn-mode");
const btnMenu        = $("#btn-menu");
const btnCloseSidebar= $("#btn-close-sidebar");
const btnNewMobile   = $("#btn-new-mobile");
const btnNewSession  = $("#btn-new-session");
const btnLogout      = $("#btn-logout");
const btnAddProj     = $("#btn-add-proj");
const modelSelect    = $("#model-select");
const statusDot      = $("#status-dot");
const connBadge      = $("#conn-badge");
const headerTitle    = $("#header-title");
const headerSub      = $("#header-sub");
const toastEl        = $("#toast");
const modalOverlay   = $("#modal-overlay");
const modalPath      = $("#modal-path");
const modalName      = $("#modal-name");
const modalOk        = $("#modal-ok");
const modalCancel    = $("#modal-cancel");
const browserPath    = $("#browser-path");
const browserList    = $("#browser-list");
const browserMkdir   = $("#browser-mkdir");
const browserMkdirBtn = $("#browser-mkdir-btn");
const loginOverlay   = $("#login-overlay");
const loginCopy      = $("#login-copy");
const loginPassword  = $("#login-password");
const loginBtn       = $("#login-btn");
const loginStatus    = $("#login-status");
const loginErr       = $("#login-err");

function sessionSortValue(session) {
  return session.time?.updated || session.time?.created || 0;
}

function resetAppState() {
  currentSessionId = null;
  currentProjectPath = null;
  sessionBusy.clear();
  sessionQueues.clear();
  sessionContainers.clear();
  sessionContexts.clear();
  sessionModels = {};
  sessions = [];
  projects = [];
  unseenSessions.clear();
  autoScrollLocked = false;
  promptCards = new Map();
  questionCards = new Map();
  lastFinishedSessionId = null;
}

function resetAppUi() {
  projList.innerHTML = "";
  sessionList.innerHTML = "";
  messagesDiv.innerHTML = unauthenticatedStateHtml();
  sessProjName.textContent = "";
  sessProjPath.textContent = "";
  headerTitle.textContent = "OpenCode";
  headerSub.textContent = "";
  if (chatHeaderTitle) chatHeaderTitle.textContent = "OpenCode";
  if (chatHeaderSub) chatHeaderSub.textContent = "Sign in to load data";
  msgInput.value = "";
  msgInput.style.height = "";
  btnSend.disabled = true;
  updateBusyUI(false);
}

// ── Scroll ──────────────────────────────
function isNearBottom() {
  const distance = messagesDiv.scrollHeight - messagesDiv.scrollTop - messagesDiv.clientHeight;
  return distance <= AUTO_SCROLL_THRESHOLD;
}
function updateAutoScrollLock() { autoScrollLocked = !isNearBottom(); }
function scrollBottom(force = false) {
  if (!force && autoScrollLocked) return;
  requestAnimationFrame(() => {
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    autoScrollLocked = false;
  });
}
function maybeScrollBottom() { scrollBottom(false); }

// ── Auth ─────────────────────────────────
function setAuthState(state, errorText = "") {
  authState = state;
  loginPassword.disabled = state === "authenticating";
  loginBtn.disabled = state === "authenticating";
  loginBtn.textContent = state === "authenticating" ? "Connecting..." : "Connect";
  loginCopy.textContent = state === "authenticating" ? "Checking credentials and opening session" : "Enter server password";
  loginStatus.textContent = state === "authenticating" ? "Authenticating..." : "";
  if (state === "authenticated") {
    loginOverlay.classList.add("hidden");
    loginErr.style.display = "none";
    loginPassword.value = "";
  } else {
    loginOverlay.classList.remove("hidden");
    btnSend.disabled = true;
    if (errorText) { loginErr.style.display = "block"; loginErr.textContent = errorText; }
    else { loginErr.style.display = "none"; loginErr.textContent = ""; }
    if (state === "unauthenticated") loginPassword.focus();
  }
  setConnStatus(state === "authenticated" ? "connected" : state === "authenticating" ? "authenticating" : "locked");
}
function loadInitialData() { loadProviders(); loadProjects(); }
function handleUnauthorized(errorText = "Wrong password") {
  localStorage.removeItem("oc_pass");
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close();
  wsReady = false;
  resetAppState();
  resetAppUi();
  setAuthState("unauthenticated", errorText);
}
function logout() { handleUnauthorized(""); closeSidebar(); }

// ── Projects ────────────────────────────
function loadProjects() {
  if (authState !== "authenticated") return;
  apiFetch("/api/projects").then(r => r.json()).then(data => {
    projects = Array.isArray(data) ? data : [];
    renderProjRail();
    const savedProj = localStorage.getItem("oc_project");
    if (savedProj && projects.find(p => p.path === savedProj)) selectProject(savedProj, false);
    else if (projects.length) selectProject(projects[0].path, false);
    loadSessions();
  }).catch(() => {});
}
function addProject() {
  if (authState !== "authenticated") return;
  const projPath = modalPath.value.trim();
  if (!projPath) { toast("Select a path"); return; }
  const name = modalName.value.trim() || projPath.split("/").pop() || projPath;
  apiFetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: projPath, name }) })
    .then(r => r.json()).then(data => {
      if (data.error) { toast(data.error); return; }
      projects.push({ path: projPath, name });
      renderProjRail();
      selectProject(projPath);
      modalOverlay.classList.add("hidden");
      toast(`Added: ${name}`);
    }).catch(e => toast(e.message));
}
function removeProject(projPath) {
  if (authState !== "authenticated") return;
  if (!confirm("Remove this project?")) return;
  apiFetch(`/api/projects?path=${encodeURIComponent(projPath)}`, { method: "DELETE" }).then(r => r.json()).then(() => {
    projects = projects.filter(p => p.path !== projPath);
    if (currentProjectPath === projPath) { currentSessionId = null; showEmptyStateInMessages(); }
    renderProjRail();
    if (projects.length && currentProjectPath === projPath) selectProject(projects[0].path);
  }).catch(() => {});
}
function renderProjRail() {
  projList.innerHTML = "";
  projects.forEach(p => {
    const el = document.createElement("div");
    el.className = "proj-icon" + (p.path === currentProjectPath ? " active" : "");
    el.title = p.name + "\n" + p.path;
    el.dataset.path = p.path;
    el.innerHTML = `<span>${projInitial(p.name)}</span><div class="proj-tooltip">${escapeHtml(p.name)}</div>`;
    el.addEventListener("click", () => { selectProject(p.path); openSidebar(); });
    el.addEventListener("contextmenu", e => { e.preventDefault(); removeProject(p.path); });
    projList.appendChild(el);
  });
}
function projInitial(name) { return name.trim().slice(0, 2).toUpperCase() || "?"; }

function selectProject(path, loadSess = true) {
  currentProjectPath = path;
  localStorage.setItem("oc_project", path);
  renderProjRail();
  const proj = projects.find(p => p.path === path);
  sessProjName.textContent = proj?.name || path.split("/").pop() || path;
  sessProjPath.textContent = path;
  if (!loadSess) return;
  // Hide all existing containers, show empty state
  for (const [sid, c] of sessionContainers) c.style.display = "none";
  currentSessionId = null;
  messagesDiv.innerHTML = emptyStateHtml();
  autoScrollLocked = false;
  loadSessions();
}

// ── WebSocket ───────────────────────────
function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  setAuthState("authenticating");
  ws = new WebSocket(`${proto}//${location.host}`);
  ws.onopen = () => {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    const pwd = localStorage.getItem("oc_pass") || "";
    if (pwd) ws.send(JSON.stringify({ type: "auth", password: pwd }));
    else wsReady = true;
  };
  ws.onclose = (e) => {
    wsReady = false; btnSend.disabled = true;
    if (isCurrentBusy()) { setSessionBusy(currentSessionId, false); updateBusyUI(false); }
    if (e.code === 4001) { handleUnauthorized("Wrong password"); return; }
    if (authState === "authenticated" || authState === "authenticating") {
      if (reconnectCount >= MAX_RECONNECT) { setAuthState("unauthenticated", "Cannot connect to server. Please refresh the page."); reconnectCount = 0; return; }
      const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(1.5, reconnectCount), 30000);
      reconnectCount++;
      setAuthState("authenticating");
      reconnectTimer = setTimeout(connect, delay);
    }
  };
  ws.onerror = () => setConnStatus("error");
  ws.onmessage = (e) => { try { dispatch(JSON.parse(e.data)); } catch {} };
}
function setConnStatus(s) {
  statusDot.className = `dot-${s}`; statusDot.title = s;
  connBadge.className = `badge ${s}`;
  connBadge.textContent = s === "connected" ? "Connected" : s === "error" ? "Error" : s === "authenticating" ? "Authenticating" : s === "locked" ? "Locked" : "Connecting";
}

// ── Dispatcher ──────────────────────────
function dispatch(msg) {
  switch (msg.type) {
    case "connected":
      wsReady = true; reconnectCount = 0;
      loadSessionModels();
      setAuthState("authenticated");
      btnSend.disabled = false;
      loadInitialData();
      break;
    case "session_created": onSessionCreated(msg.session); break;
    case "error":           onServerError(msg); break;
    case "question_answered": toast("Answer sent"); break;
    case "aborted":
      setSessionBusy(currentSessionId, false); updateBusyUI(false);
      toast("Stopped"); drainQueue(currentSessionId);
      break;
    case "event": onEvent(msg.data); break;
  }
}

function onSessionCreated(session) {
  currentSessionId = session.id;
  if (!sessions.find(s => s.id === session.id)) sessions.push(session);
  else { const idx = sessions.findIndex(s => s.id === session.id); if (idx >= 0) sessions[idx] = session; }
  sessions.sort((a, b) => sessionSortValue(b) - sessionSortValue(a));
  renderSessionList(); updateHeader();
}

// ── Event handler (core streaming) ──────
function onEvent(evt) {
  const p = evt.properties || {};
  switch (evt.type) {

    case "message.part.delta": {
      if (!p.sessionID) break;
      const ctx = getSessionContext(p.sessionID);
      if (!streamingFirstToken(ctx, p.sessionID)) break;
      if (currentMsgElFor(ctx) && p.messageID) currentMsgElFor(ctx).dataset.msgid = p.messageID;
      if (p.field === "text" && p.delta) {
        ctx.partialText += p.delta;
        const content = getMsgContent(currentMsgElFor(ctx));
        if (content) content.innerHTML = renderMarkdown(ctx.partialText);
        if (p.sessionID === currentSessionId) maybeScrollBottom();
      }
      break;
    }

    case "message.part.updated": {
      const part = p.part;
      if (!part?.sessionID) break;
      const ctx = getSessionContext(part.sessionID);
      const sid = part.sessionID;

      if (part.type === "text") {
        if (!streamingFirstToken(ctx, sid)) break;
        if (typeof p.delta === "string") ctx.partialText += p.delta;
        else if (typeof part.text === "string") ctx.partialText = part.text;
        const content = getMsgContent(currentMsgElFor(ctx));
        if (content) content.innerHTML = renderMarkdown(ctx.partialText);
        if (sid === currentSessionId) maybeScrollBottom();
      }

      if (part.type === "tool") {
        const cid = part.callID;
        if (!ctx.toolEls[cid]) {
          ctx.toolEls[cid] = createToolEl(part);
          const container = containerFor(sid);
          const sp = container.querySelector(".spinner");
          sp ? container.insertBefore(ctx.toolEls[cid], sp) : container.appendChild(ctx.toolEls[cid]);
        }
        updateToolEl(ctx.toolEls[cid], part.state || {});
        if (sid === currentSessionId) maybeScrollBottom();
      }

      if (part.type === "reasoning" && currentMsgElFor(ctx)) {
        const box = getMsgContent(currentMsgElFor(ctx));
        let rb = box && box.querySelector(".reasoning-block");
        if (!rb && box) { rb = document.createElement("div"); rb.className = "reasoning-block"; box.prepend(rb); }
        if (rb) rb.textContent = part.text;
      }

      if (part.type === "step-start") {
        ensureAssistantBubbleFor(ctx, sid);
        const box = getMsgContent(currentMsgElFor(ctx));
        if (box) {
          const stepBar = document.createElement("div");
          stepBar.className = "step-bar";
          stepBar.dataset.step = "open";
          stepBar.innerHTML = `<span class="step-bar-dot"></span><span class="step-bar-label">Working…</span>`;
          box.appendChild(stepBar);
        }
        if (sid === currentSessionId) maybeScrollBottom();
      }

      if (part.type === "step-finish") {
        const box = getMsgContent(currentMsgElFor(ctx));
        if (box) {
          const openBars = box.querySelectorAll(`.step-bar[data-step="open"]`);
          if (openBars.length) {
            const lastBar = openBars[openBars.length - 1];
            lastBar.dataset.step = "done";
            const reason = part.reason === "stop" ? "Done" : part.reason === "tool-calls" ? "More…" : part.reason || "";
            const tok = part.tokens?.total ? `· ${part.tokens.total.toLocaleString()} tok` : "";
            const cst = (Number.isFinite(part.cost) && part.cost > 0) ? `· $${part.cost.toFixed(4)}` : "";
            lastBar.querySelector(".step-bar-label").textContent = [reason, tok, cst].filter(Boolean).join(" ");
          }
        }
        if (sid === currentSessionId) maybeScrollBottom();
      }

      if (part.type === "tool" && part.tool === "question") onQuestionTool(part);

      if (!["text", "tool", "reasoning", "step-start", "step-finish"].includes(part.type)) {
        ensureAssistantBubbleFor(ctx, sid);
        const box = getMsgContent(currentMsgElFor(ctx));
        if (box) {
          const unknownKey = String(part.id || part.type || "unknown");
          let unknownEl = box.querySelector(`[data-unknown-part="${CSS.escape(unknownKey)}"]`);
          if (!unknownEl) {
            unknownEl = document.createElement("div");
            unknownEl.className = "unknown-part";
            unknownEl.dataset.unknownPart = unknownKey;
            box.appendChild(unknownEl);
          }
          unknownEl.innerHTML = `<div class="unknown-part-head"><span class="unknown-part-label">Live Block</span><span class="unknown-part-type">${escapeHtml(part.type || "unknown")}</span></div><pre>${escapeHtml(partToPreview(part))}</pre>`;
        }
        if (sid === currentSessionId) maybeScrollBottom();
      }
      break;
    }

    case "session.status": {
      const sid = p.sessionID;
      if (p.status?.type === "busy") {
        if (sid === currentSessionId) lastFinishedSessionId = null;
        if (!isSessionBusy(sid)) {
          setSessionBusy(sid, true);
          if (sid === currentSessionId) { updateBusyUI(true); addSpinner(sid); }
        }
        if (sid !== currentSessionId) { unseenSessions.add(sid); renderSessionList(); }
      } else if (p.status?.type === "idle" && sid) {
        const wasBusy = isSessionBusy(sid);
        setSessionBusy(sid, false);
        if (wasBusy) renderSessionList();
        if (sid === currentSessionId) { updateBusyUI(false); removeSpinner(sid); }
      }
      break;
    }

    case "session.idle": {
      const sid = p.sessionID;
      if (sid) {
        const wasBusy = isSessionBusy(sid);
        setSessionBusy(sid, false);
        if (wasBusy) renderSessionList();
      }
      if (sid === currentSessionId && lastFinishedSessionId !== sid) {
        lastFinishedSessionId = sid;
        finishResponse(sid);
      } else if (sid !== currentSessionId) {
        unseenSessions.add(sid); renderSessionList();
      }
      break;
    }

    case "message.updated": {
      if (p.info?.sessionID !== currentSessionId || p.info?.role !== "assistant") break;
      const ctx = getSessionContext(p.info.sessionID);
      if (currentMsgElFor(ctx)) updateMsgMeta(currentMsgElFor(ctx), p.info);
      break;
    }

    case "session.created": case "session.updated": case "session.deleted":
      loadSessions(); break;

    case "session.diff": case "server.heartbeat": case "todo.updated": break;

    case "permission.updated": case "permission.asked": {
      onPromptEvent(p.prompt || {
        kind: "permission", id: p.id, sessionID: p.sessionID,
        title: "Permission Required", description: p.tool || p.permission || "unknown",
        detail: p.arguments || "", status: p.status || "pending",
        actions: [
          { label: "Deny", response: "deny", tone: "deny" },
          { label: "Allow Once", response: "allow", tone: "allow" },
          { label: "Always Allow", response: "allow", remember: true, tone: "always" },
        ],
      });
      break;
    }

    case "prompt.updated": onPromptEvent(p.prompt); break;
  }
}

// ── Streaming helpers ───────────────────
function streamingFirstToken(ctx, sid) {
  if (!ctx.streamStarted) {
    ctx.streamStarted = true;
    removeSpinner(sid);
    ensureAssistantBubbleFor(ctx, sid);
  }
  return true;
}
function currentMsgElFor(ctx) { return ctx.msgEl; }
function setCurrentMsgElFor(ctx, el) { ctx.msgEl = el; }

function ensureAssistantBubbleFor(ctx, sid) {
  if (ctx.msgEl) return;
  const el = document.createElement("div");
  el.className = "message assistant";
  const model = (sessionModels[sid] || modelSelect.value || "default");
  el.innerHTML = `<div class="msg-meta">
    <span class="model-tag">${escapeHtml(model.split("/").pop() || model)}</span>
    <span class="time-tag" data-start="${Date.now()}"></span>
    <span class="cost-tag"></span>
  </div>
  <div class="msg-content"></div>`;
  ctx.msgEl = el;
  const container = containerFor(sid);
  const sp = container.querySelector(".spinner");
  sp ? container.insertBefore(el, sp) : container.appendChild(el);
  startElapsedTimer(el);
  if (sid === currentSessionId) maybeScrollBottom();
}

function getMsgContent(el) { return el ? el.querySelector(".msg-content") : null; }

function startElapsedTimer(msgEl) {
  const timeEl = msgEl.querySelector(".time-tag");
  if (!timeEl) return;
  const start = Number(timeEl.dataset.start);
  if (!Number.isFinite(start)) { timeEl.textContent = ""; return; }
  const tid = setInterval(() => {
    if (!msgEl.isConnected || msgEl.dataset.done) { clearInterval(tid); return; }
    const secs = ((Date.now() - start) / 1000).toFixed(1);
    timeEl.textContent = `${secs}s`;
  }, 100);
}

function updateMsgMeta(msgEl, info) {
  if (!msgEl) return;
  msgEl.dataset.done = "1";
  const timeEl = msgEl.querySelector(".time-tag");
  const costEl = msgEl.querySelector(".cost-tag");
  const created = Number(info.time?.created);
  const completed = Number(info.time?.completed);
  if (timeEl) {
    if (Number.isFinite(created) && Number.isFinite(completed) && completed >= created) timeEl.textContent = `${((completed - created) / 1000).toFixed(1)}s`;
    else timeEl.textContent = "";
  }
  if (costEl) {
    const inp = Number.isFinite(info.tokens?.input) ? info.tokens.input : 0;
    const out = Number.isFinite(info.tokens?.output) ? info.tokens.output : 0;
    const tok = (inp || out) ? `${inp.toLocaleString()}+${out.toLocaleString()} tok` : "";
    const cost = (Number.isFinite(info.cost) && info.cost > 0) ? `$${info.cost.toFixed(4)}` : "";
    costEl.textContent = [tok, cost].filter(Boolean).join(" · ");
  }
}

// ── Per-session spinner & busy UI ───────
function addSpinner(sid) {
  const c = containerFor(sid);
  if (c.querySelector(".spinner")) return;
  const el = document.createElement("div");
  el.className = "spinner";
  el.innerHTML = "<span></span><span></span><span></span>";
  c.appendChild(el);
  if (sid === currentSessionId) maybeScrollBottom();
}
function removeSpinner(sid) {
  containerFor(sid).querySelector(".spinner")?.remove();
}

function updateBusyUI(busy) {
  btnAbort.classList.toggle("hidden", !busy);
  btnSend.classList.toggle("hidden", busy);
}

// ── Send ────────────────────────────────
function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || !wsReady) return;
  msgInput.value = "";
  msgInput.style.height = "";

  const modelVal = modelSelect.value;
  const model = modelVal ? { providerID: modelVal.split("/")[0], modelID: modelVal.split("/").slice(1).join("/") } : undefined;
  const agent = btnMode.dataset.mode || "build";
  const directory = currentProjectPath || undefined;

  addUserBubble(text);

  if (isCurrentBusy()) {
    getCurrentQueue().push({ text, model, agent, directory, sessionId: currentSessionId });
    let notice = messagesDiv.querySelector(".msg-queue-notice");
    if (!notice) { notice = document.createElement("div"); notice.className = "msg-queue-notice"; messagesDiv.appendChild(notice); }
    notice.textContent = `${getCurrentQueue().length} message${getCurrentQueue().length > 1 ? "s" : ""} queued`;
    scrollBottom(true);
    return;
  }

  doSend(text, model, agent, directory, currentSessionId);
}

function doSend(text, model, agent, directory, sessionId) {
  const sid = sessionId || currentSessionId;
  if (!currentSessionId && !sessionId) messagesDiv.innerHTML = "";

  // Create container if missing
  containerFor(sid);

  // Save model for this session
  if (currentSessionId === sid && modelSelect.value) {
    sessionModels[sid] = modelSelect.value;
    saveSessionModels();
  }

  // Reset streaming context for this session
  const ctx = getSessionContext(sid);
  ctx.partialText = "";
  ctx.toolEls = {};
  ctx.msgEl = null;
  ctx.streamStarted = false;

  const isCurrent = sid === currentSessionId;
  setSessionBusy(sid, true);
  if (isCurrent) autoScrollLocked = false;
  if (isCurrent) updateBusyUI(true);
  addSpinner(sid);
  renderSessionList();
  ws.send(JSON.stringify({ action: "send", sessionId: sid, text, model, agent, directory }));
}

function abortSession() {
  if (currentSessionId && isCurrentBusy()) {
    setSessionBusy(currentSessionId, false);
    getCurrentQueue().length = 0;
    updateQueueNotice();
    removeSpinner(currentSessionId);
    updateBusyUI(false);
    renderSessionList();
    ws.send(JSON.stringify({ action: "abort", sessionId: currentSessionId }));
  }
}

function addUserBubble(text) {
  const c = containerFor(currentSessionId);
  const el = document.createElement("div");
  el.className = "message user";
  el.innerHTML = `<div class="msg-content">${escapeHtml(text)}</div>`;
  c.appendChild(el);
  scrollBottom(true);
}

// ── Finish response ─────────────────────
function finishResponse(sessionID) {
  const ctx = getSessionContext(sessionID);
  removeSpinner(sessionID);
  if (currentMsgElFor(ctx)) {
    const content = getMsgContent(currentMsgElFor(ctx));
    if (content) content.innerHTML = renderMarkdown(ctx.partialText);
  }
  if (!sessionID || sessionID === currentSessionId) {
    ctx.msgEl = null; ctx.partialText = ""; ctx.toolEls = {};
  }
  setSessionBusy(sessionID || currentSessionId, false);
  ctx.streamStarted = false;
  if (sessionID === currentSessionId) updateBusyUI(false);
  renderSessionList();
  if (sessionID === currentSessionId) maybeScrollBottom();
  drainQueue(sessionID);

  // Fetch full message from API to render tools/steps/reasoning
  if (sessionID && sessionID === currentSessionId) {
    apiFetch(`/api/sessions/${sessionID}/messages`)
      .then(r => r.json())
      .then(messages => {
        if (!Array.isArray(messages) || !messages.length) return;
        const lastMsg = [...messages].reverse().find(m => (m.info || m).role === "assistant");
        if (!lastMsg) return;
        const msgInfo = lastMsg.info || lastMsg;

        let bubble = containerFor(sessionID).querySelector(`[data-msgid="${msgInfo.id}"]`);
        if (!bubble) {
          const allBubbles = containerFor(sessionID).querySelectorAll(".message.assistant:has(.msg-content)");
          bubble = allBubbles[allBubbles.length - 1] || null;
        }
        if (!bubble) return;

        const content = bubble.querySelector(".msg-content");
        if (content) {
          content.innerHTML = renderAssistantParts(lastMsg.parts || [], content.innerHTML);
        }
        updateMsgMeta(bubble, msgInfo);
        maybeScrollBottom();
      }).catch(() => {});
  }
}

function onServerError(msg) {
  const sid = msg.sessionId || currentSessionId;
  const ctx = getSessionContext(sid);
  removeSpinner(sid);
  if (currentMsgElFor(ctx)) {
    getMsgContent(currentMsgElFor(ctx)).insertAdjacentHTML("beforeend",
      `<div class="msg-error">⚠ ${escapeHtml(msg.error || "Unknown error")}</div>`);
    ctx.msgEl = null;
  }
  ctx.partialText = ""; ctx.toolEls = {};
  setSessionBusy(sid, false); ctx.streamStarted = false;
  if (sid === currentSessionId) updateBusyUI(false);
  renderSessionList();
  toast("Error: " + (msg.error || "failed").slice(0, 60));
  drainQueue(sid);
}

// ── Queue ───────────────────────────────
function drainQueue(sessionID) {
  const sid = sessionID || currentSessionId;
  if (!sid) return;
  const q = getSessionQueue(sid);
  if (q.length && wsReady && !isSessionBusy(sid)) {
    const next = q.shift();
    updateQueueNotice();
    doSend(next.text, next.model, next.agent, next.directory, next.sessionId);
  }
}
function updateQueueNotice() {
  const el = messagesDiv.querySelector(".msg-queue-notice");
  const q = getCurrentQueue();
  if (el) { if (q.length) el.textContent = `${q.length} message${q.length > 1 ? "s" : ""} queued`; else el.remove(); }
}

function showEmptyStateInMessages() {
  messagesDiv.innerHTML = emptyStateHtml();
}

// ── Sessions ────────────────────────────
function loadSessions() {
  if (authState !== "authenticated") return;
  const url = currentProjectPath
    ? `/api/sessions?directory=${encodeURIComponent(currentProjectPath)}`
    : "/api/sessions";
  apiFetch(url).then(r => r.json()).then(data => {
    sessions = Array.isArray(data) ? data : [];
    sessions.sort((a, b) => sessionSortValue(b) - sessionSortValue(a));
    renderSessionList();

    if (!currentSessionId) {
      const saved = localStorage.getItem("oc_session");
      const target = (saved && sessions.find(s => s.id === saved)) ? saved : sessions[0]?.id;
      if (target) selectSession(target);
      else showEmptyStateInMessages();
    }
    updateHeader();
  }).catch(() => {});
}

function renderSessionList() {
  sessions.sort((a, b) => sessionSortValue(b) - sessionSortValue(a));
  sessionList.innerHTML = "";
  if (!sessions.length) {
    sessionList.innerHTML = `<li style="padding:16px 12px;font-size:12px;color:var(--text2)">No sessions yet</li>`;
    return;
  }
  sessions.forEach(s => {
    const active = s.id === currentSessionId;
    const unseen = unseenSessions.has(s.id);
    const busy = isSessionBusy(s.id);
    const date = new Date(s.time?.updated || s.time?.created || 0);
    const timeStr = isToday(date)
      ? date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
      : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });

    const li = document.createElement("li");
    li.className = "session-item" + (active ? " active" : "") + (unseen ? " unseen" : "") + (busy ? " busy" : "");
    li.dataset.id = s.id;
    li.innerHTML = `<div class="sess-dot"></div>
      <div class="sess-meta">
        <div class="sess-title">${escapeHtml(s.title || s.id.slice(0, 12))}</div>
        <div class="sess-info">${timeStr} · ${escapeHtml(s.agent || "build")}</div>
      </div>
      ${unseen ? `<span class="sess-badge">●</span>` : ""}
      <button class="sess-del" title="Delete">✕</button>`;
    li.addEventListener("click", e => {
      if (e.target.classList.contains("sess-del")) return;
      selectSession(s.id); closeSidebar();
    });
    li.querySelector(".sess-del").addEventListener("click", e => {
      e.stopPropagation(); deleteSession(s.id);
    });
    sessionList.appendChild(li);
  });
}

function selectSession(id, fetchMessages = true) {
  if (id === currentSessionId && fetchMessages) return; // already viewing

  // Hide old container
  if (currentSessionId && sessionContainers.has(currentSessionId)) {
    const oldC = sessionContainers.get(currentSessionId);
    oldC.classList.remove("active");
    oldC.style.display = "none";
  }

  currentSessionId = id;
  localStorage.setItem("oc_session", id);
  unseenSessions.delete(id);

  // Update model selector to this session's model
  const savedModel = sessionModels[id] || "";
  if (savedModel) modelSelect.value = savedModel;

  // Show container for new session (create if needed) + scroll to bottom
  const c = containerFor(id);
  c.classList.add("active");
  c.style.display = "flex";
  autoScrollLocked = false;
  scrollBottom(true);

  // Sync busy UI to this session
  if (isSessionBusy(id)) {
    updateBusyUI(true);
    // Spinner may already be in container — add if missing
    if (!c.querySelector(".spinner")) addSpinner(id);
  } else {
    updateBusyUI(false);
    removeSpinner(id);
  }

  renderSessionList();
  updateHeader();

  // Load messages if container is empty (first time viewing)
  if (fetchMessages && !c.querySelector(".message")) {
    loadMessages(id);
  }
}

function loadMessages(id) {
  if (authState !== "authenticated") return;
  autoScrollLocked = false;
  const c = containerFor(id);

  // Show loading spinner in container
  c.innerHTML = `<div class="load-hist"><span></span><span></span><span></span></div>`;
  c.classList.add("active");
  c.style.display = "flex";

  Promise.all([
    apiFetch(`/api/sessions/${id}/messages`).then(r => r.json()),
    apiFetch(`/api/sessions/${id}/state`).then(r => r.json()).catch(() => ({ status: "idle", prompts: [] })),
  ]).then(([data, runtime]) => {
    c.innerHTML = "";
    if (Array.isArray(data) && data.length) {
      data.forEach(item => renderMessageIntoContainer(item.info || item, item.parts || [], c));
    }

    // Rehydrate busy/idle state
    if (runtime.status === "busy" && !isSessionBusy(id)) {
      setSessionBusy(id, true);
      const ctx = getSessionContext(id);
      ctx.streamStarted = false; ctx.msgEl = null; ctx.partialText = ""; ctx.toolEls = {};
      if (id === currentSessionId) updateBusyUI(true);
      addSpinner(id);
    } else if (runtime.status !== "busy" && isSessionBusy(id)) {
      setSessionBusy(id, false);
      if (id === currentSessionId) updateBusyUI(false);
      removeSpinner(id);
    }

    renderSessionList();

    // Rehydrate prompt cards
    for (const prompt of runtime?.prompts || []) onPromptEvent(prompt);
    if (id === currentSessionId) scrollBottom(true);
  }).catch(() => { c.innerHTML = ""; });
}

function renderMessageIntoContainer(msg, parts, container) {
  const el = document.createElement("div");
  el.className = `message ${msg.role}`;

  if (msg.role === "user") {
    let text = "";
    for (const p of parts) if (p.type === "text") text += escapeHtml(p.text);
    el.innerHTML = `<div class="msg-content">${text}</div>`;
  } else {
    const created = Number(msg.time?.created);
    const completed = Number(msg.time?.completed);
    const dur = (Number.isFinite(created) && Number.isFinite(completed) && completed >= created)
      ? `${((completed - created) / 1000).toFixed(1)}s` : "";
    const inp = Number.isFinite(msg.tokens?.input) ? msg.tokens.input : 0;
    const out = Number.isFinite(msg.tokens?.output) ? msg.tokens.output : 0;
    const tok = (inp || out) ? `${inp.toLocaleString()}+${out.toLocaleString()} tok` : "";
    const cost = (Number.isFinite(msg.cost) && msg.cost > 0) ? `$${msg.cost.toFixed(4)}` : "";
    const model = msg.modelID ? msg.modelID.split("/").pop() : "";
    const mode = msg.mode || msg.agent || "build";

    el.innerHTML = `<div class="msg-meta">
      ${model ? `<span class="model-tag">${escapeHtml(model)}</span>` : ""}
      <span class="mode-tag ${mode}">${mode}</span>
      ${dur ? `<span class="time-tag">${dur}</span>` : ""}
      <span class="cost-tag">${[tok, cost].filter(Boolean).join(" · ")}</span>
    </div>`;

    const content = document.createElement("div");
    content.className = "msg-content";
    content.innerHTML = renderAssistantParts(parts || []);
    el.appendChild(content);
  }
  container.appendChild(el);
}

function renderAssistantParts(parts, streamedTextHtml = "") {
  let html = "";
  let usedStreamedText = false;
  for (const p of parts) {
    if (p.type === "step-start") continue;
    else if (p.type === "step-finish") {
      html += `<div class="step-bar" data-step="done"><span class="step-bar-dot"></span><span class="step-bar-label">${stepFinishLabel(p)}</span></div>`;
    } else if (p.type === "text") {
      if (!usedStreamedText && streamedTextHtml) { html += streamedTextHtml; usedStreamedText = true; }
      else html += renderMarkdown(p.text || "");
    } else if (p.type === "reasoning") {
      html += `<div class="reasoning-block">${escapeHtml(p.text || "")}</div>`;
    } else if (p.type === "tool") {
      html += p.tool === "question" ? renderQuestionToolHtml(p) : renderToolHtml(p);
    } else {
      html += renderUnknownPartHtml(p);
    }
  }
  return html;
}

function stepFinishLabel(p) {
  const reason = p.reason === "stop" ? "Done" : p.reason === "tool-calls" ? "More…" : (p.reason || "");
  const tok = p.tokens?.total ? `· ${p.tokens.total.toLocaleString()} tok` : "";
  const cst = (Number.isFinite(p.cost) && p.cost > 0) ? `· $${p.cost.toFixed(4)}` : "";
  return [reason, tok, cst].filter(Boolean).join(" ");
}

function renderQuestionToolHtml(p) {
  const questions = p.state?.input?.questions || [];
  if (!questions.length) return `<div class="prompt-card question submitted"><div class="prompt-card-head"><div class="prompt-card-title">Question</div></div></div>`;
  const q = questions[0];
  const isResolved = p.state?.status === "completed";
  return `<div class="prompt-card question ${isResolved ? "submitted" : ""}">
    <div class="prompt-card-head">
      <div><div class="prompt-card-title">${escapeHtml(q.question || "Question")}</div>
      ${q.header ? `<div class="prompt-card-subtitle">${escapeHtml(q.header)}</div>` : ""}</div>
      <span class="prompt-card-status ${isResolved ? "allowed" : "pending"}">${isResolved ? "Answered" : "Awaiting"}</span>
    </div>
    <div class="prompt-card-options">
      ${(q.options || []).map((opt, idx) => `<label class="prompt-option ${isResolved ? "disabled" : ""}">
        <input type="${q.multiple ? 'checkbox' : 'radio'}" disabled value="${idx}">
        <span>${escapeHtml(opt.label)}</span>${opt.description ? `<small>${escapeHtml(opt.description)}</small>` : ""}
      </label>`).join("")}
    </div></div>`;
}

function renderUnknownPartHtml(part) {
  const type = part?.type || "unknown";
  const preview = partToPreview(part);
  const key = escapeHtml(part?.id || type);
  return `<div class="unknown-part" data-unknown-part="${key}">
    <div class="unknown-part-head"><span class="unknown-part-label">Live Block</span><span class="unknown-part-type">${escapeHtml(type)}</span></div>
    <pre>${escapeHtml(preview)}</pre></div>`;
}

function partToPreview(part) {
  if (!part) return "";
  if (typeof part.text === "string" && part.text.trim()) return part.text;
  if (typeof part.arguments === "string" && part.arguments.trim()) return part.arguments;
  if (typeof part.output === "string" && part.output.trim()) return part.output;
  if (typeof part.value === "string" && part.value.trim()) return part.value;
  try { return JSON.stringify(part, null, 2); } catch { return String(part); }
}

function deleteSession(id) {
  if (authState !== "authenticated") return;
  if (!confirm("Delete this session?")) return;
  apiFetch(`/api/sessions/${id}`, { method: "DELETE" }).then(() => {
    sessions = sessions.filter(s => s.id !== id);
    sessionContainers.delete(id); sessionContexts.delete(id);
    sessionQueues.delete(id); sessionBusy.delete(id);
    if (currentSessionId === id) {
      currentSessionId = null; showEmptyStateInMessages();
      localStorage.removeItem("oc_session");
    }
    renderSessionList(); updateHeader();
  });
}

function newSession() {
  if (authState !== "authenticated") return;
  // Hide all containers
  for (const c of sessionContainers.values()) { c.classList.remove("active"); c.style.display = "none"; }
  currentSessionId = null;
  localStorage.removeItem("oc_session");
  sessionQueues.clear();
  autoScrollLocked = false;
  showEmptyStateInMessages();
  renderSessionList(); updateHeader();
  msgInput.focus(); closeSidebar();
}

// ── Prompt/Question handlers ────────────
function onPromptEvent(prompt) {
  if (!prompt?.id || !prompt?.sessionID) return;
  if (prompt.sessionID !== currentSessionId) {
    unseenSessions.add(prompt.sessionID); renderSessionList(); return;
  }
  let card = promptCards.get(prompt.id);
  if (!card) {
    card = createPromptCard(prompt);
    promptCards.set(prompt.id, card);
    const c = containerFor(prompt.sessionID);
    const sp = c.querySelector(".spinner");
    sp ? c.insertBefore(card, sp) : c.appendChild(card);
  }
  updatePromptCard(card, prompt);
  if (normalizePromptStatus(prompt.status) !== "pending") promptCards.delete(prompt.id);
  maybeScrollBottom();
}

function onQuestionTool(part) {
  const qid = part.id || part.callID;
  if (!qid || part.sessionID !== currentSessionId) return;
  const questions = part.state?.input?.questions || [];
  if (!questions.length) return;
  const existingCard = questionCards.get(qid);

  if (part.state?.status === "completed") {
    if (existingCard) {
      const card = existingCard.querySelector(".prompt-card");
      const statusEl = existingCard.querySelector(".prompt-card-status");
      card.classList.add("submitted"); statusEl.textContent = "Answered";
      statusEl.className = "prompt-card-status allowed";
      existingCard.querySelectorAll(".prompt-action").forEach(b => { b.disabled = true; });
    }
    return;
  }
  if (!existingCard) {
    const el = document.createElement("div");
    el.className = "message assistant"; el.dataset.questionId = qid;
    el.innerHTML = `<div class="prompt-card question"><div class="prompt-card-head">
        <div><div class="prompt-card-title">${escapeHtml(questions[0]?.question || "Question")}</div>
        <div class="prompt-card-subtitle">AI needs your input to continue</div></div>
        <span class="prompt-card-status pending">Awaiting</span></div>
      <div class="prompt-card-options"></div><div class="prompt-card-actions"></div></div>`;
    questionCards.set(qid, el);

    const c = containerFor(part.sessionID);
    const sp = c.querySelector(".spinner");
    sp ? c.insertBefore(el, sp) : c.appendChild(el);

    const optionsEl = el.querySelector(".prompt-card-options");
    const q = questions[0];
    optionsEl.innerHTML = (q.options || []).map((option, idx) => `<label class="prompt-option">
      <input type="${q.multiple ? 'checkbox' : 'radio'}" name="q-${CSS.escape(qid)}" value="${idx}">
      <span>${escapeHtml(option.label)}</span>${option.description ? `<small>${escapeHtml(option.description)}</small>` : ""}
    </label>`).join("");

    const actionsEl = el.querySelector(".prompt-card-actions");
    const submitBtn = document.createElement("button");
    submitBtn.className = "prompt-action allow";
    submitBtn.textContent = "Submit Answer";
    submitBtn.addEventListener("click", () => submitQuestionResponse(part, el));
    actionsEl.appendChild(submitBtn);
  }
  maybeScrollBottom();
}

function submitQuestionResponse(part, el) {
  const card = el.querySelector(".prompt-card");
  const statusEl = el.querySelector(".prompt-card-status");
  const questions = part.state?.input?.questions || [];
  const selected = Array.from(el.querySelectorAll(".prompt-card-options input:checked")).map(input => {
    const idx = Number(input.value);
    const option = questions[0]?.options?.[idx];
    return option?.label || "";
  }).filter(Boolean);
  if (!selected.length) { toast("Select an option first"); return; }
  card.classList.add("submitting"); statusEl.textContent = "Sending…";
  el.querySelectorAll(".prompt-action").forEach(btn => { btn.disabled = true; });
  ws.send(JSON.stringify({ action: "answer_question", callID: part.callID, sessionID: part.sessionID, answers: selected }));
}

function createPromptCard(prompt) {
  const el = document.createElement("div");
  el.className = "message assistant"; el.dataset.promptId = prompt.id;
  el.innerHTML = `<div class="prompt-card ${escapeHtml(prompt.kind || "question")}">
    <div class="prompt-card-head"><div><div class="prompt-card-title"></div><div class="prompt-card-subtitle"></div></div>
    <span class="prompt-card-status pending">Pending</span></div>
    <div class="prompt-card-detail"></div><div class="prompt-card-input hidden"></div>
    <div class="prompt-card-options hidden"></div><div class="prompt-card-actions"></div></div>`;
  return el;
}

function updatePromptCard(el, prompt) {
  const card = el.querySelector(".prompt-card");
  const titleEl = el.querySelector(".prompt-card-title");
  const subtitleEl = el.querySelector(".prompt-card-subtitle");
  const statusEl = el.querySelector(".prompt-card-status");
  const detailEl = el.querySelector(".prompt-card-detail");
  const inputEl = el.querySelector(".prompt-card-input");
  const optionsEl = el.querySelector(".prompt-card-options");
  const actionsEl = el.querySelector(".prompt-card-actions");
  const status = normalizePromptStatus(prompt.status);
  const promptType = prompt.type || prompt.kind || "permission";

  card.className = `prompt-card ${escapeHtml(prompt.kind || "question")} ${status}`;
  titleEl.textContent = prompt.title || "Action Required";
  subtitleEl.textContent = prompt.description || promptTypeLabel(promptType);
  statusEl.textContent = promptStatusLabel(status);
  statusEl.className = `prompt-card-status ${status}`;
  const fullDetail = String(prompt.detail || "");
  const DETAIL_LIMIT = 600;
  if (fullDetail.length > DETAIL_LIMIT) {
    detailEl.textContent = fullDetail.slice(0, DETAIL_LIMIT);
    const moreBtn = document.createElement("button");
    moreBtn.className = "detail-expand-btn"; moreBtn.textContent = ` … show full (${fullDetail.length} chars)`;
    moreBtn.addEventListener("click", () => { detailEl.textContent = fullDetail; moreBtn.remove(); });
    detailEl.appendChild(moreBtn);
  } else { detailEl.textContent = fullDetail; }

  inputEl.classList.toggle("hidden", promptType !== "input");
  optionsEl.classList.toggle("hidden", promptType === "input");

  if (promptType === "input") {
    inputEl.innerHTML = `<input class="prompt-text-input" type="text" placeholder="Type your answer...">`;
  } else if (prompt.options?.length) {
    optionsEl.innerHTML = prompt.options.map((option, index) => `
      <label class="prompt-option"><input type="${prompt.multiple ? "checkbox" : "radio"}" name="prompt-${escapeHtml(prompt.id)}" value="${index}">
      <span>${escapeHtml(option.label)}</span></label>`).join("");
  } else { optionsEl.innerHTML = ""; }

  actionsEl.innerHTML = "";
  const isResolved = status !== "pending";
  (prompt.actions || defaultPromptActions(promptType)).forEach(action => {
    const btn = document.createElement("button");
    btn.className = `prompt-action ${action.tone || "default"}`;
    btn.textContent = action.label; btn.disabled = isResolved;
    btn.addEventListener("click", () => submitPromptResponse(prompt, action, el));
    actionsEl.appendChild(btn);
  });
}

function submitPromptResponse(prompt, action, el) {
  const card = el.querySelector(".prompt-card");
  const statusEl = el.querySelector(".prompt-card-status");
  const payload = { response: action.response, remember: !!action.remember };
  if (prompt.type === "input") payload.value = el.querySelector(".prompt-text-input")?.value?.trim() || "";
  if (prompt.options?.length) {
    const selected = Array.from(el.querySelectorAll(".prompt-card-options input:checked")).map(input => {
      const option = prompt.options[Number(input.value)];
      return option?.value ?? option?.label;
    }).filter(Boolean);
    payload.answers = prompt.multiple ? selected : selected[0] || "";
  }
  card.classList.add("submitting"); statusEl.textContent = "Submitting...";
  el.querySelectorAll(".prompt-action").forEach(btn => { btn.disabled = true; });

  if (prompt.kind === "permission") {
    apiFetch(`/api/sessions/${encodeURIComponent(prompt.sessionID)}/prompts/${encodeURIComponent(prompt.id)}/respond`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    }).then(async r => {
      if (!r.ok) { const data = await r.json().catch(() => ({})); throw new Error(data.error || "Failed"); }
    }).catch(err => {
      card.classList.remove("submitting"); statusEl.textContent = "Pending";
      statusEl.className = "prompt-card-status pending";
      el.querySelectorAll(".prompt-action").forEach(btn => { btn.disabled = false; });
      toast(err.message);
    });
    return;
  }
  ws.send(JSON.stringify({ action: "respond_permission", permissionId: prompt.id, sessionID: prompt.sessionID, ...payload }));
}

function normalizePromptStatus(status) {
  if (status === "granted" || status === "allow" || status === "allowed") return "allowed";
  if (status === "deny" || status === "denied" || status === "rejected") return "denied";
  if (status === "submitted") return "submitted";
  return "pending";
}
function promptStatusLabel(s) { return s === "allowed" ? "Allowed" : s === "denied" ? "Denied" : s === "submitted" ? "Submitted" : "Pending"; }
function promptTypeLabel(type) { return type === "multi" ? "Choose one or more options" : type === "single" ? "Choose one option" : type === "input" ? "Enter a response" : "Review and respond"; }
function defaultPromptActions(type) { return [{ label: type === "input" ? "Submit" : "Submit", response: "submit", tone: "allow" }]; }

// ── Tool elements ───────────────────────
function createToolEl(part) {
  const el = document.createElement("div");
  el.className = "message assistant";
  el.innerHTML = `<div class="tool-part"><div class="tool-header">
    <span class="tool-icon">⚙</span><span class="tool-name">${escapeHtml(part.tool || "")}</span>
    <span class="tool-status running">running</span></div><div class="tool-body"></div></div>`;
  return el;
}
function updateToolEl(el, state) {
  const statusEl = el.querySelector(".tool-status");
  const bodyEl = el.querySelector(".tool-body");
  statusEl.textContent = state.status || "";
  statusEl.className = "tool-status " + (state.status || "pending");
  if (state.status === "running" && state.title) bodyEl.textContent = state.title;
  if (state.status === "completed") { bodyEl.innerHTML = `<pre>${escapeHtml(state.output || "")}</pre>`; bodyEl.classList.add("open"); }
  if (state.status === "error") { bodyEl.innerHTML = `<pre class="err">${escapeHtml(state.error || "")}</pre>`; bodyEl.classList.add("open"); }
}
function renderToolHtml(p) {
  const state = p.state || {};
  const open = (state.status === "completed" || state.status === "error") ? " open" : "";
  return `<div class="tool-part">
    <div class="tool-header" onclick="this.nextElementSibling.classList.toggle('open')">
      <span class="tool-icon">⚙</span><span class="tool-name">${escapeHtml(p.tool || "")}</span>
      <span class="tool-status ${state.status || ""}">${state.status || ""}</span>
    </div>
    <div class="tool-body${open}">${state.output ? `<pre>${escapeHtml(state.output)}</pre>` : ""}${state.error ? `<pre class="err">${escapeHtml(state.error)}</pre>` : ""}</div></div>`;
}

// ── Markdown ────────────────────────────
function renderMarkdown(text) {
  if (!text) return "";
  const blocks = [];
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code class="lang-${lang}">${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return `\x00B${blocks.length - 1}\x00`;
  });
  const openFence = text.match(/```(\w*)\n?([\s\S]*)$/);
  if (openFence) {
    const [, lang = "", code = ""] = openFence;
    blocks.push(`<pre><code class="lang-${lang}">${escapeHtml(code)}</code></pre>`);
    text = text.slice(0, openFence.index) + `\x00B${blocks.length - 1}\x00`;
  }
  const lines = text.split("\n");
  let out = "", inUl = false, inOl = false;
  for (let line of lines) {
    if (/^\x00B\d+\x00$/.test(line.trim())) {
      if (inUl) { out += "</ul>"; inUl = false; } if (inOl) { out += "</ol>"; inOl = false; }
      out += line.trim().replace(/\x00B(\d+)\x00/, (_, i) => blocks[+i]); continue;
    }
    let l = escapeHtml(line);
    l = l.replace(/`([^`]+)`/g, "<code>$1</code>");
    l = l.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
    l = l.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    l = l.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    l = l.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    if (/^-{3,}$/.test(l.trim())) { if (inUl) { out += "</ul>"; inUl = false; } if (inOl) { out += "</ol>"; inOl = false; } out += "<hr>"; continue; }
    if (/^### /.test(l)) { if(inUl){out+="</ul>";inUl=false;} if(inOl){out+="</ol>";inOl=false;} out += `<h3>${l.slice(4)}</h3>`; continue; }
    if (/^## /.test(l))  { if(inUl){out+="</ul>";inUl=false;} if(inOl){out+="</ol>";inOl=false;} out += `<h2>${l.slice(3)}</h2>`; continue; }
    if (/^# /.test(l))   { if(inUl){out+="</ul>";inUl=false;} if(inOl){out+="</ol>";inOl=false;} out += `<h1>${l.slice(2)}</h1>`; continue; }
    if (/^&gt; /.test(l)) { out += `<blockquote>${l.slice(5)}</blockquote>`; continue; }
    if (/^[-*] /.test(l)) { if (!inUl) { if(inOl){out+="</ol>";inOl=false;} out += "<ul>"; inUl = true; } out += `<li>${l.slice(2)}</li>`; continue; }
    if (/^\d+\. /.test(l)) { if (!inOl) { if(inUl){out+="</ul>";inUl=false;} out += "<ol>"; inOl = true; } out += `<li>${l.replace(/^\d+\. /, "")}</li>`; continue; }
    if (inUl) { out += "</ul>"; inUl = false; } if (inOl) { out += "</ol>"; inOl = false; }
    if (l.trim() === "") { out += "<br>"; continue; }
    out += l + "<br>";
  }
  if (inUl) out += "</ul>"; if (inOl) out += "</ol>";
  out = out.replace(/\x00B(\d+)\x00/g, (_, i) => blocks[+i]);
  return out;
}

// ── Providers ───────────────────────────
let modelUsage = {};
try { modelUsage = JSON.parse(localStorage.getItem("oc_model_usage") || "{}"); } catch { modelUsage = {}; }

function loadProviders() {
  if (authState !== "authenticated") return;
  apiFetch("/api/providers").then(r => r.json()).then(data => {
    const models = (data.models || []).filter(m => m.status !== "deprecated");
    const providers = data.providers || [];
    models.sort((a, b) => {
      const ua = modelUsage[`${a.providerID}/${a.modelID}`] || 0;
      const ub = modelUsage[`${b.providerID}/${b.modelID}`] || 0;
      if (ua !== ub) return ub - ua;
      if (a.providerID !== b.providerID) return a.providerID.localeCompare(b.providerID);
      return a.modelID.localeCompare(b.modelID);
    });
    modelSelect.innerHTML = '<option value="">Default</option>';
    let lastProvider = "", group = null;
    models.forEach(m => {
      if (m.providerID !== lastProvider) {
        const prov = providers.find(p => p.id === m.providerID);
        group = document.createElement("optgroup"); group.label = prov?.name || m.providerID;
        modelSelect.appendChild(group); lastProvider = m.providerID;
      }
      const o = document.createElement("option");
      o.value = `${m.providerID}/${m.modelID}`;
      const shortName = m.name.replace(/^OpenCode\s*/i, "").replace(/^Beeknoee\s*/i, "").replace(/^9Router\s*/i, "").replace(/^Ollama Local\s*/i, "") || m.modelID;
      o.textContent = `${shortName}${modelUsage[`${m.providerID}/${m.modelID}`] ? " ⭐" : ""}`;
      group.appendChild(o);
    });
    const saved = localStorage.getItem("oc_model");
    if (saved) modelSelect.value = saved;
    apiFetch("/api/config").then(r => r.json()).then(cfg => {
      if (cfg?.model && !localStorage.getItem("oc_model")) modelSelect.value = cfg.model;
      updateHeader();
    }).catch(() => {});
  }).catch(() => {});
}

modelSelect.addEventListener("change", () => {
  const val = modelSelect.value;
  localStorage.setItem("oc_model", val);
  if (currentSessionId) { sessionModels[currentSessionId] = val; saveSessionModels(); }
  if (val) { modelUsage[val] = (modelUsage[val] || 0) + 1; localStorage.setItem("oc_model_usage", JSON.stringify(modelUsage)); }
  updateHeader();
});

// ── Auth fetch helper ────────────────────
const apiFetch = (url, opts) => {
  const pwd = localStorage.getItem("oc_pass") || "";
  const headers = opts?.headers || {};
  if (pwd) headers["Authorization"] = `Bearer ${pwd}`;
  return fetch(url, { ...opts, headers });
};

// ── Login ────────────────────────────────
loginBtn.addEventListener("click", tryLogin);
loginPassword.addEventListener("keydown", e => { if (e.key === "Enter") tryLogin(); });
function tryLogin() {
  const pwd = loginPassword.value.trim(); if (!pwd) return;
  localStorage.setItem("oc_pass", pwd); setAuthState("authenticating");
  apiFetch("/api/health").then(r => {
    if (r.status === 401) { handleUnauthorized("Wrong password"); return; }
    connect();
  }).catch(() => { localStorage.removeItem("oc_pass"); setAuthState("unauthenticated", "Connection failed"); });
}

// ── Header ──────────────────────────────
const chatHeaderTitle = $("#chat-header-title");
const chatHeaderSub = $("#chat-header-sub");
function updateHeader() {
  const sesh = sessions.find(s => s.id === currentSessionId);
  const proj = projects.find(p => p.path === currentProjectPath);
  const projName = proj?.name || currentProjectPath?.split("/").pop() || "OpenCode";
  const sessTitle = sesh?.title || "";
  headerTitle.textContent = projName; headerSub.textContent = sessTitle;
  if (chatHeaderTitle) chatHeaderTitle.textContent = projName;
  if (chatHeaderSub) chatHeaderSub.textContent = sessTitle || "New session";
}

// ── Sidebar ─────────────────────────────
function openSidebar()  { sidebar.classList.remove("hidden"); sidebarOverlay.classList.remove("hidden"); }
function closeSidebar() { sidebar.classList.add("hidden"); sidebarOverlay.classList.add("hidden"); }
btnMenu.addEventListener("click", openSidebar);
btnCloseSidebar.addEventListener("click", closeSidebar);
sidebarOverlay.addEventListener("click", closeSidebar);
btnNewMobile.addEventListener("click", newSession);
btnNewSession.addEventListener("click", () => { newSession(); });
btnLogout.addEventListener("click", logout);

// ── Add project modal ───────────────────
let browseDir = "/home";
btnAddProj.addEventListener("click", () => {
  modalName.value = ""; modalPath.value = "";
  const defaultDir = currentProjectPath ? currentProjectPath.split("/").slice(0, -1).join("/") || "/home" : (projects[0]?.path?.split("/").slice(0, 3).join("/") || "/home");
  browseDir = defaultDir; modalOverlay.classList.remove("hidden"); loadBrowse(defaultDir);
});
modalCancel.addEventListener("click", () => modalOverlay.classList.add("hidden"));
modalOk.addEventListener("click", addProject);
modalPath.addEventListener("keydown", e => { if (e.key === "Enter") addProject(); });
function loadBrowse(dir) {
  browseDir = dir;
  browserPath.innerHTML = `<button class="browse-up" title="Up">←</button> <span class="browse-crumb">${escapeHtml(dir)}</span>`;
  modalPath.value = dir;
  apiFetch(`/api/browse?path=${encodeURIComponent(dir)}`).then(r => r.json()).then(data => {
    browserList.innerHTML = "";
    if (data.entries) data.entries.forEach(e => {
      const el = document.createElement("button"); el.className = "browse-item";
      el.textContent = `📁 ${e.name}`; el.addEventListener("click", () => loadBrowse(e.path));
      browserList.appendChild(el);
    });
  }).catch(() => {});
}
browserPath.addEventListener("click", e => { if (e.target.classList.contains("browse-up")) loadBrowse(browseDir.split("/").slice(0, -1).join("/") || "/"); });
function createFolder() {
  const name = browserMkdir.value.trim(); if (!name) return;
  apiFetch("/api/browse/mkdir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parent: browseDir, name }) })
    .then(r => r.json()).then(data => { if (data.ok) { browserMkdir.value = ""; loadBrowse(data.path); } else toast(data.error); }).catch(e => toast(e.message));
}
browserMkdirBtn.addEventListener("click", createFolder);
browserMkdir.addEventListener("keydown", e => { if (e.key === "Enter") createFolder(); });

// ── Input ───────────────────────────────
btnMode.addEventListener("click", () => {
  const m = btnMode.dataset.mode === "build" ? "plan" : "build";
  btnMode.dataset.mode = m; btnMode.textContent = m === "build" ? "Build" : "Plan"; btnMode.className = "btn-mode " + m;
});
btnSend.addEventListener("click", sendMessage);
btnAbort.addEventListener("click", abortSession);
msgInput.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
msgInput.addEventListener("input", () => { msgInput.style.height = "auto"; msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + "px"; });

// ── Scroll ──────────────────────────────
messagesDiv.addEventListener("scroll", updateAutoScrollLock);

let _tt;
function toast(msg) {
  toastEl.textContent = msg; toastEl.classList.add("show");
  clearTimeout(_tt); _tt = setTimeout(() => toastEl.classList.remove("show"), 2500);
}

// ── Helpers ─────────────────────────────
function escapeHtml(s) { if (!s) return ""; return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function isToday(d) { const n = new Date(); return d.getDate()===n.getDate() && d.getMonth()===n.getMonth() && d.getFullYear()===n.getFullYear(); }
function emptyStateHtml() {
  return `<div class="empty-state"><div class="logo">⬡</div><h2>OpenCode</h2>
    <p>Select a project from the sidebar,<br>then type a message to start.</p>
    <p class="hint">Shift+Enter for newline · messages queue while AI is running</p></div>`;
}
function unauthenticatedStateHtml() {
  return `<div class="empty-state"><div class="logo">⬡</div><h2>OpenCode</h2>
    <p>Sign in to load projects, sessions,<br>and start chatting.</p></div>`;
}

// ── Init ────────────────────────────────
resetAppUi();
if (localStorage.getItem("oc_pass")) connect();
else setAuthState("unauthenticated");
