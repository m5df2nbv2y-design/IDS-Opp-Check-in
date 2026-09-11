#!/usr/bin/env node
/**
 * One-command local demo launcher.
 *
 * Starts the ordinary `next dev` server with the ordinary local .env — no
 * separate demo configuration, no networking, no deployment. Its only jobs are
 * to check the port is free, wait until Next is genuinely listening, print a
 * status banner, and open the dashboard.
 *
 * It NEVER prints an environment value. Only an allowlist of non-secret
 * provider names is read from .env, so a credential cannot reach the terminal
 * even by accident.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 3000;
const DASHBOARD = `http://localhost:${PORT}/admin`;

/**
 * The only keys this script may read. Anything not named here — every
 * credential — is never parsed and can never be printed.
 */
const SAFE_KEYS = [
  "SALESFORCE_PROVIDER",
  "EMAIL_PROVIDER",
  "SALESFORCE_WRITE_ENABLED",
  "AUTH_DEV_BYPASS",
];

// Colour only when a terminal is actually attached, so piped output stays
// clean. Escapes are written as \u001b rather than as literal control bytes.
const COLOR = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (code) => (text) => (COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);
const bold = paint(1);
const dim = paint(2);
const green = paint(32);
const yellow = paint(33);
const red = paint(31);

function readSafeConfig() {
  const config = {};
  let raw = "";
  try {
    raw = readFileSync(`${ROOT}.env`, "utf8");
  } catch {
    return config;
  }
  for (const line of raw.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    if (!SAFE_KEYS.includes(key)) continue;
    config[key] = value.trim().replace(/^["']|["']$/g, "");
  }
  return config;
}

/**
 * Resolves true when nothing is already listening on the port.
 *
 * Binds with no host, exactly as Next does, so the probe sees an existing
 * IPv6/dual-stack listener. Probing 127.0.0.1 alone reports the port free while
 * a server on :: is holding it — which lets Next quietly fall back to 3001 and
 * points the browser at the wrong instance.
 */
function portIsFree() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(PORT);
  });
}

/** Who holds the port — reported so the user can decide, never killed here. */
function describePortHolder() {
  return new Promise((resolve) => {
    const lsof = spawn("lsof", ["-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    lsof.stdout.on("data", (chunk) => (out += chunk));
    lsof.on("error", () => resolve(null));
    lsof.on("close", () => resolve(out.trim() || null));
  });
}

async function waitForServer(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Any HTTP response means Next is listening; /admin itself redirects to
      // sign-in, which is a perfectly good readiness signal.
      const response = await fetch(`http://127.0.0.1:${PORT}/admin`, {
        redirect: "manual",
        signal: AbortSignal.timeout(4000),
      });
      if (response.status > 0) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

function openBrowser(url) {
  if (process.platform !== "darwin") return false;
  try {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

function banner(config, browserOpened) {
  const salesforce = config.SALESFORCE_PROVIDER ?? "mock";
  const email = config.EMAIL_PROVIDER ?? "mock";
  const writeEnabled = config.SALESFORCE_WRITE_ENABLED === "true";
  const devBypass = config.AUTH_DEV_BYPASS === "true";

  const lines = [
    "",
    bold("  IDS OPPORTUNITY CHECK-IN — MVP"),
    dim("  ────────────────────────────────────────────────"),
    "",
    "  Dashboard:",
    bold(`      ${DASHBOARD}`),
    "",
    "  Status:",
    `      ${green("✓")} Next.js running on port ${PORT}`,
  ];

  lines.push(
    salesforce === "mock"
      ? `      ${green("✓")} Salesforce: mock demo org — no real records touched`
      : `      ${green("✓")} Salesforce: live org — ${writeEnabled ? red("WRITE-BACK ON") : "read-only"}`,
  );

  lines.push(
    email === "mock"
      ? `      ${green("✓")} Mock email provider active — captured in the outbox`
      : `      ${yellow("!")} Email provider is "${email}" — real email may be sent`,
  );

  lines.push(
    devBypass
      ? `      ${green("✓")} Local demo sign-in enabled`
      : `      ${green("✓")} Entra ID sign-in required`,
  );

  lines.push(`      ${green("✓")} Local demo environment active`);

  // A live org with write-back on is the one combination that could change real
  // data during the demo, so it is called out rather than left in the list.
  if (salesforce !== "mock" && writeEnabled) {
    lines.push(
      "",
      red("  WARNING: Salesforce write-back is ENABLED against a live org."),
      red("  Set SALESFORCE_WRITE_ENABLED=\"false\" in .env before presenting."),
    );
  }

  lines.push("");
  lines.push(
    browserOpened
      ? dim("  Your browser is opening the dashboard.")
      : dim(`  Open this in your browser:  ${DASHBOARD}`),
  );
  lines.push(dim("  Press Ctrl+C to stop."));
  lines.push("");

  console.log(lines.join("\n"));
}

async function main() {
  const config = readSafeConfig();

  if (!(await portIsFree())) {
    const holder = await describePortHolder();
    console.error(
      [
        "",
        red(`  Port ${PORT} is already in use, so the demo was not started.`),
        "",
        "  Something is already listening there — most likely an existing",
        "  `npm run dev` in another terminal tab.",
        "",
        holder ? dim(holder.split("\n").map((line) => `  ${line}`).join("\n")) : "",
        "",
        `  If that IS the app, just open:  ${bold(DASHBOARD)}`,
        "  Otherwise stop that process in its own terminal (Ctrl+C) and",
        "  run this again. Nothing was killed automatically.",
        "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    process.exit(1);
  }

  console.log(dim("\n  Starting IDS Opportunity Check-In…\n"));

  // --port pins Next to 3000. Without it Next falls back to the next free
  // port, and the demo URL in the banner would be wrong.
  const child = spawn("npm", ["run", "dev", "--", "--port", String(PORT)], {
    cwd: ROOT,
    // Next's own startup chatter is held back so the banner is what the
    // presenter sees; it is printed in full if startup fails.
    stdio: ["inherit", "pipe", "pipe"],
    env: process.env,
  });

  let startupLog = "";
  let ready = false;
  const capture = (chunk) => {
    const text = chunk.toString();
    if (ready) process.stdout.write(text);
    else startupLog += text;
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  const stop = () => {
    if (!child.killed) child.kill("SIGINT");
  };
  process.on("SIGINT", () => {
    stop();
    console.log(dim("\n  Stopped. The demo is no longer running.\n"));
    process.exit(0);
  });
  process.on("SIGTERM", stop);

  child.on("exit", (code) => {
    if (!ready) {
      console.error(startupLog);
      console.error(red(`\n  The server exited before it was ready (code ${code}).\n`));
    }
    process.exit(code ?? 0);
  });

  const up = await waitForServer();
  if (!up) {
    console.error(startupLog);
    console.error(red(`\n  The server did not start listening on port ${PORT} in time.\n`));
    stop();
    process.exit(1);
  }

  ready = true;
  const browserOpened = openBrowser(DASHBOARD);
  banner(config, browserOpened);
}

main();
