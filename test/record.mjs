/**
 * Writes what the chain actually holds into deployments.json.
 *
 *   node record.mjs --network=studiodev
 *
 * Separate from seed.mjs on purpose. A seed leaves checks PENDING whenever the
 * explorer was rate limited (docs/PROBE.md §4), and `resolve_pending.mjs` decides
 * them later — so the record has to be takeable at any point, after any tool, and
 * be a snapshot of STATE rather than of whatever the last script happened to
 * return. It is idempotent: run it again and it overwrites with what is true now.
 *
 * Everything below is read back out of the contract. Nothing here is a claim
 * this script makes on its own behalf.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { connect, argOf } from "./harness.mjs";

const networkName = argOf("network", "studiodev");
const path = new URL("../deployments.json", import.meta.url);
const doc = JSON.parse(readFileSync(path, "utf8"));
const entry = doc.deployments?.[networkName];
const address = entry?.PolicyGate?.address;
if (!address) throw new Error(`no PolicyGate address recorded for ${networkName}`);

const c = connect({ networkName, address, role: "client" });

const cfg = await c.viewJson("get_config", []);
const stats = await c.viewJson("get_stats", []);
const live = await c.viewJson("get_policies", [100]);
const checks = await c.viewJson("get_checks", [100]);

entry.config = {
  chains: cfg.chains,
  axis_fields: cfg.axis_fields,
  check_ttl_days: cfg.check_ttl_days,
  policy_cooldown: cfg.policy_cooldown,
  check_cooldown: cfg.check_cooldown,
  resolution_window: cfg.resolution_window,
  sample_size: cfg.sample_size,
  sample_lag_seconds: cfg.sample_lag_seconds,
};

entry.seeded_policies = (live.policies ?? [])
  .sort((a, b) => a.policy_id - b.policy_id)
  .map((p) => ({
    policy_id: p.policy_id, name: p.name, chain: p.chain, version: p.version,
    policy_text: p.policy_text,
    checks: p.check_count, granted: p.granted_count, denied: p.denied_count,
    inconclusive: p.inconclusive_count, pending: p.pending_count,
    // Whether five validators read this sentence the same way every time. Two
    // policies can both be checkable; one that reads identically on every run
    // and one that does not are very different things to gate access with.
    last_parse: p.last_parse, parse_runs: p.parse_runs,
    parse_changes: p.parse_changes, parse_stable: p.parse_stable,
  }));

entry.seeded_checks = (checks.checks ?? [])
  .sort((a, b) => a.check_id - b.check_id)
  .map((k) => ({
    check_id: k.check_id, policy_id: k.policy_id, policy_version: k.policy_version,
    wallet: k.wallet, chain: k.chain,
    status: k.status, verdict: k.verdict,
    // The AGREED vector — every field of it is what five validators compared.
    vector: k.vector,
    unverifiable: k.unverifiable,
    conditions_text: k.conditions_text,
    conditions: (k.conditions ?? []).map((x) => `${x.kind}: ${x.status} — ${x.detail}`),
    facts: k.facts,
    reasoning: k.reasoning,
    // Evidence, never voted on.
    evidence_digest: k.evidence_digest,
    stale: k.stale, retries: k.retry_count,
  }));

entry.stats = {
  policies_active: stats.policies_active, policies_created: stats.policies_created,
  checks_filed: stats.checks_filed, granted: stats.granted, denied: stats.denied,
  inconclusive: stats.inconclusive, stalled: stats.stalled,
  pending: stats.pending, retries: stats.retries,
  decided: stats.decided, grant_rate_bps: stats.grant_rate_bps,
};
entry.recorded_at = new Date().toISOString();

writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");

const settled = entry.seeded_checks.filter((k) => k.status === "SETTLED").length;
console.log(`\nrecorded from ${address}`);
console.log(`  ${entry.seeded_policies.length} active policies across `
  + `${new Set(entry.seeded_policies.map((p) => p.chain)).size} chains`);
console.log(`  ${entry.seeded_checks.length} checks — ${settled} settled, `
  + `${stats.granted} granted, ${stats.denied} denied, ${stats.inconclusive} inconclusive, `
  + `${stats.pending} pending, ${stats.retries} retries`);
console.log(`  written to deployments.json\n`);
