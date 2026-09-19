/**
 * Publishes the demonstration policies and checks a roster of real wallets
 * against them.
 *
 *   node seed.mjs --network=studiodev
 *
 * Every wallet below is a REAL address with a REAL history on the chain it is
 * checked against, so every verdict is decided on numbers five validators
 * fetched from Blockscout rather than on anything this script supplies.
 *
 * TWO THINGS THIS SCRIPT HAS TO GET RIGHT, both of them lessons paid for
 * elsewhere:
 *
 *   A SETTLED TRANSACTION IS NOT A DECIDED CHECK. check_access returns
 *   {"ok": false, "retry": true} as a perfectly SUCCESSFUL transaction when the
 *   explorer was rate limited, and the check stays PENDING. A script that
 *   counted transactions would report a full roster of results and have decided
 *   nothing. Every result here is read back out of contract STATE.
 *
 *   FOUR FETCHES PER VALIDATOR IS TWENTY REQUESTS PER CHECK, all leaving one
 *   IP range at once, and Blockscout rate limits hard. RETRY is the normal way
 *   this makes progress, so a pending check is resolved again with backoff
 *   rather than reported as a failure.
 */
import { readFileSync } from "node:fs";
import { connect, argOf, returnedJson, sleep, retry } from "./harness.mjs";

const networkName = argOf("network", "studiodev");
const deployments = JSON.parse(readFileSync(new URL("../deployments.json", import.meta.url), "utf8"));
const address = deployments.deployments?.[networkName]?.PolicyGate?.address;
if (!address) throw new Error(`no PolicyGate address recorded for ${networkName}`);

const RESOLVE_ATTEMPTS = Number(argOf("resolve-attempts", "4"));

/* ── the policies ──────────────────────────────────────────────────────────
 *
 * Written the way somebody gating a real thing would write them: in English,
 * with the numbers a person would actually say. Policy 5 deliberately contains
 * a requirement no on-chain condition can express, to show that the gate says
 * INCONCLUSIVE rather than quietly dropping it.
 */
const POLICIES = [
  {
    role: "creator",
    name: "Ethereum Veteran",
    description: "A long-standing, active mainnet wallet. Suitable for gating an early-contributor airdrop.",
    chain: "ethereum",
    text: "To pass this gate the wallet must be at least one year old measured from its very first transaction, must have made at least 100 transactions, must hold at least 0.01 ETH, and no more than 25 percent of its recent transactions may have failed.",
  },
  {
    role: "creator2",
    name: "Base Early Adopter",
    description: "Present on Base for at least six months with a real transaction history.",
    chain: "base",
    text: "The wallet must have been active on Base for at least six months since its first transaction, must have made at least 10 transactions, and must currently hold at least 0.001 ETH. No more than half of its recent transactions may have failed.",
  },
  {
    role: "requester",
    name: "Arbitrum Active Trader",
    description: "A wallet that trades on Arbitrum often and cleanly.",
    chain: "arbitrum",
    text: "Access requires a wallet at least 90 days old that has made at least 50 transactions on Arbitrum, with no more than 20 percent of its recent transactions having failed. There is no minimum balance requirement for this gate.",
  },
  {
    role: "requester2",
    name: "Polygon Holder",
    description: "A modest, established Polygon wallet. The easiest of the five to pass.",
    chain: "polygon",
    text: "The wallet must be at least 30 days old, must have made at least 5 transactions on Polygon, and must hold at least 1 POL. Up to 40 percent of its recent transactions may have failed; Polygon is cheap enough that people retry.",
  },
  {
    role: "resolver",
    name: "Strict Council Seat",
    description: "Deliberately carries a requirement no on-chain condition can express, so the gate answers INCONCLUSIVE rather than guessing.",
    chain: "ethereum",
    text: "A council seat requires a wallet at least two years old with at least 500 transactions, holding at least 0.05 ETH. The holder must also have passed the foundation's off-chain identity verification and must be a resident of a jurisdiction where governance participation is permitted.",
  },
];

/* ── the roster ────────────────────────────────────────────────────────────
 * Real addresses, each checked on a chain where it has a history.
 */
