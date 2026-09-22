# pi-typesafe

A generic **TypeSafe (Jev / System One)** capability for the
[pi coding agent](https://github.com/earendil-works/pi-coding-agent).

TypeSafe's Jev is **not a chat model**. It answers *typed questions* about a
piece of state and returns structured, typed answers (a choice, a score, a
noul, …) rather than free-form text. This package gives pi three things:

- **agent-owned credential storage** for the TypeSafe API key,
- a **thin SDK client** (`JevClient`) around `@typesafe-ai/sdk`, and
- a **question-bundle helper** for mapping typed answers into your own shape.

It is the generic core. Higher-level features (for example an automated
reviewer) build on top of it.

## Install

```
pi install npm:pi-typesafe
```

This registers a `/typesafe` command and exports a small library you can import
from other pi extensions.

## Commands

Manage the TypeSafe API key from inside pi:

- `/typesafe setup` — paste and store the API key. Input is **not masked**.
  Prompts before replacing an existing key.
- `/typesafe status` — report whether a key is configured and where it lives.
- `/typesafe logout` — delete the stored key (prompts to confirm).

The client also honors the `TYPESAFE_API_KEY` environment variable as a
fallback when no key has been stored.

## Library

```ts
import { CredentialStore, JevClient, evaluateBundle, type Bundle } from "pi-typesafe";

// Agent-owned credential file at <pi agent dir>/typesafe/config.json.
const credentials = new CredentialStore({ dir: resolveTypeSafeDir() });

const client = new JevClient({ credentials });

// Ask Jev one or more typed questions about some state.
const { answers, usage, latencyMs } = await client.evaluate(
  { text: "hi" },
  { q: { type: "noul", instructions: "how confident?" } },
);

// Or wrap a fixed set of questions in a Bundle and map the answers to a value.
const bundle: Bundle<number> = {
  id: "confidence",
  questions: { q: { type: "noul", instructions: "how confident?" } },
  map: (a) => (a.q as any).noul,
};
const { value } = await evaluateBundle(client, bundle, { text: "hi" });
```

### Exports

- **`CredentialStore`** — safe read/write/clear/inspect of the API-key file.
- **`resolveTypeSafeDir(env?, home?)`** — resolves the agent-owned credential
  directory (honors `PI_CODING_AGENT_DIR`, else `~/.pi/agent/typesafe`).
- **`validateApiKey(value)`** — validation helper used by the command.
- **`JevClient`** — thin wrapper over `@typesafe-ai/sdk`'s System One endpoint;
  resolves the key (stored or env), applies a timeout, and returns
  `{ answers, usage, latencyMs }`.
- **`Bundle<T>` / `evaluateBundle`** — bundle a fixed set of questions with a
  `map` function that turns the typed answers into your own value.

## Credential storage & security

The API key is stored as plaintext JSON in an extension-owned directory:

```
<pi agent dir>/typesafe/config.json
```

where `<pi agent dir>` is `$PI_CODING_AGENT_DIR` if set, otherwise
`~/.pi/agent`.

The directory is created with mode `0700` and the file with mode `0600`
(owner-only). Writes are atomic (write-to-temp then `rename`), and the store
refuses to follow symlinks or touch non-regular files. This is the **same
security posture as pi's own `auth.json`**: plaintext on disk, protected by
filesystem permissions rather than encryption. Anyone who can read your home
directory as your user can read the key, so treat the machine accordingly.

## Attribution

The `CredentialStore` implementation is adapted from
[legacybridge-tech/pi-typesafe-jev](https://github.com/legacybridge-tech/pi-typesafe-jev)
(`src/config.ts`), MIT License, © 2025 pi-typesafe-jev authors.

## License

MIT.
