/**
 * renderer.js — Vision Assistant Electron Renderer
 *
 * Runs in the BrowserWindow renderer process.
 * Accesses Electron APIs only through window.electronAPI (contextBridge).
 * All Gemini API calls are made directly via fetch() from the renderer.
 *
 * Features:
 *  - Dynamic Gemini model discovery (no hardcoded model name, no 404 ever)
 *  - Persistent storage via electron-store (through IPC bridge)
 *  - Memory extraction engine (name, interests, education, project, notes)
 *  - Web Speech API (webkitSpeechRecognition) + MediaRecorder fallback for voice input
 *  - speechSynthesis TTS for voice output
 *  - Screen capture via desktopCapturer IPC
 *  - Markdown rendering (inline)
 *  - Dark/light theme, auto-speak, pin, hide on focus-loss
 */

'use strict';

// ═══════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_CHAT_HISTORY    = 40;
const MAX_CONTEXT_MESSAGES = 10;
const MAX_MEMORY_NOTES     = 10;
const MAX_RECENT_QUERIES   = 10;

// ═══════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════

let apiKey            = '';
let chatHistory       = [];
let userMemory        = {};
let isDarkMode        = true;
let autoSpeak         = false;
let isThinking        = false;
let discoveredModel   = '';
let discoveredModelKey= '';
let currentUtterance  = null;
let recognition       = null;
let isRecording       = false;
let attachedScreenshot= null;   // { dataURL, sourceName }
let selectedSourceId  = null;
let isPinned          = true;

// Retry config for transient API errors (503, 500, overloaded)
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1500;  // first retry after 1.5 s, then 3 s, then 6 s

// ═══════════════════════════════════════════════════════════
// DOM
// ═══════════════════════════════════════════════════════════

const $ = id => document.getElementById(id);
const DOM = {
  chatMessages:      $('chat-messages'),
  welcome:           $('welcome'),
  userInput:         $('user-input'),
  btnSubmit:         $('btn-submit'),
  btnVoice:          $('btn-voice'),
  btnScreenshot:     $('btn-screenshot'),
  btnTheme:          $('btn-theme'),
  btnPin:            $('btn-pin'),
  btnMinimize:       $('btn-minimize'),
  btnHide:           $('btn-hide'),
  statusDot:         $('status-dot'),
  statusText:        $('status-text'),
  modelBadge:        $('model-badge'),
  screenshotBar:     $('screenshot-bar'),
  screenshotThumb:   $('screenshot-thumb'),
  screenshotLabel:   $('screenshot-label'),
  btnRemoveScreenshot:$('btn-remove-screenshot'),
  inputApiKey:       $('input-apikey'),
  btnShowKey:        $('btn-show-key'),
  btnSaveKey:        $('btn-save-key'),
  keyMsg:            $('key-msg'),
  chkAutospeak:      $('chk-autospeak'),
  chkDarkmode:       $('chk-darkmode'),
  chkAutohide:       $('chk-autohide'),
  modelInfo:         $('model-info'),
  memoryViewer:      $('memory-viewer'),
  btnRefreshMemory:  $('btn-refresh-memory'),
  btnClearHistory:   $('btn-clear-history'),
  btnClearMemory:    $('btn-clear-memory'),
  captureSources:    $('capture-sources'),
  btnRefreshSources: $('btn-refresh-sources'),
  btnUseCapture:     $('btn-use-capture'),
  appVersion:        $('app-version'),
  versionBadge:      $('version-badge'),
  linkAistudio:      $('link-aistudio'),
};

// ═══════════════════════════════════════════════════════════
// STORAGE (electron-store via IPC)
// ═══════════════════════════════════════════════════════════

const store = {
  get:    key         => window.electronAPI.store.get(key),
  set:    (key, val)  => window.electronAPI.store.set(key, val),
  delete: key         => window.electronAPI.store.delete(key),
};

// ═══════════════════════════════════════════════════════════
// THEME
// ═══════════════════════════════════════════════════════════

function applyTheme(dark) {
  isDarkMode = dark;
  document.body.classList.toggle('light', !dark);
  DOM.btnTheme.textContent = dark ? '☀️' : '🌙';
  DOM.chkDarkmode.checked  = dark;
  store.set('isDarkMode', dark);
}

// ═══════════════════════════════════════════════════════════
// TAB SWITCHING
// ═══════════════════════════════════════════════════════════

function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  document.querySelectorAll('.panel').forEach(p => {
    const match = p.id === `panel-${tabName}`;
    p.classList.toggle('active', match);
  });
  if (tabName === 'capture')  loadCaptureSources();
  if (tabName === 'settings') renderMemoryViewer();   // always fresh when tab opens
}

// ═══════════════════════════════════════════════════════════
// STATUS
// ═══════════════════════════════════════════════════════════

function setStatus(type, text) {
  DOM.statusDot.className = type;
  DOM.statusText.textContent = text;
}

// ═══════════════════════════════════════════════════════════
// MEMORY ENGINE
// ═══════════════════════════════════════════════════════════

