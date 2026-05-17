# Báo cáo lỗi & yêu cầu sửa — OpenCode Web Wrapper

**Ngày:** 2026-05-17  
**Reviewer:** OpenCode AI  
**Codebase:** `/home/leco/wrapper`  
**Files liên quan:** `server.js`, `public/app.js`, `public/index.html`, `public/style.css`

---

## Phân loại mức độ

| Ký hiệu | Ý nghĩa |
|---------|---------|
| 🔴 HIGH | Bug gây mất chức năng hoặc lỗ hổng bảo mật rõ ràng |
| 🟡 MEDIUM | Hành vi sai, UX xấu, hoặc tiềm năng gây lỗi khi scale |
| 🟢 LOW | Code smell, maintainability, thiếu sót nhỏ |

---

## 🔴 BUG #1 — Frontend gửi sai action name qua WebSocket (non-permission prompt)

**File:** `public/app.js`  
**Dòng:** 1019–1024  

### Mô tả

Trong hàm `submitPromptResponse()`, khi prompt **không phải** loại `permission` (ví dụ `input`, `single`, `multi`), frontend gửi WebSocket message với `action: "respond_prompt"`:

```js
// public/app.js:1019-1024
ws.send(JSON.stringify({
  action: "respond_prompt",   // ← SAI
  promptId: prompt.id,
  sessionID: prompt.sessionID,
  ...payload,
}));
```

Trong khi đó, backend (`server.js`) chỉ handle các action sau trong `handleWsMessage()`:

```js
// server.js:220, 247, 254
if (action === "send") { ... }
if (action === "abort") { ... }
if (action === "respond_permission") { ... }   // ← tên khác hoàn toàn
```

Không có handler nào cho `"respond_prompt"`. Message bị **bỏ qua hoàn toàn**, không có error response, user bấm Submit nhưng không có gì xảy ra.

### Cách fix

**Phương án A (đơn giản):** Đổi action name ở frontend cho khớp với backend:

```js
// public/app.js:1019
ws.send(JSON.stringify({
  action: "respond_permission",   // ← đổi thành tên đúng
  permissionId: prompt.id,        // ← backend đọc field này
  sessionID: prompt.sessionID,
  ...payload,
}));
```

**Phương án B (tốt hơn):** Thống nhất dùng REST API cho tất cả loại prompt response (giống như đang làm cho `permission`), thay vì dùng WebSocket. Tức là gọi `POST /api/sessions/:id/prompts/:promptId/respond` cho mọi trường hợp — xóa nhánh `ws.send` ở cuối `submitPromptResponse()`.

---

## 🔴 BUG #2 — `outerHTML` assignment làm mất DOM reference, gây duplicate unknown block

**File:** `public/app.js`  
**Dòng:** 426–432  

### Mô tả

Khi nhận được `message.part.updated` với một part type chưa biết, code tìm node hiện có rồi gán `outerHTML`:

```js
// public/app.js:426-432
let unknownEl = box.querySelector(`[data-unknown-part="${CSS.escape(unknownKey)}"]`);
if (!unknownEl) {
  unknownEl = document.createElement("div");
  unknownEl.dataset.unknownPart = unknownKey;
  box.appendChild(unknownEl);
}
unknownEl.outerHTML = renderUnknownPartHtml(part);   // ← BUG
```

Khi gán `element.outerHTML = ...`, trình duyệt **replace** node đó trong DOM bằng HTML mới. Sau lệnh này, biến `unknownEl` vẫn trỏ vào **node cũ đã bị tách khỏi DOM**. Node mới trong DOM **không có** `data-unknown-part` attribute (vì `renderUnknownPartHtml` tạo HTML string với attribute đó, nhưng `unknownEl` variable không được reassign).

Lần event tiếp theo, `box.querySelector(...)` lại không tìm thấy node → tạo node mới → **append thêm**, tạo ra block trùng lặp.

### Cách fix

Thay bằng `innerHTML` trên wrapper div, hoặc dùng `insertAdjacentHTML` + reassign:

```js
// public/app.js — thay đoạn 426-433
let unknownEl = box.querySelector(`[data-unknown-part="${CSS.escape(unknownKey)}"]`);
if (!unknownEl) {
  unknownEl = document.createElement("div");
  unknownEl.dataset.unknownPart = unknownKey;
  box.appendChild(unknownEl);
}
// Cập nhật nội dung bên trong, không thay node
unknownEl.className = "unknown-part";
unknownEl.innerHTML = `
  <div class="unknown-part-head">
    <span class="unknown-part-label">Live Block</span>
    <span class="unknown-part-type">${escapeHtml(part?.type || "unknown")}</span>
  </div>
  <pre>${escapeHtml(partToPreview(part))}</pre>`;
maybeScrollBottom();
```

---

