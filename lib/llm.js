'use strict';

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { URL } = require('node:url');

/** One-click templates for common cloud + local OpenAI-compatible APIs. */
const PRESETS = [
  {
    kind: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    requiresKey: true,
    hint: 'Cloud · get a key at platform.deepseek.com',
  },
  {
    kind: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    requiresKey: true,
    hint: 'Cloud · platform.openai.com',
  },
  {
    kind: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openrouter/auto',
    requiresKey: true,
    hint: 'Cloud · many models with one key',
  },
  {
    kind: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    requiresKey: true,
    hint: 'Cloud · fast open models',
  },
  {
    kind: 'lmstudio',
    name: 'LM Studio',
    baseUrl: 'http://127.0.0.1:1234/v1',
    defaultModel: '',
    requiresKey: false,
    hint: 'Local · start the LM Studio local server',
  },
  {
    kind: 'ollama',
    name: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: '',
    requiresKey: false,
    hint: 'Local · ollama serve (OpenAI-compatible)',
  },
  {
    kind: 'custom',
    name: 'Custom OpenAI-compatible',
    baseUrl: 'http://127.0.0.1:8000/v1',
    defaultModel: '',
    requiresKey: false,
    hint: 'Any /v1 chat completions endpoint',
  },
];

function id(prefix = 'prov') {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}

function normalizeBaseUrl(url) {
  let u = String(url || '').trim().replace(/\/$/, '');
  if (!u) return '';
  // Accept host:port
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  // Common footgun: users paste root without /v1
  if (!/\/v1$/i.test(u) && /ollama|11434|lmstudio|1234/i.test(u)) {
    // don't force; keep as-is unless clearly missing path
  }
  return u;
}

