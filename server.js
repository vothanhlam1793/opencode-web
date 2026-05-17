import { createOpencodeClient } from "@opencode-ai/sdk";
import express from "express";
import { WebSocketServer } from "ws";
import cors from "cors";
import crypto from "crypto";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const OPENCODE_URL = process.env.OPENCODE_URL || "http://localhost:4096";
const PROJECTS_FILE = path.join(__dirname, "projects.json");
const PASSWORD = process.env.OPCODE_PASSWORD || "";
const BROWSE_ROOT = process.env.BROWSE_ROOT || "/home";

// ── SQLite runtime DB ───────────────────
const db = new Database(path.join(__dirname, "runtime.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS session_status (
    session_id TEXT PRIMARY KEY,
    status     TEXT NOT NULL DEFAULT 'idle',
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session_prompts (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_prompts_session ON session_prompts(session_id);
`);

const stmts = {
  getStatus:    db.prepare("SELECT status FROM session_status WHERE session_id = ?"),
  setStatus:    db.prepare("INSERT OR REPLACE INTO session_status (session_id, status, updated_at) VALUES (?, ?, ?)"),
  delStatus:    db.prepare("DELETE FROM session_status WHERE session_id = ?"),
  getPrompts:   db.prepare("SELECT data FROM session_prompts WHERE session_id = ?"),
  getPrompt:    db.prepare("SELECT data FROM session_prompts WHERE id = ?"),
  upsertPrompt: db.prepare("INSERT OR REPLACE INTO session_prompts (id, session_id, data, updated_at) VALUES (?, ?, ?, ?)"),
  delPrompt:    db.prepare("DELETE FROM session_prompts WHERE id = ?"),
  delPrompts:   db.prepare("DELETE FROM session_prompts WHERE session_id = ?"),
};

function readProjects() {
  try { return JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf-8")); } catch { return []; }
}
function writeProjects(data) {
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(data, null, 2));
}

function assertUnderRoot(targetPath) {
  const resolved = path.resolve(targetPath);
  const root = path.resolve(BROWSE_ROOT);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    const err = new Error("Access denied: path outside allowed root");
    err.statusCode = 403;
    throw err;
  }
  return resolved;
}

const app = express();
app.use(cors());
app.use(express.json());

// Auth middleware for API routes
function safeCompare(a, b) {
  try {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
  } catch { return false; }
}

function authMiddleware(req, res, next) {
  if (!PASSWORD) return next(); // no password set = open access
  const auth = req.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : (req.query.pwd || "");
  if (token && safeCompare(token, PASSWORD)) return next();
  res.status(401).json({ error: "unauthorized" });
}
app.use("/api", authMiddleware);

app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const client = createOpencodeClient({ baseUrl: OPENCODE_URL });
const wsClients = new Map();

// ── Session runtime helpers (SQLite-backed) ─────────────────
function getSessionStatus(sessionID) {
  const row = stmts.getStatus.get(sessionID);
  return row?.status || "idle";
}

function setSessionStatus(sessionID, status) {
  stmts.setStatus.run(sessionID, status, Date.now());
}

function promptStatusLabel(status) {
  if (status === "allow" || status === "allowed" || status === "granted") return "allowed";
  if (status === "deny" || status === "denied" || status === "rejected") return "denied";
  if (status === "submitted") return "submitted";
  return "pending";
}

function upsertPrompt(prompt) {
  if (!prompt?.id || !prompt?.sessionID) return null;
  const existingRow = stmts.getPrompt.get(prompt.id);
  const existing = existingRow ? JSON.parse(existingRow.data) : {};
  const next = {
    kind: "permission",
    type: "single",
    title: "Permission Required",
    description: "",
    detail: "",
    actions: [],
    ...existing,
    ...prompt,
    status: promptStatusLabel(prompt.status || existing.status),
    createdAt: existing.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  stmts.upsertPrompt.run(next.id, next.sessionID, JSON.stringify(next), Date.now());
  return next;
}

function removePrompt(sessionID, promptID) {
  stmts.delPrompt.run(promptID);
}

function getSessionPrompts(sessionID) {
  return stmts.getPrompts.all(sessionID).map(r => JSON.parse(r.data));
}

function cleanupSession(sessionID) {
  stmts.delStatus.run(sessionID);
  stmts.delPrompts.run(sessionID);
}

function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const [, ws] of wsClients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

function broadcastPrompt(prompt, eventType = "prompt.updated") {
  if (!prompt) return;
  broadcast({
    type: "event",
    data: {
      type: eventType,
      properties: { prompt },
    },
  });
}

function broadcastSessionStatus(sessionID, status) {
  broadcast({
    type: "event",
    data: {
      type: "session.status",
      properties: { sessionID, status: { type: status } },
    },
  });
}

async function forwardEvents() {
  while (true) {
    try {
      console.log("[SSE] Connecting to opencode event stream...");
      const res = await fetch(`${OPENCODE_URL}/event`);
      if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`);
      
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      console.log("[SSE] Stream ready");
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));
            const p = event.properties || {};

            // Track session busy/idle status → persist to SQLite
            if (event.type === "session.status") {
              const { sessionID, status } = p;
              if (sessionID && status?.type) {
                const prev = getSessionStatus(sessionID);
                setSessionStatus(sessionID, status.type);
                // Only re-broadcast if status changed (avoid flood)
                if (prev !== status.type) {
                  broadcastSessionStatus(sessionID, status.type);
                }
              }
              continue; // skip default broadcast below — already done above
            }

            if (event.type === "session.idle") {
              const { sessionID } = p;
              if (sessionID) {
                setSessionStatus(sessionID, "idle");
                // Let the event flow through for frontend finishResponse()
              }
            }

            if (event.type === "permission.updated") {
              const prompt = upsertPrompt({
                id: p.id,
                sessionID: p.sessionID,
                kind: "permission",
                type: "single",
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
              if (prompt) {
                event.properties.prompt = prompt;
                if (prompt.status === "allowed" || prompt.status === "denied") {
                  removePrompt(prompt.sessionID, prompt.id);
                }
              }
            }

            broadcast({ type: "event", data: event });
          } catch {}
        }
      }
    } catch (e) {
      console.error("[SSE] Error:", e.message);
    }
    console.log("[SSE] Reconnecting in 3s...");
    await new Promise(r => setTimeout(r, 3000));
  }
}

