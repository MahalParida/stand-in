#!/usr/bin/env bash
# Smoke-test a live Stand-In deployment (spec M6 / section 13).
#
#   scripts/smoke-live.sh https://stand-in.xxxxx.ap-south-1.cs.amazonlightsail.com
#
# Checks: /health 200; POST /mcp without a token -> 401 with no WWW-Authenticate;
# a foreign Origin -> 403; /sim/config reports mode aws (EXPECT_MODE overrides);
# an authenticated MCP initialize + tools/list through the SDK client.
#
# The Bearer token comes from $STANDIN_TOKEN, else the local .env, else the
# hosted demo's /sim/config (DEMO_EMBED_TOKEN=true). It is never printed, and
# the /sim/config body (which may carry it) is never printed either.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
URL="${1:-${URL:-}}"
EXPECT_MODE="${EXPECT_MODE:-aws}"
[[ -n "$URL" ]] || { echo "usage: $0 <base-url>" >&2; exit 2; }
URL="${URL%/}"
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 2; }

umask 077
WORK="$(mktemp -d "${TMPDIR:-/tmp}/standin-smoke.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

fails=0
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; fails=$((fails + 1)); }

INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'

# 1. /health
code="$(curl -sS -o "$WORK/health" -w '%{http_code}' --max-time 15 "$URL/health" || true)"
if [[ "$code" == "200" ]]; then pass "/health 200"; else fail "/health returned $code"; fi

# 2. POST /mcp without a token: 401 and no WWW-Authenticate
code="$(curl -sS -o /dev/null -D "$WORK/h401" -w '%{http_code}' --max-time 15 -X POST "$URL/mcp" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --data "$INIT" || true)"
if [[ "$code" == "401" ]]; then pass "/mcp without token 401"; else fail "/mcp without token returned $code"; fi
if grep -qi '^www-authenticate:' "$WORK/h401"; then fail "401 carries a WWW-Authenticate header"; else pass "401 has no WWW-Authenticate"; fi

# 3. Foreign Origin: 403 (checked before auth)
code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$URL/mcp" \
  -H 'origin: https://evil.example.invalid' -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' --data "$INIT" || true)"
if [[ "$code" == "403" ]]; then pass "bad Origin 403"; else fail "bad Origin returned $code"; fi

# 4. /sim/config mode (body kept in a 0600 temp file, never printed)
code="$(curl -sS -o "$WORK/simcfg" -w '%{http_code}' --max-time 15 "$URL/sim/config" || true)"
mode="$(node -e "try{const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(String(c.mode))}catch{process.stdout.write('unparseable')}" "$WORK/simcfg")"
if [[ "$code" == "200" && "$mode" == "$EXPECT_MODE" ]]; then pass "/sim/config mode $mode"; else fail "/sim/config returned $code with mode $mode (expected $EXPECT_MODE)"; fi

# 5. Authenticated MCP initialize + tools/list
token="${STANDIN_TOKEN:-}"
if [[ -z "$token" && -f "$ENV_FILE" ]]; then
  line="$(grep -E '^[[:space:]]*(export[[:space:]]+)?STANDIN_TOKEN=' "$ENV_FILE" | tail -n 1 || true)"
  token="${line#*=}"
  token="${token%$'\r'}"
  if [[ "$token" =~ ^\"(.*)\"$ ]] || [[ "$token" =~ ^\'(.*)\'$ ]]; then token="${BASH_REMATCH[1]}"; fi
fi
if [[ -z "$token" ]]; then
  token="$(node -e "try{const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(typeof c.demoToken==='string'?c.demoToken:'')}catch{}" "$WORK/simcfg")"
fi
if [[ -z "$token" ]]; then
  fail "no Bearer token (set STANDIN_TOKEN, add it to .env, or enable DEMO_EMBED_TOKEN)"
elif SMOKE_URL="$URL" SMOKE_TOKEN="$token" node "$ROOT/scripts/smoke-mcp.mjs"; then
  pass "MCP initialize + tools/list"
else
  fail "MCP initialize + tools/list"
fi
unset token

if ((fails > 0)); then
  printf '%d check(s) failed for %s\n' "$fails" "$URL"
  exit 1
fi
printf 'all checks passed for %s\n' "$URL"
