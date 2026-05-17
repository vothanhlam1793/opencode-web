/* ─────────────────────────────────────────
   OpenCode Web – app.js v5
   Features:
   · Project rail (sidebar left panel)
   · Session list per project (sidebar right panel)
   · Model selector + Plan/Build toggle in toolbar
   · Queue: can type next message while AI is running
   · Stop button only shows when actually streaming
   · Message metadata: model, mode, duration, tokens, cost
───────────────────────────────────────── */

const $ = (s) => document.querySelector(s);

// ── State ──────────────────────────────
let ws, wsReady = false;
let currentSessionId = null;
let currentProjectPath = null;   // path of selected project
let isBusy = false;              // AI is processing
let currentMsgEl = null;         // assistant bubble being streamed
let partialText = "";
let currentToolEls = {};
let sessions = [];               // sessions loaded via API (filtered by project)
let unseenSessions = new Set();  // session IDs with unread updates
let msgQueue = [];               // queued messages while busy
let streamStarted = false;       // first token received
let authState = "unauthenticated";
let reconnectTimer = null;
let reconnectCount = 0;
const MAX_RECONNECT = 10;
const RECONNECT_BASE_DELAY = 2000;
let autoScrollLocked = false;
let promptCards = new Map();
let questionCards = new Map();

const AUTO_SCROLL_THRESHOLD = 96;

// Projects fetched from server (stored in projects.json)
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
  isBusy = false;
  currentMsgEl = null;
  partialText = "";
  currentToolEls = {};
  sessions = [];
  projects = [];
  unseenSessions.clear();
  msgQueue = [];
  streamStarted = false;
  autoScrollLocked = false;
  promptCards = new Map();
  questionCards = new Map();
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
  setBusy(false);
}

function isNearBottom() {
  const distance = messagesDiv.scrollHeight - messagesDiv.scrollTop - messagesDiv.clientHeight;
  return distance <= AUTO_SCROLL_THRESHOLD;
}

function updateAutoScrollLock() {
  autoScrollLocked = !isNearBottom();
}

function scrollBottom(force = false) {
  if (!force && autoScrollLocked) return;
  requestAnimationFrame(() => {
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    autoScrollLocked = false;
  });
}

function maybeScrollBottom() {
  scrollBottom(false);
}

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
    if (errorText) {
      loginErr.style.display = "block";
      loginErr.textContent = errorText;
    } else {
      loginErr.style.display = "none";
      loginErr.textContent = "";
    }
    if (state === "unauthenticated") {
      loginPassword.focus();
    }
  }
  setConnStatus(state === "authenticated" ? "connected" : state === "authenticating" ? "authenticating" : "locked");
}

function loadInitialData() {
  loadProviders();
  loadProjects();
}

function handleUnauthorized(errorText = "Wrong password") {
  localStorage.removeItem("oc_pass");
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    ws.close();
  }
  wsReady = false;
  resetAppState();
  resetAppUi();
  setAuthState("unauthenticated", errorText);
}

function logout() {
  handleUnauthorized("");
  closeSidebar();
}

// ── Projects ───────────────────────────
function loadProjects() {
  if (authState !== "authenticated") return;
  apiFetch("/api/projects").then(r => r.json()).then(data => {
    projects = Array.isArray(data) ? data : [];
    renderProjRail();
    const savedProj = localStorage.getItem("oc_project");
    if (savedProj && projects.find(p => p.path === savedProj)) {
      selectProject(savedProj, false);
    } else if (projects.length) {
      selectProject(projects[0].path, false);
    }
    loadSessions();
  }).catch(() => {});
}

function saveProjects() {
  // Không cần - server tự lưu
}