function cleanPhrase(text) {
  text = text.replace(/^(?:that|hai|ki|a|an|the|is|ka|ke)\s+/i, '');
  text = text.replace(/\s+(?:hai|ka|ki|ke|hoon|hu|tha|the)$/i, '');
  return text.trim().replace(/^[\s.:,;'"!?\t\n]+|[\s.:,;'"!?\t\n]+$/g, '');
}

function smartExtractAndSaveMemory(query) {
  if (!query?.trim()) return;
  const q   = query.trim();
  const mem = userMemory;
  mem.last_active = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const profile = (typeof mem.profile === 'object' && mem.profile) ? mem.profile : {};

  // Name
  const nameMatch = q.match(/\b(?:my name is|mera naam|call me|i am|iam)\s+([a-zA-Z]+)\b/i);
  if (nameMatch) {
    const ignored = new Set(['working','trying','doing','making','learning','studying','building',
      'a','an','the','hai','looking','fine','good','happy','student','developer','engineer',
      'currently','just','now','not','so','very']);
    const cand = nameMatch[1].trim();
    if (!ignored.has(cand.toLowerCase()) && cand.length > 1)
      profile.name = cand.charAt(0).toUpperCase() + cand.slice(1).toLowerCase();
  }

  // Interests
  const loveMatch = q.match(/\b(?:i love|i like|i really like|i enjoy|mujhe|mujhko)\s+([^,.\n\r!?]+?)(?:\s+pasand hai|\s+bahut pasand hai|$|[.,!?])/i);
  if (loveMatch) {
    const raw = cleanPhrase(loveMatch[1]);
    if (raw && raw.length > 1 && !['to','it','that','this','you','me'].includes(raw.toLowerCase())) {
      const interests = Array.isArray(profile.interests) ? profile.interests : [];
      for (const item of raw.split(/\s*(?:,|and|aur|&)\s*/i)) {
        const c = cleanPhrase(item);
        if (c && c.length > 1 && !interests.some(i => i.toLowerCase() === c.toLowerCase()))
          interests.push(c.length < 15 ? c.charAt(0).toUpperCase() + c.slice(1) : c);
      }
      profile.interests = interests;
    }
  }

  // Education
  const eduMatch = q.match(/\b(b\.?tech|m\.?tech|bca|mca|b\.?sc|m\.?sc|bba|mba|phd|high school|computer science)\b/i);
  if (eduMatch) profile.education = eduMatch[1].toUpperCase().replace('BTECH','B.Tech').replace('MTECH','M.Tech');

  // Project
  const projMatch = q.match(/\b(?:mera project|my project is|current project is|working on|building|creating|developing)\s+([^,.\n\r!?]+?)(?:\s+ka hai|\s+project|$|[.,!?])/i);
  if (projMatch) {
    const pt = cleanPhrase(projMatch[1]);
    if (pt && pt.length > 2 && !['it','this','that','something','project'].includes(pt.toLowerCase()))
      profile.current_project = pt.charAt(0).toUpperCase() + pt.slice(1);
  }

  // Notes
  const memTrigger = q.match(/\b(?:remember that|remember|note that|yad rakhna|yaad rakhna|always remember)\s+(.+)/i);
  if (memTrigger) {
    const note = cleanPhrase(memTrigger[1]);
    if (note) {
      const notes = Array.isArray(mem.notes) ? mem.notes : [];
      if (!notes.includes(note)) { notes.push(note); if (notes.length > MAX_MEMORY_NOTES) notes.splice(0, notes.length - MAX_MEMORY_NOTES); }
      mem.notes = notes;
    }
  }

  if (Object.keys(profile).length > 0) mem.profile = profile;
  const rq = Array.isArray(mem.recent_queries) ? mem.recent_queries : [];
  if (!rq.length || rq[rq.length-1] !== q) rq.push(q);
  if (rq.length > MAX_RECENT_QUERIES) rq.splice(0, rq.length - MAX_RECENT_QUERIES);
  mem.recent_queries = rq;

  userMemory = mem;
  store.set('userMemory', mem);
}

function getMemoryContextString() {
  const mem = userMemory;
  if (!mem || Object.keys(mem).length === 0) return 'User Memory: None yet.';
  const parts = [];
  if (mem.last_active) parts.push(`Last Active: ${mem.last_active}`);
  const profile = mem.profile;
  if (profile && typeof profile === 'object') {
    for (const [k, v] of Object.entries(profile)) {
      if (v) parts.push(`${k.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase())}: ${Array.isArray(v)?v.join(', '):v}`);
    }
  }
  if (Array.isArray(mem.notes)   && mem.notes.length)          parts.push('Key Notes: '       + mem.notes.slice(-5).join(' | '));
  if (Array.isArray(mem.recent_queries) && mem.recent_queries.length) parts.push('Recent Queries: ' + mem.recent_queries.slice(-5).join(' | '));
  if (!parts.length) return 'User Memory: None yet.';
  return 'User Historical Context & Profile Memory:\n' + parts.map(p=>`- ${p}`).join('\n');
}

// ═══════════════════════════════════════════════════════════
// GEMINI PROMPT BUILDING
// ═══════════════════════════════════════════════════════════

function buildSystemPrompt() {
  return `You are Vision Assistant, an advanced AI companion running as a desktop app.
You are helpful, friendly, knowledgeable, and context-aware.
You remember details about the user and use that context naturally.
You support English and Hindi (Hinglish) seamlessly.
${getMemoryContextString()}

RESPONSE FORMAT:
- Use clear markdown for complex answers (headers, bullets, code blocks).
- For conversational replies, keep it natural and concise.
- Always be helpful and warm.`;
}

function buildApiPayload(userText, screenshotDataURL = null) {
  const contextMessages = chatHistory.slice(-MAX_CONTEXT_MESSAGES);
  const contents = [];

  for (const msg of contextMessages) {
    contents.push({
      role:  msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.text }],
    });
  }

  // Current message (with optional image)
  const currentParts = [];
  if (screenshotDataURL) {
    // Extract base64 from dataURL
    const match = screenshotDataURL.match(/^data:(image\/\w+);base64,(.+)$/);
    if (match) {
      currentParts.push({ inline_data: { mime_type: match[1], data: match[2] } });
    }
  }
  currentParts.push({ text: userText });

  const lastMsg = contents[contents.length - 1];
  if (!lastMsg || lastMsg.role !== 'user') {
    contents.push({ role: 'user', parts: currentParts });
  }

  return {
    system_instruction: { parts: [{ text: buildSystemPrompt() }] },
    contents,
    generationConfig: { temperature: 0.7, topK: 40, topP: 0.95, maxOutputTokens: 2048 },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    ],
  };
}

