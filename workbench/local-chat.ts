import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { setting } from "../env.js";
import { chatConfiguration, localOllamaName } from "./chat-config.js";
import type { ChatConfiguration } from "./chat.js";

const rememberedModel = z.object({ version: z.literal(1), model: z.string().min(1).max(200).refine(localOllamaName) }).strict();
const installedModels = z.object({ models: z.array(z.object({
  name: z.string().min(1).max(200), size: z.number().nonnegative(),
  remote_model: z.string().optional(), remote_host: z.string().optional(),
})).max(500) });
const modelDetails = z.object({
  capabilities: z.array(z.string()), remote_model: z.string().optional(), remote_host: z.string().optional(),
});

/** Only the unconfigured local application discovers a default. Approved bindings stay explicit. */
export async function localChatConfiguration(directory: string, options: {
  env?: NodeJS.ProcessEnv; request?: typeof fetch;
} = {}): Promise<ChatConfiguration> {
  const env = options.env;
  const provider = setting("MAGENTIC_LLM_PROVIDER", env)?.trim();
  const model = setting("MAGENTIC_LLM_CHAT_MODEL", env)?.trim();
  const baseUrl = setting("MAGENTIC_LLM_BASE_URL", env)?.trim();
  if (provider || model || baseUrl) {
    return chatConfiguration(true, { ...options, env: {
      ...(env ?? process.env), MAGENTIC_LLM_PROVIDER: provider || "ollama",
    } })!;
  }
  const path = join(directory, "local-model.json");
  let saved: string | undefined;
  try { saved = rememberedModel.parse(JSON.parse(readFileSync(path, "utf8"))).model; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("local-model.json is invalid. Restore the saved local model preference.");
  }
  let selected: string | undefined;
  const request = options.request ?? fetch;
  // Discovery sends no prompt and has one deadline; a stopped service must not prevent opening the workspace.
  const signal = AbortSignal.timeout(8_000);
  try {
    const response = await request("http://127.0.0.1:11434/api/tags", { signal, redirect: "error" });
    if (!response.ok) throw new Error("Model discovery failed");
    const candidates = installedModels.parse(await response.json()).models
      .filter(item => item.size > 0 && !item.remote_model && !item.remote_host && localOllamaName(item.name))
      .sort((a, b) => Number(b.name === saved) - Number(a.name === saved) || a.size - b.size || a.name.localeCompare(b.name));
    // Prefer the remembered model, then smaller downloads. Capability checks avoid selecting embedding-only models.
    for (const candidate of candidates.slice(0, 20)) {
      try {
        const response = await request("http://127.0.0.1:11434/api/show", {
          method: "POST", signal, redirect: "error", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: candidate.name }),
        });
        if (!response.ok) continue;
        const details = modelDetails.parse(await response.json());
        if (details.remote_model || details.remote_host || !details.capabilities.includes("completion")) continue;
        selected = candidate.name;
        break;
      } catch { if (signal.aborted) break; }
    }
  } catch { /* The catalog reports service availability when the user opens chat. */ }
  if (selected && selected !== saved) {
    writeFileSync(path + ".pending", JSON.stringify({ version: 1, model: selected }) + "\n", { mode: 0o600 });
    renameSync(path + ".pending", path);
  }
  return chatConfiguration(true, { ...options, localOnly: true, env: {
    ...(env ?? process.env), MAGENTIC_LLM_PROVIDER: "ollama",
    MAGENTIC_LLM_BASE_URL: "http://127.0.0.1:11434", MAGENTIC_LLM_CHAT_MODEL: selected ?? saved ?? "qwen2.5-coder:7b",
  } })!;
}