function defaultProvidersFromEnv() {
  const deepseekKey = process.env.DEEPSEEK_API_KEY || '';
  const deepseekBase = normalizeBaseUrl(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1');
  const defaultModel = process.env.DEFAULT_MODEL || 'deepseek-v4-flash';

  const providers = [
    {
      id: 'deepseek',
      kind: 'deepseek',
      name: 'DeepSeek',
      baseUrl: deepseekBase,
      apiKey: deepseekKey,
      defaultModel,
      requiresKey: true,
      enabled: true,
    },
    {
      id: 'lmstudio',
      kind: 'lmstudio',
      name: 'LM Studio',
      baseUrl: normalizeBaseUrl(process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234/v1'),
      apiKey: process.env.LMSTUDIO_API_KEY || '',
      defaultModel: process.env.LMSTUDIO_MODEL || '',
      requiresKey: false,
      enabled: true,
    },
    {
      id: 'ollama',
      kind: 'ollama',
      name: 'Ollama',
      baseUrl: normalizeBaseUrl(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1'),
      apiKey: process.env.OLLAMA_API_KEY || '',
      defaultModel: process.env.OLLAMA_MODEL || '',
      requiresKey: false,
      enabled: true,
    },
  ];

  // Optional extra custom from env
  if (process.env.OPENAI_BASE_URL || process.env.OPENAI_API_KEY) {
    providers.push({
      id: 'openai-compat',
      kind: 'custom',
      name: process.env.OPENAI_PROVIDER_NAME || 'OpenAI-compatible',
      baseUrl: normalizeBaseUrl(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'),
      apiKey: process.env.OPENAI_API_KEY || '',
      defaultModel: process.env.OPENAI_MODEL || '',
      requiresKey: Boolean(process.env.OPENAI_API_KEY),
      enabled: true,
    });
  }

  return {
    activeProviderId: deepseekKey ? 'deepseek' : 'lmstudio',
    providers,
  };
}

function normalizeProvider(input = {}, fallback = {}) {
  const kind = String(input.kind || fallback.kind || 'custom').slice(0, 40);
  const preset = PRESETS.find((p) => p.kind === kind);
  const requiresKey = input.requiresKey !== undefined ? Boolean(input.requiresKey) : preset ? preset.requiresKey : true;
  return {
    id: String(input.id || fallback.id || id('prov')).slice(0, 64),
    kind,
    name: String(input.name || fallback.name || preset?.name || 'Provider').slice(0, 80),
    baseUrl: normalizeBaseUrl(input.baseUrl || fallback.baseUrl || preset?.baseUrl || ''),
    // Keep existing key if client sends blank mask
    apiKey: input.apiKey === '********' || input.apiKey === undefined
      ? String(fallback.apiKey || '')
      : String(input.apiKey || '').slice(0, 500),
    defaultModel: String(input.defaultModel ?? fallback.defaultModel ?? preset?.defaultModel ?? '').slice(0, 120),
    requiresKey,
    enabled: input.enabled === undefined ? fallback.enabled !== false : Boolean(input.enabled),
  };
}

function normalizeLlmSettings(input = {}, envDefaults = null) {
  const defaults = envDefaults || defaultProvidersFromEnv();
  const incoming = input && typeof input === 'object' ? input : {};
  const byId = new Map((defaults.providers || []).map((p) => [p.id, p]));
  let providers = Array.isArray(incoming.providers)
    ? incoming.providers.map((p) => normalizeProvider(p, byId.get(p.id) || {}))
    : defaults.providers.map((p) => normalizeProvider(p));

  // Merge env deepseek key if provider has no key yet
  providers = providers.map((p) => {
    if (p.kind === 'deepseek' && !p.apiKey && process.env.DEEPSEEK_API_KEY) {
      return { ...p, apiKey: process.env.DEEPSEEK_API_KEY };
    }
    return p;
  });

  if (!providers.length) providers = defaults.providers.map((p) => normalizeProvider(p));

  let activeProviderId = String(incoming.activeProviderId || defaults.activeProviderId || providers[0].id);
  if (!providers.some((p) => p.id === activeProviderId)) activeProviderId = providers[0].id;

  return { activeProviderId, providers };
}

function publicProvider(p) {
  return {
    id: p.id,
    kind: p.kind,
    name: p.name,
    baseUrl: p.baseUrl,
    defaultModel: p.defaultModel,
    requiresKey: p.requiresKey,
    enabled: p.enabled !== false,
    hasApiKey: Boolean(p.apiKey),
    apiKeyMasked: p.apiKey ? '********' : '',
  };
}

function publicLlmSettings(llm) {
  return {
    activeProviderId: llm.activeProviderId,
    providers: (llm.providers || []).map(publicProvider),
  };
}

function getActiveProvider(llm) {
  const list = llm?.providers || [];
  return list.find((p) => p.id === llm.activeProviderId) || list[0] || null;
}

function getProvider(llm, providerId) {
  if (!providerId) return getActiveProvider(llm);
  return (llm?.providers || []).find((p) => p.id === providerId) || getActiveProvider(llm);
}

function request(urlString, { method = 'GET', headers = {}, body = null, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch {
      reject(Object.assign(new Error(`Invalid URL: ${urlString}`), { status: 400 }));
      return;
    }
    const lib = url.protocol === 'https:' ? https : http;
    const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          ...headers,
          ...(payload ? { 'Content-Length': payload.length } : {}),
        },
        timeout: 20000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Connection timed out')));
    req.on('error', reject);
    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error('Aborted'));
        return;
      }
      signal.addEventListener('abort', () => req.destroy(new Error('Aborted')), { once: true });
    }
    if (payload) req.write(payload);
    req.end();
  });
}

function authHeaders(provider) {
  const headers = { Accept: 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  // Some local servers want a dummy bearer
  else if (provider.kind === 'lmstudio') headers.Authorization = 'Bearer lm-studio';
  return headers;
}

async function testProvider(provider) {
  if (!provider?.baseUrl) {
    return { ok: false, error: 'Base URL is required' };
  }
  if (provider.requiresKey && !provider.apiKey) {
    return { ok: false, error: 'API key is required for this provider' };
  }
  try {
    const res = await request(`${provider.baseUrl}/models`, {
      headers: authHeaders(provider),
    });
    const text = res.body.toString('utf8');
    if (res.status >= 400) {
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, status: res.status };
    }
    let models = [];
    try {
      const parsed = JSON.parse(text);
      models = (parsed.data || parsed.models || [])
        .map((m) => (typeof m === 'string' ? m : m.id || m.name))
        .filter(Boolean);
    } catch {
      /* ignore */
    }
    return {
      ok: true,
      baseUrl: provider.baseUrl,
      modelCount: models.length,
      models: models.slice(0, 40),
      defaultModel: provider.defaultModel || models[0] || '',
    };
  } catch (err) {
    return { ok: false, error: err.message || 'Connection failed' };
  }
}

