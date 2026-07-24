import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pyScript = path.join(__dirname, "update_special.py");

// -u = unbuffered stdout/stderr so lines show up while Python runs (not only at the end).
const candidates = [
  ["py", "-3", "-u", pyScript],
  ["python", "-u", pyScript],
  ["python3", "-u", pyScript],
];

const env = {
  ...process.env,
  PYTHONUNBUFFERED: "1",
};
if (!process.env.FETCH_TIMEOUT) env.FETCH_TIMEOUT = "25";
if (!process.env.FETCH_RETRIES) env.FETCH_RETRIES = "2";
if (!process.env.FETCH_BACKOFF) env.FETCH_BACKOFF = "1";

console.log("[scrape] Running RSS fetch on your PC (first request may take up to ~25s)…");

for (const [cmd, ...args] of candidates) {
  console.log(`[scrape] Trying: ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    env,
    windowsHide: true,
  });
  if (result.status === 0) {
    console.log("[scrape] Done.");
    process.exit(0);
  }
  if (result.error && result.error.code === "ENOENT") {
    console.log(`[scrape] "${cmd}" not found, trying next…`);
    continue;
  }
  if (typeof result.status === "number" && result.status !== 0) {
    console.error(`[scrape] Python exited with code ${result.status}`);
    process.exit(result.status);
  }
}

console.error(
  "Could not run Python. Install Python 3 from https://www.python.org/downloads/\n" +
    "On Windows, enable the \"py\" launcher or add python.exe to PATH, then run again."
);
process.exit(1);