setTimeout(forwardEvents, 1000);

wss.on("connection", (ws, req) => {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);

  if (PASSWORD) {
    ws.authed = false;
    const authTimer = setTimeout(() => {
      if (!ws.authed) { ws.send(JSON.stringify({ type: "error", error: "Auth required" })); ws.close(); }
    }, 5000);

    ws.on("message", (raw) => {
      if (!ws.authed) {
        try {
          const m = JSON.parse(raw.toString());
          if (m.type === "auth" && m.password === PASSWORD) {
            ws.authed = true;
            clearTimeout(authTimer);
            registerClient(ws, id);
            return;
          }
        } catch {}
        ws.send(JSON.stringify({ type: "error", error: "Invalid password" }));
        ws.close(4001, "auth failed");
        return;
      }
      handleMessage(ws, raw);
    });
  } else {
    registerClient(ws, id);
    ws.on("message", (raw) => handleMessage(ws, raw));
  }
});

function registerClient(ws, id) {
  wsClients.set(id, ws);
  console.log(`[WS] Client connected (total: ${wsClients.size})`);
  ws.send(JSON.stringify({ type: "connected", id }));
  ws.on("close", () => wsClients.delete(id));
}

async function handleMessage(ws, raw) {
  try {
    const msg = JSON.parse(raw.toString());
    await handleWsMessage(ws, msg);
  } catch (e) {
    ws.send(JSON.stringify({ type: "error", error: e.message }));
  }
}

async function handleWsMessage(ws, msg) {
  const { action, sessionId, text, model, agent, directory } = msg;

  if (action === "send") {
    let sid = sessionId;
    if (!sid) {
      const createOpts = { body: { title: text?.slice(0, 60) || "New chat" } };
      if (directory) createOpts.query = { directory };
      const r = await client.session.create(createOpts);
      sid = r.data.id;
      ws.send(JSON.stringify({ type: "session_created", session: r.data }));
    }

    const body = {
      parts: [{ type: "text", text }],
    };
    if (model) body.model = model;
    if (agent) body.agent = agent;

    try {
      await client.session.promptAsync({
        path: { id: sid },
        body,
      });
      // Response sẽ đến qua SSE events (message.part.delta, session.idle, ...)
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", error: e.message, sessionId: sid }));
    }
  }

  if (action === "abort") {
    if (sessionId) {
      await client.session.abort({ path: { id: sessionId } });
      ws.send(JSON.stringify({ type: "aborted", sessionId }));
    }
  }

  if (action === "respond_permission") {
    const { permissionId, sessionID, response, remember } = msg;
    if (permissionId && sessionID) {
      await respondToPermission({ permissionId, sessionID, response, remember });
    }
  }
}