function addProject() {
  if (authState !== "authenticated") return;
  const projPath = modalPath.value.trim();
  if (!projPath) { toast("Select a path"); return; }
  const name = modalName.value.trim() || projPath.split("/").pop() || projPath;

  apiFetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: projPath, name }),
  }).then(r => r.json()).then(data => {
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
  apiFetch(`/api/projects?path=${encodeURIComponent(projPath)}`, { method: "DELETE" })
    .then(r => r.json()).then(() => {
      projects = projects.filter(p => p.path !== projPath);
      if (currentProjectPath === projPath) {
        currentSessionId = null;
        messagesDiv.innerHTML = emptyStateHtml();
      }
      renderProjRail();
      if (projects.length && currentProjectPath === projPath) {
        selectProject(projects[0].path);
      }
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

function projInitial(name) {
  return name.trim().slice(0, 2).toUpperCase() || "?";
}

function selectProject(path, renderSessions = true) {
  currentProjectPath = path;
  localStorage.setItem("oc_project", path);
  renderProjRail();
  const proj = projects.find(p => p.path === path);
  sessProjName.textContent = proj?.name || path.split("/").pop() || path;
  sessProjPath.textContent = path;

  if (!renderSessions) return;

  // Clear current chat & reload sessions for this project
  if (!isBusy) {
    currentSessionId = null;
    messagesDiv.innerHTML = emptyStateHtml();
    autoScrollLocked = false;
  }
  loadSessions();
}

// ── WebSocket ──────────────────────────
function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  setAuthState("authenticating");
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const pwd = localStorage.getItem("oc_pass") || "";
    if (pwd) {
      ws.send(JSON.stringify({ type: "auth", password: pwd }));
    } else {
      wsReady = true;
    }
  };

  ws.onclose = (e) => {
    wsReady = false;
    btnSend.disabled = true;
    if (isBusy) { isBusy = false; streamStarted = false; setBusy(false); }
    if (e.code === 4001) {
      handleUnauthorized("Wrong password");
      return;
    }
    if (authState === "authenticated" || authState === "authenticating") {
      if (reconnectCount >= MAX_RECONNECT) {
        setAuthState("unauthenticated", "Cannot connect to server. Please refresh the page.");
        reconnectCount = 0;
        return;
      }
      const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(1.5, reconnectCount), 30000);
      reconnectCount++;
      setAuthState("authenticating");
      reconnectTimer = setTimeout(connect, delay);
    }
  };

  ws.onerror = () => setConnStatus("error");

  ws.onmessage = (e) => {
    try { dispatch(JSON.parse(e.data)); } catch {}
  };
}

function setConnStatus(s) {
  statusDot.className = `dot-${s}`;
  statusDot.title = s;
  connBadge.className = `badge ${s}`;
  connBadge.textContent = s === "connected"
    ? "Connected"
    : s === "error"
      ? "Error"
      : s === "authenticating"
        ? "Authenticating"
        : s === "locked"
          ? "Locked"
          : "Connecting";
}

// ── Dispatcher ─────────────────────────
function dispatch(msg) {
  switch (msg.type) {
    case "connected":
      wsReady = true;
      reconnectCount = 0;
      setAuthState("authenticated");
      btnSend.disabled = false;
      loadInitialData();
      break;
    case "session_created": onSessionCreated(msg.session); break;
    case "error":           onServerError(msg); break;
    case "question_answered": {
      // Question answer submitted — card stays, awaiting tool completion
      toast("Answer sent");
      break;
    }
    case "aborted":
      isBusy = false; streamStarted = false;
      setBusy(false);
      toast("Stopped");
      drainQueue();
      break;
    case "event": onEvent(msg.data); break;
  }
}

function onSessionCreated(session) {
  currentSessionId = session.id;
  if (!sessions.find(s => s.id === session.id)) {
    sessions.push(session);
  } else {
    const idx = sessions.findIndex(s => s.id === session.id);
    if (idx >= 0) sessions[idx] = session;
  }
  sessions.sort((a, b) => sessionSortValue(b) - sessionSortValue(a));
  renderSessionList();
  updateHeader();
}

function onEvent(evt) {
  const p = evt.properties || {};

  switch (evt.type) {

    case "message.part.delta": {
      if (p.sessionID !== currentSessionId) break;
      if (!streamStarted) { streamStarted = true; removeSpinner(); ensureAssistantBubble(); }
      if (p.field === "text" && p.delta) {
        partialText += p.delta;
        getMsgContent(currentMsgEl).innerHTML = renderMarkdown(partialText);
        maybeScrollBottom();
      }
      break;
    }

    case "message.part.updated": {
      if (p.part?.sessionID !== currentSessionId) break;
      const part = p.part;

      if (part.type === "text") {
        if (!streamStarted) { streamStarted = true; removeSpinner(); ensureAssistantBubble(); }
        if (typeof p.delta === "string") {
          partialText += p.delta;
        } else if (typeof part.text === "string") {
          partialText = part.text;
        }
        getMsgContent(currentMsgEl).innerHTML = renderMarkdown(partialText);
        maybeScrollBottom();
      }

      if (part.type === "tool") {
        const cid = part.callID;
        if (!currentToolEls[cid]) {
          currentToolEls[cid] = createToolEl(part);
          // Insert before spinner if any
          const sp = messagesDiv.querySelector(".spinner");
          sp ? messagesDiv.insertBefore(currentToolEls[cid], sp) : messagesDiv.appendChild(currentToolEls[cid]);
        }
        updateToolEl(currentToolEls[cid], part.state || {});
        maybeScrollBottom();
      }

      if (part.type === "reasoning" && currentMsgEl) {
        const box = getMsgContent(currentMsgEl);
        let rb = box.querySelector(".reasoning-block");
        if (!rb) { rb = document.createElement("div"); rb.className = "reasoning-block"; box.prepend(rb); }
        rb.textContent = part.text;
      }

      if (part.type === "step-start") {
        ensureAssistantBubble();
        const box = getMsgContent(currentMsgEl);
        let stepBar = box.querySelector(`[data-step]`);
        // Start new step bar — anchors at current position
        stepBar = document.createElement("div");
        stepBar.className = "step-bar";
        stepBar.dataset.step = "open";
        stepBar.innerHTML = `<span class="step-bar-dot"></span><span class="step-bar-label">Working…</span>`;
        box.appendChild(stepBar);
        maybeScrollBottom();
      }

      if (part.type === "step-finish") {
        const box = getMsgContent(currentMsgEl);
        // Find last open step bar and mark it done
        const openBars = box.querySelectorAll(`.step-bar[data-step="open"]`);
        if (openBars.length) {
          const lastBar = openBars[openBars.length - 1];
          lastBar.dataset.step = "done";
          const reason = part.reason === "stop" ? "Done" : part.reason === "tool-calls" ? "More…" : part.reason || "";
          const tok = part.tokens?.total ? `· ${part.tokens.total.toLocaleString()} tok` : "";
          const cst = (Number.isFinite(part.cost) && part.cost > 0) ? `· $${part.cost.toFixed(4)}` : "";
          lastBar.querySelector(".step-bar-label").textContent = [reason, tok, cst].filter(Boolean).join(" ");
        }
        maybeScrollBottom();
      }

      if (part.type === "tool" && part.tool === "question") {
        // Question tool — show interactive prompt card inline
        onQuestionTool(part);
      }

      if (!["text", "tool", "reasoning", "step-start", "step-finish"].includes(part.type)) {
        ensureAssistantBubble();
        const box = getMsgContent(currentMsgEl);
        const unknownKey = String(part.id || part.type || "unknown");
        let unknownEl = box.querySelector(`[data-unknown-part="${CSS.escape(unknownKey)}"]`);
        if (!unknownEl) {
          unknownEl = document.createElement("div");
          unknownEl.className = "unknown-part";
          unknownEl.dataset.unknownPart = unknownKey;
          box.appendChild(unknownEl);
        }
        unknownEl.innerHTML =
          `<div class="unknown-part-head">
            <span class="unknown-part-label">Live Block</span>
            <span class="unknown-part-type">${escapeHtml(part.type || "unknown")}</span>
          </div>
          <pre>${escapeHtml(partToPreview(part))}</pre>`;
        maybeScrollBottom();
      }
      break;
    }

    case "session.status": {
      if (p.status?.type === "busy") {
        if (p.sessionID !== currentSessionId) {
          unseenSessions.add(p.sessionID);
          renderSessionList();
        } else if (!isBusy) {
          isBusy = true; setBusy(true);
        }
      } else if (p.status?.type === "idle" && p.sessionID === currentSessionId) {
        finishResponse();
      }
      break;
    }

    case "session.idle": {
      if (p.sessionID === currentSessionId) {
        finishResponse();
      } else {
        unseenSessions.add(p.sessionID);
        renderSessionList();
      }
      break;
    }

    case "message.updated": {
      // Update cost/token in meta after completion
      if (p.info?.sessionID !== currentSessionId || p.info?.role !== "assistant") break;
      if (currentMsgEl) updateMsgMeta(currentMsgEl, p.info);
      break;
    }

    case "session.created":
    case "session.updated":
    case "session.deleted":
      loadSessions();
      break;

    case "session.diff":
    case "server.heartbeat":
    case "todo.updated":
      break;

    case "permission.updated": {
      onPromptEvent(p.prompt || {
        kind: "permission",
        id: p.id,
        sessionID: p.sessionID,
        title: "Permission Required",
        description: p.tool || "unknown",
        detail: p.arguments || "",
        status: p.status || "pending",
        actions: [
          { label: "Deny", response: "deny", tone: "deny" },
          { label: "Allow Once", response: "allow", tone: "allow" },
          { label: "Always Allow", response: "allow", remember: true, tone: "always" },
        ],
      });
      break;
    }

    case "prompt.updated": {
      onPromptEvent(p.prompt);
      break;
    }
  }
}

function finishResponse() {
  removeSpinner();
  if (currentMsgEl) {
    // Final render
    getMsgContent(currentMsgEl).innerHTML = renderMarkdown(partialText);
  }
  currentMsgEl   = null;
  partialText    = "";
  currentToolEls = {};
  isBusy         = false;
  streamStarted  = false;
  setBusy(false);
  maybeScrollBottom();
  drainQueue();
}

function onServerError(msg) {
  removeSpinner();
  if (currentMsgEl) {
    getMsgContent(currentMsgEl).insertAdjacentHTML("beforeend",
      `<div class="msg-error">⚠ ${escapeHtml(msg.error || "Unknown error")}</div>`);
    currentMsgEl = null;
  }
  partialText = ""; currentToolEls = {};
  isBusy = false; streamStarted = false;
  setBusy(false);
  toast("Error: " + (msg.error || "failed").slice(0, 60));
  drainQueue();
}

// ── Queue ──────────────────────────────
function drainQueue() {
  if (msgQueue.length && wsReady && !isBusy) {
    const next = msgQueue.shift();
    updateQueueNotice();
    doSend(next.text, next.model, next.agent, next.directory, next.sessionId);
  }
}

function updateQueueNotice() {
  const el = messagesDiv.querySelector(".msg-queue-notice");
  if (el) {
    if (msgQueue.length) el.textContent = `${msgQueue.length} message${msgQueue.length>1?"s":""} queued`;
    else el.remove();
  }
}

// ── Busy / UI state ───────────────────
function setBusy(busy) {
  // Stop button shows only when actually streaming or waiting
  btnAbort.classList.toggle("hidden", !busy);
  btnSend.classList.toggle("hidden", busy);
  // Input stays enabled (for queue)
  if (busy) addSpinner();
  else removeSpinner();
}

function addSpinner() {
  if (messagesDiv.querySelector(".spinner")) return;
  const el = document.createElement("div");
  el.className = "spinner";
  el.innerHTML = "<span></span><span></span><span></span>";
  messagesDiv.appendChild(el);
  maybeScrollBottom();
}

function removeSpinner() {
  messagesDiv.querySelector(".spinner")?.remove();
}

function ensureAssistantBubble() {
  if (currentMsgEl) return;
  currentMsgEl = document.createElement("div");
  currentMsgEl.className = "message assistant";
  const model = modelSelect.value || "default";
  currentMsgEl.innerHTML = `
    <div class="msg-meta">
      <span class="model-tag">${escapeHtml(model.split("/").pop() || model)}</span>
      <span class="time-tag" data-start="${Date.now()}"></span>
      <span class="cost-tag"></span>
    </div>
    <div class="msg-content"></div>`;
  const sp = messagesDiv.querySelector(".spinner");
  sp ? messagesDiv.insertBefore(currentMsgEl, sp) : messagesDiv.appendChild(currentMsgEl);
  // Tick elapsed time
  startElapsedTimer(currentMsgEl);
  maybeScrollBottom();
}

function getMsgContent(el) { return el.querySelector(".msg-content"); }

function startElapsedTimer(msgEl) {
  const timeEl = msgEl.querySelector(".time-tag");
  if (!timeEl) return;
  const start = Number(timeEl.dataset.start);
  if (!Number.isFinite(start)) {
    timeEl.textContent = "";
    return;
  }
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
    if (Number.isFinite(created) && Number.isFinite(completed) && completed >= created) {
      const dur = ((completed - created) / 1000).toFixed(1);
      timeEl.textContent = `${dur}s`;
    } else {
      timeEl.textContent = "";
    }
  }
  if (costEl) {
    const inp  = Number.isFinite(info.tokens?.input) ? info.tokens.input : 0;
    const out  = Number.isFinite(info.tokens?.output) ? info.tokens.output : 0;
    const tok  = (inp || out) ? `${inp.toLocaleString()}+${out.toLocaleString()} tok` : "";
    const cost = (Number.isFinite(info.cost) && info.cost > 0) ? `$${info.cost.toFixed(4)}` : "";
    costEl.textContent = [tok, cost].filter(Boolean).join(" · ");
  }
}

