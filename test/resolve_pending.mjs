/**
 * Walk the pending checks and try to decide them. Permissionless.
 *
 *   node resolve_pending.mjs --network=studiodev
 *   node resolve_pending.mjs --network=studiodev --rounds=3 --gap=90
 *
 * This is the operational half of the RETRY design, and it exists because
 * docs/PROBE.md §4 measured what it is for: four fetches per validator is twenty
 * Blockscout requests per check, all leaving one IP range at once, and the
 * explorers rate limit hard enough that a busy run leaves checks PENDING. That
 * is not a failure — it is the contract declining to decide on data nobody
 * managed to read.
 *
 * Anyone may run this. `resolve_check` takes no privilege and grants none: it
 * re-runs the same consensus round the original caller asked for, and the
 * result is the same public fact whoever pays for it.
 *
 * A check that stays stuck past `resolution_window` can be closed by anybody
 * with `settle_stalled`, which can only ever produce INCONCLUSIVE. Pass
 * `--settle` to do that here for anything eligible.
 */
import { readFileSync } from "node:fs";
import { connect, argOf, returnedJson, sleep } from "./harness.mjs";

const networkName = argOf("network", "studiodev");
const rounds = Number(argOf("rounds", "3"));
const gapSeconds = Number(argOf("gap", "60"));
const alsoSettle = process.argv.includes("--settle");

const deployments = JSON.parse(readFileSync(new URL("../deployments.json", import.meta.url), "utf8"));
const address = deployments.deployments?.[networkName]?.PolicyGate?.address;
if (!address) throw new Error(`no PolicyGate address recorded for ${networkName}`);

const c = connect({ networkName, address, role: "resolver" });

console.log(`\nPolicyGate resolve → ${networkName}`);
console.log(`  contract ${address}`);
console.log(`  signer   resolver (${c.account.address}) — no privilege, and none needed\n`);

for (let round = 1; round <= rounds; round++) {
  const pending = (await c.viewJson("get_pending_checks", [100])).pending ?? [];
  if (pending.length === 0) {
    console.log(`  round ${round}: nothing pending`);
    break;
  }
  console.log(`  round ${round}: ${pending.length} pending`);
  for (const p of pending) {
    const { returned } = await c.send("resolve_check", [p.check_id]);
    const body = returnedJson(returned);
    // STATE is the authority: a settled transaction is not a decided check.
    const row = (await c.viewJson("get_check", [p.check_id]).catch(() => null))?.check;
    const status = row?.status ?? "unreadable";
    if (status === "SETTLED") {
      const v = row.vector;
      console.log(`    ✔ check ${String(p.check_id).padEnd(3)} ${row.verdict.padEnd(13)} `
        + `${v.conditions_met}/${v.conditions_total} met  age${v.wallet_age_bucket} tx${v.tx_count_bucket} bal${v.balance_bucket}`);
    } else if (alsoSettle && p.settleable) {
      const out = returnedJson((await c.send("settle_stalled", [p.check_id])).returned);
      console.log(`    · check ${String(p.check_id).padEnd(3)} ${out?.ok ? "closed as STALLED / INCONCLUSIVE" : "could not be settled: " + out?.reason}`);
    } else {
      console.log(`    … check ${String(p.check_id).padEnd(3)} still ${status}`
        + ` (${row?.retry_count ?? "?"} retries)${body?.reason ? " — " + String(body.reason).slice(0, 60) : ""}`);
    }
  }
  if (round < rounds) {
    console.log(`    waiting ${gapSeconds}s for the explorers to forgive us`);
    await sleep(gapSeconds * 1000);
  }
}

const stats = await c.viewJson("get_stats", []);
console.log(`\n  ${stats.checks_filed} checks — ${stats.granted} granted, ${stats.denied} denied, `
  + `${stats.inconclusive} inconclusive, ${stats.stalled} stalled, ${stats.pending} pending, ${stats.retries} retries\n`);
