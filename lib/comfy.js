'use strict';

/**
 * ComfyUI client — Studio-style workflows (checkpoints, LoRAs, presets)
 * adapted from Agent Media Tools Comfy Studio.
 */

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const crypto = require('node:crypto');

const SIZE_PRESETS = [
  { id: 'portrait', label: 'Portrait', width: 832, height: 1216 },
  { id: 'square', label: 'Square', width: 1024, height: 1024 },
  { id: 'landscape', label: 'Landscape', width: 1216, height: 832 },
  { id: 'wide', label: 'Wide', width: 1344, height: 768 },
  { id: 'tall', label: 'Tall', width: 768, height: 1344 },
];

const QUICK_STYLES = [
  {
    id: 'anime',
    label: 'Anime',
    suffix: 'anime style, clean lineart, detailed eyes, high quality',
    negativeExtra: 'photorealistic, 3d, blurry, lowres',
  },
  {
    id: 'realistic',
    label: 'Realistic',
    suffix: 'photorealistic, natural lighting, detailed skin, high quality',
    negativeExtra: 'anime, cartoon, drawing, illustration',
  },
  {
    id: 'cinematic',
    label: 'Cinematic',
    suffix: 'cinematic lighting, dramatic composition, film still, high detail',
    negativeExtra: 'selfie, low quality, blurry',
  },
  {
    id: 'portrait',
    label: 'Portrait',
    suffix: 'portrait, looking at viewer, soft lighting, detailed face',
    negativeExtra: 'full body crowd, blurry face, extra limbs',
  },
];