// ── Send ───────────────────────────────
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

  if (isBusy) {
    // Queue it
    msgQueue.push({ text, model, agent, directory, sessionId: currentSessionId });
    // Show queue notice
    let notice = messagesDiv.querySelector(".msg-queue-notice");
    if (!notice) {
      notice = document.createElement("div");
      notice.className = "msg-queue-notice";
      messagesDiv.appendChild(notice);
    }
    notice.textContent = `${msgQueue.length} message${msgQueue.length>1?"s":""} queued`;
    scrollBottom(true);
    return;
  }

  doSend(text, model, agent, directory, currentSessionId);
}

function doSend(text, model, agent, directory, sessionId) {
  if (!currentSessionId && !sessionId) messagesDiv.innerHTML = "";
  partialText    = "";
  currentToolEls = {};
  currentMsgEl   = null;
  streamStarted  = false;
  isBusy = true;
  autoScrollLocked = false;
  setBusy(true);
  ws.send(JSON.stringify({ action: "send", sessionId: sessionId || currentSessionId, text, model, agent, directory }));
}

function abortSession() {
  if (currentSessionId && isBusy) {
    msgQueue = []; // clear queue too
    updateQueueNotice();
    ws.send(JSON.stringify({ action: "abort", sessionId: currentSessionId }));
  }
}

