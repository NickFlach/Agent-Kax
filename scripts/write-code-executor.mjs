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
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, openSync, fsyncSync, closeSync, writeSync, unlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import crypto from "node:crypto";
import {
  ACTION_GENESIS_HASH,
  branchName,
  budgetGate,
  buildSignedAction,
  failureLine,
  fileFor,
  isContainedRelPath,
  formatCommitTrailers,
  overCeiling,
  DEFAULT_WALL_CLOCK_CEILING_MS,
  revocationCheckDue,
  scopeCheck,
} from "./lib/executor-core.mjs";

const HOME = homedir();
const KAX_API = (process.env.KAX_API || "https://kax.ninja-portal.com/api").replace(/\/$/, "");
const RECORD = process.env.EXECUTOR_RECORD_FILE || join(HOME, ".kannaka", "kax-action-record.jsonl");
const RUNS_LOG = process.env.EXECUTOR_RUNS_FILE || join(HOME, ".kannaka", "kax-executor-runs.jsonl");
const LOCK_FILE = process.env.EXECUTOR_LOCK_FILE || join(HOME, ".kannaka", "kax-executor.lock");
const KEY_FILE = process.env.EXECUTOR_KEY_FILE || join(HOME, ".kannaka", "kax-executor-ed25519.pem");
const WORK_DIR = process.env.EXECUTOR_WORK_DIR || join(HOME, ".kannaka", "executor-work");
/** A stage may not run longer than this without being abandoned (D7 backstop). */
const STAGE_TIMEOUT_MS = Number(process.env.EXECUTOR_STAGE_TIMEOUT_MS || 180_000);

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

function readRuns() {
  if (!existsSync(RUNS_LOG)) return [];
  return readFileSync(RUNS_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function appendJsonl(file, row) {
  mkdirSync(join(file, ".."), { recursive: true });
  appendFileSync(file, JSON.stringify(row) + "\n");
  const fd = openSync(file, "r+");
  fsyncSync(fd);
  closeSync(fd);
}

const appendRecord = (row) => appendJsonl(RECORD, row);
const logRun = (row) => appendJsonl(RUNS_LOG, { ...row, at: Date.now() });

/**
 * A GLOBAL executor lock. It serializes executors on one machine, which does
 * two things the review found were missing: it stops two runs of the SAME
 * commitment from both acting (the idempotency check was a TOCTOU window
 * minutes wide), and it stops two DIFFERENT commitments from computing the
 * same chain head/seq concurrently and forking the append-only action chain
 * with no repair path. Executors are rare and minutes-long; serializing them
 * is the right trade against chain corruption. A lock left by a crashed
 * process is reclaimed once it is older than a full wall-clock ceiling.
 */
function acquireLock() {
  mkdirSync(join(LOCK_FILE, ".."), { recursive: true });
  const stale = DEFAULT_WALL_CLOCK_CEILING_MS + STAGE_TIMEOUT_MS + 60_000;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK_FILE, "wx"); // exclusive create; throws if held
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fsyncSync(fd);
      closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // Reclaim a stale lock (crashed holder) exactly once, then retry.
      try {
        if (Date.now() - statSync(LOCK_FILE).mtimeMs > stale) { unlinkSync(LOCK_FILE); continue; }
      } catch { /* someone else just released it — fall through to the retry */ }
      return false;
    }
  }
  return false;
}

