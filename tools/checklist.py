"""Every past-rejection pattern, checked against the SOURCE rather than claimed.

    python3 tools/checklist.py

Each item is decided by parsing `contracts/PolicyGate.py` and, where it exists,
`build/PolicyGate.min.py`. A claim that cannot be decided by reading the file is
not on this list — "we were careful about X" is not a check.

Exit status is non-zero if anything fails, so this is usable in CI.
"""
import ast
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_PATH = os.path.join(ROOT, "contracts", "PolicyGate.py")
ART_PATH = os.path.join(ROOT, "build", "PolicyGate.min.py")

src = open(SRC_PATH, encoding="utf8").read()
tree = ast.parse(src)
art = open(ART_PATH, encoding="utf8").read() if os.path.exists(ART_PATH) else ""
art_tree = ast.parse(art) if art else None

PASS, FAIL = [], []


def ck(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    mark = "PASS" if cond else "FAIL"
    print("  %s  %s%s" % (mark, name, (" — " + detail) if detail else ""))


def fn(name, where=None):
    for node in ast.walk(where or tree):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    return None


def inner(outer_name, inner_name):
    outer = fn(outer_name)
    return fn(inner_name, outer) if outer else None


def code_of(node):
    """A function's body as text, WITHOUT its docstring.

    Every one of these checks is a search for a name in code. A docstring that
    explains why the reasoning is NOT on the axis contains the word "reasoning",
    and a checklist that searched the raw unparse would fail the file for
    documenting itself. Prose about a field is not the field.
    """
    clone = ast.parse(ast.unparse(node)).body[0]
    if (clone.body and isinstance(clone.body[0], ast.Expr)
            and isinstance(clone.body[0].value, ast.Constant)
            and isinstance(clone.body[0].value.value, str)):
        clone.body = clone.body[1:] or [ast.Pass()]
    return ast.unparse(clone)


def called_names(node):
    return {n.func.id for n in ast.walk(node)
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)}


def public_methods(t=None):
    out = {}
    for node in ast.walk(t or tree):
        if isinstance(node, ast.ClassDef) and node.name == "PolicyGate":
            for item in node.body:
                if isinstance(item, ast.FunctionDef):
                    decs = [ast.unparse(d) for d in item.decorator_list]
                    if any(d.startswith("gl.public") for d in decs):
                        out[item.name] = (item, decs)
    return out


print("\nPolicyGate — rejection-pattern checklist\n")

# ── 1. Consensus binds ALL stored values ────────────────────────────────────
print(" 1. Consensus binds every stored value that matters")
resolve = fn("_resolve")
settle_assigns = []
for node in ast.walk(resolve):
    if isinstance(node, ast.Assign):
        for t in node.targets:
            if isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name) and t.value.id == "check":
                settle_assigns.append((t.attr, ast.unparse(node.value)))
axis_fields = ("verdict", "conditions_met", "conditions_total",
               "wallet_age_bucket", "tx_count_bucket", "balance_bucket",
               "content_hash")
from_result = {a for a, v in settle_assigns if "result" in v or a == "verdict"}
ck("every axis field is assigned from the agreed `result`",
   all(f in from_result for f in axis_fields),
   "bound: " + ", ".join(sorted(f for f in axis_fields if f in from_result)))

not_from_result = sorted({a for a, v in settle_assigns
                          if "result" not in v and a not in ("verdict",)})
# `status`, `settled_at` and `retry_count` are bookkeeping about the ROUND, not
# claims about the wallet: a leader cannot move a verdict or a bucket with any
# of them, and none of them can produce a grant. Everything that IS a claim
# about the wallet must come from the agreed vector.
ck("no field that makes a claim about the wallet is invented locally",
   set(not_from_result) <= {"status", "settled_at", "retry_count"},
   "local-only: " + ", ".join(not_from_result))

ck("the parsed conditions are bound too (they feed the content hash)",
   "cond_text" in ast.unparse(fn("_run_check")) and
   "conditions_text" in ast.unparse(fn("_run_check")))

# ── 2. Leader can't forge ───────────────────────────────────────────────────
print("\n 2. A leader cannot forge what it reported")
axis = fn("_axis")
axis_src = code_of(axis)
ck("wallet age is on the axis", "wallet_age_bucket" in axis_src)
ck("transaction count is on the axis", "tx_count_bucket" in axis_src)
ck("balance is on the axis", "balance_bucket" in axis_src)
validator = inner("_resolve", "validator_fn")
ck("the validator RE-RUNS the whole evaluation and compares axes",
   "_run_check" in called_names(validator) and "_axis" in called_names(validator))
