# OpenCode Web Wrapper

Giao diện web để chat với OpenCode AI từ xa qua trình duyệt, có hỗ trợ realtime streaming, quản lý project/session, xác thực đăng nhập, và đồng bộ prompt pending giữa nhiều trình duyệt.

---

## Tổng quan

Đây là một web application đóng vai trò wrapper giữa browser và OpenCode backend.

### Tính năng chính

- Chat realtime qua WebSocket với streaming token-by-token
- Quản lý project theo thư mục server
- Quản lý session theo từng project
- Chọn model AI và chuyển mode `Build / Plan`
- Queue message khi AI đang bận
- Inline prompt card cho permission/prompt pending ngay trong luồng chat
- Prompt runtime state sync qua WebSocket giữa nhiều browser/tab
- Rehydrate prompt state sau `F5` bằng session state API
- Tự dừng auto-scroll khi người dùng kéo lên đọc
- Markdown renderer phía client, hỗ trợ code block realtime
- Auth bằng password, login/logout ngay trên website
- Responsive cho mobile và desktop

### Công nghệ sử dụng

| Lớp | Công nghệ |
|-----|-----------|
| Backend | Node.js, Express, WebSocket (`ws`), `@opencode-ai/sdk` |
| Frontend | Vanilla JavaScript, HTML, CSS |
| Storage cục bộ | `projects.json` |
| Session/prompt upstream | OpenCode backend |
| Runtime sync state | SQLite (`runtime.db`) + in-process broadcast |
| Deploy | PM2, nginx reverse proxy |

---

## Kiến trúc hiện tại

```
Browser
  ├─ index.html                giao diện SPA
  ├─ app.js                    state client, WS, render chat, prompt cards
  └─ style.css                 giao diện dark theme, responsive
          │
          │ HTTP + WebSocket
          ▼
Wrapper Server (server.js)
  ├─ Express static + REST API
  ├─ WebSocket server
  ├─ SSE forwarder từ OpenCode `/event`
  ├─ Runtime state theo session
  │   └─ prompts pending/submitted/allowed/denied
  └─ Proxy xử lý permission response từ website
          │
          │ HTTP / SDK
          ▼
OpenCode backend
  ├─ session.create
  ├─ session.promptAsync
  ├─ session.messages
  ├─ permission response API
  └─ /event SSE stream
```

---

## Luồng dữ liệu chính

## 1. Gửi một tin nhắn chat

```
User nhập text
  → app.js: sendMessage()
  → nếu AI đang bận thì đẩy vào msgQueue
  → nếu rảnh thì ws.send({ action: "send", ... })

server.js: handleWsMessage()
  → nếu chưa có session thì tạo session mới
  → gọi client.session.promptAsync()

OpenCode backend
  → stream SSE event qua /event

server.js: forwardEvents()
  → broadcast event qua WebSocket cho mọi client

app.js: onEvent()
  → render delta text realtime
  → render tool blocks / reasoning / prompt blocks
  → cập nhật metadata khi message hoàn tất
```

## 2. Permission / prompt pending

```
OpenCode backend phát event permission.updated
  → server.js chuẩn hóa thành prompt runtime state
  → lưu vào sessionRuntime.prompts
  → broadcast lại qua WebSocket

Frontend session đang mở
  → render inline prompt card ngay trong chat

User bấm Allow / Deny / Always Allow
  → frontend gọi REST API của wrapper
  → backend đổi state thành submitted
  → broadcast prompt.updated cho mọi browser/tab
  → backend gọi OpenCode permission API
  → nếu thành công: chờ event upstream xác nhận
  → nếu lỗi: rollback về pending và broadcast lại
```

## 3. Rehydrate sau F5

```
Frontend mở lại session
  → GET /api/sessions/:id/messages
  → GET /api/sessions/:id/state
  → dựng lại message history
  → dựng lại prompt pending từ state snapshot
```

---

## WebSocket protocol

### Client → Server