async function listModels(provider) {
  if (!provider?.baseUrl) {
    return { models: provider?.defaultModel ? [provider.defaultModel] : [], provider: provider?.name || 'unknown' };
  }
  try {
    const res = await request(`${provider.baseUrl}/models`, { headers: authHeaders(provider) });
    if (res.status >= 400) {
      const fallback = [provider.defaultModel].filter(Boolean);
      return { models: fallback, provider: provider.name, error: `HTTP ${res.status}` };
    }
    const parsed = JSON.parse(res.body.toString('utf8'));
    let models = (parsed.data || parsed.models || [])
      .map((m) => (typeof m === 'string' ? m : m.id || m.name))
      .filter(Boolean);
    if (provider.defaultModel && !models.includes(provider.defaultModel)) {
      models = [provider.defaultModel, ...models];
    }
    if (!models.length && provider.defaultModel) models = [provider.defaultModel];
    return { models, provider: provider.name, baseUrl: provider.baseUrl };
  } catch (err) {
    const fallback = [provider.defaultModel].filter(Boolean);
    return { models: fallback, provider: provider.name, error: err.message };
  }
}

async function streamChatCompletions(provider, { messages, model, temperature, topP, maxTokens, signal, onDelta }) {
  if (!provider?.baseUrl) {
    throw Object.assign(new Error('No LLM provider configured. Open Settings → Models.'), { status: 400 });
  }
  if (provider.requiresKey && !provider.apiKey) {
    throw Object.assign(new Error(`${provider.name} needs an API key. Open Settings → Models.`), { status: 400 });
  }

  const useModel = model || provider.defaultModel;
  if (!useModel) {
    throw Object.assign(new Error('No model selected. Pick a model or set a default in Settings → Models.'), { status: 400 });
  }

  const payload = JSON.stringify({
    model: useModel,
    messages,
    stream: true,
    temperature: temperature ?? 0.8,
    top_p: topP ?? 0.95,
    max_tokens: maxTokens ?? 4096,
  });

  const url = new URL(`${provider.baseUrl}/chat/completions`);
  const lib = url.protocol === 'https:' ? https : http;
  const headers = {
    ...authHeaders(provider),
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'Content-Length': Buffer.byteLength(payload),
  };

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
      },
      (res) => {
        if ((res.statusCode || 0) >= 400) {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            reject(
              Object.assign(new Error(`${provider.name} error ${res.statusCode}: ${text.slice(0, 400)}`), {
                status: 502,
              }),
            );
          });
          return;
        }

        let buffer = '';
        let full = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          const parts = buffer.split('\n');
          buffer = parts.pop() || '';
          for (const line of parts) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content || '';
              if (delta) {
                full += delta;
                onDelta(delta, full);
              }
            } catch {
              /* partial */
            }
          }
        });
        res.on('end', () => resolve(full));
        res.on('error', reject);
      },
    );

    req.on('error', (err) => {
      const code = err?.code || '';
      if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH') {
        reject(
          Object.assign(
            new Error(
              `Cannot reach ${provider.name} at ${provider.baseUrl}. Is it running? Switch provider in Settings → Models.`,
            ),
            { status: 502, cause: err },
          ),
        );
        return;
      }
      reject(err);
    });
    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error('Aborted'));
        return;
      }
      signal.addEventListener('abort', () => req.destroy(new Error('Aborted')), { once: true });
    }
    req.write(payload);
    req.end();
  });
}

function createFromPreset(kind, overrides = {}) {
  const preset = PRESETS.find((p) => p.kind === kind) || PRESETS.find((p) => p.kind === 'custom');
  return normalizeProvider({
    id: id(preset.kind),
    kind: preset.kind,
    name: overrides.name || preset.name,
    baseUrl: overrides.baseUrl || preset.baseUrl,
    apiKey: overrides.apiKey || '',
    defaultModel: overrides.defaultModel ?? preset.defaultModel,
    requiresKey: preset.requiresKey,
    enabled: true,
  });
}

module.exports = {
  PRESETS,
  defaultProvidersFromEnv,
  normalizeLlmSettings,
  normalizeProvider,
  publicLlmSettings,
  publicProvider,
  getActiveProvider,
  getProvider,
  testProvider,
  listModels,
  streamChatCompletions,
  createFromPreset,
  normalizeBaseUrl,
};