ck("the validator gates the leader's own calldata with _coherent",
   "_coherent" in called_names(validator))
coh = ast.unparse(fn("_coherent"))
ck("a forged GRANTED is rejected by _coherent",
   "V_GRANTED" in coh and "met != total" in coh and "unver > 0" in coh)
ck("a leader ERROR is re-run, never voted False",
   "gl.vm.Return" in ast.unparse(validator) and "leader_fn()" in ast.unparse(validator))

# ── 3. Validators compare a feature vector, not just a verdict ──────────────
print("\n 3. The axis is a feature vector")
joined = [n for n in ast.walk(axis) if isinstance(n, ast.List)]
count = len(joined[0].elts) if joined else 0
ck("the axis carries seven fields", count == 7, "counted %d" % count)
ck("RETRY is on the axis beside the verdicts", "V_RETRY" in axis_src)
ck("the evidence digest is NOT on the axis", "evidence_digest" not in axis_src)
ck("the reasoning is NOT on the axis", "reasoning" not in axis_src)

# ── 4. No counter-before-revert ─────────────────────────────────────────────
print("\n 4. No counter written before a revert")
raises = [n.lineno for n in ast.walk(tree) if isinstance(n, ast.Raise)]
ck("the source contains ZERO raise statements", not raises, str(raises or "none"))
if art_tree:
    art_raises = [n.lineno for n in ast.walk(art_tree) if isinstance(n, ast.Raise)]
    ck("the artifact contains ZERO raise statements", not art_raises)
ck("the RETRY path returns instead of reverting",
   "retry" in ast.unparse(resolve) and "return json.dumps" in ast.unparse(resolve))

# ── 5. No payable methods ───────────────────────────────────────────────────
print("\n 5. No money anywhere")
payable = [n for n, (node, decs) in public_methods().items()
           if any("payable" in d for d in decs)]
ck("no public method is payable", not payable, str(payable or "none"))
ck("gl.message.value is never read", "gl.message.value" not in src)
ck("no transfer interface is declared",
   "emit_transfer" not in src and "gl.evm.contract_interface" not in src)
ck("no balance field exists", "self.balance" not in src)

# ── 6. Conservative on unavailable ──────────────────────────────────────────
print("\n 6. Conservative when a fact could not be read")
verdict_rule = ast.unparse(fn("_verdict_of"))
ck("an UNKNOWN condition forces INCONCLUSIVE",
   "R_UNKNOWN" in verdict_rule and "V_INCONCLUSIVE" in verdict_rule)
ck("an unverifiable requirement forces INCONCLUSIVE",
   "unverifiable > 0" in verdict_rule)
ck("zero conditions is INCONCLUSIVE, never GRANTED",
   "conditions_total <= 0" in verdict_rule)
ck("a failed parse is INCONCLUSIVE", "not parsed_ok" in verdict_rule)
ck("GRANTED is the LAST clause, reachable only after every guard",
   verdict_rule.rindex("V_GRANTED") > verdict_rule.rindex("V_INCONCLUSIVE"))
facts = code_of(fn("_fetch_facts"))
ck("every fact carries a `known` flag",
   all(k in facts for k in ("age_known", "tx_count_known", "balance_known",
                            "failed_known")))
ck("a transient explorer is RETRY, never a verdict",
   "_transient" in facts and "'retry'" in facts)
ck("a lower-bound count can prove a PASS and never a FAIL",
   "tx_count_exact" in code_of(fn("_evaluate")))

# ── 7. Content hash ─────────────────────────────────────────────────────────
print("\n 7. Content hash")
ck("a content hash is computed and stored",
   "_content_hash" in src and "content_hash" in src)
builtin_hash = [n.lineno for n in ast.walk(tree) if isinstance(n, ast.Call)
                and isinstance(n.func, ast.Name) and n.func.id == "hash"]
ck("it is FNV-1a by hand, not Python's seeded hash()",
   "0xCBF29CE484222325" in src and not builtin_hash)
run_check = code_of(fn("_run_check"))
# Read the `hash_input` assignment as a TREE rather than slicing its text: what
# matters is the exact set of expressions fed to the hash, and a text search
# cannot tell one appearing there from one appearing anywhere else.
hash_parts = None
for node in ast.walk(fn("_run_check")):
    if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "hash_input" for t in node.targets):
        for sub in ast.walk(node.value):
            if isinstance(sub, ast.List):
                hash_parts = [ast.unparse(e) for e in sub.elts]
                break
ck("the hash input was found and is a fixed list", hash_parts is not None,
   "%d parts" % (len(hash_parts) if hash_parts else 0))