```json
{ "type": "auth", "password": "server_password" }

{ "action": "send", "sessionId": "ses_xxx", "text": "hello", "model": {"providerID": "openai", "modelID": "gpt-4o"}, "agent": "build", "directory": "/home/leco/project" }

{ "action": "abort", "sessionId": "ses_xxx" }

{ "action": "respond_permission", "permissionId": "perm_xxx", "sessionID": "ses_xxx", "response": "allow", "remember": true }
```

Ghi chú:
- `respond_permission` vẫn được backend hỗ trợ qua WebSocket.
- Website hiện ưu tiên gọi REST API cho permission response để có flow ổn định hơn và dễ rollback UI.

### Server → Client

```json
{ "type": "connected", "id": "ws_abc123" }
{ "type": "session_created", "session": { ... } }
{ "type": "error", "error": "..." }
{ "type": "aborted", "sessionId": "ses_xxx" }

{ "type": "event", "data": { "type": "message.part.delta", "properties": { ... } } }
{ "type": "event", "data": { "type": "message.part.updated", "properties": { ... } } }
{ "type": "event", "data": { "type": "message.updated", "properties": { ... } } }
{ "type": "event", "data": { "type": "session.status", "properties": { ... } } }
{ "type": "event", "data": { "type": "session.idle", "properties": { ... } } }
{ "type": "event", "data": { "type": "permission.updated", "properties": { ... } } }
{ "type": "event", "data": { "type": "prompt.updated", "properties": { "prompt": { ... } } } }
```

---

## REST API

Tất cả endpoint dùng prefix `/api` và sẽ yêu cầu `Authorization: Bearer <password>` nếu server có đặt `OPCODE_PASSWORD`.

| Method | Path | Mô tả |
|--------|------|-------|
| GET | `/api/health` | Health check OpenCode backend |
| GET | `/api/sessions` | Danh sách session, hỗ trợ `?directory=` |
| POST | `/api/sessions` | Tạo session mới |
| DELETE | `/api/sessions/:id` | Xóa session |
| GET | `/api/sessions/:id/messages` | Lấy history message |
| GET | `/api/sessions/:id/state` | Lấy runtime prompt state của session |
| POST | `/api/sessions/:id/prompt` | Gửi prompt đồng bộ |
| POST | `/api/sessions/:id/prompts/:promptId/respond` | Trả lời permission/prompt từ website |
| GET | `/api/providers` | Danh sách provider/model |
| GET | `/api/agents` | Danh sách agent |
| GET | `/api/config` | Cấu hình hiện tại của OpenCode |
| GET | `/api/projects` | Danh sách project |
| POST | `/api/projects` | Thêm project |
| DELETE | `/api/projects` | Xóa project |
| GET | `/api/browse` | Duyệt thư mục server |
| POST | `/api/browse/mkdir` | Tạo thư mục mới |

### Ví dụ API

```bash
# Lấy runtime state của session
curl -H "Authorization: Bearer mật_khẩu" \
  "https://your-host/api/sessions/ses_xxx/state"

# Trả lời permission từ website hoặc script
curl -X POST \
  -H "Authorization: Bearer mật_khẩu" \
  -H "Content-Type: application/json" \
  -d '{"response":"allow","remember":true}' \
  "https://your-host/api/sessions/ses_xxx/prompts/perm_xxx/respond"
```

---

## Auth flow

### Hành vi hiện tại

- Nếu chưa có password trong `localStorage`, app sẽ hiện login overlay.
- Chỉ sau khi auth WebSocket thành công mới load:
  - projects
  - sessions
  - providers
- Có nút `Logout` trong sidebar.
- Logout sẽ:
  - xóa password local
  - đóng socket
  - reset state/UI
  - quay lại màn login

### LocalStorage đang dùng

| Key | Mục đích |
|-----|----------|
| `oc_pass` | Password đã lưu |
| `oc_project` | Project đang chọn |
| `oc_session` | Session đang chọn |
| `oc_model` | Model đang chọn |
| `oc_model_usage` | Bộ đếm mức độ dùng model |

---

## Prompt sync và multi-browser behavior

Wrapper server hiện có runtime prompt store theo `sessionID`.

### Điều này mang lại

