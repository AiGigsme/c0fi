#!/usr/bin/env bash
# start.sh — one command for everything C0fi needs, instead of a terminal per piece.
#
#   ./start.sh                     engine only: real web search, page reading, MCP tools
#   ./start.sh --with-page-agent   also start the page-agent MCP bridge (browser actions:
#                                   click, type, navigate — needs the Page Agent Ext Chrome
#                                   extension installed and enabled first)
#
# Ctrl+C stops everything this script started.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

ENGINE_PORT="${C0FI_PORT:-8790}"
PAGE_AGENT_PORT="${C0FI_PAGE_AGENT_PORT:-8794}"
PAGE_AGENT_LLM_BASE_URL="${LLM_BASE_URL:-http://localhost:11435/v1}"
PAGE_AGENT_LLM_MODEL="${LLM_MODEL_NAME:-qwen3-coder:30b}"
WITH_PAGE_AGENT=0
[[ "${1:-}" == "--with-page-agent" ]] && WITH_PAGE_AGENT=1

pids=()
cleanup() {
  trap - EXIT INT TERM
  echo
  echo "start.sh: stopping…"
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null; done
}
trap cleanup EXIT INT TERM

if ! curl -sf http://localhost:11434/api/tags >/dev/null 2>&1 && ! curl -sf http://localhost:11435/api/tags >/dev/null 2>&1; then
  echo "start.sh: Ollama isn't answering on 11434 or 11435."
  echo "  Quickest fix (survives Ollama.app's origin restrictions): run in another terminal"
  echo "    OLLAMA_HOST=127.0.0.1:11435 OLLAMA_ORIGINS=\"*\" ollama serve"
  echo "  then point C0fi's Engine settings at http://localhost:11435"
  echo "  (continuing anyway — C0fi will show 'engine offline' until Ollama is up)"
fi

echo "start.sh: launching C0fi engine on :$ENGINE_PORT (web search, page reading, MCP tools)…"
python3 c0fi_server.py "$ENGINE_PORT" &
pids+=("$!")

if [[ "$WITH_PAGE_AGENT" == "1" ]]; then
  echo "start.sh: launching page-agent MCP bridge on :$PAGE_AGENT_PORT (browser actions)…"
  echo "  needs Page Agent Ext installed + enabled in Chrome, and a hub tab open"
  LLM_BASE_URL="$PAGE_AGENT_LLM_BASE_URL" LLM_MODEL_NAME="$PAGE_AGENT_LLM_MODEL" \
    python3 mcp_stdio_bridge.py "$PAGE_AGENT_PORT" -- npx -y @page-agent/mcp &
  pids+=("$!")
fi

latest_html=$(ls c0fi-v*.html 2>/dev/null | sort -t v -k2 -n | tail -1)
if [[ -n "$latest_html" ]]; then
  sleep 1
  echo "start.sh: opening $latest_html"
  open "$latest_html"
else
  echo "start.sh: no c0fi-v*.html found in $(pwd) — open it manually."
fi

echo "start.sh: running. Ctrl+C to stop everything."
wait
