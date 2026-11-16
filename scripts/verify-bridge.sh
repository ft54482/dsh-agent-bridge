#!/usr/bin/env bash
# Local read-only protocol checks; no SSH, sessions, prompts, restart or deployment.
# Optional DSH_SERVICE=dsh-web checks local systemd PID/listener ownership (Host only).
set +x
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -n "${DSH_SERVICE:-}" ]]; then
  [[ "$DSH_SERVICE" =~ ^[a-zA-Z0-9_.@-]+$ ]] || { echo 'Invalid service name' >&2; exit 1; }
  systemctl is-active --quiet "$DSH_SERVICE"
  MAINPID="$(systemctl show "$DSH_SERVICE" -p MainPID --value)"
  [[ "$MAINPID" =~ ^[1-9][0-9]*$ ]] || { echo 'Missing service MainPID' >&2; exit 1; }
  LISTENERS="$(ss -lntpH)" MAINPID="$MAINPID" python3 - <<'PY'
import os, re, urllib.parse
url=urllib.parse.urlsplit(os.environ.get('DSH_MCP_URL','http://127.0.0.1:17300/mcp'))
port=url.port or 80
rows=[row for row in os.environ['LISTENERS'].splitlines() if len(row.split())>3 and row.split()[3].endswith(':'+str(port))]
assert rows, 'No listener found'
for row in rows:
    address=row.split()[3]
    assert address in ('127.0.0.1:'+str(port),'[::1]:'+str(port)), 'Unexpected bind address'
    assert 'pid='+os.environ['MAINPID']+',' in row, 'Listener PID is not service MainPID (or ss lacks visibility)'
print('Service/listener ownership: OK')
PY
fi
python3 - <<'PY'
import ipaddress,json,os,sys,urllib.request,urllib.parse,urllib.error
url=os.environ.get('DSH_MCP_URL','http://127.0.0.1:17300/mcp')
p=urllib.parse.urlsplit(url)
assert p.scheme=='http' and ipaddress.ip_address(p.hostname).is_loopback and not(p.username or p.password or p.query or p.fragment), 'Expected credential-free loopback HTTP URL'
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
for origin,expected in [(None,401),('https://untrusted.example.com',403)]:
    headers={'Content-Type':'application/json'}
    if origin: headers['Origin']=origin
    req=urllib.request.Request(url,data=b'{"jsonrpc":"2.0","id":1,"method":"tools/list"}',headers=headers)
    try:
        with opener.open(req,timeout=10) as response: code=response.status
    except urllib.error.HTTPError as error: code=error.code
    assert code==expected, 'Expected HTTP '+str(expected)+', got '+str(code)
print('No Bearer:401; non-loopback Origin:403 — OK')
PY
INIT="$("$ROOT/scripts/dshmcp.sh" initialize '{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"bridge-verify","version":"1.0.0"}}')"
printf '%s' "$INIT" | python3 -c 'import json,re,sys;o=json.load(sys.stdin);s=o["result"]["serverInfo"];assert s["name"]=="dsh-agent-bridge" and re.fullmatch(r"\d+\.\d+\.\d+",s["version"]),"unexpected serverInfo: "+json.dumps(s);print("initialize: OK (serverInfo.version="+s["version"]+")")'
TOOLS="$("$ROOT/scripts/dshmcp.sh" tools/list)"
printf '%s' "$TOOLS" | python3 -c 'import json,sys;t=json.load(sys.stdin)["result"]["tools"];n={x["name"] for x in t};assert len(t)==12 and len(n)==12 and "dsh_list_workspaces" in n; c=next(x for x in t if x["name"]=="dsh_create_session")["inputSchema"];assert c["required"]==["cwd"] and "workspaceId" in c["properties"] and "workspaceSlug" in c["properties"];print("tools/list: 12, workspace schema OK")'
echo 'VERIFY_BRIDGE PASS'