function addUserBubble(text) {
  const el = document.createElement("div");
  el.className = "message user";
  el.innerHTML = `<div class="msg-content">${escapeHtml(text)}</div>`;
  messagesDiv.appendChild(el);
  scrollBottom(true);
}

// ── Sessions ───────────────────────────
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
      if (target) {
        currentSessionId = target;
        localStorage.setItem("oc_session", target);
        renderSessionList();
        loadMessages(target);
      }
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
    const date   = new Date(s.time?.updated || s.time?.created || 0);
    const timeStr = isToday(date)
      ? date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
      : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });

    const li = document.createElement("li");
    li.className = "session-item" + (active ? " active" : "") + (unseen ? " unseen" : "");
    li.dataset.id = s.id;
    li.innerHTML = `
      <div class="sess-dot"></div>
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
  currentSessionId = id;
  localStorage.setItem("oc_session", id);
  unseenSessions.delete(id);
  renderSessionList();
  updateHeader();
  if (fetchMessages) loadMessages(id);
}

function loadMessages(id) {
  if (authState !== "authenticated") return;
  autoScrollLocked = false;
  promptCards = new Map();
  questionCards = new Map();
  messagesDiv.innerHTML = `<div class="load-hist"><span></span><span></span><span></span></div>`;
  Promise.all([
    apiFetch(`/api/sessions/${id}/messages`).then(r => r.json()),
    apiFetch(`/api/sessions/${id}/state`).then(r => r.json()).catch(() => ({ status: "idle", prompts: [] })),
  ]).then(([data, runtime]) => {
    messagesDiv.innerHTML = "";
    if (Array.isArray(data) && data.length) {
      data.forEach(item => renderMessage(item.info || item, item.parts || []));
    } else if (runtime.status !== "busy") {
      messagesDiv.innerHTML = emptyStateHtml();
    }

    // Rehydrate busy/idle state từ server
    if (runtime.status === "busy" && !isBusy) {
      isBusy = true;
      streamStarted = false;
      currentMsgEl = null;
      partialText = "";
      currentToolEls = {};
      setBusy(true);
    } else if (runtime.status !== "busy" && isBusy) {
      // session đã idle nhưng client còn đang hiển thị busy → reset
      isBusy = false;
      streamStarted = false;
      setBusy(false);
    }

    // Rehydrate prompt pending cards
    for (const prompt of runtime?.prompts || []) onPromptEvent(prompt);
    scrollBottom(true);
  }).catch(() => { messagesDiv.innerHTML = emptyStateHtml(); });
}

function renderMessage(msg, parts) {
  const el = document.createElement("div");
  el.className = `message ${msg.role}`;

  if (msg.role === "user") {
    let text = "";
    for (const p of parts) if (p.type === "text") text += escapeHtml(p.text);
    el.innerHTML = `<div class="msg-content">${text}</div>`;
  } else {
    const created   = Number(msg.time?.created);
    const completed = Number(msg.time?.completed);
    const dur  = (Number.isFinite(created) && Number.isFinite(completed) && completed >= created)
      ? `${((completed - created) / 1000).toFixed(1)}s`
      : "";
    const inp  = Number.isFinite(msg.tokens?.input) ? msg.tokens.input : 0;
    const out  = Number.isFinite(msg.tokens?.output) ? msg.tokens.output : 0;
    const tok  = (inp || out) ? `${inp.toLocaleString()}+${out.toLocaleString()} tok` : "";
    const cost = (Number.isFinite(msg.cost) && msg.cost > 0) ? `$${msg.cost.toFixed(4)}` : "";
    const model = msg.modelID ? msg.modelID.split("/").pop() : "";
    const mode  = msg.mode || msg.agent || "build";

    el.innerHTML = `<div class="msg-meta">
      ${model ? `<span class="model-tag">${escapeHtml(model)}</span>` : ""}
      <span class="mode-tag ${mode}">${mode}</span>
      ${dur  ? `<span class="time-tag">${dur}</span>` : ""}
      <span class="cost-tag">${[tok, cost].filter(Boolean).join(" · ")}</span>
    </div>`;

    const content = document.createElement("div");
    content.className = "msg-content";
    let html = "";
    for (const p of parts) {
      if (p.type === "step-start") {
        html += `<div class="step-bar" data-step="open">
          <span class="step-bar-dot"></span><span class="step-bar-label">Working…</span>
        </div>`;
      } else if (p.type === "step-finish") {
        html += `<div class="step-bar" data-step="done">
          <span class="step-bar-dot"></span><span class="step-bar-label">${stepFinishLabel(p)}</span>
        </div>`;
      } else if (p.type === "text") {
        html += renderMarkdown(p.text);
      } else if (p.type === "reasoning") {
        html += `<div class="reasoning-block">${escapeHtml(p.text)}</div>`;
      } else if (p.type === "tool") {
        if (p.tool === "question") {
          html += renderQuestionToolHtml(p);
        } else {
          html += renderToolHtml(p);
        }
      } else {
        html += renderUnknownPartHtml(p);
      }
    }
    content.innerHTML = html;
    el.appendChild(content);
  }
  messagesDiv.appendChild(el);
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
      <div>
        <div class="prompt-card-title">${escapeHtml(q.question || "Question")}</div>
        ${q.header ? `<div class="prompt-card-subtitle">${escapeHtml(q.header)}</div>` : ""}
      </div>
      <span class="prompt-card-status ${isResolved ? "allowed" : "pending"}">${isResolved ? "Answered" : "Awaiting"}</span>
    </div>
    <div class="prompt-card-options">
      ${(q.options || []).map((opt, idx) => `
        <label class="prompt-option ${isResolved ? "disabled" : ""}">
          <input type="${q.multiple ? 'checkbox' : 'radio'}" disabled ${isResolved ? "" : ""} value="${idx}">
          <span>${escapeHtml(opt.label)}</span>
          ${opt.description ? `<small>${escapeHtml(opt.description)}</small>` : ""}
        </label>`).join("")}
    </div>
  </div>`;
}