- `F5` không mất prompt pending nếu server vẫn đang chạy
- 2 browser/tab mở cùng một session có thể đồng bộ prompt state
- Khi một browser bấm `Allow` hoặc `Deny`, browser còn lại sẽ thấy trạng thái đổi qua WebSocket

### Giới hạn hiện tại

- Runtime state hiện đang nằm trong memory của `server.js`
- Nếu restart wrapper server, state này sẽ mất
- History message vẫn do OpenCode backend quản lý, nhưng prompt runtime state hiện chưa được persist riêng

---

## Auto-scroll behavior

Frontend hiện có auto-scroll thông minh:

- Nếu user đang ở gần cuối chat, response mới sẽ tự cuộn xuống
- Nếu user kéo lên đọc, auto-scroll sẽ tạm dừng
- Khi user quay lại gần cuối hoặc gửi tin nhắn mới, auto-scroll tiếp tục hoạt động

Ngưỡng hiện tại dùng trong code là `AUTO_SCROLL_THRESHOLD = 96`.

---

## Realtime rendering behavior

Frontend hiện hỗ trợ:

- Text delta streaming
- Text part update không cần delta
- Code block chưa đóng fence vẫn render realtime
- Tool block realtime
- Reasoning block realtime
- Unknown block fallback realtime (`Live Block`) nếu backend gửi `part.type` chưa có renderer riêng

Điều này giúp giảm tình trạng phải `F5` mới thấy block xuất hiện.

---

## Cấu trúc thư mục

```
wrapper/
├── server.js
├── start.sh
├── package.json
├── package-lock.json
├── projects.json
├── README.md
└── public/
    ├── index.html
    ├── app.js
    └── style.css
```

---

## Mô tả file chính

### `server.js`

Backend chính, chịu trách nhiệm:

- Phục vụ static files và REST API
- Tạo WebSocket server cho client
- Kết nối OpenCode `/event` SSE và broadcast lại
- Quản lý runtime prompt state theo session
- Xử lý permission response từ website
- Rehydrate prompt state qua API snapshot

### `public/app.js`

Client logic chính:

- Auth/login/logout flow
- WebSocket connection + reconnect
- Realtime chat rendering
- Auto-scroll thông minh
- Inline prompt card rendering
- Rehydrate messages + prompt state khi load session
- Fallback block renderer cho part type chưa biết

### `public/style.css`

Toàn bộ giao diện:

- Dark theme
- Responsive mobile/desktop
- Chat typography
- Tool block, reasoning block, prompt card, unknown block
- Login overlay, modal, toast

---

## Hướng dẫn chạy local

```bash
# Start OpenCode backend
opencode serve --port 4096 --hostname 127.0.0.1

# Start wrapper
cd /home/leco/wrapper
PORT=36788 OPCODE_PASSWORD="your_password" OPENCODE_URL="http://127.0.0.1:4096" node server.js
```

Hoặc:

```bash
bash start.sh
```

Development mode:

```bash
npm run dev
```

---

## Deploy hiện tại

Wrapper hiện chạy bằng **PM2**, không còn dùng `node server.js` tay hay `nohup`.

### Cài PM2 (chỉ cần 1 lần)

```bash
npm install -g pm2
pm2 startup          # để PM2 tự chạy sau reboot
```

### Deploy — workflow đầy đủ

```bash
# 1. Pull code mới
cd /home/leco/wrapper
git pull

# 2. Restart wrapper (PM2 giữ env cũ, code mới từ đĩa)
pm2 restart opencode-wrapper

# 3. Kiểm tra
pm2 status
curl -s -H "Authorization: Bearer <password>" http://localhost:36788/api/health

# 4. Xem log nếu có lỗi
pm2 logs opencode-wrapper --lines 10 --nostream
```

### Start lần đầu

```bash
cd /home/leco/wrapper
npm install

PORT=36788 \
OPCODE_PASSWORD="your_password" \
OPENCODE_URL="http://127.0.0.1:4096" \
BROWSE_ROOT="/home" \
pm2 start server.js --name opencode-wrapper

pm2 save   # lưu process list để reboot tự chạy
```

### Cập nhật env (password, port...)

