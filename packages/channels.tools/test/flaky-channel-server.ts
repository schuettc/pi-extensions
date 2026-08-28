// A claude/channel server that fails its very first invocation and behaves
// like the normal fake server on every subsequent one — used to exercise the
// ConnectionManager retry path end to end (F1): a channel that fails at
// session_start and reconnects later via scheduleRetry().
//
// Env knobs:
//   FLAKY_COUNTER_FILE=path  → required; tracks invocation count across
//                              separate spawned processes.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const counterFile = process.env.FLAKY_COUNTER_FILE;
if (!counterFile) throw new Error("FLAKY_COUNTER_FILE is required");

let count = 0;
if (existsSync(counterFile)) count = Number(readFileSync(counterFile, "utf-8"));
count += 1;
writeFileSync(counterFile, String(count));

if (count === 1) {
  // Exit immediately without reading stdin or responding to `initialize` —
  // a deterministic mid-handshake death on the first attempt.
  process.exit(1);
} else {
  // Every later attempt behaves like a normal, healthy channel server.
  await import("./fake-channel-server.ts");
}