function renderUnknownPartHtml(part) {
  const type = part?.type || "unknown";
  const preview = partToPreview(part);
  const key = escapeHtml(part?.id || type);
  return `<div class="unknown-part" data-unknown-part="${key}">
    <div class="unknown-part-head">
      <span class="unknown-part-label">Live Block</span>
      <span class="unknown-part-type">${escapeHtml(type)}</span>
    </div>
    <pre>${escapeHtml(preview)}</pre>
  </div>`;
}

function partToPreview(part) {
  if (!part) return "";
  if (typeof part.text === "string" && part.text.trim()) return part.text;
  if (typeof part.arguments === "string" && part.arguments.trim()) return part.arguments;
  if (typeof part.output === "string" && part.output.trim()) return part.output;
  if (typeof part.value === "string" && part.value.trim()) return part.value;
  try {
    return JSON.stringify(part, null, 2);
  } catch {
    return String(part);
  }
}

function deleteSession(id) {
  if (authState !== "authenticated") return;
  if (!confirm("Delete this session?")) return;
  apiFetch(`/api/sessions/${id}`, { method: "DELETE" }).then(() => {
    sessions = sessions.filter(s => s.id !== id);
    if (currentSessionId === id) {
      currentSessionId = null;
      messagesDiv.innerHTML = emptyStateHtml();
      localStorage.removeItem("oc_session");
    }
    renderSessionList();
    updateHeader();
  });
}

function newSession() {
  if (authState !== "authenticated") return;
  currentSessionId = null;
  localStorage.removeItem("oc_session");
  msgQueue = [];
  autoScrollLocked = false;
  messagesDiv.innerHTML = emptyStateHtml();
  renderSessionList();
  updateHeader();
  msgInput.focus();
  closeSidebar();
}

function onPromptEvent(prompt) {
  if (!prompt?.id || !prompt?.sessionID) return;

  if (prompt.sessionID !== currentSessionId) {
    unseenSessions.add(prompt.sessionID);
    renderSessionList();
    return;
  }

  let card = promptCards.get(prompt.id);
  if (!card) {
    card = createPromptCard(prompt);
    promptCards.set(prompt.id, card);
    const spinner = messagesDiv.querySelector(".spinner");
    spinner ? messagesDiv.insertBefore(card, spinner) : messagesDiv.appendChild(card);
  }

  updatePromptCard(card, prompt);
  if (normalizePromptStatus(prompt.status) !== "pending") {
    promptCards.delete(prompt.id);
  }
  maybeScrollBottom();
}

// ── Question tool handler (AI asks user a question inline) ──

