// Proves the before_provider_request hook leaks into other providers' payloads,
// and that both editions (workbuddy intl + codebuddy cn) register cleanly.
const ext: any = await import("../extensions/workbuddy.ts");

const handlers: Record<string, Function[]> = {};
const registered: any[] = [];
const commands: string[] = [];
const pi: any = {
  on: (name: string, fn: Function) => { (handlers[name] ??= []).push(fn); },
  registerProvider: (id: string, cfg: any) => { registered.push({ id, cfg }); },
  registerCommand: (name: string) => { commands.push(name); },
};

await ext.default(pi);

// --- two providers, cleanly separated ---
const ids = registered.map((r) => r.id).sort();
if (JSON.stringify(ids) !== JSON.stringify(["codebuddy", "workbuddy"])) {
  throw new Error(`expected [codebuddy, workbuddy], got ${JSON.stringify(ids)}`);
}
const markers = registered.map((r) => r.cfg.headers).flatMap((h: any) => Object.keys(h));
if (new Set(markers).size !== 2 || !markers.every((m: string) => m.startsWith("X-Pi-"))) {
  throw new Error(`expected two distinct X-Pi-* markers, got ${JSON.stringify(markers)}`);
}
const baseUrls = Object.fromEntries(registered.map((r) => [r.id, r.cfg.baseUrl]));
if (baseUrls.workbuddy !== "https://www.workbuddy.ai/v2") throw new Error("intl baseUrl");
if (baseUrls.codebuddy !== "https://copilot.tencent.com/v2") throw new Error("cn baseUrl");
if (JSON.stringify(commands.sort()) !== JSON.stringify(["codebuddy", "workbuddy"])) {
  throw new Error(`expected both commands, got ${JSON.stringify(commands)}`);
}
console.log("OK: both editions registered with distinct ids, markers, baseUrls, commands.");

// --- the request hook still leaves foreign providers alone ---
const hook = handlers["before_provider_request"]?.[0];
if (!hook) throw new Error("no before_provider_request handler");

// A totally unrelated provider's payload (grok, deepseek, anything).
const foreign = {
  model: "grok-4.6",
  messages: [
    { role: "developer", content: "You are Grok." },
    { role: "user", content: "hi" },
  ],
  tool_choice: "none",
  tools: [{ type: "function", function: { name: "bash" } }],
};
const before = JSON.stringify(foreign);
hook({ type: "before_provider_request", payload: foreign });
const after = JSON.stringify(foreign);

console.log("foreign payload changed?", before !== after);
if (before !== after) {
  const now = foreign as any;
  console.log("  role[0]:", JSON.parse(before).messages[0].role, "->", now.messages[0].role);
  console.log("  tools kept?", now.tools !== undefined, " tool_choice:", JSON.stringify(now.tool_choice));
  console.log("  msg count:", JSON.parse(before).messages.length, "->", now.messages.length);
  console.log("\nREGRESSION: another provider's request was rewritten.");
  process.exit(1);
}
console.log("OK: foreign provider payload untouched.");

// --- the request hook DOES normalize our own models (either edition) ---
for (const model of ["hy3", "deepseek-v4.1-flash"]) {
  const ours: any = { model, messages: [{ role: "developer", content: "s" }], tool_choice: "none" };
  const result = hook({ type: "before_provider_request", payload: ours });
  if (result?.stream !== true) throw new Error(`stream not forced for ${model}`);
  if (ours.messages[0].role !== "system") throw new Error(`developer role not rewritten for ${model}`);
  if ("tool_choice" in ours) throw new Error(`tool_choice=none not dropped for ${model}`);
}
console.log("OK: own models normalized, both editions covered by the shared hook.");
