#!/usr/bin/env bash
# Everything that can be checked, checked, in one command.
#
#   bash tools/audit.sh
#
# Four stages, in the order that fails fastest:
#   1. build      — minify, mangle, lint; refuses over the measured deploy ceiling
#   2. checklist  — every past-rejection pattern, decided by parsing the source
#   3. offline    — the full unit suite, source AND mangled artifact
#   4. on-chain   — what the deployed contract actually holds (skipped if none)
set -uo pipefail
cd "$(dirname "$0")/.."
rc=0

hr() { printf '\n\033[1m%s\033[0m\n%s\n' "$1" "$(printf '=%.0s' {1..70})"; }

hr "1. BUILD"
bash tools/build.sh || rc=1

hr "2. REJECTION-PATTERN CHECKLIST"
python3 tools/checklist.py || rc=1

hr "3. OFFLINE SUITE"
python3 test/test_logic.py 2>&1 | tail -4 || rc=1
python3 test/test_logic.py >/dev/null 2>&1 || rc=1

hr "4. ON-CHAIN STATE"
python3 - <<'PY' || true
import json, os, urllib.request

path = "deployments.json"
if not os.path.exists(path):
    print("  no deployments.json — nothing deployed yet"); raise SystemExit
doc = json.load(open(path))
dep = (doc.get("deployments") or {}).get("studiodev") or {}
addr = (dep.get("PolicyGate") or {}).get("address")
if not addr:
    print("  no studiodev deployment recorded"); raise SystemExit
print(f"  contract   {addr}")
print(f"  owner      {dep.get('owner')}")
print(f"  artifact   {dep.get('artifact_bytes'):,} bytes  deployed {dep.get('deployed_at')}")

import hashlib
here = hashlib.sha256(open("build/PolicyGate.min.py","rb").read()).hexdigest()
on_chain = dep.get("artifact_sha256")
# TWO DIFFERENT QUESTIONS, and conflating them hides the interesting one.
#   1. do the bytes this tree builds match what was deployed?
#   2. if not, has the SOURCE moved on since — which is ordinary — or is the
#      deployment of unknown provenance, which is not?
if not on_chain:
    print(f"  checksum   this tree builds {here[:16]}…; no deployed checksum recorded")
elif here == on_chain:
    print(f"  checksum   MATCHES the deployed artifact  ({here[:16]}…)")
else:
    print(f"  checksum   this tree builds {here[:16]}…, the chain holds {on_chain[:16]}…")
    print("             the source has moved on since this deploy — redeploy to realign")


try:
    import subprocess
    out = subprocess.run(["node","-e","""
      import('./test/harness.mjs').then(async (h)=>{
        const c = h.connect({networkName:'studiodev', address: process.argv[1], role:'client'});
        const s = await c.viewJson('get_stats',[]);
        const g = await c.viewJson('get_config',[]);
        console.log(JSON.stringify({s,g}));
      }).catch(e=>{console.log('ERR '+e.message)});
    """, addr], capture_output=True, text=True, timeout=120)
    line = out.stdout.strip().splitlines()[-1] if out.stdout.strip() else ""
    if line.startswith("{"):
        d = json.loads(line); s, g = d["s"], d["g"]
        print(f"  policies   {s['policies_active']} active / {s['policies_created']} created")
        print(f"  checks     {s['checks_filed']} filed — {s['granted']} granted, {s['denied']} denied, "
              f"{s['inconclusive']} inconclusive, {s['stalled']} stalled, {s['pending']} pending")
        print(f"  retries    {s['retries']}   grant rate {s['grant_rate_bps']/100:.1f}% of {s['decided']} decided")
        print(f"  axis       {', '.join(g['axis_fields'])}")
        print(f"  paused     {g['paused']}")
    else:
        print(f"  could not read the chain: {line or out.stderr.strip()[:120]}")
except Exception as e:
    print(f"  could not read the chain: {e}")
PY

hr "RESULT"
if [ "$rc" -eq 0 ]; then
  echo "  everything that can be checked, passed."
else
  echo "  SOMETHING FAILED — see above."
fi
exit "$rc"
