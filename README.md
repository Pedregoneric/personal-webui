# Personal WebUI

Free, self-hosted **personal chat** for local and OpenAI-compatible cloud models. Characters, personas, prompt presets, image/file gallery, themes, and chat settings — on **your** machine.

**Free forever.** No paid tier, no feature unlocks. Optional one-time tips via [agentmediatools.com/tip](https://agentmediatools.com/tip) if it helps.

Sibling to [Grok WebUI](https://github.com/Pedregoneric/grok-webui) and [Codex WebUI](https://github.com/Pedregoneric/codex-webui) from Agent Media Tools — same privacy model, different job (personal chat + light Code mode, not shell agents).

## Features (v0.1)

- Multi-chat history with pin-friendly list + search
- Streaming chat via OpenAI-compatible APIs (DeepSeek default)
- Modes: **Chat**, **Companion**, **Story**, **Studio**, **Code**
- **Code mode** — per-chat file workspace, copyable fences, Apply path-tagged files, zip import/export (pair-program packs; not an agent shell)
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

### Code mode vs Codex / Grok WebUI

| | Personal WebUI **Code** | Codex / Grok WebUI |
|--|-------------------------|--------------------|
| Job | Pair-program in chat + zip packs | Agentic coding with shell/tools |
| Files | Per-chat sandbox under `data/workspaces/` | Real project workspace on disk |
| AI edits | Path-tagged fences → **Apply** | Tool loops / patches |
| Zip | Import / export project packs | Upload as attachments |

Stay on Codex/Grok WebUI when you need the model to run commands. Use Personal **Code** when you want a private chat that co-writes files and ships a zip.

## Security model

- Bind to Tailscale IP or localhost — not `0.0.0.0` on a public network
- Username + scrypt-hashed password; API keys only in server `.env`
- Sessions: random `HttpOnly`, `SameSite=Strict` cookies
- State-changing requests require same origin

This is a **trusted personal tool**, not multi-user SaaS. Do not port-forward it to the open internet.

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
```

## License

MIT
