# Start locally and keep your connections

After cloning and installing the repository's pinned dependencies, run:

```powershell
corepack pnpm start:local
```

This builds the workspace and starts the real local application. It is not the
scripted demo. With no explicit model settings, startup inspects Ollama at
`http://127.0.0.1:11434`, chooses an installed model with completion capability,
and remembers it for the next start. First use prefers a smaller model by download
size; that is not a quality or hardware-compatibility guarantee.

Install Ollama and download a chat model once on each machine. Ollama must be
running. Agentick does not install software, pull models or call inference at
startup. Discovery checks at most 20 local candidates within an eight-second
deadline. Embedding-only models and models marked remote/cloud are not
automatically selected.

If Ollama is stopped or has no suitable model, the workspace still opens. Start
Ollama, install a chat model if needed, then restart Agentick. A previously
configured model becomes usable again when Ollama is reachable; use Refresh
models for a running server. There is no automatic fallback to a paid provider.
Explicit `MAGENTIC_LLM_PROVIDER`, `MAGENTIC_LLM_CHAT_MODEL` and
`MAGENTIC_LLM_BASE_URL` settings take precedence.

## What survives a restart or another clone

The normal local application uses a data directory outside the checkout:

- Windows: `%LOCALAPPDATA%\MagenticDeveloper\data\workspaces`
- Linux/macOS: `$XDG_DATA_HOME/MagenticDeveloper/data/workspaces`, or
  `~/.local/share/MagenticDeveloper/data/workspaces`.

The existing directory name is retained so upgrades do not strand saved work.
`local-model.json` remembers the automatic model choice. Workspace records,
encrypted personal API connections and their matching vault key remain in this
directory. A second clone on the same machine and OS account reuses them when
launched with `start:local` or `local:workbench`.

Only one process may own a data directory. Close the earlier local server before
starting a different clone against the same data. Never delete its lock to force
a second instance. An incompatible or corrupt store stops startup rather than
opening an empty replacement.

To choose another persistent location, set `MAGENTIC_WORKSPACES_DIR` before
starting. Keep using that same path and encryption key. Do not copy secrets into
Git. A clone on a different machine does not inherit credentials or models.
Expired or revoked provider credentials still require replacement, and the
separate chat MCP credential still expires after seven days.

## Development and demo modes

`dev:workbench` intentionally keeps separate data under `.magentic-dev/data`
inside its checkout. Its restarts preserve that directory. To reuse a dedicated
development directory across clones, specify it each time:

```powershell
corepack pnpm dev:workbench --data-dir=C:/Agentick/dev-data --port=4188
```

Do not point two running servers at the same directory. Demo commands use
synthetic data and scripted responses unless explicitly launched in live mode;
they are not persistent account-connection environments.

The standalone relay's stdio/HTTP embedding and retrieval configuration remains
separate. This automatic local setup covers workspace chat, Chat MCP and the
workspace agents that use its model configuration; it does not enable relay
embeddings or connect private company systems automatically.

References: [Ollama model listing](https://docs.ollama.com/api/tags) and
[model metadata and capabilities](https://github.com/ollama/ollama/blob/main/docs/openapi.yaml).
