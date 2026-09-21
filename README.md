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
test/test_logic.py          398 offline tests — source AND mangled artifact
test/fixtures.json          71 verbatim Blockscout bodies from four live hosts
test/deploy.mjs             deploys the artifact, never the source
test/seed.mjs               5 policies across 4 chains, 15 checks on real wallets
test/e2e.mjs                live integration suite
test/resolve_pending.mjs    the operational half of the RETRY design
test/record.mjs             writes what the chain holds into deployments.json
tools/build.sh              minify → mangle → lint
tools/checklist.py          79 rejection-pattern checks, decided by parsing
tools/verify_onchain.py     reads the code back off the chain and compares sha256
tools/audit.sh              all of the above in one command
```

## Running it

```bash
bash tools/audit.sh                          # build + checklist + 398 tests + chain state

cd test && npm install
node accounts.mjs                            # a stable pool of signing keys
node deploy.mjs   --network=studiodev
node seed.mjs     --network=studiodev        # 5 policies, 15 checks
node e2e.mjs      --network=studiodev
node resolve_pending.mjs --network=studiodev --rounds=5 --gap=1800 --max-per-round=4
python3 tools/verify_onchain.py <address> build/PolicyGate.min.py
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

Contract **`0xB0F8bE23f9Ae0f53D818D0b9C68F6641c22500A4`** — running the artifact
in this tree, verified byte for byte against the chain (see **Deployment**).

Five policies, four chains, sixteen checks — every wallet a real address with a
real history, every verdict decided on numbers five validators fetched
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
 9  p1  base      0x42000000   GRANTED       4/4    age7 tx4 bal7  0
10  p0  ethereum  0xd8da6bf2   GRANTED       4/4    age7 tx7 bal5  0
11  p0  ethereum  0x33015b74   DENIED        1/4    age1 tx1 bal1  0
12  p0  ethereum  0x28c6c062   DENIED        3/4    age7 tx5 bal7  0
13  p4  ethereum  0xd8da6bf2   INCONCLUSIVE  3/3    age7 tx7 bal5  2
14  p4  ethereum  0x33015b74   DENIED        0/3    age1 tx1 bal1  2
```

The sixteenth is the integration suite's own: `e2e.mjs` creates a policy, checks
a wallet against it, rewrites it and then deletes it, so check 15 is recorded
STALE against a DELETED policy. That is the pair of states that makes rewriting
a policy mean something — the check stays readable as evidence and grants
nothing.

**Checks 13 and 14 are the pair worth reading.** Same policy — the one carrying
a genuine off-chain clause ("must also have passed the foundation's identity
verification… and be a resident of a jurisdiction where governance participation
is permitted"), which every round on both deployments counted as exactly **2**
unverifiable requirements. vitalik.eth meets all three on-chain conditions, so
the gate **declines to decide**. The wallet with no history provably fails all
three, so it is **denied outright**. A proven failure outranks an unprovable
requirement; an unprovable requirement outranks a clean sweep. That ordering is
the whole of `_verdict_of`, and this is it running on real data.

**The same fifteen checks ran twice, two days apart, on two deployments**, and
thirteen came back identical — same verdict, same count, same three buckets.
Two moved, and in both the data moved rather than the gate:

- **check 9** (the WETH predeploy on Base) kept GRANTED 4/4 and moved
  `tx_count_bucket` from 5 to 4. Base's counter endpoint reports
  `transactions_count: "0"` ([§3](docs/PROBE.md)), so the count is a lower bound
  read off the served page — and a lower bound may prove a PASS and may never
  prove a FAIL, which is exactly why the verdict did not move with it.
- **check 12** (Binance 14 against *Ethereum Veteran*) went from GRANTED 4/4 to
  DENIED 3/4. The wallet is 1,978 days old, holds 155,026 ETH and has made 742
  transactions, so it passes those three comfortably. It failed
  `max_failed_tx_pct` on a sample of **three** rows, all three of which had
  failed. The page came back full and the five-minute lag window dropped 47 of
  its 50 rows, because this wallet is busy enough that they were all younger
  than the window. Nothing was misread — `sample_n: 3` is stored on the check —
  and `contracts/NOTES.md` §12 carries the fix, a minimum sample size that makes
  this INCONCLUSIVE rather than DENIED, together with why it is deliberately not
  in this artifact.

**Every policy parsed identically on every run** — `parse_changes = 0` across
all sixteen rounds, on both deployments — which is what the snapping ladders
exist for. Their exact readings, unchanged between the two runs:

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

**32 retries across 16 checks**, every one the same story: a busy wallet needs
the v1 first-transaction call and that quota is scarce ([§4](docs/PROBE.md)).
All 16 settled. How they drained is itself the finding, and this run made it
sharper than the first one did. Four checks sat PENDING through **six rounds of
three-at-a-time with five-minute gaps — thirty retries that recovered
nothing** — and then all four settled on the **first** attempt after the
explorers had been left alone for about twenty minutes. The retry is the thing
preventing the recovery.

`test/resolve_pending.mjs` also grew a rotating window here, for a starvation
this run exposed: `get_pending_checks` answers in check_id order, so a fixed
window over the head of it retried checks 7, 8 and 9 six times each while check
13 — filed, valid and decidable — was never tried once.

## Deployment

```
address   0xB0F8bE23f9Ae0f53D818D0b9C68F6641c22500A4   studio-dev
artifact  build/PolicyGate.min.py   44,090 bytes   sha256 e56dfc93b681611e…
source    contracts/PolicyGate.py   at 93ada5c9
```

`deployments.json` carries that address, the checksum of the bytes that actually
went on chain, every seeded policy with its text and its parse stability, and
every check with the seven-field vector five validators agreed on. It is written
by `record.mjs` reading the chain back — not by whatever script last wrote to it
— so it is a snapshot rather than a claim.

**The deployed bytes are the source in this tree, and that is checkable rather
than asserted:**

```bash
bash tools/build.sh                 # rebuild the artifact from contracts/PolicyGate.py
python3 tools/verify_onchain.py 0xB0F8bE23f9Ae0f53D818D0b9C68F6641c22500A4 \
                                build/PolicyGate.min.py
# MATCH  sha256 e56dfc93b681611ec5fe43071a15c72f70feadfa7dddd75808f9a1a8a751e0ee
```

`verify_onchain.py` reads the code back with `genlayer code`, strips the CLI's
chrome and compares sha256. It has three answers — MATCH, EQUIVALENT (the same
token stream under a bijective renaming of private identifiers) and DIFFER — and
this deployment is **MATCH**, not EQUIVALENT. `tools/audit.sh` prints the same
comparison beside the live counts on every run, and distinguishes "the artifact
differs" from "the source has moved on since this deploy", because those call
for opposite responses.

An earlier deployment (`0xCd0865Ce…`) was one commit behind on a single view
field — `parse_stable` answering `false` where the source answers `null` for a
policy nobody has checked yet — and was submitted that way. It is recorded under
`supersedes` in `deployments.json`, and why keeping it was the wrong call is
`contracts/NOTES.md` §13.