// ═══════════════════════════════════════════════════════════
// DYNAMIC MODEL DISCOVERY
// ═══════════════════════════════════════════════════════════

/**
 * scoreModel — pure algorithmic scoring, no hardcoded list.
 * Future models (gemini-3.x, 4.x) automatically rank higher.
 */
function scoreModel(shortName) {
  if (!shortName.startsWith('gemini')) return 0;
  const m = shortName.match(/gemini-([\d]+)\.?([\d]*)/);
  const major = m ? parseInt(m[1], 10) : 0;
  const minor = m ? parseInt(m[2] || '0', 10) : 0;
  let score = major * 100 + minor * 10;
  if (shortName.includes('flash'))   score += 30;
  if (shortName.includes('pro'))     score += 20;
  if (shortName.includes('ultra'))   score += 25;
  if (shortName.includes('lite'))    score -= 15;
  if (shortName.includes('exp'))     score -= 10;
  if (shortName.includes('preview')) score -= 10;
  if (shortName.includes('latest'))  score -=  5;
  return Math.max(score, 1);
}

async function discoverModel(key) {
  if (discoveredModel && discoveredModelKey === key) return discoveredModel;

  setStatus('thinking', '● Discovering model…');
  DOM.modelBadge.textContent = 'discovering…';

  let modelList;
  try {
    const resp = await fetch(`${GEMINI_API_BASE}/models?key=${key}`);
    if (resp.status === 401 || resp.status === 403) {
      throw Object.assign(new Error('API key rejected.'), { isAuthError: true });
    }
    if (!resp.ok) throw new Error(`Model list error ${resp.status}`);

    const data = await resp.json();
    modelList = (data.models || []).filter(model =>
      Array.isArray(model.supportedGenerationMethods) &&
      model.supportedGenerationMethods.includes('generateContent')
    );
  } catch (e) {
    if (e.isAuthError) throw e;
    // Network fallback
    discoveredModel    = 'gemini-1.5-flash';
    discoveredModelKey = key;
    updateModelBadge(discoveredModel);
    return discoveredModel;
  }

  if (!modelList.length) {
    throw Object.assign(new Error('No generateContent models found. Check your API key.'), { isAuthError: true });
  }

  let best = null, bestScore = -1;
  for (const m of modelList) {
    const name  = m.name.replace(/^models\//, '');
    const score = scoreModel(name);
    if (score > bestScore) { bestScore = score; best = name; }
  }
  if (!best) best = modelList[0].name.replace(/^models\//, '');

  discoveredModel    = best;
  discoveredModelKey = key;
  updateModelBadge(best);
  DOM.modelInfo.textContent = `✅ ${best}  (score: ${bestScore})`;
  console.log(`[VisionAssistant] Model selected: ${best} (score ${bestScore})`);
  return best;
}

function updateModelBadge(name) {
  DOM.modelBadge.textContent = name || 'unknown';
}

// ═══════════════════════════════════════════════════════════
// FETCH WITH RETRY  (handles 503, 500, overloaded)
// ═══════════════════════════════════════════════════════════

/**
 * fetchWithRetry(url, options)
 *
 * Wraps fetch() with exponential back-off retry for transient
 * server-side errors (503 Service Unavailable, 500 Internal Server
 * Error, and Gemini "model overloaded" 429 variants).
 *
 * Hard-stop errors (400, 401, 403, 404) are never retried.
 */
async function fetchWithRetry(url, options, attempt = 1) {
  let resp;
  try {
    resp = await fetch(url, options);
  } catch (netErr) {
    // Pure network failure — retry if attempts remain
    if (attempt < RETRY_MAX_ATTEMPTS) {
      const delay = RETRY_BASE_DELAY_MS * attempt;
      setStatus('thinking', `● Network error. Retrying (${attempt}/${RETRY_MAX_ATTEMPTS})…`);
      console.warn(`[VisionAssistant] Network error, retrying in ${delay}ms…`, netErr.message);
      await new Promise(r => setTimeout(r, delay));
      return fetchWithRetry(url, options, attempt + 1);
    }
    throw new Error(`Network error after ${RETRY_MAX_ATTEMPTS} retries: ${netErr.message}`);
  }

  // Determine if this status is retryable
  const code = resp.status;
  const isRetryable = code === 503 || code === 500 ||
    (code === 429 && attempt < RETRY_MAX_ATTEMPTS);  // 429 = rate limit — retry with back-off

  if (isRetryable && attempt < RETRY_MAX_ATTEMPTS) {
    // Read the error body for a helpful message
    const errBody  = await resp.json().catch(() => ({}));
    const errMsg   = errBody?.error?.message || resp.statusText || `HTTP ${code}`;
    const delay    = RETRY_BASE_DELAY_MS * attempt;

    setStatus('thinking', `● ${code === 503 ? 'Service busy' : 'Overloaded'}. Retrying (${attempt}/${RETRY_MAX_ATTEMPTS}) in ${delay / 1000}s…`);
    console.warn(`[VisionAssistant] ${code} — ${errMsg}. Retry ${attempt}/${RETRY_MAX_ATTEMPTS} in ${delay}ms.`);
    await new Promise(r => setTimeout(r, delay));
    return fetchWithRetry(url, options, attempt + 1);
  }

  return resp;   // return as-is (success OR non-retryable error)
}

async function callGeminiAPI(userText, screenshotDataURL = null) {
  // Always re-read key from store to pick up changes without restart
  const storedKey = await store.get('apiKey') || '';
  if (storedKey !== apiKey) {
    apiKey             = storedKey;
    discoveredModel    = '';
    discoveredModelKey = '';
  }

  if (!apiKey) {
    switchTab('settings');
    showKeyMsg('Please save your Gemini API key first.', 'error');
    throw new Error('NO_API_KEY');
  }

  const model = await discoverModel(apiKey);
  const url   = `${GEMINI_API_BASE}/models/${model}:generateContent?key=${apiKey}`;

  console.log(`[VisionAssistant] → ${model}`);
  setStatus('thinking', `● Calling ${model}…`);

  // Use fetchWithRetry instead of plain fetch
  const resp = await fetchWithRetry(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(buildApiPayload(userText, screenshotDataURL)),
  });

  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({}));
    const code    = resp.status;
    const msg     = errBody?.error?.message || resp.statusText || 'Unknown error';
    if (code === 429) throw Object.assign(new Error(`Rate limit (429): ${msg}`), { isRateLimit: true });
    if (code === 400 || code === 401 || code === 403) throw Object.assign(new Error(`Auth error (${code}): ${msg}`), { isAuthError: true });
    if (code === 404) { discoveredModel = ''; discoveredModelKey = ''; }
    throw new Error(`API error ${code}: ${msg}`);
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from Gemini.');

  setStatus('ready', '● Ready');
  return text.trim();
}