```bash
pm2 restart opencode-wrapper --update-env
```

> Nếu đổi PORT, nhớ kiểm tra lại `nginx` hoặc URL truy cập.

### Lệnh PM2 hằng ngày

| Lệnh | Ý nghĩa |
|------|---------|
| `pm2 status` | Xem trạng thái app |
| `pm2 restart opencode-wrapper` | Restart deploy |
| `pm2 logs opencode-wrapper` | Xem log realtime |
| `pm2 logs opencode-wrapper --lines 20 --nostream` | Xem 20 dòng log gần nhất |
| `pm2 stop opencode-wrapper` | Dừng |
| `pm2 start opencode-wrapper` | Start lại sau stop |
| `pm2 save` | Lưu process list |
| `pm2 startup` | Tự khởi động sau reboot |

### Verify sau deploy

```bash
# Health check
curl -s -H "Authorization: Bearer your_password" "http://127.0.0.1:36788/api/health"
# → {"healthy":true,"version":"1.15.1"}

# Session state (có SQLite persistence)
curl -s -H "Authorization: Bearer your_password" "http://127.0.0.1:36788/api/sessions/<id>/state"
# → {"status":"idle","prompts":[]}

# Danh sách project
curl -s -H "Authorization: Bearer your_password" "http://127.0.0.1:36788/api/projects"
```

### Troubleshoot

```bash
# Xem log lỗi
pm2 logs opencode-wrapper --err --lines 20 --nostream

# Restart nếu crash
pm2 restart opencode-wrapper

# Xem process có đang giữ port không
fuser 36788/tcp

# Kill tay nếu PM2 không dừng được
fuser -k 36788/tcp
pm2 restart opencode-wrapper
```

---

## Kiểm thử nên làm sau các thay đổi gần đây

### Auth

1. Vào web khi chưa login
2. Login đúng
3. Login sai
4. Logout
5. Reload khi đã có password lưu sẵn

### Prompt sync

1. Mở cùng một session ở 2 tab/browser
2. Tạo permission prompt
3. Bấm `Allow Once` ở tab A
4. Kiểm tra tab B có đổi trạng thái không
5. `F5` một tab khi prompt còn pending
6. Kiểm tra prompt có rehydrate lại không

### Session status sync

1. Mở cùng một session ở 2 tab/browser hoặc 2 thiết bị
2. Gửi một prompt dài từ thiết bị A
3. Mở session đó ở thiết bị B trong lúc AI đang xử lý
4. Kiểm tra thiết bị B nhận đúng trạng thái `busy`
5. Chờ AI chạy xong
6. Kiểm tra cả 2 bên đều về `idle`
7. Restart wrapper bằng `pm2 restart opencode-wrapper`
8. Mở lại session và kiểm tra `state` API vẫn trả đúng `status` + `prompts`

### Chat rendering

1. Stream một response dài có code block
2. Kéo lên đọc trong lúc AI đang trả lời
3. Kiểm tra auto-scroll có dừng đúng không
4. Kiểm tra code block/unknown block có hiện realtime không

---

## Hạn chế hiện tại

- `session_status` và `session_prompts` đã persist qua SQLite, nhưng draft stream đang chạy dở chưa được persist
- Generic prompt flow cho `single/multi/input` mới hoàn thiện UI nền, chưa có backend schema đầy đủ như permission
- Frontend hiện render tốt `text`, `tool`, `reasoning`, nhưng nhiều part type upstream vẫn đang fallback
- `step-start` / `step-finish` xuất hiện nhiều trong history thực tế, nhưng chưa có renderer chuyên biệt

---

## Định hướng mở rộng tiếp theo

1. Persist thêm partial assistant draft / active tool state để rehydrate sâu hơn khi session đang `busy`
2. Thiết kế generic prompt schema cho:
   - chọn 1
   - chọn nhiều
   - nhập text
3. Thêm renderer riêng cho `step-start` / `step-finish`
4. Render lại resolved prompt history đẹp hơn sau reload
5. Thêm `Jump to latest` hoặc `New action below`
6. Thêm `copy code` và polish code block UI
