# Personal WebUI

Free, self-hosted **personal chat** for local and OpenAI-compatible cloud models. Characters, personas, prompt presets, folders, image/file gallery, themes, and chat settings — on **your** machine.

**Free forever.** No paid tier, no feature unlocks. Optional one-time tips via [agentmediatools.com/tip](https://agentmediatools.com/tip) if it helps.

Sibling to [Grok WebUI](https://github.com/Pedregoneric/grok-webui) and [Codex WebUI](https://github.com/Pedregoneric/codex-webui) from Agent Media Tools — same privacy model, different job (personal chat + light Code mode, not shell agents).

![Personal WebUI Companion mode](docs/screenshots/personal-webui-companion.png)

<p align="center">
  <a href="docs/screenshots/personal-webui-code.png">Code mode</a> ·
  <a href="docs/screenshots/personal-webui-mobile.png">Mobile view</a> ·
  <a href="https://agentmediatools.com/personal-webui">Product page</a> ·
  <a href="https://agentmediatools.com/tip?from=personal-webui">Optional tip</a>
</p>

## Features (v0.1)

- Multi-chat history with **pin / delete** on the sidebar, plus search
- Streaming chat via OpenAI-compatible APIs (DeepSeek default)
- Modes: **Chat**, **Companion**, **Story**, **Studio**, **Code**
- **Code mode** — per-chat file workspace, copyable fences, Apply path-tagged files, zip import/export (pair-program packs; not an agent shell)
- **Folders** — group chats; optional folder system/style prompts and default model/sampling/preset (**inherit with chat override**)
- Message actions: **Copy** / **Regenerate** / **Branch** (branch clones the thread up through that reply)
- **Characters** (system prompt, personality, scenario, first message, examples)
- **User personas** (who you are in the chat)
- **Prompt presets** (system/style + generation defaults)
- Temperature / top_p / max tokens per chat
- Image & file gallery (upload, browse; stays local)
- Themes, accents, density, chat width, font scale, custom CSS
- Prompt preview (exact messages that would be sent)
- Markdown export
- Password-protected UI, Tailscale-friendly bind
- Optional tip link (does not unlock features)

### Modes

| Mode | Role |
|------|------|
| **Chat** | Clean conversation |
| **Companion** | Character-first presence |
| **Story** | Scene / narrative notes |
| **Studio** | Creative / image-oriented layout |
| **Code** | Per-chat sandbox workspace + zip packs |

### Folders

Chats can sit in a flat folder (or stay unfiled). A folder may set `systemPrompt`, `stylePrompt`, and defaults for model / temperature / top_p / max tokens / preset. **Null folder fields inherit** from mode/settings; **chat fields override** folder when set. New chats inherit the active sidebar folder. Collapse/expand folders in the list; edit folder settings from the folder header.

### Message & sidebar actions

- On assistant replies: **Copy**, **Regenerate** (truncate from that message and re-stream), **Branch** (new chat cloned through that message, same folder/mode/settings).
- On each sidebar thread: **Pin** / **Unpin**, **Delete** (with confirm), **Move** into a folder.

### Multi-user & admin

- Accounts live in `data/users.json` with durable sessions in `data/sessions.json`.
- Each user gets an isolated tree under `data/users/{userId}/` (chats, folders, library, settings, workspaces, media).
- **First account from `.env`** (`WEBUI_USERNAME` + password salt/hash) becomes **admin** on boot migration; first-visit browser setup also creates an admin.
- **Open signup defaults to off** (`app.signupEnabled`). Admins can create users and optionally enable signup.
- **Admin area** at [`/admin`](/admin) — manage users (role, disable, reset password), signup toggle, brand title, tip URL. Admins do **not** browse other users’ chats.

This remains a **trusted personal / small-household tool** on Tailscale or localhost — not public multi-tenant SaaS. Do not port-forward it to the open internet.

### Code mode vs Codex / Grok WebUI

| | Personal WebUI **Code** | Codex / Grok WebUI |
|--|-------------------------|--------------------|
| Job | Pair-program in chat + zip packs | Agentic coding with shell/tools |
| Files | Per-chat sandbox under `data/users/…/workspaces/` | Real project workspace on disk |
| AI edits | Path-tagged fences → **Apply** | Tool loops / patches |
| Zip | Import / export project packs | Upload as attachments |
| Agents | None — you drive the chat | Shell / tool agents run commands |

Stay on Codex/Grok WebUI when you need the model to run commands. Use Personal **Code** when you want a private chat that co-writes files and ships a zip.

## Security model

- Bind to Tailscale IP or localhost — not `0.0.0.0` on a public network
- Username + scrypt-hashed password; API keys only in server `.env`
- Sessions: random `HttpOnly`, `SameSite=Strict` cookies
- Browser hardening headers on every response; session cookies become `Secure` automatically behind an HTTPS proxy
- State-changing requests require same origin
- Admin routes return **403** for non-admins; signup returns **403** when disabled

## Setup

Prerequisites: Node.js 20+

```bash
cd /path/to/personal-webui
cp .env.example .env   # if present; or create .env
# Set DEEPSEEK_API_KEY, HOST, PORT, and either run first-visit setup in the browser
# or set WEBUI_USERNAME + PASSWORD_SALT + PASSWORD_HASH
npm start
```

Default port: **4547**.

Useful deployment options:

```env
# Force Secure session cookies when TLS terminates somewhere that does not
# forward X-Forwarded-Proto: https.
COOKIE_SECURE=true

# Optional alternate env file (useful for services, tests, or parallel installs).
PERSONAL_WEBUI_ENV_FILE=/path/to/personal-webui.env
```

On boot the server runs an **idempotent migration**: if legacy flat `data/` chats/settings/library exist (or `.env` credentials are present and no users yet), they move into the admin user’s namespace under `data/users/{id}/`. Re-running start is safe — already-migrated installs are skipped.

### DeepSeek

```env
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
DEFAULT_MODEL=deepseek-chat
```

LM Studio / Ollama can be wired the same way later (OpenAI-compatible base URL).

## Development

```bash
npm start
npm run check
npm test
```

Zero npm dependencies. Tests use Node’s built-in `node:test` only.

## License

MIT
