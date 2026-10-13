import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const authDir = join(tmpdir(), `workbuddy-session-start-${process.pid}`);
await mkdir(authDir, { recursive: true });
// intl cred only; the cn edition has no cred here and must still not block.
await writeFile(join(authDir, ".workbuddy-auth.json"), JSON.stringify({
  version: 1,
  credential: {
    accessToken: "test-token",
    refreshToken: "",
    expiresAtMs: Date.now() + 60 * 60 * 1000,
    domain: "",
    uid: "test-user",
  },
}));
process.env.PI_CODING_AGENT_DIR = authDir;

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => await new Promise<Response>(() => {});

const ext: any = await import("../extensions/workbuddy.ts");
const handlers: Record<string, Function[]> = {};
const pi: any = {
  on: (name: string, fn: Function) => { (handlers[name] ??= []).push(fn); },
  registerProvider: () => {},
  registerCommand: () => {},
};
await ext.default(pi);

const starts = handlers.session_start ?? [];
if (starts.length !== 2) throw new Error(`expected 2 session_start handlers (both editions), got ${starts.length}`);

const ui = { setWidget() {}, setStatus() {}, notify() {} };
for (const [i, start] of starts.entries()) {
  const result = await Promise.race([
    start({}, { model: { provider: i === 0 ? "workbuddy" : "codebuddy" }, ui }),
    new Promise<symbol>((resolve) => setTimeout(() => resolve(Symbol.for("timed-out")), 100)),
  ]);
  if (result === Symbol.for("timed-out")) {
    throw new Error(`session_start handler ${i} is blocked by a network request`);
  }
}
globalThis.fetch = originalFetch;
console.log("OK: both editions' session_start return without waiting for network");
