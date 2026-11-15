#!/usr/bin/env bash
# Usage: dshmcp.sh <method> [json-params]; credentials never appear in argv.
set +x
set -euo pipefail
if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo 'Usage: dshmcp.sh <method> [json-params]' >&2; exit 2
fi
PARAMS='{}'
if [[ $# -ge 2 ]]; then PARAMS="$2"; fi
python3 - "$1" "$PARAMS" <<'PY'
import ipaddress, json, os, pathlib, sys, urllib.request, urllib.parse, urllib.error

def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)

url = os.environ.get('DSH_MCP_URL', 'http://127.0.0.1:17300/mcp')
try:
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != 'http' or not ipaddress.ip_address(parsed.hostname).is_loopback
        or parsed.username or parsed.password or parsed.query or parsed.fragment):
        fail('DSH_MCP_URL must be plain HTTP on a loopback literal, without credentials/query/fragment')
    params = json.loads(sys.argv[2])
    if not isinstance(params, dict):
        fail('JSON params must be an object')
except (ValueError, TypeError):
    fail('Invalid loopback URL or JSON params')
secret = os.environ.get('DSH_BRIDGE_SECRET')
if secret is None:
    filename = os.environ.get('DSH_BRIDGE_SECRET_FILE')
    if not filename:
        fail('Set DSH_BRIDGE_SECRET or DSH_BRIDGE_SECRET_FILE outside the repository')
    try:
        secret = pathlib.Path(filename).read_text().strip()
    except (OSError, UnicodeError):
        fail('Cannot read the explicitly configured local credential file')
if len(secret.encode()) < 32 or '\r' in secret or '\n' in secret:
    fail('Credential must be at least 32 bytes and contain no line breaks')

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None
# Never consult proxy variables, and never forward Bearer on redirects.
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

def call(method, params, request_id=None):
    message = {'jsonrpc':'2.0', 'method':method, 'params':params}
    if request_id is not None:
        message['id'] = request_id
    data = json.dumps(message).encode()
    request = urllib.request.Request(url, data=data, headers={
        'Authorization':'Bearer '+secret,
        'Content-Type':'application/json',
        'Accept':'application/json, text/event-stream'})
    try:
        with opener.open(request, timeout=65) as response:
            body = response.read()
        return json.loads(body) if body else None
    except urllib.error.HTTPError as error:
        fail('Bridge HTTP failure: '+str(error.code))
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        fail('Bridge transport/JSON failure (details suppressed to protect credentials)')

method = sys.argv[1]
if method != 'initialize':
    result = call('initialize', {'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'dshmcp','version':'0.2.2'}}, 0)
    if not isinstance(result, dict) or 'error' in result:
        fail('MCP initialize failed')
    call('notifications/initialized', {})
result = call(method, params, 1)
if result is not None:
    print(json.dumps(result, ensure_ascii=False))
if isinstance(result, dict) and ('error' in result or result.get('result', {}).get('isError') is True):
    sys.exit(1)
PY