## 🔴 BUG #3 — Indentation sai gây `onEvent` bị định nghĩa lồng trong `onSessionCreated`

**File:** `public/app.js`  
**Dòng:** 357–373  

### Mô tả

```js
// public/app.js:357-373
function onSessionCreated(session) {
  currentSessionId = session.id;
  if (!sessions.find(s => s.id === session.id)) {
    sessions.push(session);
  } else {
    const idx = sessions.findIndex(s => s.id === session.id);
    if (idx >= 0) sessions[idx] = session;
  }
    sessions.sort(...);     // ← indent lạc 4 spaces
    renderSessionList();    // ← indent lạc
    updateHeader();         // ← indent lạc
  }                         // ← đóng onSessionCreated ở đây
  
  function onEvent(evt) {  // ← function này nằm NGOÀI onSessionCreated về mặt scope
  const p = evt.properties || {};  // ← nhưng indent như thể nằm trong
```

Về mặt cú pháp JavaScript, hàm `onEvent` **không** bị nhốt trong `onSessionCreated` (do dấu `}` trước nó đóng đúng). Tuy nhiên indent sai gây **hiểu nhầm nghiêm trọng** khi đọc code và có thể khiến dev sau vô tình sửa sai.

Ngoài ra, 3 dòng `sessions.sort`, `renderSessionList()`, `updateHeader()` bị indent lạc vào trong nhánh `else` về mặt nhìn, trong khi thực tế chúng nằm ngoài — đây là logic có thể dẫn đến **thiếu sort/render** nếu sau này ai đó tái cấu trúc dựa theo indent.

### Cách fix

```js
// public/app.js — fix indent
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
  // ...
}
```

---

## 🟡 BUG #4 — Reconnect loop vô hạn khi mất kết nối trong lúc đang authenticate

**File:** `public/app.js`  
**Dòng:** 300–311  

### Mô tả

```js
// public/app.js:300-311
ws.onclose = (e) => {
  wsReady = false;
  btnSend.disabled = true;
  if (isBusy) { isBusy = false; streamStarted = false; setBusy(false); }
  if (e.code === 4001) {
    handleUnauthorized("Wrong password");
    return;
  }
  if (authState === "authenticated" || authState === "authenticating") {
    setAuthState("authenticating");
    reconnectTimer = setTimeout(connect, 2000);   // ← reconnect sau 2s, không có giới hạn
  }
};
```

Nếu server không phản hồi (down, network lỗi), app sẽ reconnect vô hạn, không bao giờ dừng, không thông báo rõ cho user. Không có backoff, không có max retry count.

### Cách fix

Thêm biến đếm retry và exponential backoff:

```js
// public/app.js — thêm vào phần State
let reconnectCount = 0;
const MAX_RECONNECT = 10;
const BASE_RECONNECT_DELAY = 2000;

// Trong ws.onclose:
if (authState === "authenticated" || authState === "authenticating") {
  if (reconnectCount >= MAX_RECONNECT) {
    setAuthState("unauthenticated", "Cannot connect to server. Please refresh.");
    reconnectCount = 0;
    return;
  }
  const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(1.5, reconnectCount), 30000);
  reconnectCount++;
  setAuthState("authenticating");
  reconnectTimer = setTimeout(connect, delay);
}

// Khi kết nối thành công (trong dispatch case "connected"):
reconnectCount = 0;
```

---

## 🟡 BUG #5 — `/api/browse` không giới hạn vùng filesystem, lộ cấu trúc server

**File:** `server.js`  
**Dòng:** 442–458  

### Mô tả

```js
// server.js:442-458
app.get("/api/browse", (req, res) => {
  const dir = req.query.path || "/home";   // ← nhận path bất kỳ từ client
  // ...
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    // liệt kê thư mục
  }
});
```

User đã authenticated có thể duyệt **toàn bộ filesystem** bằng cách gửi `?path=/etc`, `?path=/root`, `?path=/`, v.v. Không có restriction nào về vùng được phép.

Endpoint `mkdir` cũng không có restriction:

```js
// server.js:461-473
app.post("/api/browse/mkdir", (req, res) => {
  const full = path.join(parent, safe);
  fs.mkdirSync(full, { recursive: true });   // ← tạo thư mục bất kỳ trên server
});
```

### Cách fix

Thêm biến `BROWSE_ROOT` và validate path trước khi thao tác:

```js
// server.js — thêm vào phần config
const BROWSE_ROOT = process.env.BROWSE_ROOT || "/home";

// Helper validate path
function assertUnderRoot(targetPath) {
  const resolved = path.resolve(targetPath);
  const root = path.resolve(BROWSE_ROOT);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error("Access denied: path outside allowed root");
  }
  return resolved;
}

// Áp dụng vào /api/browse:
app.get("/api/browse", (req, res) => {
  try {
    const dir = assertUnderRoot(req.query.path || BROWSE_ROOT);
    // ... phần còn lại giữ nguyên
  } catch (e) {
    res.status(403).json({ error: e.message });
  }
});

// Áp dụng vào /api/browse/mkdir:
app.post("/api/browse/mkdir", (req, res) => {
  try {
    const full = assertUnderRoot(path.join(req.body.parent, safe));
    fs.mkdirSync(full, { recursive: true });
    // ...
  } catch (e) {
    res.status(403).json({ error: e.message });
  }
});
```

