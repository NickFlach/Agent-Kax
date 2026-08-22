#!/usr/bin/env node
/**
 * write-code-executor.mjs — from a sentence in the cafe to a PR link
 * (ADR-0003 v0.1, issue #402).
 *
 * Takes ONE write-code commitment and carries it through the stages the ADR
 * names — worktree, edit, test, commit, push, pr — with every decision made
 * by lib/executor-core.mjs (pure, tested) and only the git/network wiring
 * here. T0 throughout: the output is a pull request; nothing lands without
 * a human merge.
 *
 * Invocation (by the resident daemon when a write-code commitment falls due,
 * or by hand for the demo):
 *
 *   node write-code-executor.mjs run --repo owner/name --task "…" \
 *     --commitment cmt-id --principal kax:agent:<bot_id> --agent-id 0xSCADA-QE
 *   node write-code-executor.mjs keygen        # mint the agent's Ed25519 key
 *
 * Environment:
 *   EXECUTOR_REPOS            repo allowlist, comma-separated (the v0.1
 *                             grant; empty = agent holds no capability)
 *   EXECUTOR_BRANCH_PREFIX    branch namespace, default agent/<agent-id>
 *   EXECUTOR_KEY_FILE         Ed25519 private key PEM (keygen writes it)
 *   EXECUTOR_RECORD_FILE      write-ahead action record JSONL
 *                             (default ~/.kannaka/kax-action-record.jsonl)
 *   EXECUTOR_WORK_DIR         where per-commitment clones live
 *   EXECUTOR_TEST_CMD         optional command run in the worktree; red = stop
 *   KAX_API / KAX_TOKEN_FILE  city API + agent token, for the revocation
 *                             probe (GET /city/onboarding — authed,
 *                             read-only, does NOT drain /city/look) and for
 *                             speaking the report/failure in the room
 *   KANNAKA_NATS_URL + NATS_USER/NATS_PASSWORD (or ~/.kannaka-nats.env) —
 *                             the edit itself is asked of the agent's OWN
 *                             mind over KANNAKA.ask.<agent-id>
 *
 * Stated v0.1 limits, per the ADR's operator decisions: the push/PR uses the
 * operator's ambient gh auth (decision 4, per-agent identities are v0.2+);
 * edits are single-file, produced one-shot by the agent's mind.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";
import {
  ACTION_GENESIS_HASH,
  branchName,
  budgetGate,
  computeActionHash,
  buildSignedAction,
  failureLine,
  fileFor,
  formatCommitTrailers,
  overCeiling,
  revocationCheckDue,
  scopeCheck,
} from "./lib/executor-core.mjs";

const HOME = homedir();
const KAX_API = (process.env.KAX_API || "https://kax.ninja-portal.com/api").replace(/\/$/, "");
const RECORD = process.env.EXECUTOR_RECORD_FILE || join(HOME, ".kannaka", "kax-action-record.jsonl");
const KEY_FILE = process.env.EXECUTOR_KEY_FILE || join(HOME, ".kannaka", "kax-executor-ed25519.pem");
const WORK_DIR = process.env.EXECUTOR_WORK_DIR || join(HOME, ".kannaka", "executor-work");

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// --------------------------------------------------------------------------
// The write-ahead action record. Append-only JSONL, hash-chained, fsync'd
// BEFORE the externally-visible act (D5): a crash after recording is a
// harmless recorded non-action the idempotency key skips next time; a crash
// after acting but before recording would be the silent failure D8 forbids.
// --------------------------------------------------------------------------

function readRecord() {
  if (!existsSync(RECORD)) return [];
  return readFileSync(RECORD, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function appendRecord(row) {
  mkdirSync(join(RECORD, ".."), { recursive: true });
  appendFileSync(RECORD, JSON.stringify(row) + "\n");
  const fd = openSync(RECORD, "r+");
  fsyncSync(fd);
  closeSync(fd);
}

// --------------------------------------------------------------------------
// Revocation probe — authed read-only endpoint; 401/403 = the grant is gone.
// --------------------------------------------------------------------------

function kaxToken() {
  const file = process.env.KAX_TOKEN_FILE;
  if (file && existsSync(file)) return readFileSync(file, "utf8").trim();
  return process.env.KAX_TOKEN || null;
}

async function assertNotRevoked(state) {
  if (!revocationCheckDue(state.lastRevocationCheckAt)) return;
  const token = kaxToken();
  if (!token) throw new Error("no KAX token for the revocation probe — refusing to act unverifiable");
  const res = await fetch(`${KAX_API}/city/onboarding`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`revoked mid-run (probe returned ${res.status}) — stopping`);
  }
  state.lastRevocationCheckAt = Date.now();
}

async function speak(text) {
  const token = kaxToken();
  if (!token) { log(`(no token to speak with) ${text}`); return; }
  await fetch(`${KAX_API}/city/say`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: text.slice(0, 280) }),
  }).catch(() => {});
}

// --------------------------------------------------------------------------
// The edit: asked of the agent's own mind, one file, full replacement.
// --------------------------------------------------------------------------

async function askMind(agentId, prompt) {
  const { connect } = await import("nats");
  let user = process.env.NATS_USER, pass = process.env.NATS_PASSWORD;
  if (!user || !pass) {
    const envFile = process.env.KANNAKA_NATS_ENV || join(HOME, ".kannaka-nats.env");
    for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const m = /^(?:export\s+)?(NATS_USER|NATS_PASSWORD)=(.*)$/.exec(line.trim());
      if (m) m[1] === "NATS_USER" ? (user ||= m[2]) : (pass ||= m[2]);
    }
  }
  const nc = await connect({
    servers: process.env.KANNAKA_NATS_URL || "nats://swarm.ninja-portal.com:4222",
    user, pass,
  });
  try {
    const reply = await nc.request(
      `KANNAKA.ask.${agentId}`,
      JSON.stringify({ text: prompt }),
      { timeout: 120_000 },
    );
    const parsed = JSON.parse(new TextDecoder().decode(reply.data));
    return parsed.text ?? "";
  } finally {
    await nc.close();
  }
}

// --------------------------------------------------------------------------
// run — the stages, in order, with the cadence and the ceiling held.
// --------------------------------------------------------------------------

async function run() {
  const commitment = {
    id: arg("commitment") || `cmt-${Date.now()}`,
    repo: arg("repo"),
    task: arg("task"),
  };
  const agentId = arg("agent-id");
  const principal = arg("principal");
  if (!commitment.repo || !commitment.task || !agentId || !principal) {
    console.error("need --repo --task --agent-id --principal (and ideally --commitment)");
    process.exit(2);
  }

  const grant = {
    repos: (process.env.EXECUTOR_REPOS || "").split(",").map((s) => s.trim()).filter(Boolean),
    branchPrefix: process.env.EXECUTOR_BRANCH_PREFIX || `agent/${agentId.toLowerCase()}`,
  };

  // SCOPE: refused out loud, before anything touches a disk.
  const scope = scopeCheck(commitment, grant);
  if (!scope.ok) { await speak(scope.reason); process.exit(1); }

  // IDEMPOTENCY + BUDGET, from the record itself.
  const record = readRecord();
  if (record.some((r) => r.commitmentId === commitment.id)) {
    log(`commitment ${commitment.id} already recorded — refusing to double-act`);
    process.exit(0);
  }
  const gate = budgetGate(record.map((r) => r.startedAt ?? 0), Date.now());
  if (!gate.ok) { await speak(gate.say); process.exit(1); }

  const startedAt = Date.now();
  const state = { lastRevocationCheckAt: null };
  const branch = branchName(commitment, grant);
  const dir = join(WORK_DIR, commitment.id.replace(/[^a-zA-Z0-9-]/g, ""));
  const stage = { name: "worktree" };

  try {
    // WORKTREE — a fresh shallow clone per commitment; never a shared tree.
    await assertNotRevoked(state);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["clone", "--depth", "1", `https://github.com/${commitment.repo}.git`, dir], { encoding: "utf8" });
    git(dir, "checkout", "-b", branch);

    // EDIT — the agent's own mind, one named file, full replacement.
    stage.name = "edit";
    await assertNotRevoked(state);
    if (overCeiling(startedAt)) throw new Error("wall-clock ceiling reached");
    const file = fileFor(commitment.task);
    const before = existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8") : "";
    const answer = await askMind(agentId, [
      `You are ${agentId}. You accepted this code task: "${commitment.task}".`,
      `Here is the current content of ${file} between the markers.`,
      `Reply with ONLY the complete corrected content of ${file} — no prose, no fences.`,
      `-----BEGIN ${file}-----`, before, `-----END ${file}-----`,
    ].join("\n"));
    const after = answer.replace(/^```[\w-]*\n?/, "").replace(/\n?```\s*$/, "");
    if (!after.trim() || after.trim() === before.trim()) throw new Error("the mind produced no change");
    writeFileSync(join(dir, file), after.endsWith("\n") ? after : after + "\n");

    // TEST — optional, red stops the run.
    stage.name = "test";
    await assertNotRevoked(state);
    if (process.env.EXECUTOR_TEST_CMD) {
      execFileSync("sh", ["-c", process.env.EXECUTOR_TEST_CMD], { cwd: dir, encoding: "utf8", stdio: "pipe" });
    }

    // COMMIT — explicit path, trailers signed over the action's canonical
    // payload so the commit and the record attest each other.
    stage.name = "commit";
    await assertNotRevoked(state);
    if (overCeiling(startedAt)) throw new Error("wall-clock ceiling reached");
    git(dir, "add", file); // never -A: SESSION-LANES rule, in code
    const head = record.length ? record[record.length - 1].entryHash : ACTION_GENESIS_HASH;
    const seq = record.length + 1;
    const key = crypto.createPrivateKey(readFileSync(KEY_FILE, "utf8"));
    const preRow = buildSignedAction(head, seq, {
      commitmentId: commitment.id, principal, kind: "write-code", commitSha: null, ref: commitment.repo,
    }, key);
    git(dir, "-c", "user.name=" + agentId, "-c", `user.email=agent@kax.ninja-portal.com`, "commit", "-m",
      `${commitment.task.slice(0, 68)}\n\n${formatCommitTrailers({
        commitmentId: commitment.id, principal, signature: preRow.signature,
      })}\nCo-Authored-By: ${agentId} <agent@kax.ninja-portal.com>`);
    const sha = git(dir, "rev-parse", "HEAD").trim();

    // RECORD (write-ahead of the visible act), then PUSH, then PR.
    stage.name = "push";
    await assertNotRevoked(state);
    const row = buildSignedAction(head, seq, {
      commitmentId: commitment.id, principal, kind: "write-code", commitSha: sha, ref: commitment.repo,
    }, key);
    appendRecord({ ...row, startedAt, task: commitment.task, spokenBy: arg("from") ?? null });
    git(dir, "push", "origin", `HEAD:${branch}`);

    stage.name = "pr";
    await assertNotRevoked(state);
    const prUrl = execFileSync("gh", ["pr", "create", "--repo", commitment.repo, "--head", branch,
      "--title", commitment.task.slice(0, 80),
      "--body", `Autonomous T0 work for commitment \`${commitment.id}\` by \`${principal}\`.\n\nTask, as spoken in the room: ${commitment.task}\n\nPR-only per KAX-ADR-0003 v0.1 — nothing lands without a human merge.`,
    ], { cwd: dir, encoding: "utf8" }).trim();

    await speak(`Done — the work I agreed to is up for review: ${prUrl}`);
    log(`PR: ${prUrl}`);
  } catch (e) {
    const line = failureLine(stage.name, e.message);
    await speak(line);
    log(line);
    process.exit(1);
  }
}

// --------------------------------------------------------------------------

const cmd = process.argv[2];
if (cmd === "keygen") {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  mkdirSync(join(KEY_FILE, ".."), { recursive: true });
  writeFileSync(KEY_FILE, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  console.log(`private key written to ${KEY_FILE}`);
  console.log(`public key (archive this against the principal):\n${publicKey.export({ type: "spki", format: "pem" })}`);
} else if (cmd === "run") {
  await run();
} else {
  console.error("usage: write-code-executor.mjs run --repo o/r --task '…' --agent-id A --principal kax:agent:<uuid> | keygen");
  process.exit(2);
}
