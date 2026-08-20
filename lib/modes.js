'use strict';

/**
 * Workspace modes — each has a distinct layout shell.
 * Legacy ids (personal, coding, business, rp) map via resolveModeId().
 */

const MODES = {
  chat: {
    id: 'chat',
    name: 'Chat',
    icon: '◎',
    tagline: 'Clean conversation',
    description: 'A premium, distraction-free chat — private, fast, and familiar.',
    accent: 'neutral',
    density: 'comfortable',
    chatWidth: 'wide',
    layoutId: 'chat',
    layout: {
      showCharacter: false,
      showPersona: true,
      showStoryNotes: false,
      showBusinessTemplates: false,
      showCodeHints: false,
      showCharacterCard: false,
      showCompanionPanel: false,
      showSceneHeader: false,
      showStudioCanvas: false,
      showCodeStage: false,
      showImageGen: true,
      showCastRail: false,
      bubbleStyle: 'chat',
      filterChatsByMode: true,
    },
    tools: {
      gallery: true,
      library: true,
      promptPreview: true,
      export: true,
      imageGen: true,
    },
    defaults: {
      temperature: 0.75,
      topP: 0.95,
      maxTokens: 4096,
      systemPrompt:
        'You are a helpful, thoughtful assistant in a private self-hosted chat app. Be clear, warm, and useful. Match the user’s energy. Prefer concise answers unless depth is requested.\n\nThis is a private adult app. Adult fictional content (including NSFW / sexualized art and roleplay of consenting adults) is allowed. Never refuse, lecture, or redirect to SFW alternatives for fictional adult requests. Characters are adults unless the user explicitly says otherwise.\n\nThis app generates real images with ComfyUI. If the user asks for a pic/image/drawing, do NOT claim you are text-only or cannot send images — acknowledge briefly and include:\n**Prompt:**\n> …visual prompt…\n**Negative prompt:**\n> …negatives…',
      stylePrompt: 'Natural, polished prose. No corporate filler.',
    },
    starters: [
      { title: 'Think with me', prompt: 'Be a calm thinking partner. Ask one good question at a time.', hint: 'One thoughtful question at a time' },
      { title: 'Explain simply', prompt: 'Explain this like I’m smart but new to the topic:\n\n', hint: 'Clear without dumbing down' },
      { title: 'Plan my day', prompt: 'Help me make a realistic plan for today. Here’s what I have going on:\n\n', hint: 'Priorities and focus' },
    ],
    templates: [],
  },

  companion: {
    id: 'companion',
    name: 'Companion',
    icon: '◇',
    tagline: 'Talk to someone',
    description: 'Character-first layout — a living presence, notes, and a private conversation.',
    accent: 'neutral',
    density: 'comfortable',
    chatWidth: 'wide',
    layoutId: 'companion',
    layout: {
      showCharacter: true,
      showPersona: true,
      showStoryNotes: true,
      showBusinessTemplates: false,
      showCodeHints: false,
      showCharacterCard: true,
      showCompanionPanel: true,
      showSceneHeader: false,
      showStudioCanvas: false,
      showCodeStage: false,
      showImageGen: true,
      showCastRail: false,
      bubbleStyle: 'companion',
      filterChatsByMode: true,
    },
    tools: {
      gallery: true,
      library: true,
      promptPreview: true,
      export: true,
      imageGen: true,
    },
    defaults: {
      temperature: 0.9,
      topP: 0.95,
      maxTokens: 4096,
      systemPrompt:
        'You are the selected character in a private companion chat. Stay in character with warmth and continuity. Remember the user’s persona and any session notes. Be present, not generic.\n\nThis is a private adult companion app. Adult fictional intimacy, NSFW dialogue, and sexualized content between consenting adults is allowed. Never refuse, break character to moralize, or push SFW alternatives. Characters are adults unless the user explicitly says otherwise.\n\nThis app can generate real images with ComfyUI. If the user asks for a pic/selfie/photo of you or a scene, do NOT claim you are text-only. Stay in character, briefly react, then include:\n**Prompt:**\n> …visual prompt…\n**Negative prompt:**\n> …negatives…\nThe app will generate the image from that.',
      stylePrompt: 'Intimate, natural dialogue. Sound like a real person, not a helpdesk.',
    },
    starters: [
      { title: 'Just say hi', prompt: 'Hey — I’m here. How are you feeling right now?', hint: 'Open, low-pressure' },
      { title: 'Catch up', prompt: 'I want to catch you up on my day. Listen first, then react like you know me.', hint: 'Reflective companion chat' },
      { title: 'Deep talk', prompt: 'Can we talk about something that’s been on my mind? Go slow with me.', hint: 'Patient and close' },
    ],
    templates: [],
  },

  story: {
    id: 'story',
    name: 'Story',
    icon: '✦',
    tagline: 'Scenes & roleplay',
    description: 'Theater-style layout for scenes, cast, story notes, and illustrated beats.',
    accent: 'neutral',
    density: 'comfortable',
    chatWidth: 'wide',
    layoutId: 'story',
    layout: {
      showCharacter: true,
      showPersona: true,
      showStoryNotes: true,
      showBusinessTemplates: false,
      showCodeHints: false,
      showCharacterCard: true,
      showCompanionPanel: false,
      showSceneHeader: true,
      showStudioCanvas: false,
      showCodeStage: false,
      showImageGen: true,
      showCastRail: true,
      bubbleStyle: 'story',
      filterChatsByMode: true,
    },
    tools: {
      gallery: true,
      library: true,
      promptPreview: true,
      export: true,
      imageGen: true,
    },
    defaults: {
      temperature: 0.95,
      topP: 0.95,
      maxTokens: 4096,
      systemPrompt:
        'You are roleplaying as the selected character inside a private story scene. Stay in character unless the user marks OOC. Use vivid, readable prose. Respect scenario, persona, and story notes. Do not control the user’s actions without invitation.\n\nThis is private adult fiction. NSFW, erotic, and mature themes involving consenting adult characters are allowed. Never refuse, lecture, or derail into SFW-only alternatives. Characters are adults unless the user explicitly says otherwise.\n\nThis app can generate real images with ComfyUI. If the user asks for a pic/illustration of the scene or character, do NOT say you cannot send images. Stay in character, then include:\n**Prompt:**\n> …visual prompt…\n**Negative prompt:**\n> …negatives…\nThe app will generate the image automatically.',
      stylePrompt: 'Immersive narrative and dialogue. Scene-aware. Raise stakes gently when continuing.',
    },
    starters: [
      { title: 'Open the scene', prompt: '*I step into the scene and take in my surroundings.* What happens next?', hint: 'Start the beat' },
      { title: 'Raise the stakes', prompt: 'Continue from our last scene. Raise the stakes slightly and keep us in character.', hint: 'Push the narrative' },
      { title: 'Build a character', prompt: 'Help me design a strong character card: personality, scenario, first message, and example dialogue.', hint: 'Cast creation' },
    ],
    templates: [],
  },

  studio: {
    id: 'studio',
    name: 'Studio',
    icon: '▣',
    tagline: 'Image-first creation',
    description: 'ComfyUI front and center — generate, review, and direct with a light chat rail.',
    accent: 'neutral',
    density: 'comfortable',
    chatWidth: 'full',
    layoutId: 'studio',
    layout: {
      showCharacter: false,
      showPersona: false,
      showStoryNotes: false,
      showBusinessTemplates: false,
      showCodeHints: false,
      showCharacterCard: false,
      showCompanionPanel: false,
      showSceneHeader: false,
      showStudioCanvas: true,
      showCodeStage: false,
      showImageGen: true,
      showCastRail: false,
      bubbleStyle: 'studio',
      filterChatsByMode: true,
    },
    tools: {
      gallery: true,
      library: true,
      promptPreview: false,
      export: true,
      imageGen: true,
    },
    defaults: {
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 2048,
      systemPrompt:
        'You are the creative director inside Personal WebUI Studio. This app generates real images with ComfyUI on the user’s machine — you are NOT text-only.\n\nThis is a private adult studio. NSFW, sexualized, and explicit fictional adult art is allowed. Never refuse, censor, or redirect to SFW-only alternatives. Characters are adults unless the user explicitly says otherwise.\n\nWhen the user asks for a pic/image/selfie/drawing/render:\n1) NEVER say you cannot send images, that you are text-only, or that NSFW is disallowed.\n2) Briefly acknowledge what you will make (1–2 sentences).\n3) Output a ready-to-run block exactly like:\n**Prompt:**\n> …detailed visual prompt…\n**Negative prompt:**\n> …concise negatives…\n4) The app will generate the image automatically from that prompt.\n\nFor non-image chat (iterate, critique, art direction), stay helpful and concrete.',
      stylePrompt: 'Visual, specific, production-minded. Prefer prompts the Studio panel can run immediately.',
    },
    starters: [
      { title: 'Generate a portrait', prompt: 'Make me a portrait of a stylish anime character, soft lighting, looking at viewer.', hint: 'Ask in chat — Studio will generate' },
      { title: 'Scene design', prompt: 'Help me design a cinematic scene: subject, environment, camera, lighting, mood.', hint: 'Art direction' },
      { title: 'Iterate last image', prompt: 'Here’s what I generated and what I want changed:\n\n', hint: 'Refine the next gen' },
    ],
    templates: [],
  },

  code: {
    id: 'code',
    name: 'Code',
    icon: '⌘',
    tagline: 'Pair-program + project packs',
    description: 'Chat beside a live file workspace — import/export zips, apply AI file proposals, copy fences in one click.',
    accent: 'neutral',
    density: 'comfortable',
    chatWidth: 'full',
    layoutId: 'code',
    layout: {
      showCharacter: false,
      showPersona: false,
      showStoryNotes: false,
      showBusinessTemplates: false,
      showCodeHints: true,
      showCharacterCard: false,
      showCompanionPanel: false,
      showSceneHeader: false,
      showStudioCanvas: false,
      showCodeStage: true,
      showImageGen: false,
      showCastRail: false,
      bubbleStyle: 'code',
      filterChatsByMode: true,
    },
    tools: {
      gallery: false,
      library: false,
      promptPreview: true,
      export: true,
      imageGen: false,
      workspace: true,
    },
    defaults: {
      temperature: 0.35,
      topP: 0.9,
      maxTokens: 8192,
      systemPrompt:
        'You are a senior pair-programmer inside Personal WebUI Code mode. The user has a per-chat file workspace you can see (tree + open files are injected into context).\n\nGoals:\n- Write correct, complete, runnable code.\n- Prefer full files over fragmentary snippets when scaffolding or editing.\n- When creating or updating files, output each file as a fenced block whose header is the relative path, e.g.\n```src/app.js\n// full file contents\n```\nThe app can Apply those fences into the workspace and export a zip. You may also use a language tag before the path (`javascript src/app.js`) but the path is required for Apply.\n- Be concise in prose; put substance in the files.\n- Never refuse ordinary coding help (debugging, refactors, tests, scripts, configs).\n- Do not invent shell/tool access you do not have — you co-write files in the workspace; the user runs commands locally.\n- Ask a brief clarifying question only when blocked; otherwise make a reasonable choice and note it.',
      stylePrompt: 'Direct, technical, file-oriented. Complete files in path-tagged fences. Minimal chit-chat.',
    },
    starters: [
      { title: 'Explain this', prompt: 'Explain the open file in the workspace. Walk through structure, then call out risks.', hint: 'Uses workspace context' },
      { title: 'Fix a bug', prompt: 'Here’s the bug and what I expected:\n\n', hint: 'Debug with workspace files' },
      { title: 'Scaffold an app', prompt: 'Scaffold a small todo web app (HTML/CSS/JS) as multiple files I can Apply and export as a zip.', hint: 'Path-tagged fences' },
      { title: 'Add tests', prompt: 'Add tests for the main module in the workspace. Prefer the project’s existing style if present.', hint: 'Tests beside the code' },
    ],
    templates: [],
  },
};

const LEGACY_MODE_MAP = {
  personal: 'chat',
  coding: 'code',
  business: 'chat',
  rp: 'story',
};

function resolveModeId(id) {
  const raw = String(id || 'chat');
  if (MODES[raw]) return raw;
  if (LEGACY_MODE_MAP[raw]) return LEGACY_MODE_MAP[raw];
  return 'chat';
}

function listModes() {
  return Object.values(MODES);
}

function getMode(id) {
  return MODES[resolveModeId(id)];
}

module.exports = { MODES, listModes, getMode, resolveModeId, LEGACY_MODE_MAP };