// ═══════════════════════════════════════════════════════════
// MARKDOWN RENDERER (lightweight inline)
// ═══════════════════════════════════════════════════════════

function renderMarkdown(text) {
  let h = text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    // code blocks
    .replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    // inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // italic
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // headers
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm,  '<h3>$1</h3>')
    .replace(/^# (.+)$/gm,   '<h2>$1</h2>')
    // bullets
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
    // line breaks
    .replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br/>');
  return `<p>${h}</p>`;
}

// ═══════════════════════════════════════════════════════════
// CHAT UI
// ═══════════════════════════════════════════════════════════

function appendMessage({ role, text, timestamp }) {
  if (DOM.welcome) DOM.welcome.style.display = 'none';

  const isUser = role === 'user';
  const div    = document.createElement('div');
  div.className = `msg ${isUser ? 'user' : 'assistant'}`;
  div.innerHTML = `
    <div class="msg-avatar">${isUser ? '👤' : '🤖'}</div>
    <div>
      <div class="msg-bubble">${isUser ? escHtml(text) : renderMarkdown(text)}</div>
      <div class="msg-time">${formatTime(timestamp)}</div>
    </div>`;
  DOM.chatMessages.appendChild(div);
  DOM.chatMessages.scrollTop = DOM.chatMessages.scrollHeight;
}

function escHtml(t) {
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br/>');
}

function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function addTypingIndicator() {
  if (DOM.welcome) DOM.welcome.style.display = 'none';
  const div = document.createElement('div');
  div.className = 'msg assistant';
  div.id = 'typing-indicator';
  div.innerHTML = `<div class="msg-avatar">🤖</div>
    <div><div class="msg-bubble"><div class="typing-dots"><span></span><span></span><span></span></div></div></div>`;
  DOM.chatMessages.appendChild(div);
  DOM.chatMessages.scrollTop = DOM.chatMessages.scrollHeight;
}

function removeTypingIndicator() {
  document.getElementById('typing-indicator')?.remove();
}

function showInlineError(message, showKeyBtn = false) {
  removeInlineErrors();
  const div = document.createElement('div');
  div.className = 'inline-error';
  div.innerHTML = `<span>⚠️ ${escHtml(message)}</span>`;
  if (showKeyBtn) {
    const btn = document.createElement('button');
    btn.textContent = 'Add API Key';
    btn.onclick = () => switchTab('settings');
    div.appendChild(btn);
  }
  DOM.chatMessages.after(div);
}

function removeInlineErrors() {
  document.querySelectorAll('.inline-error').forEach(e => e.remove());
}

// ═══════════════════════════════════════════════════════════
// SUBMIT HANDLER
// ═══════════════════════════════════════════════════════════

async function handleSubmit() {
  const text = DOM.userInput.value.trim();
  if (!text || isThinking) return;

  removeInlineErrors();
  smartExtractAndSaveMemory(text);

  const screenshot = attachedScreenshot?.dataURL || null;
  clearAttachedScreenshot();

  const userMsg = { role: 'user', text, timestamp: new Date().toISOString() };
  chatHistory.push(userMsg);
  appendMessage(userMsg);
  if (chatHistory.length > MAX_CHAT_HISTORY) chatHistory = chatHistory.slice(-MAX_CHAT_HISTORY);
  store.set('chatHistory', chatHistory);

  DOM.userInput.value = '';
  autoResize();

  isThinking         = true;
  DOM.btnSubmit.disabled = true;
  addTypingIndicator();
  setStatus('thinking', '● Thinking…');

  try {
    const response = await callGeminiAPI(text, screenshot);
    removeTypingIndicator();

    const aiMsg = { role: 'assistant', text: response, timestamp: new Date().toISOString() };
    chatHistory.push(aiMsg);
    if (chatHistory.length > MAX_CHAT_HISTORY) chatHistory = chatHistory.slice(-MAX_CHAT_HISTORY);
    store.set('chatHistory', chatHistory);
    appendMessage(aiMsg);

    if (autoSpeak) speakText(response);

  } catch (err) {
    removeTypingIndicator();
    console.error('[VisionAssistant]', err);
    let msg = `Error: ${err.message}`;
    if (err.message === 'NO_API_KEY')    { msg = 'No API key configured.'; }
    else if (err.isAuthError)            { msg = '❌ Invalid API key. Please check your key.'; }
    else if (err.isRateLimit)            { msg = '⏳ Rate limit reached. Try again shortly.'; }
    showInlineError(msg, err.message === 'NO_API_KEY' || err.isAuthError);
    setStatus('error', '● Error');
  } finally {
    isThinking = false;
    DOM.btnSubmit.disabled = false;
    if (DOM.statusDot.className !== 'error') setStatus('ready', '● Ready');
  }
}