function onQuestionTool(part) {
  const qid = part.id || part.callID;
  if (!qid || part.sessionID !== currentSessionId) return;

  const questions = part.state?.input?.questions || [];
  if (!questions.length) return;

  const existingCard = questionCards.get(qid);

  if (part.state?.status === "completed") {
    // Question was answered — show resolved state
    if (existingCard) {
      const card = existingCard.querySelector(".prompt-card");
      const statusEl = existingCard.querySelector(".prompt-card-status");
      card.classList.add("submitted");
      statusEl.textContent = "Answered";
      statusEl.className = "prompt-card-status allowed";
      existingCard.querySelectorAll(".prompt-action").forEach(b => { b.disabled = true; });
    }
    return;
  }

  // Show active question card
  if (!existingCard) {
    const el = document.createElement("div");
    el.className = "message assistant";
    el.dataset.questionId = qid;
    el.innerHTML = `<div class="prompt-card question">
      <div class="prompt-card-head">
        <div>
          <div class="prompt-card-title">${escapeHtml(questions[0]?.question || "Question")}</div>
          <div class="prompt-card-subtitle">AI needs your input to continue</div>
        </div>
        <span class="prompt-card-status pending">Awaiting</span>
      </div>
      <div class="prompt-card-options"></div>
      <div class="prompt-card-actions"></div>
    </div>`;
    questionCards.set(qid, el);

    const spinner = messagesDiv.querySelector(".spinner");
    spinner ? messagesDiv.insertBefore(el, spinner) : messagesDiv.appendChild(el);

    const optionsEl = el.querySelector(".prompt-card-options");
    const q = questions[0];
    optionsEl.innerHTML = (q.options || []).map((option, idx) => `
      <label class="prompt-option">
        <input type="${q.multiple ? 'checkbox' : 'radio'}" name="q-${CSS.escape(qid)}" value="${idx}">
        <span>${escapeHtml(option.label)}</span>
        ${option.description ? `<small>${escapeHtml(option.description)}</small>` : ""}
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

  card.classList.add("submitting");
  statusEl.textContent = "Sending…";
  el.querySelectorAll(".prompt-action").forEach(btn => { btn.disabled = true; });

  ws.send(JSON.stringify({
    action: "answer_question",
    callID: part.callID,
    sessionID: part.sessionID,
    answers: selected,
  }));
}

function createPromptCard(prompt) {
  const el = document.createElement("div");
  el.className = "message assistant";
  el.dataset.promptId = prompt.id;
  el.innerHTML = `
    <div class="prompt-card ${escapeHtml(prompt.kind || "question")}">
      <div class="prompt-card-head">
        <div>
          <div class="prompt-card-title"></div>
          <div class="prompt-card-subtitle"></div>
        </div>
        <span class="prompt-card-status pending">Pending</span>
      </div>
      <div class="prompt-card-detail"></div>
      <div class="prompt-card-input hidden"></div>
      <div class="prompt-card-options hidden"></div>
      <div class="prompt-card-actions"></div>
    </div>`;
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
    moreBtn.className = "detail-expand-btn";
    moreBtn.textContent = ` … show full (${fullDetail.length} chars)`;
    moreBtn.addEventListener("click", () => {
      detailEl.textContent = fullDetail;
      moreBtn.remove();
    });
    detailEl.appendChild(moreBtn);
  } else {
    detailEl.textContent = fullDetail;
  }

  inputEl.classList.toggle("hidden", promptType !== "input");
  optionsEl.classList.toggle("hidden", promptType === "input");

  if (promptType === "input") {
    inputEl.innerHTML = `<input class="prompt-text-input" type="text" placeholder="Type your answer...">`;
  } else if (prompt.options?.length) {
    optionsEl.innerHTML = prompt.options.map((option, index) => `
      <label class="prompt-option">
        <input type="${prompt.multiple ? "checkbox" : "radio"}" name="prompt-${escapeHtml(prompt.id)}" value="${index}">
        <span>${escapeHtml(option.label)}</span>
      </label>`).join("");
  } else {
    optionsEl.innerHTML = "";
  }

  actionsEl.innerHTML = "";
  const isResolved = status !== "pending";
  (prompt.actions || defaultPromptActions(promptType)).forEach(action => {
    const btn = document.createElement("button");
    btn.className = `prompt-action ${action.tone || "default"}`;
    btn.textContent = action.label;
    btn.disabled = isResolved;
    btn.addEventListener("click", () => submitPromptResponse(prompt, action, el));
    actionsEl.appendChild(btn);
  });
}

function submitPromptResponse(prompt, action, el) {
  const card = el.querySelector(".prompt-card");
  const statusEl = el.querySelector(".prompt-card-status");
  const payload = {
    response: action.response,
    remember: !!action.remember,
  };

  if (prompt.type === "input") {
    payload.value = el.querySelector(".prompt-text-input")?.value?.trim() || "";
  }

  if (prompt.options?.length) {
    const selected = Array.from(el.querySelectorAll(".prompt-card-options input:checked")).map(input => {
      const option = prompt.options[Number(input.value)];
      return option?.value ?? option?.label;
    }).filter(Boolean);
    payload.answers = prompt.multiple ? selected : selected[0] || "";
  }

  card.classList.add("submitting");
  statusEl.textContent = "Submitting...";
  el.querySelectorAll(".prompt-action").forEach(btn => { btn.disabled = true; });

  if (prompt.kind === "permission") {
    apiFetch(`/api/sessions/${encodeURIComponent(prompt.sessionID)}/prompts/${encodeURIComponent(prompt.id)}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(async r => {
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.error || "Failed to submit response");
      }
    }).catch(err => {
      card.classList.remove("submitting");
      statusEl.textContent = "Pending";
      statusEl.className = "prompt-card-status pending";
      el.querySelectorAll(".prompt-action").forEach(btn => { btn.disabled = false; });
      toast(err.message);
    });
    return;
  }

  ws.send(JSON.stringify({
    action: "respond_permission",
    permissionId: prompt.id,
    sessionID: prompt.sessionID,
    ...payload,
  }));
}

function normalizePromptStatus(status) {
  if (status === "granted" || status === "allow" || status === "allowed") return "allowed";
  if (status === "deny" || status === "denied" || status === "rejected") return "denied";
  if (status === "submitted") return "submitted";
  return "pending";
}

function promptStatusLabel(status) {
  if (status === "allowed") return "Allowed";
  if (status === "denied") return "Denied";
  if (status === "submitted") return "Submitted";
  return "Pending";
}

function promptTypeLabel(type) {
  if (type === "multi") return "Choose one or more options";
  if (type === "single") return "Choose one option";
  if (type === "input") return "Enter a response";
  return "Review and respond";
}

function defaultPromptActions(type) {
  if (type === "input") return [{ label: "Submit", response: "submit", tone: "allow" }];
  if (type === "multi" || type === "single") return [{ label: "Submit", response: "submit", tone: "allow" }];
  return [{ label: "Submit", response: "submit", tone: "allow" }];
}

// ── Tool elements ──────────────────────
function createToolEl(part) {
  const el = document.createElement("div");
  el.className = "message assistant";
  el.innerHTML = `<div class="tool-part">
    <div class="tool-header">
      <span class="tool-icon">⚙</span>
      <span class="tool-name">${escapeHtml(part.tool || "")}</span>
      <span class="tool-status running">running</span>
    </div>
    <div class="tool-body"></div>
  </div>`;
  return el;
}

function updateToolEl(el, state) {
  const statusEl = el.querySelector(".tool-status");
  const bodyEl   = el.querySelector(".tool-body");
  statusEl.textContent = state.status || "";
  statusEl.className   = "tool-status " + (state.status || "pending");
  if (state.status === "running" && state.title) bodyEl.textContent = state.title;
  if (state.status === "completed") {
    bodyEl.innerHTML = `<pre>${escapeHtml(state.output || "")}</pre>`;
    bodyEl.classList.add("open");
  }
  if (state.status === "error") {
    bodyEl.innerHTML = `<pre class="err">${escapeHtml(state.error || "")}</pre>`;
    bodyEl.classList.add("open");
  }
}