function defaultComfySettings() {
  let baseUrl = 'http://100.88.12.25:8188';
  if (process.env.COMFY_URL) {
    baseUrl = String(process.env.COMFY_URL).replace(/\/$/, '');
  } else if (process.env.COMFY_HOST) {
    const host = String(process.env.COMFY_HOST).replace(/^https?:\/\//, '').replace(/\/$/, '');
    const port = process.env.COMFY_PORT || '8188';
    baseUrl = host.includes(':') ? `http://${host}` : `http://${host}:${port}`;
  }
  return {
    enabled: process.env.COMFY_ENABLED !== '0',
    baseUrl,
    checkpoint: process.env.COMFY_CHECKPOINT || 'waiIllustriousSDXL_v170.safetensors',
    width: 832,
    height: 1216,
    steps: 28,
    cfg: 5.5,
    sampler: 'euler_ancestral',
    scheduler: 'normal',
    seed: -1,
    negative:
      process.env.COMFY_NEGATIVE ||
      'lowres, worst quality, low quality, bad anatomy, bad hands, extra fingers, blurry, jpeg artifacts, text, watermark, child, loli, shota',
    timeoutMs: 300000,
    filenamePrefix: 'PersonalWebUI',
    loras: [],
  };
}

function normalizeLoras(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((l) => ({
      name: String(l.name || l.lora || l).slice(0, 260),
      weight: Number.isFinite(Number(l.weight)) ? Math.min(2, Math.max(-2, Number(l.weight))) : 1,
      trigger: String(l.trigger || '').slice(0, 200),
    }))
    .filter((l) => l.name)
    .slice(0, 5);
}

function normalizeComfySettings(input = {}) {
  const d = defaultComfySettings();
  const baseUrl = String(input.baseUrl || d.baseUrl || '').replace(/\/$/, '');
  return {
    enabled: input.enabled !== undefined ? Boolean(input.enabled) : d.enabled,
    baseUrl,
    checkpoint: String(input.checkpoint || d.checkpoint).slice(0, 260),
    width: clampInt(input.width, 256, 2048, d.width),
    height: clampInt(input.height, 256, 2048, d.height),
    steps: clampInt(input.steps, 1, 150, d.steps),
    cfg: clampNum(input.cfg, 0.1, 30, d.cfg),
    sampler: String(input.sampler || d.sampler).slice(0, 64),
    scheduler: String(input.scheduler || d.scheduler).slice(0, 64),
    seed: Number.isFinite(Number(input.seed)) ? Number(input.seed) : d.seed,
    negative: String(input.negative ?? d.negative).slice(0, 4000),
    timeoutMs: clampInt(input.timeoutMs, 15000, 900000, d.timeoutMs),
    filenamePrefix: String(input.filenamePrefix || d.filenamePrefix).replace(/[^\w.-]+/g, '_').slice(0, 64),
    loras: normalizeLoras(input.loras !== undefined ? input.loras : d.loras),
  };
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function request(baseUrl, route, { method = 'GET', body = null, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(route, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    } catch {
      reject(Object.assign(new Error(`Invalid ComfyUI URL: ${baseUrl}`), { status: 400 }));
      return;
    }
    const lib = url.protocol === 'https:' ? https : http;
    const payload = body
      ? Buffer.isBuffer(body)
        ? body
        : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
      : null;
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': payload.length,
            }
          : {},
        timeout: 30000,
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
    req.on('timeout', () => req.destroy(new Error('ComfyUI request timed out')));
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

async function comfyJson(settings, route, options = {}) {
  const res = await request(settings.baseUrl, route, options);
  const text = res.body.toString('utf8');
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  if (res.status >= 400) {
    const msg = data?.error?.message || data?.error || data?.raw || text.slice(0, 300) || `HTTP ${res.status}`;
    throw Object.assign(new Error(`ComfyUI ${route}: ${msg}`), { status: 502, detail: data });
  }
  return data;
}

function listFromInfo(info, node, key) {
  return info?.[node]?.input?.required?.[key]?.[0] || [];
}

/**
 * Studio-style workflow with optional LoRA chain (Comfy Studio agentWorkflow, checkpoint path).
 */
function buildStudioWorkflow(settings, { prompt, negative, seed, loras }) {
  const actualSeed = seed >= 0 ? Math.floor(seed) : Math.floor(Math.random() * 2 ** 32);
  const neg = negative != null && String(negative).length ? String(negative) : settings.negative;
  let positive = String(prompt || '');
  const chosenLoras = normalizeLoras(loras !== undefined ? loras : settings.loras);

  // Append LoRA triggers into the positive prompt (Comfy Studio convention)
  for (const l of chosenLoras) {
    if (l.trigger && !positive.toLowerCase().includes(l.trigger.toLowerCase())) {
      positive = `${l.trigger}, ${positive}`;
    }
  }

  const w = {
    1: {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: settings.checkpoint },
    },
  };

  let model = ['1', 0];
  let clip = ['1', 1];
  let nodeId = 10;
  for (const l of chosenLoras) {
    w[String(nodeId)] = {
      class_type: 'LoraLoader',
      inputs: {
        lora_name: l.name,
        strength_model: l.weight,
        strength_clip: l.weight,
        model,
        clip,
      },
    };
    model = [String(nodeId), 0];
    clip = [String(nodeId), 1];
    nodeId += 1;
  }

  const posId = String(nodeId++);
  const negId = String(nodeId++);
  const latentId = String(nodeId++);
  const sampleId = String(nodeId++);
  const decodeId = String(nodeId++);
  const saveId = String(nodeId++);

  w[posId] = {
    class_type: 'CLIPTextEncode',
    inputs: { text: positive, clip },
  };
  w[negId] = {
    class_type: 'CLIPTextEncode',
    inputs: { text: neg, clip },
  };
  w[latentId] = {
    class_type: 'EmptyLatentImage',
    inputs: {
      width: settings.width,
      height: settings.height,
      batch_size: 1,
    },
  };
  w[sampleId] = {
    class_type: 'KSampler',
    inputs: {
      seed: actualSeed,
      steps: settings.steps,
      cfg: settings.cfg,
      sampler_name: settings.sampler,
      scheduler: settings.scheduler,
      denoise: 1,
      model,
      positive: [posId, 0],
      negative: [negId, 0],
      latent_image: [latentId, 0],
    },
  };
  w[decodeId] = {
    class_type: 'VAEDecode',
    inputs: { samples: [sampleId, 0], vae: ['1', 2] },
  };
  w[saveId] = {
    class_type: 'SaveImage',
    inputs: {
      filename_prefix: settings.filenamePrefix || 'PersonalWebUI',
      images: [decodeId, 0],
    },
  };

  return {
    workflow: w,
    seed: actualSeed,
    prompt: positive,
    negative: neg,
    model: settings.checkpoint,
    loras: chosenLoras,
  };
}

async function getStatus(settings) {
  try {
    const stats = await comfyJson(settings, '/system_stats');
    return {
      ok: true,
      baseUrl: settings.baseUrl,
      system: stats.system || null,
      devices: stats.devices || null,
    };
  } catch (err) {
    return {
      ok: false,
      baseUrl: settings.baseUrl,
      error: err.message,
    };
  }
}

async function listModels(settings) {
  const assets = await listAssets(settings);
  return {
    checkpoints: assets.checkpoints,
    samplers: assets.samplers,
    schedulers: assets.schedulers,
    loras: assets.loras,
  };
}

async function listAssets(settings) {
  const info = await comfyJson(settings, '/object_info');
  const checkpoints = listFromInfo(info, 'CheckpointLoaderSimple', 'ckpt_name');
  const diffusionModels = listFromInfo(info, 'UNETLoader', 'unet_name');
  const loras = listFromInfo(info, 'LoraLoader', 'lora_name');
  const samplers = listFromInfo(info, 'KSampler', 'sampler_name');
  const schedulers = listFromInfo(info, 'KSampler', 'scheduler');
  return {
    checkpoints,
    diffusionModels,
    loras,
    samplers,
    schedulers,
    sizePresets: SIZE_PRESETS,
    quickStyles: QUICK_STYLES.map(({ id, label }) => ({ id, label })),
    defaults: {
      checkpoint: settings.checkpoint,
      width: settings.width,
      height: settings.height,
      steps: settings.steps,
      cfg: settings.cfg,
      sampler: settings.sampler,
      scheduler: settings.scheduler,
      negative: settings.negative,
    },
  };
}

async function queuePrompt(settings, input) {
  const built = buildStudioWorkflow(settings, input);
  const clientId = `personal-webui-${crypto.randomBytes(6).toString('hex')}`;
  const queued = await comfyJson(settings, '/prompt', {
    method: 'POST',
    body: { prompt: built.workflow, client_id: clientId },
  });
  return {
    promptId: queued.prompt_id,
    seed: built.seed,
    clientId,
    number: queued.number,
    prompt: built.prompt,
    negative: built.negative,
    model: built.model,
    loras: built.loras,
  };
}

async function waitForPrompt(settings, promptId, { timeoutMs, signal } = {}) {
  const deadline = Date.now() + (timeoutMs || settings.timeoutMs || 300000);
  while (Date.now() < deadline) {
    if (signal?.aborted) throw Object.assign(new Error('Aborted'), { status: 499 });
    const history = await comfyJson(settings, `/history/${encodeURIComponent(promptId)}`);
    const entry = history?.[promptId];
    if (entry) {
      if (entry.status?.status_str === 'error') {
        throw Object.assign(new Error('ComfyUI generation failed'), { status: 502 });
      }
      const images = [];
      for (const nodeOut of Object.values(entry.outputs || {})) {
        for (const img of nodeOut.images || []) images.push(img);
      }
      if (images.length) return { entry, images };
      if (entry.status?.completed || entry.status?.status_str === 'success') {
        return { entry, images };
      }
    }
    await sleep(1200, signal);
  }
  throw Object.assign(new Error('ComfyUI generation timed out'), { status: 504 });
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('Aborted'), { status: 499 }));
      return;
    }
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(Object.assign(new Error('Aborted'), { status: 499 }));
        },
        { once: true },
      );
    }
  });
}

