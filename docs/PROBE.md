# PROBE — what the four explorers actually do

Every number in this file was **measured**, against the live hosts a PolicyGate
validator reaches, on 2026-09-19. Nothing here is inferred from documentation.

The captures are committed at `test/fixtures.json` (594 KB, 64 bodies from four
hosts plus seven of them fetched a second time seconds later, stored gzipped and
byte-identical after decoding), and the offline
suite asserts against them rather than against anything hand-written. Where a
measurement is the whole argument for a design decision, the numbers are given
and the decision is named.

Reproduce with `python3 test/test_logic.py` — the `TestRealBodies` class is
this document, executable.

---

## 1. All four chains answer every endpoint this contract reads

`PolicyGate` reads three URLs per wallet, and a fourth only for a busy one. All
four hosts answered all of them with a plain `GET`, HTTP 200, no browser and no
headers:

| endpoint | purpose | measured size |
|---|---|---|
| `/api/v2/addresses/{w}/counters` | transaction count | 100–118 B |
| `/api/v2/addresses/{w}` | native balance | 613–737 B |
| `/api/v2/addresses/{w}/transactions` | the recent sample **and**, when the page is not full, the first transaction | 36 B – 889 KB |
| `/api?…txlist&sort=asc&offset=1` | the first transaction, **only** when the page was full | ~614 B |

**Consequence:** no chain here needs `gl.nondet.web.render`. Sentinel needed it
for a fifth chain sitting behind a Cloudflare bot check; none of these four is.

**Why the v1 `/api` endpoint survives at all.** The v2 list cannot be sorted
ascending, so reaching a wallet's *first* transaction through it means
paginating the whole history — half a megabyte a page. The v1 endpoint answers
that one question in 614 bytes. It is called only when the v2 page came back
full, which §4 explains is the difference between a working gate and a
rate-limited one.

`sort`, `page` and `offset` are the v1 endpoint's own documented parameters, so
the v2 rule about unknown query parameters (§6) does not apply to it.

---

## 2. A transaction row carries its whole calldata

A row carries its full input data and neither endpoint has a way to ask it not
to, so row size is not a constant and a page's total is not predictable from its
row count. One wallet (`0xd8dA…6045`), one afternoon:

```
  v1  polygon,  offset=10           5,822 bytes
  v1  polygon,  offset=100      1,300,395 bytes    ← 10x the window, 223x the bytes
  v1  ethereum, offset=50          37,838 bytes
  v1  ethereum, offset=100        151,026 bytes
```

A 10x wider window cost 223x the bytes, because a handful of rows in it carry
enormous calldata — Polygon's is cheap enough that people use a lot of it. **No
single-chain measurement would have revealed this**: the same window on Ethereum
was 151 KB. A single contract-creation row is 50,481 bytes on its own, because
its input is the deployed bytecode.

The v2 page the contract actually reads is a fixed 50 items, and its size was
measured on every host:

```
  /api/v2/addresses/{w}/transactions, vitalik.eth
    ethereum   530,791 bytes      base       521,344 bytes
    arbitrum   535,814 bytes      polygon    888,652 bytes
    an address with no history         36 bytes
```

**50 is not a number this contract chooses.** It is the page size the host
serves, and `SAMPLE_SIZE` records it so the offline suite can assert the
assumption rather than inherit it silently — a test walks every captured page,
checks none exceeds it, checks the widest reaches it, and checks that a short
page never claims another one exists.

Half a megabyte per validator is the price of an endpoint that answers; §4 is
why the cheap one does not.

---

## 3. base.blockscout.com reports `transactions_count: "0"` for busy wallets

Measured, reproducible, and the reason rule 5 exists.

```
GET https://base.blockscout.com/api/v2/addresses/0xd8dA…6045/counters
{"transactions_count":"0","token_transfers_count":"0","gas_usage_count":"0",…}
```

— three times in a row, identical. Meanwhile, on the same host, the same wallet:

```
GET https://base.blockscout.com/api?module=account&action=txlist&address=0xd8dA…6045&sort=desc&page=1&offset=200
  status 1, 200 rows, timestamps spanning 1786360967 … 1789741615
```