blob = " ".join(hash_parts or [])
ck("it hashes the policy, wallet, chain, parse and buckets",
   all(k in blob for k in ("policy_id", "policy_text", "wallet", "chain",
                           "cond_text", "unverifiable", "total", "met",
                           "age_b", "tx_b", "bal_b", "verdict")))
# The ONLY explorer-derived values allowed here are the three BUCKETS, which are
# themselves on the axis. A raw number, a body or the evidence digest appearing
# in this list is the exact failure docs/PROBE.md §5 measured.
ck("it hashes NO raw explorer bytes",
   not any(k in blob for k in ("digest", "body", "facts[", "age_days",
                               "tx_count", "balance_wei", "failed_pct")),
   "parts: " + ", ".join(hash_parts or []))
ck("verify_check recomputes it from stored evidence",
   "_content_hash" in code_of(fn("verify_check")))

# ── 8. settle_stalled ───────────────────────────────────────────────────────
print("\n 8. Stuck consensus has an exit")
stalled = public_methods().get("settle_stalled")
ck("settle_stalled exists and is public", stalled is not None)
stalled_src = ast.unparse(stalled[0]) if stalled else ""
ck("it is permissionless", "_require_owner" not in stalled_src
   and "sender_address" not in stalled_src)
ck("it can NEVER produce a GRANTED",
   "V_GRANTED" not in stalled_src and "V_INCONCLUSIVE" in stalled_src)
ck("it is gated on the resolution window", "resolution_window" in stalled_src)
ck("resolve_check lets anyone retry a pending check",
   "resolve_check" in public_methods()
   and "_require_owner" not in ast.unparse(public_methods()["resolve_check"][0]))

# ── 9. No str.replace() ─────────────────────────────────────────────────────
print("\n 9. Runner-rejected constructs")
bad_replace = [n.lineno for n in ast.walk(tree) if isinstance(n, ast.Call)
               and isinstance(n.func, ast.Attribute) and n.func.attr == "replace"]
ck("no .replace() call", not bad_replace, str(bad_replace or "none"))
ck("_strip_token slices around find() instead", fn("_strip_token") is not None)
ck("no lambda", not [n for n in ast.walk(tree) if isinstance(n, ast.Lambda)])
lines = src.split("\n")
ck("the runner header is the first two lines and nothing else",
   lines[0] == "# v0.3.0" and lines[1].startswith("# {")
   and lines[2].strip() == "import genlayer as gl")
pin = json.loads(lines[1][2:])["Depends"].split(":")[1]
ck("the runner pin is a concrete hash, not a moving alias",
   pin not in ("test", "latest", "dev") and len(pin) > 40, pin[:16] + "…")

# ── 10. Identity ────────────────────────────────────────────────────────────
print("\n10. Identity: the wallet is the subject, the caller is nobody")
check_access = ast.unparse(public_methods()["check_access"][0])
ck("check_access takes the wallet as an argument", "wallet" in check_access)
ck("the answer is keyed on (policy, wallet), not on the caller",
   "_pair_key" in check_access)
ck("the caller is recorded but never gates anything",
   "requester = gl.message.sender_address" in check_access
   and "sender_address !=" not in check_access)
grant = ast.unparse(fn("_grant_state"))
ck("is_granted reads the same _grant_state every view reads",
   "_grant_state" in ast.unparse(public_methods()["is_granted"][0]))
ck("a stale check is not a grant", "stale" in grant)
ck("an expired check is not a grant", "expired" in grant)
ck("a pending check is not a grant", "C_SETTLED" in grant)
latest_writers = set()
for node in ast.walk(tree):
    if isinstance(node, ast.FunctionDef):
        for sub in ast.walk(node):
            if isinstance(sub, ast.Assign):
                for t in sub.targets:
                    if isinstance(t, ast.Subscript) and "latest_check" in ast.unparse(t):
                        latest_writers.add(node.name)
ck("a PENDING check cannot displace a decided grant",
   latest_writers == {"_resolve"}, "written by " + ", ".join(sorted(latest_writers)))

# ── 11. Deposit lifecycle ───────────────────────────────────────────────────
print("\n11. Deposit lifecycle: there is none")
ck("no deposit, bond or stake field exists",
   not any(w in src for w in ("self.bond", "self.stake", "locked_", "protocol_balance")))
# "no refund path" is a claim about CODE, not about the word. The word appears
# in the header, explaining why there is nothing to refund.
money_methods = [n for n in public_methods()
                 if any(w in n for w in ("refund", "withdraw", "claim",
                                         "deposit", "sweep", "pay"))]
