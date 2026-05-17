#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

OPCODE_PORT="${OPCODE_PORT:-4096}"
WRAPPER_PORT="${WRAPPER_PORT:-36788}"

echo "=============================================="
echo "  OpenCode Web Wrapper"
echo "=============================================="
echo ""

# Start opencode serve in background if not already running
if curl -s "http://localhost:${OPCODE_PORT}/global/health" > /dev/null 2>&1; then
  echo "✅ opencode server already running on port ${OPCODE_PORT}"
else
  echo "🔧 Starting opencode serve on port ${OPCODE_PORT}..."
  if [ -n "$OPENCODE_SERVER_PASSWORD" ]; then
    echo "   (password protected)"
  else
    echo "   ⚠️  No OPENCODE_SERVER_PASSWORD set - server is unsecured"
  fi
  opencode serve --port "${OPCODE_PORT}" --hostname 127.0.0.1 &
  OPCODE_PID=$!
  sleep 3

  if curl -s "http://localhost:${OPCODE_PORT}/global/health" > /dev/null 2>&1; then
    echo "✅ opencode server started on port ${OPCODE_PORT}"
  else
    echo "❌ Failed to start opencode server"
    exit 1
  fi
fi

echo ""
echo "🚀 Starting web wrapper on http://localhost:${WRAPPER_PORT} ..."
echo "   opencode API: http://localhost:${OPCODE_PORT}"
echo ""

export OPENCODE_URL="http://localhost:${OPCODE_PORT}"
export PORT="${WRAPPER_PORT}"

# Ensure deps installed
if [ ! -d "node_modules" ]; then
  echo "📦 Installing dependencies..."
  npm install
fi

node server.js
