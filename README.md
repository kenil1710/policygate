# PolicyGate

**Access control written in English, decided by consensus.**

An owner writes a policy in plain English:

> *The wallet must be at least one year old measured from its very first
> transaction, must have made at least 100 transactions, must hold at least
> 0.01 ETH, and no more than 25 percent of its recent transactions may have
> failed.*

Anyone may then ask whether a given wallet satisfies it. Five GenLayer
validators independently **parse** that sentence into structured conditions,
independently **fetch** the wallet's history from Blockscout on one of four
chains, independently **evaluate** each condition in Python against the numbers
they fetched, and agree on a **feature vector**.

Any contract can then call `is_granted(wallet, policy_id)` and get a bool.

```
  ┌─ create_policy ────────────────────────────────────────────────┐
  │  "at least a year old, 100+ transactions, 0.01 ETH, <25% fail" │
  └────────────────────────────────┬───────────────────────────────┘
                                   │
  ┌─ check_access(wallet, policy) ─▼───────────────────────────────┐
  │                                                                │
  │   each validator, independently:                               │
  │                                                                │
  │     1. FETCH   3 Blockscout endpoints ── counters, balance,    │
  │                and one page of transactions (a 4th, for the    │
  │                first tx, only when that page came back full)   │
  │     2. PARSE   the POLICY through a model → snapped conditions │
  │                (the model never sees the wallet)               │
  │     3. EVALUATE  integer comparison, in Python, per condition  │
  │                                                                │
  │   then agree on one vector:                                    │
  │     verdict │ met │ total │ age_bucket │ tx_bucket │ bal_bucket│
  │             │ content_hash                                     │
  └────────────────────────────────┬───────────────────────────────┘
                                   │
  ┌─ is_granted(wallet, policy) ───▼─── bool ──────────────────────┐
  │  true only for a SETTLED, GRANTED, CURRENT, UNEXPIRED check    │
  └────────────────────────────────────────────────────────────────┘
```

---

## Why this needs GenLayer

A regular contract can read on-chain state on its own chain. It cannot:

- **parse a natural-language policy** into structured conditions;
- **fetch cross-chain data** from Blockscout on Ethereum, Base, Arbitrum and
  Polygon;
- **verify a wallet's history** on a chain it does not live on;
- **agree** with four other nodes about a number none of them can prove alone.

## Why this is not a thin LLM wrapper

The model does exactly one thing: it turns one English sentence into a JSON form
with six fixed keys. It is **never shown a wallet** and **never asked for a
verdict** — a static test asserts `exec_prompt` appears exactly once in the file,
that `_parse_prompt` takes only the policy text, and that no wallet address can
reach a prompt.

Every decision after that is integer comparison in Python on numbers five
validators fetched separately:

```python
age_days >= 90        tx_count >= 50        balance_wei >= 50000000000000000
failed_pct <= 20      required_address in parties
```

A wallet has **no channel through which to address the evaluator**, because the
evaluator is never shown it.

---

## The consensus axis

Seven fields, one string. Every field on it is quantised, immutable, or a pure
function of the others:

| field | what makes it stable |
|---|---|
| `verdict` | GRANTED / DENIED / INCONCLUSIVE, from integer comparison |
| `conditions_met` | a count of PASSes over a **snapped** parse |
| `conditions_total` | the size of that parse |
| `wallet_age_bucket` | from the **first** transaction — immutable — against the **block** clock |
| `tx_count_bucket` | log-scale; a wallet must cross an order of magnitude mid-round to move it |
| `balance_bucket` | likewise |
| `content_hash` | a hash of the six above plus the policy, wallet and chain — **no raw bytes** |

**A leader cannot forge a wallet age, a transaction count or a balance**,
because all three are on the axis in bucketed form.

**A raw digest is deliberately not on it.** [`docs/PROBE.md` §5](docs/PROBE.md)
measured the same wallet fetched twice seconds apart returning **different
bodies on 5 of 7 captures** — `confirmations` moves on every row of every chain,
and Base additionally finished decoding method names between the two fetches. A
digest on the axis would have disagreed on **4 of 4** chains; the quantised
vector disagreed on **0 of 4**. The evidence digest is stored on every check and
**never voted on**.

---

## Three rules the measurements forced

**A number that could not be read is never a pass.** Every fact carries a
`known` flag and every condition can answer UNKNOWN. An unknown pushes the
verdict to INCONCLUSIVE — never to GRANTED. An empty parse is INCONCLUSIVE too:
"no conditions, therefore all conditions met" is a gate that opens for everyone
the moment someone writes a policy the parser cannot reduce.

**A lower bound may prove a PASS and may never prove a FAIL.**
`base.blockscout.com` reports `transactions_count: "0"` for wallets with
hundreds of transactions — measured, reproducible, committed as a fixture
([§3](docs/PROBE.md)). Reading it as a real zero would have denied every wallet
on Base *silently*, because "0 transactions, DENIED" looks exactly like a correct
answer about a fresh wallet.