async function fetchImage(settings, imageMeta) {
  const qs = new URLSearchParams({
    filename: imageMeta.filename,
    subfolder: imageMeta.subfolder || '',
    type: imageMeta.type || 'output',
  });
  const res = await request(settings.baseUrl, `/view?${qs}`);
  if (res.status >= 400) {
    throw Object.assign(new Error(`Failed to download image (${res.status})`), { status: 502 });
  }
  return {
    data: res.body,
    mimeType: res.headers['content-type'] || 'image/png',
    filename: imageMeta.filename,
  };
}

function applyStylePreset(prompt, negative, styleId) {
  const style = QUICK_STYLES.find((s) => s.id === styleId);
  if (!style) return { prompt, negative };
  let nextPrompt = String(prompt || '').trim();
  if (style.suffix && !nextPrompt.toLowerCase().includes(style.suffix.split(',')[0].toLowerCase())) {
    nextPrompt = nextPrompt ? `${nextPrompt}, ${style.suffix}` : style.suffix;
  }
  let nextNeg = String(negative || '').trim();
  if (style.negativeExtra) {
    nextNeg = nextNeg ? `${nextNeg}, ${style.negativeExtra}` : style.negativeExtra;
  }
  return { prompt: nextPrompt, negative: nextNeg };
}

