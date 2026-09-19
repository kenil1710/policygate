/**
 * Deploys the PolicyGate BUILD ARTIFACT — never the readable source.
 *
 *   node deploy.mjs --network=studiodev
 *   node deploy.mjs --network=studiodev --keystore=mywallet
 *
 * What lands on chain is then byte-identical to what deployments.json records a
 * checksum for, which is the only way `python3 tools/verify_onchain.py` can be
 * a real check rather than a formality.
 *
 * WHO SIGNS: without --keystore the plaintext `client` account in
 * .accounts.json signs, which is right for a gasless network and wrong for a
 * metered one. --keystore=<name> unlocks a real GenLayer CLI wallet instead.
 * The signer becomes the OWNER — the account that can pause and re-price the
 * contract. It can never decide a verdict; see contracts/NOTES.md §5.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createClient, createAccount } from "genlayer-js";
import { CHAINS, argOf, outcomeOf, contractAddressOf, fundOnStudio, retry, sleep } from "./harness.mjs";
import { resolveSigner } from "./keystore.mjs";

const networkName = argOf("network", "studiodev");
const ttlDays = Number(argOf("ttl-days", "30"));
const chain = CHAINS[networkName];
if (!chain) throw new Error(`unknown network ${networkName}`);

const ARTIFACT = new URL("../build/PolicyGate.min.py", import.meta.url);
const code = readFileSync(ARTIFACT);

const signer = resolveSigner(process.argv, new URL("./.accounts.json", import.meta.url));
const account = createAccount(signer.key);
const wallet = createClient({ chain, account });
const read = createClient({ chain });

console.log(`\nPolicyGate deploy → ${networkName}`);
console.log(`  artifact   build/PolicyGate.min.py  (${code.length.toLocaleString()} bytes)`);
console.log(`  signer     ${signer.label}`);

// The MEASURED ceiling: 53,000 bytes accepted on a live network and 53,500
// refused with BlockPubdataLimitReached. Refusing here beats discovering it
// after a four-minute wait.
if (code.length > 52_783) {
  console.error(`\nArtifact is ${code.length} bytes; 53,000 was accepted and 53,500 refused.`);
  process.exit(1);
}

if (chain.isStudio) {
  await fundOnStudio(chain, account.address, 100n * 10n ** 18n);
} else {
  const balance = await read.getBalance({ address: account.address });
  const gen = Number(balance) / 1e18;
  console.log(`  balance    ${gen.toFixed(4)} GEN`);
  if (gen < 0.3) {
    console.error(`\nRefusing to start below 0.3 GEN — fund ${account.address}.`);
    process.exit(1);
  }
}

/*
 * The fee deposit, when the network charges one.
 *
 * Studio Dev does: a deploy sent without `fees` is refused by the consensus
 * contract with `FeeValueMustBeNonZero(1)` — a revert, minutes in, with nothing
 * in the message to say the deposit was what was missing.
 *
 * Unknown is NOT "free". A policy that cannot be read is assumed to charge, so
 * the failure mode is an over-funded deploy rather than a reverted one.
 */
let fees;
let feesRequired = true;
try {
  feesRequired = Boolean((await wallet.getCurrentFeePolicy())?.enabled);
} catch (e) {
  console.log(`  fees       policy unreadable (${String(e?.message ?? e).slice(0, 60)}), assuming required`);
}
if (feesRequired) {
  fees = await wallet.estimateTransactionFees({});
  console.log(`  fees       ${(Number(fees.feeValue) / 1e18).toFixed(4)} GEN deposit`);
}

const hash = await retry(
  () => wallet.deployContract({ code, args: [ttlDays], leaderOnly: false, ...(fees ? { fees } : {}) }),
  { label: "deploy" },
);
console.log(`  tx         ${hash}`);

const started = Date.now();
let address = null;
for (;;) {
  await sleep(chain.isStudio ? 2000 : 5000);
  const tx = await read.getTransaction({ hash }).catch(() => null);
  const out = outcomeOf(tx);
  if (out.settled) {
    if (!out.ok) {
      console.error(`\nDeploy failed: ${out.status} ${out.revertReason || out.stderr}`);
      process.exit(1);
    }
    address = contractAddressOf(tx);
    break;
  }
  if (Date.now() - started > 900_000) {
    console.error("\nDeploy never settled in 900s");
    process.exit(1);
  }
}
if (!address) {
  console.error("\nDeployed but no contract address in the receipt — refusing to record it");
  process.exit(1);
}
console.log(`  address    ${address}`);

// Prove it ANSWERS before recording it. A deploy that lands but cannot be read
// is not a deploy anyone can use, and recording it would publish a dead link.
const cfg = JSON.parse(await retry(
  () => read.readContract({ address, functionName: "get_config", args: [] }),
  { label: "get_config" },
));
const stats = JSON.parse(await retry(
  () => read.readContract({ address, functionName: "get_stats", args: [] }),
  { label: "get_stats" },
));
console.log(`  owner      ${cfg.owner}`);
console.log(`  chains     ${cfg.chains.join(", ")}`);
console.log(`  axis       ${cfg.axis_fields.join(", ")}`);
console.log(`  ttl        ${cfg.check_ttl_days} days   sample ${cfg.sample_size} tx, lag ${cfg.sample_lag_seconds}s`);
console.log(`  policies   ${stats.policies_created}`);

const path = new URL("../deployments.json", import.meta.url);
const doc = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
doc.deployments = doc.deployments || {};
doc.deployments[networkName] = {
  ...(doc.deployments[networkName] || {}),
  network: networkName,
  PolicyGate: { address },
  owner: cfg.owner,
  artifact_bytes: code.length,
  deployed_at: new Date().toISOString(),
};
writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
console.log(`\n✔ recorded in deployments.json\n`);