**A policy this gate cannot express is INCONCLUSIVE, not GRANTED and not
DENIED.** "…and the holder must have passed the foundation's off-chain identity
verification" is a real requirement no on-chain condition expresses. The parser
counts it; the gate declines to decide. Policy 4 in the seed demonstrates this
on a live network.

---

## No money, and therefore no raise

`PolicyGate.py` contains **zero `raise` statements** and **no payable method** —
both asserted by parsing the AST of the source *and* the built artifact.

A gate holds no money: no bond, no stake, no deposit, no refund path. So the
usual hazard — a payable method that reverts keeps the caller's value, because a
`UserError` rolls back storage but not the transfer that rode in with it — cannot
arise, and the rule is free to be the stronger one. Every rejection is a
**successful transaction** returning `{"ok": false, "reason": "..."}`.

The RETRY path is where a contract like this would normally revert. It does not
need to: at that point in `_resolve` no verdict, no counter and no status has
been touched, so **retrying is simply not writing** — and the revert it replaces
would have rolled back the check row itself, losing a validly asked question.

---

## Five ways a grant is not a grant

`is_granted` returns `true` only for a wallet whose **latest** check against a
**live** policy is SETTLED, GRANTED, made against the **current** version of the
policy text, and inside the configured lifetime.

| state | why it is not access |
|---|---|
| no check | nobody ever asked; absence is not permission |
| not SETTLED | a PENDING or STALLED check decided nothing |
| verdict not GRANTED | the obvious one |
| **STALE** | the policy was rewritten after the check |
| **EXPIRED** | older than the TTL |

Without the stale rule, tightening a policy would be purely cosmetic — everyone
already through the gate would stay through it. The old checks stay fully
readable as the audit trail of what the policy used to say and who satisfied it.

And a **pending question never displaces a decided grant**: since anyone may
check anyone, writing the current answer at filing time would let anybody
suspend a competitor's grant just by asking about their wallet at a moment when
the explorer was down.

---

## Methods

**Write**

| method | who | notes |
|---|---|---|
| `create_policy(name, description, chain, policy_text)` | anyone | 50–1000 chars, 1 per wallet per 300s |
| `check_access(wallet, policy_id)` | **anyone** | files and resolves in one call |
| `resolve_check(check_id)` | **anyone** | re-runs a PENDING check |
| `update_policy(policy_id, new_text)` | creator | bumps the version; every earlier check goes stale |
| `delete_policy(policy_id)` | creator | refused while a check is unresolved |
| `settle_stalled(check_id)` | **anyone** | can only ever produce INCONCLUSIVE |
| `set_paused` / `set_params` / `transfer_ownership` | owner | no path into a decision |

**View**

`get_policy` · `get_policies` · `get_policies_by_creator` · `get_policies_by_chain` ·
`get_check` · `get_checks` · `get_checks_by_policy` · `get_wallet_history` ·
`get_pending_checks` · `get_access_status` · **`is_granted`** · `get_stats` ·
`get_config` · `verify_check`

`is_granted` is the only method returning a bare `bool`, because it exists to be
called by another contract. **False is the answer for every failure**, including
a malformed address and a policy that does not exist — a gate whose error case is
`true` is not a gate. Callers needing the distinction read `get_access_status`.

### Composability

```python
@gl.public.write
def claim(self) -> str:
    gate = gl.contract.get_contract_at(Address(POLICYGATE_ADDRESS))
    if not gate.view().is_granted(str(gl.message.sender_address), POLICY_ID):
        return json.dumps({"ok": False, "reason": "wallet does not satisfy the policy"})
    ...
```

---

## Layout

```
contracts/PolicyGate.py     the contract, with its reasoning
contracts/NOTES.md          hazards and decisions not recoverable from the code
docs/PROBE.md               every measurement, with numbers
build/PolicyGate.min.py     the deployed artifact (42 KB)
test/test_logic.py          393 offline tests — source AND mangled artifact
test/fixtures.json          71 verbatim Blockscout bodies from four live hosts
test/deploy.mjs             deploys the artifact, never the source
test/seed.mjs               5 policies across 4 chains, 14 real wallets checked
test/e2e.mjs                live integration suite
test/resolve_pending.mjs    the operational half of the RETRY design
test/record.mjs             writes what the chain holds into deployments.json
tools/build.sh              minify → mangle → lint
tools/checklist.py          79 rejection-pattern checks, decided by parsing
tools/audit.sh              all of the above in one command
```

## Running it

