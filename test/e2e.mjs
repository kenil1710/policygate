/**
 * Live integration suite against a deployed PolicyGate.
 *
 *   node e2e.mjs --network=studiodev
 *
 * What this covers that `test/test_logic.py` cannot: that the ABI is callable,
 * that a `bool` return survives the transport, that the storage shapes survive
 * a real GenVM, and that the access-control and lifecycle guards hold against a
 * real chain with real signers.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: run a consensus round for every assertion.
 * A check_access is three Blockscout fetches per validator plus a model call —
 * four for a busy wallet — and docs/PROBE.md §4 measured the explorers rate
 * limiting that hard. It runs exactly one round, against a wallet with no
 * history, which needs no v1 request and so settles without touching the scarce
 * quota. The rest of the rounds live in seed.mjs; this suite proves the surface
 * around them.
 *
 * A REJECTION IS A SUCCESSFUL TRANSACTION HERE. PolicyGate contains zero raise
 * statements, so a refused call settles normally and returns
 * {"ok": false, "reason": ...}. Every assertion below reads the RETURN VALUE,
 * and where a return is unreadable — which depends on whether the network
 * populated consensus_data at all — it falls back to reading contract state.
 */
import { readFileSync } from "node:fs";
import { connect, argOf, returnedJson, sleep } from "./harness.mjs";

const networkName = argOf("network", "studiodev");
const deployments = JSON.parse(readFileSync(new URL("../deployments.json", import.meta.url), "utf8"));
const address = deployments.deployments?.[networkName]?.PolicyGate?.address;
if (!address) throw new Error(`no PolicyGate address recorded for ${networkName}`);

const TEXT = "Every wallet seeking access under this test policy must be at least 30 days old, must have made at least 5 transactions, and must hold at least 0.0001 ETH in its account.";
const TEXT2 = "This rewritten test policy requires a wallet at least 365 days old with at least 250 transactions and a balance of at least 1 ETH, which is strictly harder than before.";
const WALLET = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const FRESH = "0x33015b74a177b62554e5DcD8d622d1233CCf0cb4";

/*
 * `client` creates this suite's policy, and the choice is not arbitrary: seed.mjs
 * spends creator, creator2, requester, requester2 and resolver on its five
 * policies, and create_policy is rate limited to one per wallet per 300s. An e2e
 * run started soon after a seed with any of those roles would be refused by the
 * cooldown and read as a failure of the thing it was trying to test.
 *
 * It also demonstrates something worth demonstrating: the owner gets no special
 * standing over a policy. It is the creator of this one, and the access-control
 * block below still checks that a stranger cannot touch it.
 */
const creator = connect({ networkName, address, role: "client" });
const outsider = connect({ networkName, address, role: "outsider" });
const reader = connect({ networkName, address, role: "client" });

let passed = 0;
const failures = [];