function releaseLock() {
  try { unlinkSync(LOCK_FILE); } catch { /* already gone */ }
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

  // The fleet-wide kill switch (#403, D6), checked on the SAME cadence so a
  // halt flipped mid-run stops the next stage. Fail closed: if it can't be
  // read, or reads halted, stop. This is not revocation — the agent keeps its
  // identity and its home, it just stops acting and says why.
  try {
    const a = await fetch(`${KAX_API}/city/autonomy`);
    if (!a.ok) throw new Error(`autonomy status ${a.status}`);
    const status = await a.json();
    if (status.halted) {
      throw new Error(`autonomous execution is halted fleet-wide${status.reason ? ` (${status.reason})` : ""} — standing down`);
    }
  } catch (e) {
    if (String(e.message).includes("halted")) throw e;
    throw new Error(`could not read the autonomy kill switch (${e.message}) — stopping rather than acting`);
  }

  let res;
  try {
    res = await fetch(`${KAX_API}/city/onboarding`, { headers: { Authorization: `Bearer ${token}` } });
  } catch (e) {
    // A network error is not evidence the grant still holds. Fail closed: an
    // agent that cannot confirm it is still verified must stop, not push.
    throw new Error(`revocation probe unreachable (${e.message}) — stopping rather than acting unverified`);
  }
  // Fail closed on ANYTHING that is not a clean 2xx. A 401/403 is an explicit
  // revocation; a 5xx/429 is an outage that must NOT read as "still allowed"
  // — the old code treated only 401/403 as revoked and refreshed the clock on
  // a 500, turning an API outage into a rubber stamp for the rest of the run.
  if (!res.ok) {
    throw new Error(`revocation probe returned ${res.status} — stopping (only a clean 2xx confirms the grant still holds)`);
  }
  // ONLY a confirmed-still-verified response advances the clock.
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

  // SCOPE: refused out loud, before anything touches a disk or a lock.
  const scope = scopeCheck(commitment, grant);
  if (!scope.ok) { await speak(scope.reason); process.exit(1); }

  // FILE SCOPE resolved and CONTAINED before anything runs: a spoken path that
  // escapes the clone would read a host file into a prompt and overwrite it.
  const file = fileFor(commitment.task);
  if (!file) {
    await speak("I can't take that — the file it names looks like it points outside the repo, and I only touch one file inside it.");
    process.exit(1);
  }

  // The global lock closes the concurrent double-act / chain-fork window.
  if (!acquireLock()) {
    await speak("Another piece of work is in progress — I'll pick this up once it's done.");
    process.exit(1);
  }

  const startedAt = Date.now();
  const state = { lastRevocationCheckAt: null };
  const branch = branchName(commitment, grant);
  const dir = join(WORK_DIR, commitment.id.replace(/[^a-zA-Z0-9-]/g, ""));
  const stage = { name: "worktree" };

  try {
    // IDEMPOTENCY, under the lock so the check and the record cannot race.
    // Distinguish DONE from STALLED so a crash between record and PR is not a
    // silent evaporated promise (D8): a completed run points at its PR; an
    // attempted-but-unfinished one is said out loud for a human to check.
    const runs = readRuns();
    const done = runs.find((r) => r.commitmentId === commitment.id && r.phase === "completed");
    if (done) { await speak(`I already did that — it's up for review: ${done.prUrl}`); releaseLock(); process.exit(0); }
    if (readRecord().some((r) => r.commitmentId === commitment.id) ||
        runs.some((r) => r.commitmentId === commitment.id && r.phase === "attempt")) {
      await speak("I started that work earlier and it didn't finish — a human should check before I try again.");
      releaseLock();
      process.exit(1);
    }

    // BUDGET counts ATTEMPTS, not just successful pushes — a run that fails at
    // clone/edit/test still spends API + mind calls, so it must deplete the
    // window too. Record the attempt now (write-ahead of the whole action).
    const gate = budgetGate(runs.filter((r) => r.phase === "attempt").map((r) => r.at), Date.now());
    if (!gate.ok) { await speak(gate.say); releaseLock(); process.exit(1); }
    logRun({ phase: "attempt", commitmentId: commitment.id, principal });

    // WORKTREE — a fresh shallow clone per commitment; never a shared tree.
    await assertNotRevoked(state);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["clone", "--depth", "1", `https://github.com/${commitment.repo}.git`, dir],
      { encoding: "utf8", timeout: STAGE_TIMEOUT_MS });
    git(dir, "checkout", "-b", branch);

    // Belt-and-suspenders containment: even with fileFor's check, confirm the
    // resolved path stays inside the clone before any read or write.
    const abs = resolve(dir, file);
    if (abs !== resolve(dir) && !abs.startsWith(resolve(dir) + sep)) {
      throw new Error(`refusing to touch a path outside the clone: ${file}`);
    }

    // EDIT — the agent's own mind, one named file, full replacement.
    stage.name = "edit";
    await assertNotRevoked(state);
    if (overCeiling(startedAt)) throw new Error("wall-clock ceiling reached");
    const before = existsSync(abs) ? readFileSync(abs, "utf8") : "";
    const answer = await askMind(agentId, [
      `You are ${agentId}. You accepted this code task: "${commitment.task}".`,
      `Here is the current content of ${file} between the markers.`,
      `Reply with ONLY the complete corrected content of ${file} — no prose, no fences.`,
      `-----BEGIN ${file}-----`, before, `-----END ${file}-----`,
    ].join("\n"));
    const after = answer.replace(/^```[\w-]*\n?/, "").replace(/\n?```\s*$/, "");
    if (!after.trim() || after.trim() === before.trim()) throw new Error("the mind produced no change");
    writeFileSync(abs, after.endsWith("\n") ? after : after + "\n");

    // TEST — optional, red stops the run. Bounded, or a hung test blows the
    // wall-clock ceiling with no revocation check in flight.
    stage.name = "test";
    await assertNotRevoked(state);
    if (overCeiling(startedAt)) throw new Error("wall-clock ceiling reached");
    if (process.env.EXECUTOR_TEST_CMD) {
      execFileSync("sh", ["-c", process.env.EXECUTOR_TEST_CMD],
        { cwd: dir, encoding: "utf8", stdio: "pipe", timeout: STAGE_TIMEOUT_MS });
    }

    // COMMIT + write-ahead RECORD. The record row and the commit trailer are
    // signed over the SAME canonical payload (commitSha: null — the sha is not
    // known until after the commit and does not need to be signed; the trailer
    // lives IN the commit, so the branch the PR names carries the attestation).
    // Signing two different payloads, as the first version did, produced a
    // trailer signature that could never verify against the record.
    stage.name = "commit";
    await assertNotRevoked(state);
    if (overCeiling(startedAt)) throw new Error("wall-clock ceiling reached");
    git(dir, "add", file); // never -A: SESSION-LANES rule, in code
    const record = readRecord();
    const head = record.length ? record[record.length - 1].entryHash : ACTION_GENESIS_HASH;
    const seq = record.length + 1;
    const key = crypto.createPrivateKey(readFileSync(KEY_FILE, "utf8"));
    const row = buildSignedAction(head, seq, {
      commitmentId: commitment.id, principal, kind: "write-code", commitSha: null, ref: commitment.repo,
    }, key);
    // Write-ahead: the signed row lands (fsync'd) before the commit that
    // carries its signature, and well before the push that makes work visible.
    appendRecord({ ...row, startedAt, task: commitment.task, spokenBy: arg("from") ?? null });
    // The task is attacker-controlled text on the SUBJECT line. A subject that
    // itself looks like a trailer ("KAX-Principal: x — fix the readme") would,
    // by git's own last-wins/duplicate folding, collide with the real trailer
    // block and make the whole message parse as UNATTRIBUTED. Neutralise any
    // leading "Word-Word:" so the subject can never be read as a trailer.
    const subject = commitment.task.replace(/\r?\n/g, " ").replace(/^([A-Za-z][\w-]*):/, "$1 -").slice(0, 68);
    git(dir, "-c", "user.name=" + agentId, "-c", "user.email=agent@kax.ninja-portal.com", "commit", "-m",
      `${subject}\n\n${formatCommitTrailers({
        commitmentId: commitment.id, principal, signature: row.signature,
      })}\nCo-Authored-By: ${agentId} <agent@kax.ninja-portal.com>`);
    const sha = git(dir, "rev-parse", "HEAD").trim();

    stage.name = "push";
    await assertNotRevoked(state);
    if (overCeiling(startedAt)) throw new Error("wall-clock ceiling reached");
    execFileSync("git", ["push", "origin", `HEAD:${branch}`], { cwd: dir, encoding: "utf8", timeout: STAGE_TIMEOUT_MS });

    stage.name = "pr";
    await assertNotRevoked(state);
    const prUrl = execFileSync("gh", ["pr", "create", "--repo", commitment.repo, "--head", branch,
      "--title", commitment.task.slice(0, 80),
      "--body", `Autonomous T0 work for commitment \`${commitment.id}\` by \`${principal}\`.\n\nTask, as spoken in the room: ${commitment.task}\n\nPR-only per KAX-ADR-0003 v0.1 — nothing lands without a human merge.`,
    ], { cwd: dir, encoding: "utf8", timeout: STAGE_TIMEOUT_MS }).trim();

    logRun({ phase: "completed", commitmentId: commitment.id, commitSha: sha, prUrl });
    await speak(`Done — the work I agreed to is up for review: ${prUrl}`);
    log(`PR: ${prUrl}`);
  } catch (e) {
    logRun({ phase: "failed", commitmentId: commitment.id, stage: stage.name, reason: String(e.message).slice(0, 200) });
    const line = failureLine(stage.name, e.message);
    await speak(line);
    log(line);
    releaseLock();
    process.exit(1);
  }
  releaseLock();
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