ck("no method moves value", not money_methods, str(money_methods or "none"))
ck("nothing calls a transfer primitive",
   not [n for n in ast.walk(tree) if isinstance(n, ast.Call)
        and isinstance(n.func, ast.Attribute)
        and n.func.attr in ("emit_transfer", "transfer", "send_value")])

# ── 12. The URL is never caller-supplied ────────────────────────────────────
print("\n12. The explorer URL is derived, never supplied")
builders = {"_counters_url", "_address_url", "_txlist_url", "_txs_url"}
offenders = []
for node in ast.walk(tree):
    if isinstance(node, ast.FunctionDef):
        doc = ast.get_docstring(node, clean=False)
        for sub in ast.walk(node):
            if isinstance(sub, ast.Constant) and isinstance(sub.value, str):
                if sub.value != doc and "blockscout" in sub.value and node.name not in builders:
                    offenders.append("%s:%d" % (node.name, sub.lineno))
ck("no host literal outside the three URL builders", not offenders,
   str(offenders or "none"))
for b in sorted(builders):
    node = fn(b)
    ck("%s takes no caller URL and reads CHAIN_HOSTS" % b,
       "url" not in [a.arg for a in node.args.args]
       and "CHAIN_HOSTS.get(chain" in ast.unparse(node))

# ── 13. The model's reach ───────────────────────────────────────────────────
print("\n13. The model reads the policy and nothing else")
prompts = [n for n in ast.walk(tree) if isinstance(n, ast.Call)
           and ast.unparse(n.func) == "gl.nondet.exec_prompt"]
ck("exec_prompt appears exactly once in the file", len(prompts) == 1,
   "%d call(s)" % len(prompts))
ck("_parse_prompt takes only the policy text",
   [a.arg for a in fn("_parse_prompt").args.args] == ["policy_text"])
ck("the prompt fences the policy", "FENCE_BEGIN" in ast.unparse(fn("_parse_prompt")))
ck("the model never produces a verdict",
   "verdict" not in ast.unparse(fn("_parse_policy")))
ck("the explorer is read BEFORE the model is asked anything",
   run_check.index("_fetch_facts") < run_check.index("_parse_policy"))
ck("policy text is defanged at write time",
   "_clean_text" in ast.unparse(public_methods()["create_policy"][0]))
ck("the injection flag is advisory and off the axis",
   "flagged" not in axis_src)

# ── 14. Owner powers ────────────────────────────────────────────────────────
print("\n14. The owner has no path into a decision")
forbidden = {"verdict", "conditions_met", "conditions_total", "content_hash",
             "wallet_age_bucket", "tx_count_bucket", "balance_bucket", "status"}
leaks = []
for name, (node, decs) in public_methods().items():
    body = ast.unparse(node)
    if "_require_owner" not in body:
        continue
    for sub in ast.walk(node):
        if isinstance(sub, ast.Assign):
            for t in sub.targets:
                if isinstance(t, ast.Attribute) and t.attr in forbidden:
                    leaks.append("%s writes %s" % (name, t.attr))
ck("no owner-gated method writes a decision field", not leaks, str(leaks or "none"))
for name in ("resolve_check", "settle_stalled"):
    ck("%s is not gated on paused (an exit must not be trapped)" % name,
       "self.paused" not in ast.unparse(public_methods()[name][0]))
for name in ("create_policy", "check_access"):
    ck("%s honours the pause" % name,
       "self.paused" in ast.unparse(public_methods()[name][0]))
ck("only the creator may rewrite or delete a policy",
   all("policy.creator" in ast.unparse(public_methods()[m][0])
       for m in ("update_policy", "delete_policy")))

# ── 15. The build ───────────────────────────────────────────────────────────
print("\n15. The deploy artifact")
if art:
    size = len(art.encode("utf8"))
    ck("within the measured deploy ceiling (53,000 accepted / 53,500 refused)",
       size < 53000, "%s bytes" % format(size, ","))
    art_public = set(public_methods(art_tree).keys())
    ck("the public ABI survived the mangle unchanged",
       art_public == set(public_methods().keys()),
       "%d methods" % len(art_public))
    ck("the class name survived", "class PolicyGate" in art)
    alines = art.split("\n")
    ck("the runner header survived",
       alines[0] == "# v0.3.0" and alines[2].strip() == "import genlayer as gl")
else:
    print("  SKIP  no artifact built — run tools/build.sh")

# ── summary ─────────────────────────────────────────────────────────────────
print("\n" + "-" * 70)
print("  %d passed, %d failed" % (len(PASS), len(FAIL)))
if FAIL:
    print("\n  FAILED:")
    for name in FAIL:
        print("    · " + name)
print("")
sys.exit(1 if FAIL else 0)