and its first transaction is real and dated: block 2370740, 1691530827
(August 2023, Base's launch month).

**What would have happened without a cross-check.** Every policy with a
transaction requirement would have denied every wallet on Base, and it would
have done it *silently* — "0 transactions, DENIED" is exactly what a correct
answer about a fresh wallet looks like. That is the same class of failure
Sentinel's probe found on a different endpoint: a wrong answer that is
indistinguishable from a right one.

**Decision.** The counter is cross-examined against what the list plainly shows:

```
if counters_n >= sample_n:   exact count
else:                        LOWER BOUND of sample_n
```

and `_evaluate` then applies the asymmetry that makes a lower bound safe:

- a lower bound **above** the threshold **proves a PASS**;
- a lower bound **below** the threshold **proves nothing** → UNKNOWN → INCONCLUSIVE.

Never FAIL. `test_the_broken_counter_does_not_deny_a_base_wallet` asserts this
against the captured body.

---

## 4. The v1 and v2 APIs have separate rate-limit budgets, and v1's is unusable

The measurement that rewrote two of the four fetches.

Four fetches per validator is **twenty requests per check**, all leaving one
datacentre IP range within a second or two. The first version of this contract
read the transaction list through the v1 `/api` endpoint, and checks on Ethereum
stopped settling. Interleaving the two APIs one second apart, from one address:

```
   1 v2/counters HTTP 200   |  v1/txlist HTTP 429
   2 v2/counters HTTP 200   |  v1/txlist HTTP 429
   3 v2/counters HTTP 200   |  v1/txlist HTTP 429
   4 v2/counters HTTP 200   |  v1/txlist HTTP 429
   5 v2/counters HTTP 200   |  v1/txlist HTTP 429
   6 v2/counters HTTP 200   |  v1/txlist HTTP 429
```

Six for six, each way, alternating. They are not one budget.

And the v1 budget is not a burst limit — it does not recover:

```
  after   0s idle   v1 HTTP 429   (a different v1 action: 429)
  after  30s idle   v1 HTTP 429   (429)
  after  60s idle   v1 HTTP 429   (429)
  after  90s idle   v1 HTTP 429   (429)
```

The whole `/api` path is limited, not one action, and ninety seconds of complete
silence did not clear it. Meanwhile `/api/v2/addresses/{w}/transactions` answered
**12 of 12** across all four hosts and all three probe wallets.

This was visible on the live deployment before it was diagnosed: the first check
against a policy settled normally, and the two behind it exhausted the validators'
v1 quota and returned RETRY until they gave up. **Five validators fetching twice
each is ten v1 requests per check**, and one check was enough.

**Decision.** The sample moved to the v2 list, and the v1 endpoint is now read
for one thing only — a wallet's first transaction — and only when the v2 page came
back full. A page that is not full *is* the whole history, so its oldest row is
the first transaction. **For every wallet with 50 transactions or fewer, this
contract makes no v1 request at all.**

The v2 page also turned out to be the better document: `next_page_params` states
*exactly* whether more transactions exist, where the v1 row count could only be
guessed at, and that is precisely the difference between proving a required
interaction is absent and merely failing to find it.

**RETRY remains load-bearing.** A 429 anywhere is transient, so the whole check
becomes RETRY, the check stays PENDING, and `resolve_check` runs it again later.
That is why `retry_count` is stored per check, why `resolve_check` is
permissionless, and why `settle_stalled` sits behind both. A design that read a
429 as "this wallet has no transactions" would deny honest wallets at random.

## 5. A raw digest on the consensus axis would have failed on every chain

The measurement the axis design rests on, made on these four hosts rather than
inherited from a previous project.

The same wallet, the same URLs, fetched twice seconds apart — **5 of 7 bodies
came back different**:

| body | identical? | what moved |
|---|---|---|
| `ethereum:vitalik:counters` | yes | — |
| `base:vitalik:counters` | yes | — |
| `ethereum:vitalik:address` | **no** | `block_number_balance_updated_at`, `exchange_rate` |
| `ethereum:vitalik:txs` | **no** | `confirmations`, `exchange_rate` |
| `arbitrum:vitalik:txs` | **no** | `confirmations` |
| `polygon:vitalik:txs` | **no** | `confirmations`, `exchange_rate` |
| `base:vitalik:txs` | **no** | `confirmations`, `exchange_rate`, **`decoded_input`, `method`** |

That last row is the sharpest version of the point: between two fetches seconds
apart, Base's indexer finished **decoding method names** it had not decoded on
the first. The replicas do not merely lag on block height — they disagree about
the *content* of rows neither fetch disputes.

`confirmations` moves on **every row of every chain**, because it is the block
height minus the transaction's block. It cannot decide a policy condition. Nor
can `exchange_rate`, which is additionally a float on one chain and a string on
another. Nor can `block_number_balance_updated_at`.

Feeding those bodies to a hash and putting the hash on the axis:

```
  ethereum   raw digest DIFFER    buckets (7, 7, 5) vs (7, 7, 5)   SAME
  base       raw digest DIFFER    buckets (7, 4, 5) vs (7, 4, 5)   SAME
  arbitrum   raw digest DIFFER    buckets (7, 7, 4) vs (7, 7, 4)   SAME
  polygon    raw digest DIFFER    buckets (7, 6, 7) vs (7, 6, 7)   SAME

  a raw digest on the axis would have disagreed on 4/4
  the quantised vector disagreed on               0/4
```

A hash amplifies a one-bit difference into a total one. Sentinel measured the
same phenomenon differently — validators disagreeing about **one round in four**
on a digest of a *projection* whose every mandate-relevant field was identical,
because Blockscout is a load-balanced cluster whose replicas index at slightly
different rates.

**Decision.** The axis carries a **quantised feature vector**, and every field on
it is one of three things:

| field | why it is stable |
|---|---|
| `verdict` | one of three words, from integer comparison |
| `conditions_met` / `conditions_total` | counts over a **snapped** parse (§7) |
| `wallet_age_bucket` | from the FIRST transaction — immutable — against the **block** clock |
| `tx_count_bucket` | log-scale; a wallet must cross an order of magnitude mid-round to move it |
| `balance_bucket` | likewise |
| `content_hash` | a hash of the six above, plus the policy and the wallet — **no raw bytes** |

The content hash earns its place on the axis precisely because it contains no
explorer output: it is a pure function of values the validators must already
agree about, so it binds them together and can never itself be what they fall
out over.

The **evidence digest** — a hash of the raw numbers — is stored on every check
and is **never voted on**. It is published so a reader can re-derive what a
validator saw; a mismatch is a reason to distrust that leader, not a consensus
value. `test_the_evidence_digest_is_NOT_on_the_axis` asserts the distinction.

`test_a_raw_digest_on_the_axis_would_have_FAILED_and_the_vector_did_not` runs
this whole comparison in the offline suite.

---

## 6. Deterministic answers, and how they present

Worth writing down because three of these look like failures and are not.

| condition | HTTP | body | read as |
|---|---|---|---|
| wallet with no history | 200 | `{"message":"No transactions found","result":[],"status":"0"}` | **empty history, KNOWN** — age 0, count 0, exact |
| address never indexed | 200 | `"coin_balance": null` | **holds nothing, KNOWN** |
| malformed address, v2 | **422** | `{"errors":[{"detail":"Invalid format. Expected ~r/^0x([A-Fa-f0-9]{40})$/"}]}` | not transient |
| malformed address, v1 | 200 | `{"message":"Invalid address format","result":null,"status":"0"}` | not ok |
| unknown query parameter, v2 | **422** | — | the reason no v2 URL here carries one |

`status: "0"` on the v1 API is **not an error code**. It is how both "no
transactions" and "invalid address" present, and telling them apart is the whole
job of `_tx_rows`. Reading the first as a failure would make every brand-new
wallet INCONCLUSIVE instead of correctly DENIED — which is precisely the
population an age gate exists to exclude.

`coin_balance: null` is a real answer meaning zero, and treating it as zero
fails in the safe direction: a balance policy DENIES rather than grants.

---

## 7. What the block clock fixes that a wall clock cannot

Two stabilisers use `gl.message.raw["datetime"]`, which is identical for every
validator in a round, where the obvious implementation would use wall-clock time
and would not be.

**Wallet age.** `age_days = (block_time − first_tx_time) // 86400`. The first
transaction is immutable, and the block time is shared, so the age is the same
integer on every node. A wall clock would give two validators a few seconds
apart different ages for the same transaction — and at a bucket boundary, a
different axis.

**The sample cutoff.** Rows newer than `block_time − 300s` are dropped before
anything is computed from the sample. Two validators fetching seconds apart see
different *newest* rows, so a failure rate over "the last 25" would differ
between them for no reason anybody could audit. Every validator trims to the
same instant, and anything older than five minutes has been indexed everywhere.

---

## 8. Snapping, and the one nondeterministic step

The parse is the only place a model is used, and a threshold is where its
nondeterminism shows up first: "at least a couple of months old" is 60 days to
one model and 61 to another, and two validators that disagree by one day
disagree about the whole check.

Every threshold is snapped to the nearest rung of a fixed ladder, ties resolving
**downward** — a rule rather than a rounding mode, because every validator must
break a tie the same way. Both readings above land on 60.

Two further canonicalisations collapse the rest of that class:

- **A vacuous condition is not a condition.** "at least 0 transactions" is what
  one model writes where another writes `null`, and `conditions_total` is on the
  axis. A zero minimum, and a 100% failure allowance, are dropped rather than
  counted.
- **Addresses are copied, never resolved.** A model asked what address Uniswap
  is will answer, confidently and differently on different runs, and five
  validators would then check five different contracts. Only a literal
  `0x`-prefixed address appearing in the policy is used; a protocol named in
  words is counted as *unverifiable*, which forces INCONCLUSIVE.

---

## 9. What is still true and not fixed

- **A wallet sitting exactly on a bucket edge can still split a round.** A
  wallet with 999 transactions that makes its 1000th mid-round moves
  `tx_count_bucket` from 5 to 6, and the validators disagree. The outcome is
  UNDETERMINED — no state applied, the check stays PENDING, `resolve_check`
  tries again. It is rare, it is safe, and it is the price of putting the
  numbers on the axis at all. Leaving them off would let a leader forge them.
- **The sample is a sample.** `max_failed_tx_pct` is computed over the served
  page — at most 50 transactions, older than five minutes — and not over the
  whole history. The stored condition detail says so in as many words.
- **A policy this gate cannot express is INCONCLUSIVE, never GRANTED**, but it
  is also never DENIED. The gate declines to decide rather than deciding wrongly,
  and `is_granted` answers false either way.