function renderToolHtml(p) {
  const state = p.state || {};
  const open  = (state.status === "completed" || state.status === "error") ? " open" : "";
  return `<div class="tool-part">
    <div class="tool-header" onclick="this.nextElementSibling.classList.toggle('open')">
      <span class="tool-icon">⚙</span>
      <span class="tool-name">${escapeHtml(p.tool || "")}</span>
      <span class="tool-status ${state.status || ""}">${state.status || ""}</span>
    </div>
    <div class="tool-body${open}">
      ${state.output ? `<pre>${escapeHtml(state.output)}</pre>` : ""}
      ${state.error  ? `<pre class="err">${escapeHtml(state.error)}</pre>` : ""}
    </div>
  </div>`;
}

// ── Markdown ───────────────────────────
function renderMarkdown(text) {
  if (!text) return "";
  // Extract code blocks first
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

  // Process line by line
  const lines = text.split("\n");
  let out = "", inUl = false, inOl = false;

  for (let line of lines) {
    // Code block placeholders
    if (/^\x00B\d+\x00$/.test(line.trim())) {
      if (inUl) { out += "</ul>"; inUl = false; }
      if (inOl) { out += "</ol>"; inOl = false; }
      out += line.trim().replace(/\x00B(\d+)\x00/, (_, i) => blocks[+i]);
      continue;
    }
    let l = escapeHtml(line);
    // Inline code
    l = l.replace(/`([^`]+)`/g, "<code>$1</code>");
    // Bold / italic
    l = l.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
    l = l.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    l = l.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    // Links
    l = l.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    // Horizontal rule
    if (/^-{3,}$/.test(l.trim())) {
      if (inUl) { out += "</ul>"; inUl = false; }
      if (inOl) { out += "</ol>"; inOl = false; }
      out += "<hr>"; continue;
    }
    // Headings
    if (/^### /.test(l)) { if(inUl){out+="</ul>";inUl=false;} out += `<h3>${l.slice(4)}</h3>`; continue; }
    if (/^## /.test(l))  { if(inUl){out+="</ul>";inUl=false;} out += `<h2>${l.slice(3)}</h2>`; continue; }
    if (/^# /.test(l))   { if(inUl){out+="</ul>";inUl=false;} out += `<h1>${l.slice(2)}</h1>`; continue; }
    // Blockquote
    if (/^&gt; /.test(l)) { out += `<blockquote>${l.slice(5)}</blockquote>`; continue; }
    // Unordered list
    if (/^[-*] /.test(l)) {
      if (!inUl) { if(inOl){out+="</ol>";inOl=false;} out += "<ul>"; inUl = true; }
      out += `<li>${l.slice(2)}</li>`; continue;
    }
    // Ordered list
    if (/^\d+\. /.test(l)) {
      if (!inOl) { if(inUl){out+="</ul>";inUl=false;} out += "<ol>"; inOl = true; }
      out += `<li>${l.replace(/^\d+\. /, "")}</li>`; continue;
    }
    if (inUl) { out += "</ul>"; inUl = false; }
    if (inOl) { out += "</ol>"; inOl = false; }
    // Empty line = paragraph break
    if (l.trim() === "") { out += "<br>"; continue; }
    out += l + "<br>";
  }
  if (inUl) out += "</ul>";
  if (inOl) out += "</ol>";
  // Restore code block placeholders outside lines
  out = out.replace(/\x00B(\d+)\x00/g, (_, i) => blocks[+i]);
  return out;
}

// ── Providers ──────────────────────────
let modelUsage = {};
try { modelUsage = JSON.parse(localStorage.getItem("oc_model_usage") || "{}"); } catch { modelUsage = {}; }

function loadProviders() {
  if (authState !== "authenticated") return;
  apiFetch("/api/providers").then(r => r.json()).then(data => {
    const models = (data.models || []).filter(m => m.status !== "deprecated");
    const providers = data.providers || [];

    // Sort: frequently used first, then by provider, then name
    models.sort((a, b) => {
      const ua = modelUsage[`${a.providerID}/${a.modelID}`] || 0;
      const ub = modelUsage[`${b.providerID}/${b.modelID}`] || 0;
      if (ua !== ub) return ub - ua;                     // nhiều usage lên đầu
      if (a.providerID !== b.providerID) return a.providerID.localeCompare(b.providerID);
      return a.modelID.localeCompare(b.modelID);
    });

    modelSelect.innerHTML = '<option value="">Default</option>';

    // Tạo optgroup cho từng provider
    let lastProvider = "";
    let group = null;
    models.forEach(m => {
      if (m.providerID !== lastProvider) {
        const prov = providers.find(p => p.id === m.providerID);
        group = document.createElement("optgroup");
        group.label = prov?.name || m.providerID;
        modelSelect.appendChild(group);
        lastProvider = m.providerID;
      }
      const o = document.createElement("option");
      o.value = `${m.providerID}/${m.modelID}`;
      // Tên model rút gọn: bỏ prefix provider nếu có
      const shortName = m.name
        .replace(/^OpenCode\s*/i, "")
        .replace(/^Beeknoee\s*/i, "")
        .replace(/^9Router\s*/i, "")
        .replace(/^Ollama Local\s*/i, "") || m.modelID;
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
  // Track usage
  if (val) {
    modelUsage[val] = (modelUsage[val] || 0) + 1;
    localStorage.setItem("oc_model_usage", JSON.stringify(modelUsage));
  }
  updateHeader();
});

// ── Auth fetch helper ───────────────────
const apiFetch = (url, opts) => {
  const pwd = localStorage.getItem("oc_pass") || "";
  const headers = opts?.headers || {};
  if (pwd) headers["Authorization"] = `Bearer ${pwd}`;
  return fetch(url, { ...opts, headers });
};

// ── Login ───────────────────────────────
loginBtn.addEventListener("click", tryLogin);
loginPassword.addEventListener("keydown", e => { if (e.key === "Enter") tryLogin(); });

function tryLogin() {
  const pwd = loginPassword.value.trim();
  if (!pwd) return;
  localStorage.setItem("oc_pass", pwd);
  setAuthState("authenticating");
  // Test auth via health endpoint
  apiFetch("/api/health").then(r => {
    if (r.status === 401) {
      handleUnauthorized("Wrong password");
      return;
    }
    connect();
  }).catch(() => {
    localStorage.removeItem("oc_pass");
    setAuthState("unauthenticated", "Connection failed");
  });
}

// ── Header ─────────────────────────────
const chatHeaderTitle = $("#chat-header-title");
const chatHeaderSub   = $("#chat-header-sub");

function updateHeader() {
  const sesh = sessions.find(s => s.id === currentSessionId);
  const proj = projects.find(p => p.path === currentProjectPath);
  const projName = proj?.name || currentProjectPath?.split("/").pop() || "OpenCode";
  const sessTitle = sesh?.title || "";

  // Mobile topbar
  headerTitle.textContent = projName;
  headerSub.textContent   = sessTitle;

  // Chat area header bar
  if (chatHeaderTitle) chatHeaderTitle.textContent = projName;
  if (chatHeaderSub)   chatHeaderSub.textContent   = sessTitle || "New session";
}

// ── Sidebar ────────────────────────────
function openSidebar()  {
  sidebar.classList.remove("hidden");
  sidebarOverlay.classList.remove("hidden");
}
function closeSidebar() {
  sidebar.classList.add("hidden");
  sidebarOverlay.classList.add("hidden");
}
btnMenu.addEventListener("click", openSidebar);
btnCloseSidebar.addEventListener("click", closeSidebar);
sidebarOverlay.addEventListener("click", closeSidebar);
btnNewMobile.addEventListener("click", newSession);
btnNewSession.addEventListener("click", () => { newSession(); });
btnLogout.addEventListener("click", logout);

// ── Add project modal ──────────────────
let browseDir = "/home";

btnAddProj.addEventListener("click", () => {
  modalName.value = ""; modalPath.value = "";
  const defaultDir = currentProjectPath
    ? currentProjectPath.split("/").slice(0, -1).join("/") || "/home"
    : (projects[0]?.path?.split("/").slice(0, 3).join("/") || "/home");
  browseDir = defaultDir;
  modalOverlay.classList.remove("hidden");
  loadBrowse(defaultDir);
});
modalCancel.addEventListener("click", () => modalOverlay.classList.add("hidden"));
modalOk.addEventListener("click", addProject);
modalPath.addEventListener("keydown", e => { if (e.key === "Enter") addProject(); });

function loadBrowse(dir) {
  browseDir = dir;
  browserPath.innerHTML = `<button class="browse-up" title="Up">←</button> <span class="browse-crumb">${escapeHtml(dir)}</span>`;
  modalPath.value = dir;

  apiFetch(`/api/browse?path=${encodeURIComponent(dir)}`)
    .then(r => r.json())
    .then(data => {
      browserList.innerHTML = "";
      if (data.entries) {
        data.entries.forEach(e => {
          const el = document.createElement("button");
          el.className = "browse-item";
          el.textContent = `📁 ${e.name}`;
          el.addEventListener("click", () => loadBrowse(e.path));
          browserList.appendChild(el);
        });
      }
    })
    .catch(() => {});
}

browserPath.addEventListener("click", e => {
  if (e.target.classList.contains("browse-up")) {
    loadBrowse(browseDir.split("/").slice(0, -1).join("/") || "/");
  }
});

function createFolder() {
  const name = browserMkdir.value.trim();
  if (!name) return;
  apiFetch("/api/browse/mkdir", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parent: browseDir, name }),
  }).then(r => r.json()).then(data => {
    if (data.ok) { browserMkdir.value = ""; loadBrowse(data.path); }
    else toast(data.error);
  }).catch(e => toast(e.message));
}
browserMkdirBtn.addEventListener("click", createFolder);
browserMkdir.addEventListener("keydown", e => { if (e.key === "Enter") createFolder(); });

// ── Input ──────────────────────────────
btnMode.addEventListener("click", () => {
  const m = btnMode.dataset.mode === "build" ? "plan" : "build";
  btnMode.dataset.mode = m;
  btnMode.textContent = m === "build" ? "Build" : "Plan";
  btnMode.className = "btn-mode " + m;
});
btnSend.addEventListener("click", sendMessage);
btnAbort.addEventListener("click", abortSession);
msgInput.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
msgInput.addEventListener("input", () => {
  msgInput.style.height = "auto";
  msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + "px";
});

// ── Scroll ─────────────────────────────
messagesDiv.addEventListener("scroll", updateAutoScrollLock);

let _tt;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(_tt);
  _tt = setTimeout(() => toastEl.classList.remove("show"), 2500);
}

// ── Helpers ────────────────────────────
function escapeHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function isToday(d) {
  const n = new Date();
  return d.getDate()===n.getDate() && d.getMonth()===n.getMonth() && d.getFullYear()===n.getFullYear();
}
function emptyStateHtml() {
  return `<div class="empty-state">
    <div class="logo">⬡</div>
    <h2>OpenCode</h2>
    <p>Select a project from the sidebar,<br>then type a message to start.</p>
    <p class="hint">Shift+Enter for newline · messages queue while AI is running</p>
  </div>`;
}

function unauthenticatedStateHtml() {
  return `<div class="empty-state">
    <div class="logo">⬡</div>
    <h2>OpenCode</h2>
    <p>Sign in to load projects, sessions,<br>and start chatting.</p>
  </div>`;
}

// ── Init ───────────────────────────────
resetAppUi();
if (localStorage.getItem("oc_pass")) {
  connect();
} else {
  setAuthState("unauthenticated");
}