// ═══════════════════════════════════════════════════════════
// TTS
// ═══════════════════════════════════════════════════════════

function speakText(text) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    .replace(/\n+/g, '. ')
    .replace(/\s+/g, ' ').trim();

  const utt = new SpeechSynthesisUtterance(cleaned);
  utt.lang = 'en-IN'; utt.rate = 0.95; utt.pitch = 1.05;
  const voices = window.speechSynthesis.getVoices();
  const pref   = voices.find(v => /zira|google.*india|en-in/i.test(v.name + v.lang))
              || voices.find(v => v.lang?.startsWith('en'));
  if (pref) utt.voice = pref;
  currentUtterance = utt;
  window.speechSynthesis.speak(utt);
}

// ═══════════════════════════════════════════════════════════
// VOICE INPUT  (webkitSpeechRecognition + MediaRecorder fallback)
//
// Tries webkitSpeechRecognition first for native speech recognition:
//   - Faster, lower latency, no network-dependent transcription
//   - Routes through Google's speech recognition service
//   - If unavailable or fails (network error), automatically falls back
//     to MediaRecorder + Gemini transcription
//
// Fallback (MediaRecorder → Gemini transcription):
//   1. Captures mic audio with MediaRecorder (runs locally)
//   2. On stop, base64-encodes the audio blob
//   3. Sends it to Gemini with a "transcribe this audio" prompt
//   4. Puts the transcript in the query box and auto-submits
// ═══════════════════════════════════════════════════════════

let mediaRecorder     = null;
let audioChunks       = [];
let voiceAutoStopTimer= null;
let transcriptBuffer  = '';  // Module-level for speech recognition transcript accumulation
const VOICE_MAX_SECS  = 15;   // auto-stop after 15 seconds
let useWebkitSpeechRecognition = false;  // will be set after checking availability

/** Check if webkitSpeechRecognition is available and usable */
function initWebkitSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    console.log('[VisionAssistant] webkitSpeechRecognition is available');
    useWebkitSpeechRecognition = true;
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    // ─── Set up event handlers once during initialization ───────────────────
    recognition.onstart = () => {
      console.log('[VisionAssistant] webkitSpeechRecognition started');
      transcriptBuffer = '';  // Reset buffer for new session
      isRecording = true;
      DOM.btnVoice.classList.add('active');
      DOM.btnVoice.title = 'Click to stop recording';
      DOM.btnVoice.textContent = '⏹';
      setStatus('thinking', `● Listening… (${VOICE_MAX_SECS}s max)`);
    };

    recognition.onresult = (event) => {
      console.log(`[VisionAssistant] onresult fired, resultIndex=${event.resultIndex}, length=${event.results.length}`);
      let interim = '';
      
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript || '';
        console.log(`[VisionAssistant] Result ${i}: isFinal=${event.results[i].isFinal}, transcript="${transcript}"`);
        
        if (event.results[i].isFinal) {
          transcriptBuffer += transcript + ' ';
        } else {
          interim += transcript;
        }
      }

      // Update input field with accumulated transcript + interim
      const finalText = (transcriptBuffer + interim).trim();
      if (finalText) {
        console.log(`[VisionAssistant] Setting input to: "${finalText}"`);
        DOM.userInput.value = finalText;
        autoResize();
      }
    };

    recognition.onerror = (event) => {
      console.error('[VisionAssistant] webkitSpeechRecognition error:', event.error);
      isRecording = false;
      DOM.btnVoice.classList.remove('active');
      DOM.btnVoice.textContent = '🎙';
      
      // Map error codes to user-friendly messages
      const errorMap = {
        'network': 'Network error — Google speech recognition servers unreachable. Using local transcription instead…',
        'no-speech': 'No speech detected. Please try again.',
        'audio-capture': 'Microphone access denied or unavailable.',
        'not-allowed': 'Microphone permission denied.',
        'service-not-allowed': 'Speech recognition service not available.',
      };

      const errorMsg = errorMap[event.error] || `Speech recognition error: ${event.error}`;
      showInlineError(`🎙 ${errorMsg}`);

      // Fallback to MediaRecorder for network or service errors
      if (['network', 'service-not-allowed', 'audio-capture'].includes(event.error)) {
        console.log('[VisionAssistant] Falling back to MediaRecorder + Gemini transcription');
        setStatus('thinking', '● Switching to local transcription…');
        setTimeout(() => startVoiceRecordingFallback(), 500);
      } else {
        setStatus('error', '● Voice error');
      }
    };

    recognition.onend = () => {
      console.log('[VisionAssistant] webkitSpeechRecognition ended');
      isRecording = false;
      DOM.btnVoice.classList.remove('active');
      DOM.btnVoice.textContent = '🎙';
      DOM.btnVoice.title = 'Voice input';
      setStatus('ready', '● Ready');
    };
  } else {
    console.log('[VisionAssistant] webkitSpeechRecognition not available, will use MediaRecorder fallback');
    useWebkitSpeechRecognition = false;
  }
}

