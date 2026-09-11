#!/usr/bin/env node
/**
 * Starts the local PostgreSQL container the app, the demo, and the test suite
 * all run against.
 *
 * Plain `docker run` rather than compose: only the docker CLI is assumed, and
 * there is exactly one way to start the database rather than two that can drift.
 *
 * Idempotent — running it when the database is already up is a no-op.
 */

import { spawnSync } from "node:child_process";

export const CONTAINER = "ids-checkin-postgres";

const IMAGE = "postgres:16-alpine";
const VOLUME = "ids-checkin-pgdata";

const run = (args, opts = {}) =>
  spawnSync("docker", args, { encoding: "utf8", stdio: "pipe", ...opts });

const COLOR = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (code) => (text) => (COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);
const red = paint(31);
const green = paint(32);
const dim = paint(2);

/** Whether the docker CLI exists AND its daemon is reachable. */
export function dockerStatus() {
  const version = run(["--version"]);
  if (version.error || version.status !== 0) return "NO_CLI";
  return run(["info"]).status === 0 ? "READY" : "NO_DAEMON";
}

export function dockerHelp(status) {
  if (status === "NO_CLI") {
    return [
      red("  Docker is not installed."),
      "",
      "  The application runs on PostgreSQL everywhere, so local development",
      "  needs a database. Install Docker Desktop, or run PostgreSQL another",
      "  way and point DATABASE_URL at it.",
    ].join("\n");
  }
  return [
    red("  Docker is installed but its daemon is not running."),
    "",
    "  Start it, then try again:",
    "",
    "      colima start        (if you use colima)",
    "      open -a Docker      (if you use Docker Desktop)",
  ].join("\n");
}

/** True once Postgres answers, false if it never does. */
function waitForPostgres(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (run(["exec", CONTAINER, "pg_isready", "-U", "ids", "-d", "ids_checkin"]).status === 0) {
      return true;
    }
    spawnSync("sleep", ["1"]);
  }
  return false;
}

export function ensureDatabase({ quiet = false } = {}) {
  const status = dockerStatus();
  if (status !== "READY") return { ok: false, reason: status };

  const state = run([
    "ps",
    "-a",
    "--filter",
    `name=^${CONTAINER}$`,
    "--format",
    "{{.State}}",
  ]).stdout.trim();

  if (state === "running") {
    return waitForPostgres(20000)
      ? { ok: true, started: false }
      : { ok: false, reason: "NOT_ANSWERING" };
  }

  if (!quiet) console.log(dim(`  Starting PostgreSQL (${IMAGE})...`));

  if (state) {
    run(["start", CONTAINER]);
  } else {
    const created = run([
      "run",
      "-d",
      "--name",
      CONTAINER,
      "-e",
      "POSTGRES_USER=ids",
      "-e",
      "POSTGRES_PASSWORD=ids_local_dev",
      "-e",
      "POSTGRES_DB=ids_checkin",
      "-p",
      "5432:5432",
      "-v",
      `${VOLUME}:/var/lib/postgresql/data`,
      IMAGE,
    ]);
    if (created.status !== 0) {
      return { ok: false, reason: "START_FAILED", detail: created.stderr.trim() };
    }
  }

  return waitForPostgres() ? { ok: true, started: true } : { ok: false, reason: "NOT_ANSWERING" };
}

export function explainFailure(result) {
  if (result.reason === "NO_CLI" || result.reason === "NO_DAEMON") return dockerHelp(result.reason);
  if (result.reason === "NOT_ANSWERING") {
    return red(`  PostgreSQL did not become ready. Check:  docker logs ${CONTAINER}`);
  }
  return red(`  Could not start PostgreSQL.\n\n  ${result.detail ?? ""}`);
}

// Run directly (npm run db:up), not when imported by the demo launcher.
if (process.argv[1] && process.argv[1].endsWith("db-up.mjs")) {
  const result = ensureDatabase();
  if (!result.ok) {
    console.error(`\n${explainFailure(result)}\n`);
    process.exit(1);
  }
  console.log(
    `  ${green("✓")} PostgreSQL ready on localhost:5432${result.started ? "" : " (already running)"}`,
  );
}
