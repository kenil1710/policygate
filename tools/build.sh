#!/usr/bin/env bash
# Builds the deploy artifact from the readable source.
#
#   bash tools/build.sh
#
# Two stages, deliberately separate:
#   1. minify   — strips comments, docstrings and blank lines
#   2. mangle   — shortens identifiers; the source is never touched
#
# The deploy ceiling was MEASURED on a live network, not guessed: 53,000 bytes
# accepted and 53,500 refused with BlockPubdataLimitReached. Stage 1 alone leaves
# a contract that carries its own reasoning and is well over it.
#
# The name map stage 2 emits is not a courtesy. test/test_logic.py runs its whole
# battery against the MANGLED artifact through that map, because a mangle bug
# that renames a parameter onto a local parses, passes lint, passes validation,
# and deploys.
set -euo pipefail
cd "$(dirname "$0")/.."

python3 tools/minify_contract.py contracts/PolicyGate.py -o build/PolicyGate.premangle.py | sed 's/^/  /'
# The pre-mangle text is committed: diffing against it is how a reader checks
# that the mangle did nothing but rename.
python3 tools/mangle_names.py build/PolicyGate.premangle.py \
    -o build/PolicyGate.min.py --map build/PolicyGate.names.json | sed 's/^/  /'
python3 -c "import ast;ast.parse(open('build/PolicyGate.min.py').read())"

if [ -x "$HOME/.local/bin/genvm-lint" ]; then
  # Two stages that fail for different reasons. The LINT is about this contract
  # and must always pass. The VALIDATION loads the runner named in the pin, so it
  # fails with "Failed to load SDK" whenever the local linter bundle has not
  # cached that runner tarball — a fact about this machine, not the artifact.
  lint_out="$(mktemp)"
  set +e
  "$HOME/.local/bin/genvm-lint" check build/PolicyGate.min.py >"$lint_out" 2>&1
  lint_rc=$?
  set -e
  sed 's/^/  /' "$lint_out"
  if [ "$lint_rc" -ne 0 ]; then
    if grep -q 'Failed to load SDK' "$lint_out"; then
      echo "  note: the local genvm-lint bundle has not cached this runner pin;"
      echo "        lint passed, validation was skipped. Not a build failure."
    else
      rm -f "$lint_out"; exit "$lint_rc"
    fi
  fi
  rm -f "$lint_out"
fi

python3 - <<'PY'
import hashlib, json, os
path = "deployments.json"
d = json.load(open(path)) if os.path.exists(path) else {}
d.setdefault("artifacts", {})
meta = d["artifacts"].setdefault("build/PolicyGate.min.py", {"source": "contracts/PolicyGate.py"})
meta["bytes"] = os.path.getsize("build/PolicyGate.min.py")
meta["sha256"] = hashlib.sha256(open("build/PolicyGate.min.py", "rb").read()).hexdigest()
meta["source_sha256"] = hashlib.sha256(open(meta["source"], "rb").read()).hexdigest()
meta["premangle_bytes"] = os.path.getsize("build/PolicyGate.premangle.py")
# ensure_ascii=False and a trailing newline: without either, every build rewrites
# every § and → in this file as a \uXXXX escape and `git diff` after a no-op
# build is pages of noise.
with open(path, "w", encoding="utf-8") as fh:
    json.dump(d, fh, indent=2, ensure_ascii=False)
    fh.write("\n")
print(f"  {meta['bytes']:>7,} bytes  build/PolicyGate.min.py  sha256 {meta['sha256'][:16]}…")
PY