/** Start webkitSpeechRecognition with automatic fallback on error */
async function startVoiceWithWebkitSpeechRecognition() {
  if (!recognition) {
    console.warn('[VisionAssistant] Recognition object not initialized');
    return startVoiceRecordingFallback();
  }

  removeInlineErrors();

  // Clear previous transcript
  transcriptBuffer = '';
  DOM.userInput.value = '';

  // Start with timeout fallback
  try {
    console.log('[VisionAssistant] Starting recognition...');
    recognition.start();
    voiceAutoStopTimer = setTimeout(() => {
      if (isRecording) {
        console.log('[VisionAssistant] Voice timeout, stopping recognition');
        recognition.stop();
      }
    }, VOICE_MAX_SECS * 1000);
  } catch (err) {
    console.error('[VisionAssistant] Failed to start recognition:', err);
    setStatus('error', '● Mic error');
    setTimeout(() => startVoiceRecordingFallback(), 500);
  }
}

/** Pick the best MIME type MediaRecorder supports on this platform */
function getBestAudioMime() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
    'audio/mp4',
  ];
  return candidates.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

/** Convert a Blob to base64 string (without the data-URL prefix) */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Send recorded audio to Gemini for transcription.
 * Returns the transcribed text string.
 */
async function transcribeWithGemini(audioBlob, mimeType) {
  // Re-read key in case it changed
  const key = await store.get('apiKey') || apiKey;
  if (!key) throw new Error('NO_API_KEY');

  const model   = await discoverModel(key);
  const url     = `${GEMINI_API_BASE}/models/${model}:generateContent?key=${key}`;
  const b64data = await blobToBase64(audioBlob);

  const payload = {
    contents: [{
      role: 'user',
      parts: [
        {
          inline_data: {
            mime_type: mimeType.split(';')[0],   // strip codec params
            data: b64data,
          },
        },
        {
          text: 'Please transcribe this audio recording accurately and completely. ' +
                'Return ONLY the transcribed text with no additional commentary, ' +
                'labels, or formatting.',
        },
      ],
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 512 },
  };

  const resp = await fetchWithRetry(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Transcription API error ${resp.status}`);
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned an empty transcription.');
  return text.trim();
}

/** Start recording (MediaRecorder fallback) — called when mic button is clicked while idle */
async function startVoiceRecordingFallback() {
  removeInlineErrors();

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    const msgMap = {
      NotAllowedError:  '🎙 Microphone access denied. Allow mic permission and try again.',
      PermissionDeniedError: '🎙 Microphone access denied.',
      NotFoundError:    '🎙 No microphone found. Please connect one.',
      NotReadableError: '🎙 Microphone is in use by another app.',
    };
    showInlineError(msgMap[err.name] || `🎙 Mic error: ${err.message}`);
    setStatus('error', '● Mic error');
    return;
  }

  const mimeType = getBestAudioMime();
  audioChunks    = [];

  try {
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch (err) {
    stream.getTracks().forEach(t => t.stop());
    showInlineError(`🎙 Could not start recorder: ${err.message}`);
    return;
  }

  mediaRecorder.ondataavailable = (e) => {
    if (e.data?.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    // Release mic immediately
    stream.getTracks().forEach(t => t.stop());
    clearTimeout(voiceAutoStopTimer);

    isRecording = false;
    DOM.btnVoice.classList.remove('active');
    DOM.btnVoice.title     = 'Voice input';
    DOM.btnVoice.textContent = '🎙';

    if (audioChunks.length === 0) {
      setStatus('ready', '● Ready');
      return;
    }

    // ── Transcribe ──
    setStatus('thinking', '● Transcribing…');
    DOM.btnSubmit.disabled = true;

    try {
      const actualMime  = mediaRecorder.mimeType || mimeType || 'audio/webm';
      const audioBlob   = new Blob(audioChunks, { type: actualMime });
      const transcript  = await transcribeWithGemini(audioBlob, actualMime);

      if (transcript) {
        DOM.userInput.value = transcript;
        autoResize();
        setStatus('ready', '● Ready');
        DOM.btnSubmit.disabled = false;
      } else {
        setStatus('ready', '● Ready');
        DOM.btnSubmit.disabled = false;
      }
    } catch (err) {
      console.error('[VisionAssistant] Transcription failed:', err);
      if (err.message === 'NO_API_KEY') {
        showInlineError('🎙 No API key. Please add your Gemini key in Settings.', true);
      } else {
        showInlineError(`🎙 Transcription failed: ${err.message}`);
      }
      setStatus('error', '● Transcription error');
      DOM.btnSubmit.disabled = false;
    }

    audioChunks   = [];
    mediaRecorder = null;
  };

  mediaRecorder.onerror = (e) => {
    console.error('[VisionAssistant] MediaRecorder error:', e.error);
    stream.getTracks().forEach(t => t.stop());
    showInlineError(`🎙 Recorder error: ${e.error?.message || e.error}`);
    isRecording = false;
    DOM.btnVoice.classList.remove('active');
  };

  // Start recording with 100 ms timeslices for smooth ondataavailable events
  mediaRecorder.start(100);
  isRecording = true;
  DOM.btnVoice.classList.add('active');
  DOM.btnVoice.title       = 'Click to stop recording';
  DOM.btnVoice.textContent = '⏹';
  setStatus('thinking', `● Recording… (${VOICE_MAX_SECS}s max)`);

  // Auto-stop after VOICE_MAX_SECS
  voiceAutoStopTimer = setTimeout(() => {
    if (isRecording) stopVoiceRecording();
  }, VOICE_MAX_SECS * 1000);
}

/** Stop recording — called when mic button is clicked while recording */
function stopVoiceRecording() {
  clearTimeout(voiceAutoStopTimer);
  
  // Stop webkitSpeechRecognition if active
  if (useWebkitSpeechRecognition && recognition && isRecording) {
    recognition.stop();
  } else if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    // Stop MediaRecorder fallback
    mediaRecorder.stop();   // triggers onstop → transcribe
  }
}

/** Public toggle: start if idle, stop if recording */
function startVoice() {
  if (isRecording) {
    stopVoiceRecording();
  } else {
    // Use webkitSpeechRecognition if available, otherwise fall back to MediaRecorder
    if (useWebkitSpeechRecognition) {
      startVoiceWithWebkitSpeechRecognition();
    } else {
      startVoiceRecordingFallback();
    }
  }
}


// ═══════════════════════════════════════════════════════════
// SCREEN CAPTURE
// ═══════════════════════════════════════════════════════════

async function loadCaptureSources() {
  DOM.captureSources.innerHTML = '<p style="color:var(--text-muted);font-size:12px;padding:8px;">Loading sources…</p>';
  try {
    const sources = await window.electronAPI.capture.getSources({ types: ['screen', 'window'] });
    DOM.captureSources.innerHTML = '';
    if (!sources.length) {
      DOM.captureSources.innerHTML = '<p style="color:var(--text-muted);font-size:12px;">No sources found.</p>';
      return;
    }
    sources.forEach(src => {
      const card = document.createElement('div');
      card.className = 'capture-source-card';
      if (src.id === selectedSourceId) card.classList.add('selected');
      card.innerHTML = `<img class="capture-thumb" src="${src.thumbnail}" alt="${escHtml(src.name)}" />
                        <div class="capture-name" title="${escHtml(src.name)}">${escHtml(src.name)}</div>`;
      card.addEventListener('click', () => {
        selectedSourceId = src.id;
        document.querySelectorAll('.capture-source-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        // Preview the thumbnail immediately as the attached screenshot
        attachedScreenshot = { dataURL: src.thumbnail, sourceName: src.name };
      });
      DOM.captureSources.appendChild(card);
    });
  } catch (err) {
    DOM.captureSources.innerHTML = `<p style="color:#f87171;font-size:12px;">Error: ${escHtml(err.message)}</p>`;
  }
}

function showScreenshotBar() {
  if (!attachedScreenshot) return;
  DOM.screenshotThumb.src    = attachedScreenshot.dataURL;
  DOM.screenshotLabel.textContent = `📷 ${attachedScreenshot.sourceName}`;
  DOM.screenshotBar.classList.add('visible');
}

function clearAttachedScreenshot() {
  attachedScreenshot = null;
  DOM.screenshotBar.classList.remove('visible');
  DOM.screenshotThumb.src = '';
}

// ═══════════════════════════════════════════════════════════
// TEXTAREA AUTO-RESIZE
// ═══════════════════════════════════════════════════════════

function autoResize() {
  DOM.userInput.style.height = 'auto';
  DOM.userInput.style.height = Math.min(DOM.userInput.scrollHeight, 120) + 'px';
}

// ═══════════════════════════════════════════════════════════
// SETTINGS HELPERS
// ═══════════════════════════════════════════════════════════

function showKeyMsg(text, type) {
  DOM.keyMsg.textContent  = text;
  DOM.keyMsg.className    = `msg-box ${type}`;
  DOM.keyMsg.style.display= 'block';
  setTimeout(() => { DOM.keyMsg.style.display = 'none'; }, 4000);
}

// ═══════════════════════════════════════════════════════════
// MEMORY VIEWER
// ═══════════════════════════════════════════════════════════

function renderMemoryViewer() {
  const el = DOM.memoryViewer;
  if (!el) return;
  const mem = userMemory;

  if (!mem || Object.keys(mem).length === 0) {
    el.innerHTML = `<p class="mem-empty">No memory stored yet. Start chatting and I'll remember details about you!</p>`;
    return;
  }

  const rows = [];

  // ── Last active ──
  if (mem.last_active) {
    rows.push(memRow('🕒', 'Last Active', mem.last_active));
  }

  // ── Profile fields ──
  const profile = mem.profile;
  if (profile && typeof profile === 'object' && Object.keys(profile).length) {
    rows.push(memHeader('👤 Profile'));
    for (const [k, v] of Object.entries(profile)) {
      const label = k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const value = Array.isArray(v) ? v.join(', ') : v;
      rows.push(memRow('·', label, value));
    }
  }

  // ── Notes ──
  const notes = mem.notes;
  if (Array.isArray(notes) && notes.length) {
    rows.push(memHeader('📝 Notes & Facts'));
    notes.forEach((n, i) => rows.push(memRow(`${i + 1}.`, '', n)));
  }

  // ── Recent Queries ──
  const rq = mem.recent_queries;
  if (Array.isArray(rq) && rq.length) {
    rows.push(memHeader('🔍 Recent Queries'));
    [...rq].reverse().slice(0, 8).forEach((q, i) => rows.push(memRow(`${i + 1}.`, '', q)));
  }

  el.innerHTML = rows.join('');
}

function memHeader(label) {
  return `<div class="mem-section-header">${label}</div>`;
}

function memRow(icon, label, value) {
  return `<div class="mem-row">
    <span class="mem-icon">${icon}</span>
    ${label ? `<span class="mem-label">${escHtml(label)}:</span>` : ''}
    <span class="mem-value">${escHtml(String(value))}</span>
  </div>`;
}

async function saveApiKey() {
  const key = DOM.inputApiKey.value.trim();
  if (!key) { showKeyMsg('Please enter your Gemini API key.', 'error'); return; }

  DOM.btnSaveKey.disabled = true;
  showKeyMsg('Saving…', '');

  // Update in-memory immediately
  apiKey             = key;
  discoveredModel    = '';
  discoveredModelKey = '';

  await store.set('apiKey', key);

  // Kick off discovery in background so model badge updates
  discoverModel(key).catch(() => {});

  showKeyMsg('✅ API key saved! Ready to chat.', 'success');
  DOM.btnSaveKey.disabled = false;
  removeInlineErrors();
}

// ═══════════════════════════════════════════════════════════
// HISTORY RENDERING
// ═══════════════════════════════════════════════════════════

function renderAllHistory() {
  DOM.chatMessages.querySelectorAll('.msg').forEach(e => e.remove());
  if (!chatHistory.length) return;
  if (DOM.welcome) DOM.welcome.style.display = 'none';
  chatHistory.forEach(appendMessage);
}

// ═══════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════

async function init() {
  // Initialize webkitSpeechRecognition (with fallback detection)
  initWebkitSpeechRecognition();

  // Load all persisted data
  const stored = await window.electronAPI.store.getAll();
  apiKey      = stored.apiKey      || '';
  chatHistory = Array.isArray(stored.chatHistory) ? stored.chatHistory : [];
  userMemory  = stored.userMemory  && typeof stored.userMemory === 'object' ? stored.userMemory : {};
  isDarkMode  = stored.isDarkMode  !== undefined ? stored.isDarkMode : true;
  autoSpeak   = stored.autoSpeak   !== undefined ? stored.autoSpeak  : false;

  applyTheme(isDarkMode);
  DOM.chkAutospeak.checked = autoSpeak;
  DOM.chkAutohide.checked  = stored.autoHide || false;

  renderAllHistory();

  // Populate settings field (masked)
  if (apiKey) DOM.inputApiKey.value = apiKey;

  // App version
  const ver = await window.electronAPI.app.getVersion().catch(() => '1.0');
  DOM.appVersion.textContent  = `v${ver}`;
  DOM.versionBadge.textContent = `v${ver}`;

  // Kick off model discovery if key exists
  if (apiKey) {
    discoverModel(apiKey).catch(() => {
      DOM.modelBadge.textContent = 'key error';
      DOM.modelInfo.textContent  = '❌ Key rejected. Check your API key.';
    });
  } else {
    setStatus('error', '● No API key');
    DOM.modelBadge.textContent = 'no key';
    DOM.modelInfo.textContent  = 'No API key set. Go to Settings.';
  }

  attachEvents();
}

function attachEvents() {
  // Titlebar buttons
  DOM.btnHide.addEventListener('click',     () => window.electronAPI.window.hide());
  DOM.btnMinimize.addEventListener('click', () => window.electronAPI.window.minimize());
  DOM.btnTheme.addEventListener('click',    () => applyTheme(!isDarkMode));
  DOM.btnPin.addEventListener('click', () => {
    isPinned = !isPinned;
    window.electronAPI.window.pin(isPinned);
    DOM.btnPin.style.opacity = isPinned ? '1' : '0.4';
  });

  // Tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Chat input
  DOM.userInput.addEventListener('input', autoResize);
  DOM.userInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
  });
  DOM.btnSubmit.addEventListener('click', handleSubmit);

  // Voice
  DOM.btnVoice.addEventListener('click', startVoice);

  // Screenshot
  DOM.btnScreenshot.addEventListener('click', () => {
    if (attachedScreenshot) { clearAttachedScreenshot(); return; }
    switchTab('capture');
  });
  DOM.btnRemoveScreenshot.addEventListener('click', clearAttachedScreenshot);

  // Capture panel
  DOM.btnRefreshSources.addEventListener('click', loadCaptureSources);
  DOM.btnUseCapture.addEventListener('click', () => {
    if (!attachedScreenshot) {
      alert('Please select a screen source first.');
      return;
    }
    showScreenshotBar();
    switchTab('chat');
    DOM.userInput.focus();
  });

  // Settings
  DOM.btnSaveKey.addEventListener('click', saveApiKey);
  DOM.btnShowKey.addEventListener('click', () => {
    DOM.inputApiKey.type = DOM.inputApiKey.type === 'password' ? 'text' : 'password';
    DOM.btnShowKey.textContent = DOM.inputApiKey.type === 'password' ? '👁' : '🙈';
  });
  DOM.inputApiKey.addEventListener('keydown', e => { if (e.key === 'Enter') saveApiKey(); });

  DOM.chkAutospeak.addEventListener('change', () => {
    autoSpeak = DOM.chkAutospeak.checked;
    store.set('autoSpeak', autoSpeak);
  });
  DOM.chkDarkmode.addEventListener('change', () => applyTheme(DOM.chkDarkmode.checked));
  DOM.chkAutohide.addEventListener('change', () => store.set('autoHide', DOM.chkAutohide.checked));

  DOM.btnClearHistory.addEventListener('click', () => {
    if (!confirm('Clear all chat history?')) return;
    chatHistory = [];
    store.set('chatHistory', []);
    DOM.chatMessages.querySelectorAll('.msg').forEach(m => m.remove());
    if (DOM.welcome) DOM.welcome.style.display = '';
  });
  DOM.btnClearMemory.addEventListener('click', () => {
    if (!confirm('Clear all stored memory?')) return;
    userMemory = {};
    store.set('userMemory', {});
    renderMemoryViewer();   // refresh display immediately
  });

  if (DOM.btnRefreshMemory) {
    DOM.btnRefreshMemory.addEventListener('click', renderMemoryViewer);
  }

  // External links
  DOM.linkAistudio.addEventListener('click', () => {
    window.electronAPI.shell.openExternal('https://aistudio.google.com');
  });

  // Starter chips
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      DOM.userInput.value = chip.dataset.prompt || '';
      autoResize();
      DOM.userInput.focus();
    });
  });
}

// ── Bootstrap ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