function applySizePreset(settings, presetId) {
  const preset = SIZE_PRESETS.find((s) => s.id === presetId);
  if (!preset) return settings;
  return { ...settings, width: preset.width, height: preset.height };
}

async function generateImage(settings, input, opts = {}) {
  if (!settings.enabled) {
    throw Object.assign(new Error('Image generation is disabled in settings'), { status: 400 });
  }
  if (!settings.baseUrl) {
    throw Object.assign(new Error('ComfyUI base URL is not configured'), { status: 400 });
  }

  let runSettings = { ...settings };
  if (input.checkpoint) runSettings.checkpoint = String(input.checkpoint).slice(0, 260);
  if (input.width) runSettings.width = clampInt(input.width, 256, 2048, runSettings.width);
  if (input.height) runSettings.height = clampInt(input.height, 256, 2048, runSettings.height);
  if (input.steps) runSettings.steps = clampInt(input.steps, 1, 150, runSettings.steps);
  if (input.cfg != null) runSettings.cfg = clampNum(input.cfg, 0.1, 30, runSettings.cfg);
  if (input.sampler) runSettings.sampler = String(input.sampler).slice(0, 64);
  if (input.scheduler) runSettings.scheduler = String(input.scheduler).slice(0, 64);
  if (input.sizePreset) runSettings = applySizePreset(runSettings, input.sizePreset);

  let prompt = String(input.prompt || input.idea || '').trim();
  let negative = input.negative != null ? String(input.negative) : runSettings.negative;
  if (!prompt) throw Object.assign(new Error('Image prompt required'), { status: 400 });

  if (input.style) {
    const styled = applyStylePreset(prompt, negative, input.style);
    prompt = styled.prompt;
    negative = styled.negative;
  }

  const queued = await queuePrompt(runSettings, {
    prompt,
    negative,
    seed: input.seed != null ? Number(input.seed) : runSettings.seed,
    loras: input.loras,
  });

  const done = await waitForPrompt(runSettings, queued.promptId, {
    timeoutMs: input.timeoutMs || runSettings.timeoutMs,
    signal: opts.signal,
  });
  if (!done.images.length) {
    throw Object.assign(new Error('ComfyUI finished without images'), { status: 502 });
  }

  const file = await fetchImage(runSettings, done.images[0]);
  return {
    promptId: queued.promptId,
    seed: queued.seed,
    prompt: queued.prompt,
    negative: queued.negative,
    model: queued.model,
    loras: queued.loras,
    settings: {
      width: runSettings.width,
      height: runSettings.height,
      steps: runSettings.steps,
      cfg: runSettings.cfg,
      sampler: runSettings.sampler,
      scheduler: runSettings.scheduler,
      checkpoint: runSettings.checkpoint,
    },
    image: file,
    meta: done.images[0],
  };
}

module.exports = {
  defaultComfySettings,
  normalizeComfySettings,
  normalizeLoras,
  getStatus,
  listModels,
  listAssets,
  generateImage,
  queuePrompt,
  waitForPrompt,
  fetchImage,
  buildStudioWorkflow,
  SIZE_PRESETS,
  QUICK_STYLES,
  applyStylePreset,
  applySizePreset,
};