const ROSTER = [
  { policy: 0, wallet: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", note: "vitalik.eth — ancient, busy, funded" },
  { policy: 0, wallet: "0x28C6c06298d514Db089934071355E5743bf21d60", note: "Binance 14 — exchange hot wallet" },
  { policy: 0, wallet: "0x33015b74a177b62554e5DcD8d622d1233CCf0cb4", note: "an address with no history at all" },
  { policy: 1, wallet: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", note: "vitalik.eth on Base — where the counter reads 0" },
  { policy: 1, wallet: "0x28C6c06298d514Db089934071355E5743bf21d60", note: "Binance 14 on Base" },
  { policy: 1, wallet: "0x4200000000000000000000000000000000000006", note: "WETH predeploy — a contract, not a person" },
  { policy: 2, wallet: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", note: "vitalik.eth on Arbitrum" },
  { policy: 2, wallet: "0x1F98431c8aD98523631AE4a59f267346ea31F984", note: "Uniswap V3 factory on Arbitrum" },
  { policy: 2, wallet: "0x33015b74a177b62554e5DcD8d622d1233CCf0cb4", note: "no history — should be denied on age" },
  { policy: 3, wallet: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", note: "vitalik.eth on Polygon" },
  { policy: 3, wallet: "0x28C6c06298d514Db089934071355E5743bf21d60", note: "Binance 14 on Polygon" },
  { policy: 3, wallet: "0x1F98431c8aD98523631AE4a59f267346ea31F984", note: "Uniswap V3 factory on Polygon" },
  { policy: 4, wallet: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", note: "vitalik.eth vs a policy with an unverifiable clause" },
  { policy: 4, wallet: "0x33015b74a177b62554e5DcD8d622d1233CCf0cb4", note: "no history vs the same policy" },
];

const reader = connect({ networkName, address, role: "client" });

console.log(`\nPolicyGate seed → ${networkName}`);
console.log(`  contract   ${address}\n`);

/* ── 1. the policies ─────────────────────────────────────────────────────── */
const ids = [];
for (const spec of POLICIES) {
  const c = connect({ networkName, address, role: spec.role });
  const out = await c.send("create_policy", [spec.name, spec.description, spec.chain, spec.text]);
  const body = returnedJson(out.returned);
  if (body?.ok) {
    ids.push(body.policy_id);
    console.log(`  ✔ policy ${String(body.policy_id).padEnd(2)} ${spec.name.padEnd(24)} ${spec.chain.padEnd(9)} v${body.version}`);
  } else {
    // A rejection is a SUCCESSFUL transaction here; read the reason, not the status.
    ids.push(null);
    console.log(`  ✗ ${spec.name.padEnd(24)} ${body?.reason ?? out.revertReason ?? out.failure ?? "unreadable"}`);
  }
}

/* ── 2. the checks ───────────────────────────────────────────────────────── */
console.log("");
const results = [];
for (const entry of ROSTER) {
  const pid = ids[entry.policy];
  if (pid === null || pid === undefined) continue;
  const c = connect({ networkName, address, role: "requester" });
  const label = `${String(pid)}/${entry.wallet.slice(0, 10)}…`;

  let out = await c.send("check_access", [entry.wallet, pid]);
  let body = returnedJson(out.returned);
  let checkId = body?.check_id;

  // RETRY is the normal way a rate-limited check makes progress.
  for (let i = 0; i < RESOLVE_ATTEMPTS && body?.retry && checkId !== undefined; i++) {
    const wait = 15_000 * (i + 1);
    console.log(`    … ${label} explorer was unavailable; resolving again in ${wait / 1000}s`);
    await sleep(wait);
    out = await c.send("resolve_check", [checkId]);
    body = returnedJson(out.returned);
  }

  /*
   * STATE IS THE AUTHORITY, not the return value.
   *
   * A return value is not always readable at all — it depends on whether the
   * network populated consensus_data — so what happened is read back from the
   * contract. A script that trusted its own return values would report a
   * verdict for a check that is still pending.
   */
  let row = null;
  if (checkId !== undefined && checkId !== null) {
    const got = await reader.viewJson("get_check", [checkId]).catch(() => null);
    row = got?.check ?? null;
  }
  const verdict = row?.verdict || "(none)";
  const status = row?.status || "UNFILED";
  const v = row?.vector ?? {};
  results.push({ ...entry, pid, checkId, verdict, status, vector: v, row });
  const mark = { GRANTED: "✔", DENIED: "✗", INCONCLUSIVE: "?" }[verdict] ?? "·";
  console.log(`  ${mark} ${label.padEnd(24)} ${String(verdict).padEnd(13)} ${String(status).padEnd(8)} `
    + `${v.conditions_met ?? "-"}/${v.conditions_total ?? "-"} met  `
    + `age${v.wallet_age_bucket ?? "-"} tx${v.tx_count_bucket ?? "-"} bal${v.balance_bucket ?? "-"}  ${entry.note}`);
}

/* ── 3. what the chain now says ──────────────────────────────────────────── */
const stats = await reader.viewJson("get_stats", []);
console.log(`\n  policies ${stats.policies_active} active / ${stats.policies_created} created`);
console.log(`  checks   ${stats.checks_filed} filed — ${stats.granted} granted, ${stats.denied} denied, `
  + `${stats.inconclusive} inconclusive, ${stats.pending} pending, ${stats.retries} retries`);
console.log(`  decided  ${stats.decided}   grant rate ${(stats.grant_rate_bps / 100).toFixed(1)}%`);

if (stats.pending > 0) {
  /*
   * Not a failure. docs/PROBE.md §4: the v1 quota that a busy wallet's FIRST
   * transaction needs is per host, and Ethereum's is the tight one — it had not
   * forgiven a burst 25 minutes later, while the other three had. Those checks
   * are filed, valid, and decidable by anybody the moment the quota frees.
   */
  console.log(`\n  ${stats.pending} check(s) are still PENDING — the explorer was rate limited.`);
  console.log(`  Anyone can finish them; no privilege and no re-filing needed:\n`);
  console.log(`      node resolve_pending.mjs --network=${networkName} --rounds=4 --gap=300\n`);
} else {
  console.log("");
}