```bash
bash tools/audit.sh                          # build + checklist + 393 tests + chain state

cd test && npm install
node accounts.mjs                            # a stable pool of signing keys
node deploy.mjs   --network=studiodev
node seed.mjs     --network=studiodev        # 5 policies, 14 wallets
node e2e.mjs      --network=studiodev
node resolve_pending.mjs --network=studiodev --rounds=4 --gap=300
node record.mjs   --network=studiodev        # snapshot the chain into deployments.json
```

**Expect RETRYs.** Three fetches per validator, four for a busy wallet, all
leaving one datacentre IP range at once, and the explorers rate limit hard
([§4](docs/PROBE.md) — the measurement that moved the sample off the v1 API
after it stopped live checks from settling). A check that cannot be decided stays PENDING and
anyone can resolve it later; one that stays stuck past the window can be closed
by anyone as INCONCLUSIVE. That path is not an edge case here — it is the normal
way a busy gate makes progress.

## What it did on studio-dev

Five policies, four chains, fifteen wallets checked — every one a real address
with a real history, every verdict decided on numbers five validators fetched
separately. Full records, including each policy's exact parse and each check's
agreed vector, are in `deployments.json`.

```
id  pol chain     wallet       verdict       met    buckets        unverifiable
 0  p3  polygon   0x28c6c062   GRANTED       4/4    age6 tx3 bal6  0
 1  p2  arbitrum  0x28c6c062   DENIED        2/3    age7 tx3 bal4  0
 2  p2  arbitrum  0x33015b74   DENIED        1/3    age1 tx1 bal1  0
 3  p3  polygon   0xd8da6bf2   GRANTED       4/4    age7 tx6 bal7  0
 4  p2  arbitrum  0xd8da6bf2   GRANTED       3/3    age7 tx7 bal4  0
 5  p1  base      0xd8da6bf2   GRANTED       4/4    age7 tx4 bal5  0
 6  p1  base      0x28c6c062   GRANTED       4/4    age7 tx4 bal2  0
 7  p3  polygon   0x1f98431c   DENIED        2/4    age7 tx4 bal1  0
 8  p2  arbitrum  0x1f98431c   DENIED        2/3    age7 tx5 bal1  0
 9  p1  base      0x42000000   GRANTED       4/4    age7 tx5 bal7  0
10  p0  ethereum  0xd8da6bf2   GRANTED       4/4    age7 tx7 bal5  0
11  p0  ethereum  0x33015b74   DENIED        1/4    age1 tx1 bal1  0
12  p0  ethereum  0x28c6c062   GRANTED       4/4    age7 tx6 bal7  0
13  p4  ethereum  0xd8da6bf2   INCONCLUSIVE  3/3    age7 tx7 bal5  2
14  p4  ethereum  0x33015b74   DENIED        0/3    age1 tx1 bal1  2
```

**Checks 13 and 14 are the pair worth reading.** Same policy — the one carrying
a genuine off-chain clause ("must also have passed the foundation's identity
verification… and be a resident of a jurisdiction where governance participation
is permitted"), which both rounds counted as exactly **2** unverifiable
requirements. vitalik.eth meets all three on-chain conditions, so the gate
**declines to decide**. The wallet with no history provably fails all three, so
it is **denied outright**. A proven failure outranks an unprovable requirement;
an unprovable requirement outranks a clean sweep. That ordering is the whole of
`_verdict_of`, and this is it running on real data.

**Every policy parsed identically on every run** — `parse_changes = 0` across
all 15 rounds — which is what the snapping ladders exist for. Their exact
readings:

```
Ethereum Veteran       wallet_age_days=365; min_tx_count=100;
                       min_balance=10000000000000000; max_failed_tx_pct=25
Arbitrum Active Trader wallet_age_days=90;  min_tx_count=50; max_failed_tx_pct=20
Polygon Holder         wallet_age_days=30;  min_tx_count=5;
                       min_balance=1000000000000000000; max_failed_tx_pct=40
Strict Council Seat    wallet_age_days=730; min_tx_count=500;
                       min_balance=50000000000000000
```

"one year" became 365, "two years" 730, "0.01 ETH" the right number of wei, and
"there is no minimum balance requirement for this gate" correctly became no
balance condition at all rather than an unverifiable one.

**49 retries across 15 checks**, and every one of them is the same story: a busy
wallet needs the v1 first-transaction call, and that quota is scarce
([§4](docs/PROBE.md)). All 15 settled in the end. How they were drained is
itself a finding — see `test/resolve_pending.mjs`: retrying the whole backlog on
a short loop spends more quota than it recovers, and resolving three at a time
with long gaps drained everything that hammering could not.

## Deployment

`deployments.json` carries the current address, the artifact checksum, every
seeded policy with its text and its parse stability, and every check with the
seven-field vector five validators agreed on. It is written by `record.mjs`
reading the chain back — not by whatever script last wrote to it — so it is a
snapshot rather than a claim.

`tools/audit.sh` verifies that the deployed checksum still matches what this
tree builds, and prints the live counts beside it.