function ok(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? "  — " + detail : ""}`); }
}

async function send(c, fn, args) {
  const out = await c.send(fn, args);
  return { out, body: returnedJson(out.returned) };
}

console.log(`\nPolicyGate e2e → ${networkName}`);
console.log(`  contract ${address}\n`);

/* ── config and stats are readable at all ─────────────────────────────────── */
console.log("config");
const cfg = await reader.viewJson("get_config", []);
ok("get_config answers", cfg.ok === true);
ok("all four chains are configured", JSON.stringify(cfg.chains) === JSON.stringify(["ethereum", "base", "arbitrum", "polygon"]));
ok("the axis is seven fields", cfg.axis_fields?.length === 7, JSON.stringify(cfg.axis_fields));
ok("balance edges are strings, not doubles", cfg.bal_edges?.every((e) => typeof e === "string"));
ok("the ladders survived the build", Array.isArray(cfg.age_ladder) && cfg.age_ladder.length > 10);
const stats0 = await reader.viewJson("get_stats", []);
ok("get_stats answers", stats0.ok === true);

/* ── create_policy ────────────────────────────────────────────────────────── */
console.log("\ncreate_policy");
let r = await send(creator, "create_policy", ["E2E Gate", "integration test policy", "ethereum", TEXT]);
ok("a valid policy is created", r.body?.ok === true, r.body?.reason ?? r.out.failure ?? "");
const pid = r.body?.policy_id;
if (pid === undefined) { console.error("\ncannot continue without a policy id\n"); process.exit(1); }
console.log(`    policy_id ${pid}`);

r = await send(outsider, "create_policy", ["Bad", "d", "solana", TEXT]);
ok("an unknown chain is refused (and does not revert)", r.body?.ok === false && r.out.ok === true, r.body?.reason ?? "");
ok("the refusal explains itself", typeof r.body?.reason === "string" && r.body.reason.includes("ethereum"));

r = await send(outsider, "create_policy", ["Bad", "d", "ethereum", "far too short"]);
ok("a too-short policy is refused", r.body?.ok === false);

r = await send(creator, "create_policy", ["Second", "d", "ethereum", TEXT]);
ok("the per-wallet cooldown holds", r.body?.ok === false && String(r.body?.reason).includes("per wallet"), r.body?.reason ?? "");

/* ── reading it back ──────────────────────────────────────────────────────── */
console.log("\nviews");
const got = await reader.viewJson("get_policy", [pid]);
ok("get_policy returns the stored text", got.policy?.policy_text === TEXT);
ok("it is version 1 and ACTIVE", got.policy?.version === 1 && got.policy?.status === "ACTIVE");
ok("the creator is recorded", String(got.policy?.creator).toLowerCase() === creator.account.address.toLowerCase());
ok("a policy hash is published", typeof got.policy?.policy_hash === "string" && got.policy.policy_hash.length === 16);

const byCreator = await reader.viewJson("get_policies_by_creator", [creator.account.address, 10]);
ok("get_policies_by_creator finds it", byCreator.policies?.some((p) => p.policy_id === pid));
const byChain = await reader.viewJson("get_policies_by_chain", ["ethereum", 50]);
ok("get_policies_by_chain finds it", byChain.policies?.some((p) => p.policy_id === pid));
const active = await reader.viewJson("get_policies", [50]);
ok("it is in the active list", active.policies?.some((p) => p.policy_id === pid));

const missing = await reader.viewJson("get_policy", [99999]);
ok("a missing policy answers ok:false rather than reverting", missing.ok === false);
const missingCheck = await reader.viewJson("get_check", [99999]);
ok("a missing check answers ok:false", missingCheck.ok === false);

/* ── is_granted, the composable gate ──────────────────────────────────────── */
console.log("\nis_granted");
const never = await reader.view("is_granted", [FRESH, pid]);
ok("a never-checked wallet is false", never === false || never === "false", String(never));
const badAddr = await reader.view("is_granted", ["not-an-address", pid]);
ok("a malformed address is false, not an error", badAddr === false || badAddr === "false", String(badAddr));
const badPid = await reader.view("is_granted", [WALLET, 99999]);
ok("a missing policy is false", badPid === false || badPid === "false", String(badPid));

const status = await reader.viewJson("get_access_status", [FRESH, pid]);
ok("get_access_status explains why not", status.granted === false && String(status.reason).includes("never been checked"), status.reason ?? "");

/* ── access control ───────────────────────────────────────────────────────── */
console.log("\naccess control");
r = await send(outsider, "update_policy", [pid, TEXT2]);
ok("a stranger cannot rewrite a policy", r.body?.ok === false && String(r.body?.reason).includes("creator"), r.body?.reason ?? "");
r = await send(outsider, "delete_policy", [pid]);
ok("a stranger cannot delete a policy", r.body?.ok === false && String(r.body?.reason).includes("creator"), r.body?.reason ?? "");
r = await send(outsider, "set_paused", [true]);
ok("a stranger cannot pause the contract", r.body?.ok === false, r.body?.reason ?? "");
r = await send(outsider, "set_params", [1, 1, 600, 5, 3]);
ok("a stranger cannot move the parameters", r.body?.ok === false, r.body?.reason ?? "");
r = await send(outsider, "transfer_ownership", [outsider.account.address]);
ok("a stranger cannot take ownership", r.body?.ok === false, r.body?.reason ?? "");

const cfgAfter = await reader.viewJson("get_config", []);
ok("the config is unchanged after five refused calls",
  cfgAfter.owner === cfg.owner && cfgAfter.check_ttl === cfg.check_ttl && cfgAfter.paused === cfg.paused);

/* ── a real consensus round ───────────────────────────────────────────────── */
console.log("\ncheck_access (one live round)");
r = await send(outsider, "check_access", [FRESH, pid]);
const cid = r.body?.check_id;
ok("a check is filed and returns an id", cid !== undefined && cid !== null, JSON.stringify(r.body ?? r.out.failure));

if (cid !== undefined && cid !== null) {
  // RETRY is the normal path when the explorer is rate limited.
  let body = r.body;
  for (let i = 0; i < 4 && body?.retry; i++) {
    const wait = 20_000 * (i + 1);
    console.log(`    … explorer unavailable; resolving again in ${wait / 1000}s`);
    await sleep(wait);
    ({ body } = await send(outsider, "resolve_check", [cid]));
  }
  // STATE is the authority, not the return value.
  const row = (await reader.viewJson("get_check", [cid]).catch(() => null))?.check;
  ok("the check is readable", row !== null && row !== undefined);
  if (row?.status === "SETTLED") {
    console.log(`    verdict ${row.verdict}  ${row.vector.conditions_met}/${row.vector.conditions_total} met  `
      + `age${row.vector.wallet_age_bucket} tx${row.vector.tx_count_bucket} bal${row.vector.balance_bucket}`);
    ok("a wallet with no history is not GRANTED", row.verdict !== "GRANTED", row.verdict);
    ok("the stored vector carries all seven fields",
      ["verdict", "conditions_met", "conditions_total", "wallet_age_bucket",
       "tx_count_bucket", "balance_bucket", "content_hash"].every((k) => k in row.vector));
    ok("the content hash is 16 hex digits", /^[0-9a-f]{16}$/.test(row.vector.content_hash ?? ""));
    ok("an evidence digest is published beside it", typeof row.evidence_digest === "string");
    ok("a per-condition breakdown is stored", Array.isArray(row.conditions) && row.conditions.length > 0);
    ok("every condition carries a status and a detail",
      (row.conditions ?? []).every((c) => ["PASS", "FAIL", "UNKNOWN"].includes(c.status) && typeof c.detail === "string"));
    ok("the raw facts are stored as evidence", row.facts && "age_days" in row.facts);
    const ver = await reader.viewJson("verify_check", [cid]);
    ok("verify_check recomputes the record and agrees", ver.verified === true, JSON.stringify(ver.checks?.filter((c) => !c.ok)));
    ok("verify_check says plainly that it does not re-fetch", String(ver.note).includes("not"));
    const granted = await reader.view("is_granted", [FRESH, pid]);
    ok("is_granted agrees with the verdict",
      (granted === true || granted === "true") === (row.verdict === "GRANTED"), String(granted));
  } else {
    console.log(`    check is ${row?.status ?? "unreadable"} after ${row?.retry_count ?? "?"} retries — the explorer stayed unavailable`);
    ok("an undecided check grants nothing",
      (await reader.view("is_granted", [FRESH, pid])) !== true);
    ok("it is listed as pending", (await reader.viewJson("get_pending_checks", [50])).pending?.some((p) => p.check_id === cid));
  }
  const history = await reader.viewJson("get_wallet_history", ["ethereum", FRESH, 10]);
  ok("get_wallet_history lists it", history.checks?.some((c) => c.check_id === cid));
  const byPolicy = await reader.viewJson("get_checks_by_policy", [pid, 10]);
  ok("get_checks_by_policy lists it", byPolicy.checks?.some((c) => c.check_id === cid));
}

/* ── update invalidates ───────────────────────────────────────────────────── */
console.log("\nupdate_policy");
r = await send(creator, "update_policy", [pid, TEXT2]);
ok("the creator can rewrite it", r.body?.ok === true, r.body?.reason ?? "");
ok("the version bumped to 2", r.body?.version === 2, String(r.body?.version));
const after = await reader.viewJson("get_policy", [pid]);
ok("the new text is stored", after.policy?.policy_text === TEXT2);
ok("the agreed parse was cleared with the old wording", after.policy?.last_parse === "");

if (cid !== undefined && cid !== null) {
  const staleRow = (await reader.viewJson("get_check", [cid])).check;
  ok("the earlier check is now marked stale", staleRow?.stale === true);
  ok("it is still fully readable as evidence", staleRow?.policy_version === 1 && typeof staleRow?.reasoning === "string");
  ok("and it grants nothing", (await reader.view("is_granted", [FRESH, pid])) !== true);
}

r = await send(creator, "update_policy", [pid, TEXT2]);
ok("rewriting to the same text is refused", r.body?.ok === false && String(r.body?.reason).includes("already"), r.body?.reason ?? "");

/* ── delete ───────────────────────────────────────────────────────────────── */
console.log("\ndelete_policy");
const pendingNow = (await reader.viewJson("get_pending_checks", [50])).pending?.filter((p) => p.policy_id === pid) ?? [];
r = await send(creator, "delete_policy", [pid]);
if (pendingNow.length > 0) {
  ok("delete is refused while a check is unresolved", r.body?.ok === false && String(r.body?.reason).includes("unresolved"), r.body?.reason ?? "");
} else {
  ok("the creator can delete it", r.body?.ok === true, r.body?.reason ?? "");
  const gone = await reader.viewJson("get_policy", [pid]);
  ok("the record survives, marked DELETED", gone.policy?.status === "DELETED");
  const live = await reader.viewJson("get_policies", [50]);
  ok("it left the active list", !live.policies?.some((p) => p.policy_id === pid));
  ok("a deleted policy grants nothing", (await reader.view("is_granted", [WALLET, pid])) !== true);
  r = await send(outsider, "check_access", [WALLET, pid]);
  ok("a deleted policy cannot be checked against", r.body?.ok === false && String(r.body?.reason).includes("deleted"), r.body?.reason ?? "");
}

/* ── summary ──────────────────────────────────────────────────────────────── */
const stats = await reader.viewJson("get_stats", []);
console.log(`\n  ${stats.policies_active} active policies, ${stats.checks_filed} checks filed, `
  + `${stats.granted} granted / ${stats.denied} denied / ${stats.inconclusive} inconclusive, ${stats.retries} retries`);
console.log("\n" + "-".repeat(70));
console.log(`  ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\n  FAILED:");
  for (const f of failures) console.log("    · " + f);
}
console.log("");
process.exit(failures.length ? 1 : 0);