async function respondToPermission({ permissionId, sessionID, response, remember }) {
  const prompt = upsertPrompt({
    id: permissionId,
    sessionID,
    status: "submitted",
    response: response || "allow",
    remember: !!remember,
  });
  broadcastPrompt(prompt);
  try {
    await client.postSessionIdPermissionsPermissionId({
      path: { id: sessionID, permissionID: permissionId },
      body: { response: response || "allow", remember: !!remember },
    });
    return { ok: true };
  } catch (e) {
    const rollback = upsertPrompt({
      id: permissionId,
      sessionID,
      status: "pending",
      error: e.message,
      response: undefined,
      remember: undefined,
    });
    broadcastPrompt(rollback);
    throw e;
  }
}

// REST API
app.get("/api/health", async (_req, res) => {
  try {
    const r = await fetch(`${OPENCODE_URL}/global/health`);
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/sessions", async (req, res) => {
  try {
    const opts = {};
    const dir = req.query.directory;
    if (dir) opts.query = { directory: dir };
    const r = await client.session.list(opts);
    res.json(r.data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/sessions", async (req, res) => {
  try {
    const r = await client.session.create({ body: req.body });
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/sessions/:id", async (req, res) => {
  try {
    await client.session.delete({ path: { id: req.params.id } });
    cleanupSession(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/sessions/:id/messages", async (req, res) => {
  try {
    const r = await client.session.messages({ path: { id: req.params.id } });
    res.json(r.data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/sessions/:id/state", (req, res) => {
  const id = req.params.id;
  const status = getSessionStatus(id);
  const prompts = getSessionPrompts(id);
  res.json({ status, prompts });
});

app.post("/api/sessions/:id/prompts/:promptId/respond", async (req, res) => {
  try {
    const { response, remember } = req.body || {};
    await respondToPermission({
      permissionId: req.params.promptId,
      sessionID: req.params.id,
      response,
      remember,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/sessions/:id/prompt", async (req, res) => {
  try {
    const { text, model, agent } = req.body;
    const body = { parts: [{ type: "text", text }] };
    if (model) body.model = model;
    if (agent) body.agent = agent;

    const r = await client.session.prompt({
      path: { id: req.params.id },
      body,
    });
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/providers", async (_req, res) => {
  try {
    const r = await client.config.providers();
    const providers = r.data?.providers || [];
    const models = [];
    for (const p of providers) {
      for (const [mid, m] of Object.entries(p.models || {})) {
        models.push({
          id: `${p.id}/${mid}`,
          providerID: p.id,
          modelID: mid,
          name: m.name || mid,
          status: m.status,
          limit: m.limit,
        });
      }
    }
    res.json({ providers: providers.map(p => ({ id: p.id, name: p.name })), models });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/agents", async (_req, res) => {
  try {
    const r = await client.app.agents();
    res.json(r.data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/config", async (_req, res) => {
  try {
    const r = await client.config.get();
    res.json(r.data || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Projects CRUD (server-side storage, shared across devices)
app.get("/api/projects", (_req, res) => res.json(readProjects()));

app.post("/api/projects", (req, res) => {
  const { path: p, name } = req.body;
  if (!p || !name) return res.status(400).json({ error: "path and name required" });
  let prjs = readProjects();
  if (prjs.find(x => x.path === p)) return res.status(409).json({ error: "already exists" });
  prjs.push({ path: p, name });
  writeProjects(prjs);
  res.json({ ok: true });
});

app.delete("/api/projects", (req, res) => {
  const p = req.query.path;
  if (!p) return res.status(400).json({ error: "path required" });
  let prjs = readProjects();
  prjs = prjs.filter(x => x.path !== p);
  writeProjects(prjs);
  res.json({ ok: true });
});

app.get("/api/browse", (req, res) => {
  try {
    const dir = assertUnderRoot(req.query.path || BROWSE_ROOT);
    const entries = [];
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      if (name.isDirectory() && !name.name.startsWith(".")) {
        try {
          fs.accessSync(path.join(dir, name.name), fs.constants.R_OK);
          entries.push({ name: name.name, path: path.join(dir, name.name) });
        } catch {}
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ path: dir, entries, parent: path.dirname(dir) });
  } catch (e) {
    const code = e.statusCode || 403;
    res.status(code).json({ error: e.message });
  }
});

app.post("/api/browse/mkdir", (req, res) => {
  try {
    const { parent, name } = req.body;
    if (!parent || !name) return res.status(400).json({ error: "parent and name required" });
    const safe = name.replace(/[^a-zA-Z0-9\-_.]/g, "");
    if (!safe || safe !== name) return res.status(400).json({ error: "invalid folder name" });
    const full = assertUnderRoot(path.join(parent, safe));
    fs.mkdirSync(full, { recursive: true });
    res.json({ ok: true, path: full });
  } catch (e) {
    const code = e.statusCode || 500;
    res.status(code).json({ error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Wrapper running at http://localhost:${PORT}`);
  console.log(`📡 Connected to opencode at ${OPENCODE_URL}`);
});