---

## 🟡 BUG #6 — Hardcode đường dẫn `/home/leco` trong frontend

**File:** `public/app.js`  
**Dòng:** 1296, 1300, 1302  

### Mô tả

```js
// public/app.js:1296
let browseDir = "/home/leco";

// public/app.js:1299-1302
btnAddProj.addEventListener("click", () => {
  // ...
  browseDir = "/home/leco";
  loadBrowse("/home/leco");
});
```

Đường dẫn `/home/leco` cứng trong client-side code. Nếu deploy trên server khác user, hoặc trên Windows/Mac, browser file picker sẽ không hoạt động đúng.

### Cách fix

**Phương án A:** Thêm endpoint `GET /api/browse/root` trả về thư mục gốc cho phép browse (lấy từ env `BROWSE_ROOT`), frontend gọi endpoint này khi mở modal.

**Phương án B (nhanh hơn):** Lấy root từ project đầu tiên hoặc `currentProjectPath` thay vì hardcode:

```js
// public/app.js:1299-1302
btnAddProj.addEventListener("click", () => {
  modalName.value = ""; modalPath.value = "";
  const defaultDir = currentProjectPath
    ? currentProjectPath.split("/").slice(0, -1).join("/") || "/home"
    : (projects[0]?.path?.split("/").slice(0, 3).join("/") || "/home");
  browseDir = defaultDir;
  modalOverlay.classList.remove("hidden");
  loadBrowse(defaultDir);
});
```

---

## 🟡 BUG #7 — Session bị xóa không cleanup `sessionRuntime` tương ứng

**File:** `server.js`  
**Dòng:** 322–329  

### Mô tả

```js
// server.js:322-329
app.delete("/api/sessions/:id", async (req, res) => {
  try {
    await client.session.delete({ path: { id: req.params.id } });
    res.json({ ok: true });
    // ← THIẾU: sessionRuntime.delete(req.params.id)
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

`sessionRuntime` Map lưu prompt state theo `sessionID`. Khi session bị xóa, entry trong `sessionRuntime` **không được xóa theo**. Entry này chỉ tự cleanup khi `prompts` của nó rỗng (xảy ra khi prompt được resolve). Nếu session bị xóa khi còn prompt pending, entry tồn tại mãi trong memory.

Dùng lâu trên server chạy liên tục (production), Map này sẽ tích tụ garbage.

### Cách fix

```js
// server.js:322-329
app.delete("/api/sessions/:id", async (req, res) => {
  try {
    await client.session.delete({ path: { id: req.params.id } });
    sessionRuntime.delete(req.params.id);   // ← thêm dòng này
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

---

## 🟡 BUG #8 — Password so sánh dễ bị timing attack

**File:** `server.js`  
**Dòng:** 31–32  

### Mô tả

```js
// server.js:31-32
if (auth && auth === `Bearer ${PASSWORD}`) return next();
if (req.query.pwd === PASSWORD) return next();
```

So sánh chuỗi bằng `===` trong JavaScript không có độ trễ hằng số — trình duyệt/engine có thể thoát vòng lặp so sánh ngay khi gặp ký tự khác nhau đầu tiên. Điều này mở ra khả năng **timing attack** để đoán password từng ký tự.

Nguy cơ thấp nếu chỉ dùng nội bộ LAN, nhưng nếu expose qua Internet thì đáng fix.

### Cách fix

```js
// server.js — thêm import ở đầu file
import crypto from "crypto";

// Thay hàm authMiddleware
function authMiddleware(req, res, next) {
  if (!PASSWORD) return next();
  const auth = req.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : (req.query.pwd || "");
  if (!token) return res.status(401).json({ error: "unauthorized" });
  try {
    const a = Buffer.from(token.padEnd(64));
    const b = Buffer.from(PASSWORD.padEnd(64));
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  } catch {}
  res.status(401).json({ error: "unauthorized" });
}
```

---

## 🟢 BUG #9 — Prompt detail bị truncate cứng 600 ký tự, mất context quan trọng

**File:** `public/app.js`  
**Dòng:** 946  

### Mô tả

```js
// public/app.js:946
detailEl.textContent = String(prompt.detail || "").slice(0, 600);
```

Khi tool call có arguments dài (ví dụ: nội dung file cần ghi, câu lệnh bash phức tạp), user chỉ thấy 600 ký tự đầu và **không có dấu hiệu nào** cho biết nội dung bị cắt. User có thể bấm "Allow" mà không thấy đủ thông tin để quyết định.

### Cách fix

Hiển thị đầy đủ kèm nút collapse/expand nếu dài:

```js
// public/app.js:946
const fullDetail = String(prompt.detail || "");
const TRUNCATE_AT = 600;
if (fullDetail.length > TRUNCATE_AT) {
  detailEl.textContent = fullDetail.slice(0, TRUNCATE_AT);
  const moreBtn = document.createElement("button");
  moreBtn.className = "detail-expand-btn";
  moreBtn.textContent = `… show all (${fullDetail.length} chars)`;
  moreBtn.addEventListener("click", () => {
    detailEl.textContent = fullDetail;
    moreBtn.remove();
  });
  detailEl.appendChild(moreBtn);
} else {
  detailEl.textContent = fullDetail;
}
```

---

## 🟢 BUG #10 — Markdown renderer không xử lý link `[text](url)`, table, horizontal rule

**File:** `public/app.js`  
**Dòng:** 1102–1164  

### Mô tả

Markdown renderer tự viết thiếu các pattern phổ biến:

1. **Link:** `[text](url)` — không được render, hiển thị nguyên văn
2. **Table:** CSS có style cho `.msg-content table` nhưng renderer không tạo `<table>` từ Markdown table syntax
3. **Horizontal rule:** `---` trên dòng riêng không được render thành `<hr>`
4. **Nested list:** list lồng cấp 2 không được xử lý

AI model thường xuyên dùng cả 4 cú pháp này trong response.

### Cách fix

Thêm vào hàm `renderMarkdown()`:

```js
// public/app.js — trong renderMarkdown(), sau phần bold/italic (khoảng dòng 1136)

// Link
l = l.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g,
  '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

// Horizontal rule (phải check trước khi xử lý dòng thường)
if (/^---+$/.test(l.trim())) {
  out += "<hr>"; continue;
}
```

Với table: xem xét dùng thư viện nhẹ như `marked` hoặc `micromark` thay vì tự parse, vì table syntax khá phức tạp để parse thủ công đúng cách.

---

## 🟢 BUG #11 — Comment sai mô tả `projects` lưu ở localStorage

**File:** `public/app.js`  
**Dòng:** 33–34  

### Mô tả

```js
// public/app.js:33-34
// Projects stored in localStorage: [{path, name, color}]
let projects = [];
```

Comment này **sai**. Projects thực ra được fetch từ server qua `GET /api/projects` và lưu trên server trong `projects.json`. `localStorage` chỉ lưu `oc_project` (path của project đang chọn), không lưu toàn bộ danh sách projects.

### Cách fix

```js
// public/app.js:33-34
// Projects fetched from server via GET /api/projects (stored in projects.json on server)
let projects = [];
```

---

## Checklist tóm tắt cho dev

| # | File | Dòng | Mức | Nội dung | Fix |
|---|------|------|-----|----------|-----|
| 1 | `public/app.js` | 1019–1024 | 🔴 | WS action `"respond_prompt"` không tồn tại trên backend | Đổi thành `"respond_permission"` hoặc dùng REST API |
| 2 | `public/app.js` | 426–432 | 🔴 | `outerHTML` mất DOM reference → duplicate block | Dùng `innerHTML` thay thế |
| 3 | `public/app.js` | 357–373 | 🔴 | Indent sai: `onEvent` trông như lồng trong `onSessionCreated` | Fix indent |
| 4 | `public/app.js` | 300–311 | 🟡 | Reconnect loop vô hạn, không có max retry | Thêm counter + exponential backoff |
| 5 | `server.js` | 442–473 | 🟡 | `/api/browse` không giới hạn filesystem root | Thêm `BROWSE_ROOT` + validate path |
| 6 | `public/app.js` | 1296–1302 | 🟡 | Hardcode `/home/leco` làm browse root | Lấy từ env hoặc project path hiện tại |
| 7 | `server.js` | 322–329 | 🟡 | Xóa session không cleanup `sessionRuntime` → memory leak | Thêm `sessionRuntime.delete(id)` |
| 8 | `server.js` | 31–32 | 🟡 | Password so sánh `===` dễ bị timing attack | Dùng `crypto.timingSafeEqual` |
| 9 | `public/app.js` | 946 | 🟢 | Detail truncate 600 ký tự không có indicator | Thêm "show more" button |
| 10 | `public/app.js` | 1102–1164 | 🟢 | Markdown thiếu link, table, hr, nested list | Thêm regex hoặc dùng thư viện |
| 11 | `public/app.js` | 33–34 | 🟢 | Comment sai về localStorage | Sửa comment |

---

*Báo cáo được tạo bởi code review tự động — vui lòng verify lại với context business trước khi apply.*
