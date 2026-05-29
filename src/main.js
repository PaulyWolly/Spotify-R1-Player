// Spotify R1 Plugin - Full playback control with voice commands

// ===========================================
// Configuration & State
// ===========================================

const SPOTIFY_CLIENT_ID = '512e3d6abe5b4a9cb30546bd758495f1';

/** Spotify 2025 rules: no localhost; loopback must use http://127.0.0.1 (not https self-signed) */
function getSpotifyRedirectUri() {
  const { protocol, hostname, port, pathname } = window.location;
  const host = hostname === 'localhost' ? '127.0.0.1' : hostname;
  const isLoopback = host === '127.0.0.1' || host === '[::1]';
  const scheme = isLoopback ? 'http:' : protocol;
  const portPart = port ? `:${port}` : '';
  return `${scheme}//${host}${portPart}${pathname}`;
}

const SPOTIFY_REDIRECT_URI = getSpotifyRedirectUri();
const SPOTIFY_SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read'
].join(' ');

const state = {
  accessToken: null,
  refreshToken: null,
  tokenExpiry: 0,
  player: null,
  deviceId: null,
  isPlaying: false,
  currentTrack: null,
  progressMs: 0,
  durationMs: 0,
  playlists: [],
  currentPlaylistTracks: [],
  currentPlaylistUri: null,
  playingPlaylistUri: null,
  userId: null,
  currentView: 'auth',
  playbackMode: null,
  wasPlayingBeforeVoice: false,
  isListening: false,
  progressInterval: null,
  albumArtExpanded: false,
  audioUnlocked: false,
  activeDeviceId: null,
  playbackErrorMuteUntil: 0,
  lastApiProgressMs: null
};

let companionPollTimer = null;
let r1ApiSyncInterval = null;
let cachedPairSession = null;
let companionLoginStarted = false;

// ===========================================
// Runtime environment (R1 vs browser)
// ===========================================

function detectRuntimeEnvironment() {
  const forced = new URLSearchParams(window.location.search).get('env');
  if (forced === 'r1') return 'r1';
  if (forced === 'browser') return 'browser';
  const onR1 =
    typeof PluginMessageHandler !== 'undefined' ||
    typeof CreationVoiceHandler !== 'undefined' ||
    window.creationStorage != null;
  return onR1 ? 'r1' : 'browser';
}

function applyRuntimeEnvironment() {
  const env = detectRuntimeEnvironment();
  document.documentElement.classList.remove('env-r1', 'env-browser');
  document.documentElement.classList.add(`env-${env}`);
  return env;
}

const runtimeEnv = applyRuntimeEnvironment();

// ===========================================
// Utilities
// ===========================================

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text ?? '';
  return div.innerHTML;
}

function escapeAttr(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function parseLlmJson(response) {
  if (typeof response === 'object') return response;
  const str = String(response).trim();
  const fenced = str.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonStr = fenced ? fenced[1].trim() : str;
  return JSON.parse(jsonStr);
}

function playerPlayEndpoint() {
  const base = '/me/player/play';
  if (!state.deviceId) return base;
  return `${base}?device_id=${encodeURIComponent(state.deviceId)}`;
}

function playerDeviceQuery() {
  if (!state.deviceId) return '';
  return `?device_id=${encodeURIComponent(state.deviceId)}`;
}

function waitForSpotifySdk(timeoutMs = 15000) {
  if (typeof Spotify !== 'undefined') return Promise.resolve(true);
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = setInterval(() => {
      if (typeof Spotify !== 'undefined') {
        clearInterval(tick);
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(tick);
        resolve(false);
      }
    }, 150);
  });
}

function waitForDevice(timeoutMs = 12000) {
  if (state.deviceId) return Promise.resolve(true);
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = setInterval(() => {
      if (state.deviceId) {
        clearInterval(tick);
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(tick);
        resolve(false);
      }
    }, 200);
  });
}

function showAuthRedirectHint() {
  const el = document.getElementById('auth-redirect-uri');
  if (el) el.textContent = SPOTIFY_REDIRECT_URI;
}

function showAuthStatus(msg) {
  const el = document.getElementById('auth-status');
  if (el) el.textContent = msg || '';
  if (msg) bootStatus(msg);
}

/** Phone helper page (?helper=1) — PKCE works in normal mobile/desktop browsers. */
function isHelperMode() {
  const q = new URLSearchParams(window.location.search);
  if (q.get('helper') === '1') return true;
  if (q.has('code')) {
    try {
      return sessionStorage.getItem('spotify_helper') === '1';
    } catch (e) { /* ignore */ }
  }
  return false;
}

const PHONE_SESSION_KEY = 'spotify_phone_session';

function rememberPhoneSession(sessionId) {
  const id = String(sessionId || '').replace(/\D/g, '');
  if (id.length !== 6) return null;
  try {
    sessionStorage.setItem(PHONE_SESSION_KEY, id);
  } catch (e) { /* ignore */ }
  return id;
}

function getPhoneSession() {
  const q = new URLSearchParams(window.location.search);
  const fromUrl = q.get('session');
  if (fromUrl && /^\d{6}$/.test(fromUrl.replace(/\D/g, ''))) {
    return rememberPhoneSession(fromUrl);
  }
  try {
    const stored = sessionStorage.getItem(PHONE_SESSION_KEY);
    if (stored && /^\d{6}$/.test(stored)) return stored;
  } catch (e) { /* ignore */ }
  return null;
}

function markHelperLoginStarted(sessionId) {
  try {
    sessionStorage.setItem('spotify_helper', '1');
  } catch (e) { /* ignore */ }
  rememberPhoneSession(sessionId || getPhoneSession());
}

function clearHelperLoginFlag() {
  try {
    sessionStorage.removeItem('spotify_helper');
    sessionStorage.removeItem(PHONE_SESSION_KEY);
  } catch (e) { /* ignore */ }
}

/** R1 WebView cannot load Spotify's login page — use phone helper + paste key. */
function isCompanionAuthMode() {
  if (window.__R1_AUTH__ === false) return false;
  if (isHelperMode()) return false;
  const q = new URLSearchParams(window.location.search);
  if (q.get('desktop') === '1') return false;
  if (q.get('allowRedirect') === '1') return false;
  return true;
}

function generateSessionCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function persistPairSession(code) {
  const storageKey = 'spotify_pair_session';
  cachedPairSession = code;
  try {
    sessionStorage.setItem(storageKey, code);
  } catch (e) { /* ignore */ }
  try {
    localStorage.setItem(storageKey, code);
  } catch (e) { /* ignore */ }
  if (window.creationStorage) {
    try {
      await window.creationStorage.plain.setItem(storageKey, code);
    } catch (e) { /* ignore */ }
  }
}

async function getOrCreateAuthSession() {
  if (cachedPairSession && /^\d{6}$/.test(cachedPairSession)) {
    return cachedPairSession;
  }

  const storageKey = 'spotify_pair_session';
  const readers = [];

  if (window.creationStorage) {
    readers.push(async () => {
      try {
        return await window.creationStorage.plain.getItem(storageKey);
      } catch (e) {
        return null;
      }
    });
  }
  readers.push(async () => {
    try {
      return localStorage.getItem(storageKey);
    } catch (e) {
      return null;
    }
  });
  readers.push(async () => {
    try {
      return sessionStorage.getItem(storageKey);
    } catch (e) {
      return null;
    }
  });

  for (let i = 0; i < readers.length; i++) {
    const stored = await readers[i]();
    if (stored && /^\d{6}$/.test(stored)) {
      await persistPairSession(stored);
      return stored;
    }
  }

  const code = generateSessionCode();
  await persistPairSession(code);
  return code;
}

function getHelperLoginUrl(sessionId) {
  try {
    const u = new URL(SPOTIFY_REDIRECT_URI);
    u.search = '';
    u.hash = '';
    u.searchParams.set('helper', '1');
    if (sessionId) u.searchParams.set('session', sessionId);
    return u.toString();
  } catch (e) {
    let url = SPOTIFY_REDIRECT_URI.split('?')[0] + '?helper=1';
    if (sessionId) url += '&session=' + encodeURIComponent(sessionId);
    return url;
  }
}

function stopCompanionPolling() {
  if (companionPollTimer) {
    clearInterval(companionPollTimer);
    companionPollTimer = null;
  }
}

async function applyTokenPayload(tokens) {
  if (!tokens || !tokens.refreshToken) throw new Error('missing refresh token');
  state.accessToken = tokens.accessToken || null;
  state.refreshToken = tokens.refreshToken;
  state.tokenExpiry = tokens.tokenExpiry || 0;
  if (!state.accessToken || state.tokenExpiry - Date.now() < 60000) {
    const ok = await refreshAccessToken();
    if (!ok) throw new Error('token refresh failed — log in on phone again');
  }
  await saveTokens();
  stopCompanionPolling();
  showAuthStatus('Connected!');
  showView('player');
  bootDone();
  try {
    initPlayer();
    installR1AudioUnlock();
    fetchPlaylists();
    startProgressTimer();
  } catch (e) {
    console.error('applyTokenPayload player:', e);
    showToast('Logged in — tap a song to play', 4000);
  }
}

async function pollAuthSession(sessionId) {
  try {
    const url = '/.netlify/functions/auth-poll?session=' + encodeURIComponent(sessionId);
    const res = await fetch(url);
    if (!res.ok) {
      showAuthStatus('Login check failed (' + res.status + ')');
      return false;
    }
    const data = await res.json();
    if (data.ok && data.tokens) {
      await applyTokenPayload(data.tokens);
      return true;
    }
    if (data.error) showAuthStatus(data.error);
    return false;
  } catch (e) {
    showAuthStatus('Network error — tap Check login');
    return false;
  }
}

async function checkCompanionLogin() {
  const sessionId = await getOrCreateAuthSession();
  const pairEl = document.getElementById('pair-code');
  if (pairEl) pairEl.textContent = sessionId;
  showAuthStatus('Checking phone login…');
  const ok = await pollAuthSession(sessionId);
  if (!ok) {
    showAuthStatus('Waiting — use code ' + sessionId + ' on phone (see URL above)');
  }
}

function startCompanionAuthPolling(sessionId) {
  stopCompanionPolling();
  showAuthStatus('Waiting for phone — code ' + sessionId);
  pollAuthSession(sessionId);
  companionPollTimer = setInterval(function () {
    pollAuthSession(sessionId);
  }, 2000);
}

async function publishTokensToSession(sessionId) {
  const res = await fetch('/.netlify/functions/auth-store', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session: sessionId,
      tokens: {
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        tokenExpiry: state.tokenExpiry
      }
    })
  });
  if (!res.ok) {
    let detail = 'Could not send login to R1';
    try {
      const err = await res.json();
      if (err.error) detail = err.error;
    } catch (e) { /* ignore */ }
    throw new Error(detail);
  }
  return true;
}

async function startR1CompanionLogin() {
  if (companionLoginStarted) return;
  companionLoginStarted = true;

  const sessionId = await getOrCreateAuthSession();
  const pairEl = document.getElementById('pair-code');
  const helperUrl = document.getElementById('helper-login-url');
  if (pairEl) pairEl.textContent = sessionId;
  if (helperUrl) helperUrl.textContent = getHelperLoginUrl(sessionId);
  startCompanionAuthPolling(sessionId);
}

function createLoginKeyFromState() {
  return btoa(JSON.stringify({
    accessToken: state.accessToken,
    refreshToken: state.refreshToken,
    tokenExpiry: state.tokenExpiry
  }));
}

function showHelperSentView() {
  clearHelperLoginFlag();
  const exportView = document.getElementById('view-helper-export');
  const title = document.getElementById('helper-export-title');
  const msg = document.getElementById('helper-export-msg');
  const ta = document.getElementById('login-key-export');
  if (title) title.textContent = 'Sent to R1';
  if (msg) msg.textContent = 'Login sent! Return to your R1 — it should connect in a few seconds. You can close this page.';
  if (ta) ta.classList.add('hidden');
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  if (exportView) exportView.classList.add('active');
}

function showHelperExportView(key) {
  clearHelperLoginFlag();
  const exportView = document.getElementById('view-helper-export');
  const title = document.getElementById('helper-export-title');
  const msg = document.getElementById('helper-export-msg');
  const ta = document.getElementById('login-key-export');
  if (title) title.textContent = 'Login key';
  if (msg) msg.textContent = 'Copy ALL of this into your R1 app:';
  if (ta) {
    ta.value = key;
    ta.classList.remove('hidden');
  }
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  if (exportView) exportView.classList.add('active');
}

function configureAuthUIForEnv() {
  const btnConnect = document.getElementById('btn-connect');
  const btnImport = document.getElementById('btn-import-key');
  const webOnly = document.getElementById('auth-web-only');
  const r1Panel = document.getElementById('auth-r1-panel');
  const helperUrl = document.getElementById('helper-login-url');

  if (isHelperMode()) {
    if (btnConnect) {
      btnConnect.textContent = 'Connect';
      btnConnect.classList.remove('hidden');
    }
    if (btnImport) btnImport.classList.add('hidden');
    if (webOnly) webOnly.classList.remove('hidden');
    if (r1Panel) r1Panel.classList.add('hidden');
    showAuthRedirectHint();
    return;
  }

  if (isCompanionAuthMode()) {
    if (btnConnect) btnConnect.classList.add('hidden');
    if (btnImport) btnImport.classList.add('hidden');
    if (webOnly) webOnly.classList.add('hidden');
    if (r1Panel) r1Panel.classList.remove('hidden');
    startR1CompanionLogin();
    return;
  }

  if (btnConnect) {
    btnConnect.textContent = 'Connect';
    btnConnect.classList.remove('hidden');
  }
  if (btnImport) btnImport.classList.add('hidden');
  if (webOnly) webOnly.classList.remove('hidden');
  if (r1Panel) r1Panel.classList.add('hidden');
  showAuthRedirectHint();
}

async function importLoginKeyFromInput() {
  showAuthStatus('Use phone login — no paste needed');
}

// ===========================================
// Storage Helpers
// ===========================================

async function saveTokens() {
  const data = {
    accessToken: state.accessToken,
    refreshToken: state.refreshToken,
    tokenExpiry: state.tokenExpiry
  };
  if (window.creationStorage) {
    try {
      await window.creationStorage.plain.setItem('spotify_tokens', btoa(JSON.stringify(data)));
    } catch (e) { console.error('Storage save error:', e); }
  } else {
    localStorage.setItem('spotify_tokens', JSON.stringify(data));
  }
}

async function loadTokens() {
  if (window.creationStorage) {
    try {
      const stored = await window.creationStorage.plain.getItem('spotify_tokens');
      if (stored) return JSON.parse(atob(stored));
    } catch (e) { console.error('Storage load error:', e); }
  } else {
    const stored = localStorage.getItem('spotify_tokens');
    if (stored) return JSON.parse(stored);
  }
  return null;
}

async function clearTokens() {
  state.accessToken = null;
  state.refreshToken = null;
  state.tokenExpiry = 0;
  if (window.creationStorage) {
    try {
      await window.creationStorage.plain.removeItem('spotify_tokens');
      await window.creationStorage.plain.removeItem('spotify_verifier');
    } catch (e) { /* ignore */ }
  } else {
    localStorage.removeItem('spotify_tokens');
    sessionStorage.removeItem('spotify_verifier');
  }
}

// ===========================================
// PKCE Auth Flow
// ===========================================

function generateRandomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let result = '';
  const values = crypto.getRandomValues(new Uint8Array(length));
  for (let i = 0; i < length; i++) {
    result += chars[values[i] % chars.length];
  }
  return result;
}

async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Store PKCE verifier in every store the R1 WebView might keep across login. */
async function storeCodeVerifier(codeVerifier) {
  try {
    sessionStorage.setItem('spotify_verifier', codeVerifier);
  } catch (e) { /* ignore */ }
  try {
    localStorage.setItem('spotify_verifier', codeVerifier);
  } catch (e) { /* ignore */ }
  if (window.creationStorage) {
    try {
      await window.creationStorage.plain.setItem('spotify_verifier', btoa(codeVerifier));
    } catch (e) {
      console.warn('creationStorage verifier save failed:', e);
    }
  }
}

async function loadCodeVerifier() {
  if (window.creationStorage) {
    try {
      const stored = await window.creationStorage.plain.getItem('spotify_verifier');
      if (stored) return atob(stored);
    } catch (e) { /* fallback */ }
  }
  try {
    const fromSession = sessionStorage.getItem('spotify_verifier');
    if (fromSession) return fromSession;
  } catch (e) { /* ignore */ }
  try {
    return localStorage.getItem('spotify_verifier');
  } catch (e) {
    return null;
  }
}

async function clearCodeVerifier() {
  try {
    sessionStorage.removeItem('spotify_verifier');
  } catch (e) { /* ignore */ }
  try {
    localStorage.removeItem('spotify_verifier');
  } catch (e) { /* ignore */ }
  if (window.creationStorage) {
    try {
      await window.creationStorage.plain.removeItem('spotify_verifier');
    } catch (e) { /* ignore */ }
  }
}

async function startAuth() {
  if (isCompanionAuthMode()) {
    showAuthStatus('Use phone login (steps ①–③), then Import');
    return;
  }
  return startPkceRedirectAuth();
}

/** Browser / desktop OAuth redirect (PKCE). */
async function startPkceRedirectAuth() {
  if (isCompanionAuthMode() || window.__R1_AUTH__) {
    showAuthStatus('On R1: use phone login, then Import');
    return;
  }
  if (isHelperMode() || new URLSearchParams(window.location.search).get('helper') === '1') {
    markHelperLoginStarted(getPhoneSession());
  }
  showAuthStatus('Opening Spotify login…');
  const btn = document.getElementById('btn-connect');
  if (btn) btn.disabled = true;

  let codeVerifier;
  let codeChallenge;
  try {
    codeVerifier = generateRandomString(64);
    codeChallenge = await generateCodeChallenge(codeVerifier);
    await storeCodeVerifier(codeVerifier);
  } catch (e) {
    if (btn) btn.disabled = false;
    const msg = 'Could not start login: ' + (e && e.message ? e.message : String(e));
    showAuthStatus(msg);
    showToast(msg, 5000);
    bootError(msg);
    return;
  }

  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: SPOTIFY_REDIRECT_URI,
    scope: SPOTIFY_SCOPES,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge
  });

  const authUrl = `https://accounts.spotify.com/authorize?${params.toString()}`;
  if (window.self !== window.top) {
    window.top.location.href = authUrl;
  } else {
    window.location.href = authUrl;
  }
}

async function handleAuthCallback(code) {
  showAuthStatus('Finishing login…');
  const codeVerifier = await loadCodeVerifier();

  if (!codeVerifier) {
    const msg = 'Login session lost. Tap Connect and try again.';
    showAuthStatus(msg);
    showToast(msg, 5000);
    bootError(msg);
    return false;
  }

  let response;
  try {
    response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: SPOTIFY_CLIENT_ID,
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: SPOTIFY_REDIRECT_URI,
      code_verifier: codeVerifier
    })
    });
  } catch (e) {
    const msg = 'Network error during login';
    showAuthStatus(msg);
    showToast(msg, 5000);
    bootError(msg);
    return false;
  }

  if (!response.ok) {
    let detail = 'Auth failed';
    try {
      const err = await response.json();
      if (err.error_description) detail = err.error_description;
      else if (err.error) detail = err.error;
    } catch (e) { /* ignore */ }
    showAuthStatus(detail);
    showToast(detail, 5000);
    bootError(detail);
    return false;
  }

  const data = await response.json();
  state.accessToken = data.access_token;
  state.refreshToken = data.refresh_token;
  state.tokenExpiry = Date.now() + (data.expires_in * 1000);
  await saveTokens();
  await clearCodeVerifier();
  showAuthStatus('');

  // On desktop, the auth callback lands top-level (outside the preview frame).
  // Reload the clean root so the preview shell re-frames the now-authed app.
  if (runtimeEnv === 'browser' && window.self === window.top && !isHelperMode()) {
    window.location.replace(SPOTIFY_REDIRECT_URI);
    return true;
  }
  const cleanUrl = isHelperMode() ? getHelperLoginUrl() : SPOTIFY_REDIRECT_URI;
  window.history.replaceState({}, document.title, cleanUrl);
  return true;
}

async function refreshAccessToken() {
  if (!state.refreshToken) return false;

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: SPOTIFY_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: state.refreshToken
    })
  });

  if (!response.ok) return false;

  const data = await response.json();
  state.accessToken = data.access_token;
  if (data.refresh_token) state.refreshToken = data.refresh_token;
  state.tokenExpiry = Date.now() + (data.expires_in * 1000);
  await saveTokens();
  return true;
}

async function getValidToken() {
  if (!state.accessToken) return null;
  if (state.tokenExpiry - Date.now() < 60000) {
    const ok = await refreshAccessToken();
    if (!ok) return null;
  }
  return state.accessToken;
}

// ===========================================
// Spotify API Helpers
// ===========================================

async function spotifyFetch(endpoint, options = {}) {
  const token = await getValidToken();
  if (!token) {
    showToast('Not authenticated');
    return null;
  }

  const response = await fetch(`https://api.spotify.com/v1${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (response.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return spotifyFetch(endpoint, options);
    await clearTokens();
    showToast('Session expired — connect again', 3500);
    showView('auth');
    return null;
  }

  if (response.status === 204) return {};
  if (!response.ok) {
    let detail = `Spotify error (${response.status})`;
    try {
      const err = await response.json();
      if (err.error?.message) detail = err.error.message;
    } catch (e) { /* ignore */ }
    console.error('spotifyFetch:', endpoint, detail);
    return { _error: detail };
  }
  return response.json();
}

// ===========================================
// Spotify Web Playback SDK
// ===========================================

function initPlayer() {
  if (state.player) return;
  if (typeof Spotify === 'undefined') {
    window.onSpotifyWebPlaybackSDKReady = () => setupPlayer();
    return;
  }
  setupPlayer();
}

/** Must run synchronously inside tap/click — do not await before this on R1. */
function gestureActivateAudioSync() {
  if (runtimeEnv !== 'r1' || !state.player) return;
  try {
    if (typeof state.player.activateElement === 'function') {
      const p = state.player.activateElement();
      if (p && typeof p.then === 'function') p.catch(() => {});
    }
    state.audioUnlocked = true;
  } catch (e) {
    console.warn('gestureActivateAudioSync:', e);
  }
}

function fixSpotifyEmbedIframe() {
  const iframe = document.querySelector('iframe[src*="sdk.scdn.co"]');
  if (!iframe) return;
  iframe.setAttribute('allow', 'encrypted-media *; autoplay *');
  iframe.style.cssText =
    'display:block!important;position:absolute;width:1px;height:1px;opacity:0;' +
    'pointer-events:none;left:0;top:0;border:0;';
}

/** Connect Web Playback SDK from a button tap (required on R1). */
async function ensurePlayerFromGesture() {
  if (state.player && state.deviceId) {
    await unlockWebAudio();
    return true;
  }

  if (runtimeEnv === 'r1' && !state.player) {
    const sdkOk = await waitForSpotifySdk(15000);
    if (!sdkOk) {
      showToast('Spotify player SDK did not load', 5000);
      return false;
    }
    setupPlayer();
  } else if (!state.player) {
    initPlayer();
    if (!state.player && typeof Spotify !== 'undefined') setupPlayer();
  }

  if (!state.player) {
    showToast('Player not available', 4000);
    return false;
  }

  await unlockWebAudio();
  const ready = await waitForDevice(runtimeEnv === 'r1' ? 25000 : 12000);
  if (!ready) showToast('Connecting player… tap again', 4000);
  return ready;
}

/** Mobile / WebView: unlock audio output (must run during a user gesture). */
async function unlockWebAudio(force = false) {
  if (!state.player) return;
  if (!force && state.audioUnlocked) return;
  try {
    if (typeof state.player.activateElement === 'function') {
      await state.player.activateElement();
    }
    await state.player.setVolume(1);
    state.audioUnlocked = true;
  } catch (e) {
    console.warn('activateElement:', e);
  }
}

/** R1: always re-unlock audio on tap — WebView often drops output until activateElement runs. */
async function forceUnlockR1Audio() {
  if (runtimeEnv !== 'r1' || !state.player) return;
  await unlockWebAudio(true);
}

async function startR1LocalAudio() {
  if (runtimeEnv !== 'r1' || !state.player) return;
  fixSpotifyEmbedIframe();
  await forceUnlockR1Audio();
  try {
    const cur = await state.player.getCurrentState();
    if (cur && !cur.paused) return;
    if (cur?.paused) await state.player.resume();
  } catch (e) {
    console.warn('startR1LocalAudio:', e);
  }
}

async function ensurePlaybackDevice() {
  if (!state.deviceId) return false;
  if (state.activeDeviceId === state.deviceId) return true;
  await transferPlayback(state.deviceId);
  return state.activeDeviceId === state.deviceId;
}

/** R1 only: unlock audio + transfer once. Avoid re-transfer on every tap (causes playback_error). */
async function preparePlaybackForUserAction() {
  if (runtimeEnv !== 'r1') return;
  await forceUnlockR1Audio();
  await ensurePlaybackDevice();
}

async function resumeLocalPlayback() {
  if (!state.player) return;
  try {
    const cur = await state.player.getCurrentState();
    if (cur?.paused) await state.player.resume();
  } catch (e) {
    console.warn('resumeLocalPlayback:', e);
  }
}

function installR1AudioUnlock() {
  if (runtimeEnv !== 'r1' || state._r1UnlockInstalled) return;
  state._r1UnlockInstalled = true;
  const onGesture = () => {
    gestureActivateAudioSync();
  };
  document.addEventListener('click', onGesture, true);
  document.addEventListener('touchstart', onGesture, { capture: true, passive: true });
}

async function destroyPlayer() {
  if (!state.player) return;
  try {
    await state.player.disconnect();
  } catch (e) {
    console.warn('disconnect:', e);
  }
  state.player = null;
  state.deviceId = null;
  state.activeDeviceId = null;
  state.audioUnlocked = false;
}

async function setupPlayer() {
  if (state.player || state._setupPlayerInFlight) return;
  state._setupPlayerInFlight = true;

  let token = await getValidToken();
  if (!token && state.refreshToken) {
    await refreshAccessToken();
    token = state.accessToken;
  }
  if (!token) {
    state._setupPlayerInFlight = false;
    showToast('Session expired — log in again', 5000);
    showView('auth');
    return;
  }

  const player = new Spotify.Player({
    name: runtimeEnv === 'r1' ? 'Rabbit R1' : 'R1 Device',
    getOAuthToken: async (cb) => {
      let t = await getValidToken();
      if (!t && state.refreshToken) {
        await refreshAccessToken();
        t = state.accessToken;
      }
      if (!t) {
        showToast('Session expired — log in again', 5000);
        showView('auth');
      }
      cb(t || '');
    },
    volume: 0.8
  });

  player.addListener('ready', async ({ device_id }) => {
    state.deviceId = device_id;
    console.log('Spotify player ready, device:', device_id);
    try {
      await player.setVolume(0.8);
    } catch (e) { /* ignore */ }
    await transferPlayback(device_id);
    fixSpotifyEmbedIframe();
    syncNowPlayingFromApi();
    if (runtimeEnv === 'r1') {
      showToast('Pick a song, then tap ▶ on R1', 3500);
    }
  });

  player.addListener('not_ready', ({ device_id }) => {
    console.log('Device offline:', device_id);
    state.deviceId = null;
    state.activeDeviceId = null;
  });

  player.addListener('player_state_changed', (playerState) => {
    if (!playerState) return;
    handlePlayerStateChange(playerState);
  });

  player.addListener('initialization_error', ({ message }) => {
    console.error('Init error:', message);
    const msg = String(message || '');
    let hint = msg.slice(0, 72) || 'Player init error';
    if (/premium/i.test(msg)) hint = 'Spotify Premium required';
    else if (/initialize/i.test(msg) && !state._playerRetried) {
      hint = 'Player init failed — retrying…';
      state._playerRetried = true;
      destroyPlayer().then(() => {
        state._setupPlayerInFlight = false;
        setTimeout(() => setupPlayer(), 1500);
      });
    } else if (/initialize/i.test(msg)) {
      hint = 'Player init failed — log in again (Premium required)';
    }
    showToast(hint, 5000);
  });

  player.addListener('account_error', ({ message }) => {
    console.error('Account error:', message);
    showToast('Spotify Premium required for playback', 6000);
  });

  player.addListener('authentication_error', ({ message }) => {
    console.error('Auth error:', message);
    showToast(message ? String(message).slice(0, 72) : 'Player auth error', 4000);
    showView('auth');
  });

  player.addListener('autoplay_failed', () => {
    state.audioUnlocked = false;
    showToast('Tap ▶ or scroll to start audio', 4000);
  });

  player.addListener('playback_error', ({ message }) => {
    console.error('Playback error:', message);
    if (Date.now() < state.playbackErrorMuteUntil) return;
    state.playbackErrorMuteUntil = Date.now() + 8000;
    const msg = String(message || '');
    let hint = msg.slice(0, 72) || 'Playback error';
    if (runtimeEnv === 'r1') {
      hint = 'No R1 audio — tap ▶ again. Close Spotify on PC/phone.';
    }
    showToast(hint, 6000);
  });

  state.player = player;
  state._setupPlayerInFlight = false;
  const connected = player.connect();
  if (connected && typeof connected.then === 'function') {
    connected.then((ok) => {
      if (!ok) {
        console.error('Spotify connect failed');
        showToast('Could not connect player — retry', 4000);
      }
    });
  }
}

async function transferPlayback(deviceId) {
  if (!deviceId || state.activeDeviceId === deviceId) return;
  state.playbackErrorMuteUntil = Date.now() + 2500;
  const result = await spotifyFetch('/me/player', {
    method: 'PUT',
    body: JSON.stringify({ device_ids: [deviceId], play: false })
  });
  if (!result?._error) state.activeDeviceId = deviceId;
}

async function fetchPlayerSnapshot() {
  const data = await spotifyFetch('/me/player');
  if (!data || data._error || !data.item) return null;
  return data;
}

async function syncNowPlayingFromApi() {
  const data = await fetchPlayerSnapshot();
  if (!data) return;

  if (
    runtimeEnv === 'r1' &&
    state.deviceId &&
    data.device?.id &&
    data.device.id !== state.deviceId
  ) {
    const now = Date.now();
    if (!state._lastDeviceSteal || now - state._lastDeviceSteal > 30000) {
      state._lastDeviceSteal = now;
      const where = data.device.name || 'another device';
      showToast(`Audio was on ${where} — moved to Rabbit R1`, 4000);
      state.activeDeviceId = null;
      await ensurePlaybackDevice();
    }
  }

  const apiProg = data.progress_ms || 0;
  let playing = !!data.is_playing;
  if (
    runtimeEnv === 'r1' &&
    !playing &&
    state.lastApiProgressMs != null &&
    apiProg > state.lastApiProgressMs + 700
  ) {
    playing = true;
  }
  state.lastApiProgressMs = apiProg;
  state.isPlaying = playing;

  if (runtimeEnv === 'r1' && playing) {
    const drift = Math.abs(apiProg - state.progressMs);
    if (drift > 2500) state.progressMs = apiProg;
  } else {
    state.progressMs = apiProg;
  }
  state.durationMs = data.item.duration_ms || 0;
  state.currentTrack = {
    name: data.item.name,
    artist: (data.item.artists || []).map((a) => a.name).join(', '),
    albumArt: data.item.album?.images?.[0]?.url || '',
    uri: data.item.uri
  };
  if (data.context?.uri) state.playingPlaylistUri = data.context.uri;
  updatePlayerUI();
  updatePlayButton();
  updateProgress();
}

async function apiResumePlayback() {
  const result = await spotifyFetch(`/me/player/play${playerDeviceQuery()}`, { method: 'PUT' });
  if (result?._error) {
    showToast(result._error, 3500);
    return false;
  }
  state.isPlaying = true;
  updatePlayButton();
  return true;
}

async function apiPausePlayback() {
  const result = await spotifyFetch(`/me/player/pause${playerDeviceQuery()}`, { method: 'PUT' });
  if (result?._error) return false;
  state.isPlaying = false;
  updatePlayButton();
  return true;
}

async function startDefaultPlayback() {
  if (state.currentPlaylistTracks.length > 0) {
    return playTrackUris(state.currentPlaylistTracks.map((t) => t.uri), 0);
  }
  if (state.currentPlaylistUri) {
    return playContext(state.currentPlaylistUri, 0);
  }
  const pl = state.playlists[0];
  if (!pl) return false;
  showToast('Loading playlist…', 2000);
  await fetchPlaylistTracks(pl.id, pl.name, pl.uri, pl.owned);
  if (state.currentPlaylistTracks.length > 0) {
    return playTrackUris(state.currentPlaylistTracks.map((t) => t.uri), 0);
  }
  if (state.currentPlaylistUri) {
    return playContext(state.currentPlaylistUri, 0);
  }
  return false;
}

function handlePlayerStateChange(playerState) {
  const track = playerState.track_window?.current_track;
  state.isPlaying = !playerState.paused;
  state.progressMs = playerState.position;
  state.durationMs = playerState.duration;

  const prevPlayingUri = state.playingPlaylistUri;
  const prevTrackUri = state.currentTrack?.uri;

  // Derive the playing playlist from the actual playback context when available
  // (covers Play All / context playback and survives reconnects).
  if (playerState.context?.uri) {
    state.playingPlaylistUri = playerState.context.uri;
  }

  if (track) {
    state.currentTrack = {
      name: track.name,
      artist: track.artists.map(a => a.name).join(', '),
      albumArt: track.album.images[0]?.url || '',
      uri: track.uri
    };
    updatePlayerUI();
  }

  updatePlayButton();
  updateProgress();

  // Keep the green LED in sync if a list view is currently open.
  if (state.currentView === 'playlists' && state.playingPlaylistUri !== prevPlayingUri) {
    renderPlaylists();
  } else if (state.currentView === 'tracks' && state.currentTrack?.uri !== prevTrackUri) {
    renderTracks();
  }
}

// ===========================================
// Playback Controls
// ===========================================

async function ensureBrowserPlayer() {
  if (!state.player) initPlayer();
  return waitForDevice(12000);
}

async function togglePlay() {
  if (runtimeEnv !== 'r1') {
    if (!(await ensureBrowserPlayer()) || !state.player) {
      showToast('Player connecting… wait and tap again', 3500);
      return;
    }
    let cur = null;
    try {
      cur = await state.player.getCurrentState();
    } catch (e) {
      console.warn('getCurrentState:', e);
    }
    if (!cur?.track_window?.current_track) {
      const started = await startDefaultPlayback();
      if (!started) showToast('Open ☰ and pick a playlist', 4000);
      return;
    }
    try {
      await state.player.togglePlay();
    } catch (e) {
      showToast('Could not toggle playback', 3500);
    }
    return;
  }

  if (!(await ensurePlayerFromGesture())) return;
  await preparePlaybackForUserAction();

  const snap = await fetchPlayerSnapshot();
  const playing = snap ? !!snap.is_playing : state.isPlaying;

  if (!snap?.item && !state.currentTrack?.uri && !state.currentPlaylistTracks.length) {
    const started = await startDefaultPlayback();
    if (!started) showToast('Open ☰ and pick a playlist', 4000);
    return;
  }

  if (playing) {
    await apiPausePlayback();
    if (state.player) {
      try { await state.player.pause(); } catch (e) { /* ignore */ }
    }
  } else {
    const ok = await apiResumePlayback();
    if (!ok && state.currentPlaylistTracks.length > 0) {
      await playTrackUris(state.currentPlaylistTracks.map((t) => t.uri), 0);
    } else if (!ok && state.currentTrack?.uri) {
      await playTrackUris([state.currentTrack.uri], 0);
    } else if (!ok) {
      showToast('Nothing to play — open ☰', 4000);
      return;
    }
    await startR1LocalAudio();
    if (state.player) {
      try { await state.player.resume(); } catch (e) { /* ignore */ }
    }
  }
  setTimeout(() => syncNowPlayingFromApi(), 400);
}

async function nextTrack() {
  if (runtimeEnv !== 'r1') {
    if (!state.player) return;
    try { await state.player.nextTrack(); } catch (e) { /* ignore */ }
    return;
  }
  if (!(await ensurePlayerFromGesture())) return;
  await preparePlaybackForUserAction();
  const result = await spotifyFetch(`/me/player/next${playerDeviceQuery()}`, { method: 'POST' });
  if (result?._error && state.player) {
    try { await state.player.nextTrack(); } catch (e) { /* ignore */ }
  }
}

async function prevTrack() {
  if (runtimeEnv !== 'r1') {
    if (!state.player) return;
    try { await state.player.previousTrack(); } catch (e) { /* ignore */ }
    return;
  }
  if (!(await ensurePlayerFromGesture())) return;
  await preparePlaybackForUserAction();
  const result = await spotifyFetch(`/me/player/previous${playerDeviceQuery()}`, { method: 'POST' });
  if (result?._error && state.player) {
    try { await state.player.previousTrack(); } catch (e) { /* ignore */ }
  }
}

/** |◀◀ — jump to the start of the current playlist/list. */
async function firstTrack() {
  if (state.currentPlaylistUri) {
    await playContext(state.currentPlaylistUri, 0);
    return;
  }
  if (state.currentPlaylistTracks.length > 0) {
    await playTrackUris(state.currentPlaylistTracks.map((t) => t.uri), 0);
    return;
  }
  if (state.player) await state.player.seek(0);
}

/** ▶▶| — jump to the last track of the current list (needs a known track list). */
async function lastTrack() {
  const tracks = state.currentPlaylistTracks;
  if (tracks.length > 0) {
    await playTrackUris(tracks.map((t) => t.uri), tracks.length - 1);
    return;
  }
  showToast('End of list not available here');
}

/** Play every track in the currently open playlist, from the top. */
async function playAllCurrent() {
  if (state.currentPlaylistUri) {
    const ok = await playContext(state.currentPlaylistUri, 0);
    if (ok) {
      state.playingPlaylistUri = state.currentPlaylistUri;
      setPlaybackStatus('all');
      showView('player');
    }
    return;
  }
  if (state.currentPlaylistTracks.length > 0) {
    const uris = state.currentPlaylistTracks.map((t) => t.uri);
    const ok = await playTrackUris(uris, 0);
    if (ok) {
      state.playingPlaylistUri = state.currentPlaylistUri;
      setPlaybackStatus('all');
      showView('player');
    }
    return;
  }
  showToast('No tracks to play');
}

async function playContext(contextUri, offset = 0) {
  if (runtimeEnv === 'r1') {
    if (!(await ensurePlayerFromGesture())) return false;
    await preparePlaybackForUserAction();
  } else {
    if (!(await ensureBrowserPlayer())) {
      showToast('Player not ready — wait a moment', 3500);
      return false;
    }
    await ensurePlaybackDevice();
  }
  const result = await spotifyFetch(playerPlayEndpoint(), {
    method: 'PUT',
    body: JSON.stringify({
      context_uri: contextUri,
      offset: { position: offset }
    })
  });
  if (result?._error) {
    showToast(result._error, 3500);
    return false;
  }
  syncNowPlayingFromApi();
  if (runtimeEnv === 'r1') await startR1LocalAudio();
  return true;
}

async function playTrackUris(uris, offset = 0) {
  if (runtimeEnv === 'r1') {
    if (!(await ensurePlayerFromGesture())) return false;
    await preparePlaybackForUserAction();
  } else {
    if (!(await ensureBrowserPlayer())) {
      showToast('Player not ready — wait a moment', 3500);
      return false;
    }
    await ensurePlaybackDevice();
  }
  const result = await spotifyFetch(playerPlayEndpoint(), {
    method: 'PUT',
    body: JSON.stringify({
      uris: uris,
      offset: { position: offset }
    })
  });
  if (result?._error) {
    showToast(result._error, 3500);
    return false;
  }
  const track = state.currentPlaylistTracks[offset];
  if (track) {
    state.currentTrack = {
      name: track.name,
      artist: track.artist,
      albumArt: track.albumArt || '',
      uri: track.uri
    };
    updatePlayerUI();
  }
  syncNowPlayingFromApi();
  if (runtimeEnv === 'r1') await startR1LocalAudio();
  return true;
}

async function pausePlayback() {
  if (!state.player) return;
  await state.player.pause();
}

async function resumePlayback() {
  if (!state.player) return;
  if (runtimeEnv === 'r1') await preparePlaybackForUserAction();
  await state.player.resume();
}

// ===========================================
// Playlist & Track Fetching
// ===========================================

/** Tapping the ♫ status jumps to the song list of whatever is currently playing. */
function openCurrentPlayingList() {
  const uri = state.playingPlaylistUri;
  if (!uri) {
    showToast('No playlist is playing');
    return;
  }
  const pl = state.playlists.find((p) => p.uri === uri);
  if (pl) {
    fetchPlaylistTracks(pl.id, pl.name, pl.uri, pl.owned);
    return;
  }
  const match = /spotify:playlist:(\w+)/.exec(uri);
  if (match) {
    fetchPlaylistTracks(match[1], 'Now Playing', uri, true);
    return;
  }
  showToast('Cannot open this list');
}

async function openPlaylistBrowser() {
  showView('playlists');
  const container = document.getElementById('playlist-list');
  if (state.playlists.length === 0) {
    container.innerHTML = '<div class="loading">Loading playlists…</div>';
    await fetchPlaylists();
  } else {
    renderPlaylists();
  }
}

function playlistTrackCount(playlist) {
  return playlist.items?.total ?? playlist.tracks?.total ?? 0;
}

function parsePlaylistEntry(entry) {
  const track = entry?.track || entry?.item;
  if (!track || track.type !== 'track' || !track.uri) return null;
  const images = track.album?.images || [];
  return {
    name: track.name,
    artist: (track.artists || []).map((a) => a.name).join(', '),
    uri: track.uri,
    albumArt: images[1]?.url || images[2]?.url || images[0]?.url || ''
  };
}

async function fetchCurrentUserId() {
  if (state.userId) return state.userId;
  const me = await spotifyFetch('/me');
  if (me && !me._error && me.id) state.userId = me.id;
  return state.userId;
}

async function fetchPlaylists() {
  await fetchCurrentUserId();
  const data = await spotifyFetch('/me/playlists?limit=50');
  if (data?._error) {
    showToast(data._error, 3500);
    return;
  }
  if (data && data.items) {
    state.playlists = data.items.map((p) => ({
      id: p.id,
      name: p.name,
      uri: p.uri,
      image: p.images?.[0]?.url || '',
      trackCount: playlistTrackCount(p),
      owned: !!(state.userId && p.owner?.id === state.userId)
    }));
    renderPlaylists();
  }
}

/** Shown when Spotify won't return a track list (only owned/collaborator playlists are allowed since Feb 2026). */
function showPlayOnlyMessage(container) {
  state.currentPlaylistTracks = [];
  container.innerHTML =
    '<div class="loading">Spotify only lists songs for playlists you own.<br><br>Tap ▶ All above to play this playlist.</div>';
}

async function fetchPlaylistTracks(playlistId, playlistName, playlistUri, owned = true) {
  const container = document.getElementById('track-list');
  container.innerHTML = '<div class="loading">Loading tracks…</div>';
  state.currentPlaylistUri = playlistUri || null;
  showView('tracks');
  document.getElementById('tracks-title').textContent = playlistName;

  // Spotify (Feb 2026) only returns track listings for playlists the user owns
  // or collaborates on. For others, skip the call and offer Play All instead.
  if (!owned) {
    showPlayOnlyMessage(container);
    return;
  }

  const data = await spotifyFetch(
    `/playlists/${playlistId}/items?limit=50&additional_types=track`
  );

  if (data?._error) {
    if (/forbidden/i.test(data._error) && playlistUri) {
      showPlayOnlyMessage(container);
      return;
    }
    showToast(data._error, 3500);
    container.innerHTML = '<div class="loading">Could not load tracks</div>';
    return;
  }

  if (data?.items) {
    state.currentPlaylistTracks = data.items
      .map(parsePlaylistEntry)
      .filter(Boolean);

    if (state.currentPlaylistTracks.length === 0 && playlistUri) {
      container.innerHTML = '<div class="loading">No track list from API</div>';
      showToast('Playing playlist — pick songs in Spotify app if list is empty', 4000);
      await playContext(playlistUri);
      state.playingPlaylistUri = playlistUri;
      setPlaybackStatus('all');
      showView('player');
      return;
    }

    renderTracks();
    return;
  }

  container.innerHTML = '<div class="loading">No tracks found</div>';
}

// ===========================================
// Search (for voice commands)
// ===========================================

async function searchAndPlay(query, type = 'track') {
  const data = await spotifyFetch(`/search?q=${encodeURIComponent(query)}&type=${type}&limit=5`);
  if (!data || data._error) {
    showToast(data?._error || 'Search failed', 3500);
    return;
  }

  if (type === 'track' && data.tracks?.items?.length > 0) {
    const track = data.tracks.items[0];
    await playTrackUris([track.uri]);
    state.playingPlaylistUri = null;
    setPlaybackStatus('song');
    showToast(`Playing: ${track.name}`);
  } else if (type === 'playlist' && data.playlists?.items?.length > 0) {
    const playlist = data.playlists.items[0];
    await playContext(playlist.uri);
    state.playingPlaylistUri = playlist.uri;
    setPlaybackStatus('all');
    showToast(`Playing: ${playlist.name}`);
  } else {
    showToast('No results found');
  }
}

// ===========================================
// UI Rendering
// ===========================================

function showView(viewName) {
  if (viewName !== 'player' && state.albumArtExpanded) {
    setAlbumArtExpanded(false);
  }
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const target = document.getElementById(`view-${viewName}`);
  if (target) {
    target.classList.add('active');
    state.currentView = viewName;
  }
  // Refresh the playlist highlight (green LED) whenever the list is shown.
  if (viewName === 'playlists' && state.playlists.length > 0) {
    renderPlaylists();
  }
}

function setAlbumArtExpanded(expanded) {
  state.albumArtExpanded = expanded;
  const artEl = document.getElementById('album-art');
  const container = document.querySelector('.player-container');
  artEl.classList.toggle('expanded', expanded);
  container?.classList.toggle('art-expanded', expanded);
  artEl.setAttribute('aria-label', expanded ? 'Tap to shrink album art' : 'Tap to enlarge album art');
}

function toggleAlbumArtExpand() {
  setAlbumArtExpanded(!state.albumArtExpanded);
}

function updatePlayerUI() {
  if (!state.currentTrack) return;

  const artEl = document.getElementById('album-art');
  if (state.currentTrack.albumArt) {
    artEl.innerHTML = '';
    const img = document.createElement('img');
    img.src = state.currentTrack.albumArt;
    img.alt = 'Album art';
    artEl.appendChild(img);
  } else {
    artEl.innerHTML = '<div class="album-placeholder">♫</div>';
  }

  document.getElementById('track-name').textContent = state.currentTrack.name;
  document.getElementById('track-artist').textContent = state.currentTrack.artist;
}

function updatePlayButton() {
  const btn = document.getElementById('btn-play');
  btn.textContent = state.isPlaying ? '⏸' : '▶';
}

/** Persistent bottom-of-screen label: 'all' (whole playlist) or 'song' (single track). */
function setPlaybackStatus(mode) {
  state.playbackMode = mode;
  const el = document.getElementById('playback-status');
  if (!el) return;
  if (mode === 'all') {
    el.textContent = runtimeEnv === 'r1' ? '♫' : '♫ All';
    el.setAttribute('title', 'Playing whole playlist — tap for song list');
  } else if (mode === 'song') {
    el.textContent = runtimeEnv === 'r1' ? '♫' : '♫ Song';
    el.setAttribute('title', 'Playing one song — tap for song list');
  } else {
    el.textContent = '';
    el.removeAttribute('title');
  }

  const interactive = mode === 'all' || mode === 'song';
  el.classList.toggle('tappable', interactive);
  if (interactive) {
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', 'Show songs in the current list');
  } else {
    el.removeAttribute('role');
    el.removeAttribute('tabindex');
    el.removeAttribute('aria-label');
    el.removeAttribute('title');
  }
}

function updateProgress() {
  if (state.durationMs <= 0) return;
  const pct = (state.progressMs / state.durationMs) * 100;
  document.getElementById('progress-fill').style.width = `${pct}%`;
  document.getElementById('time-current').textContent = formatTime(state.progressMs);
  document.getElementById('time-total').textContent = formatTime(state.durationMs);
}

function startProgressTimer() {
  if (state.progressInterval) clearInterval(state.progressInterval);
  if (r1ApiSyncInterval) clearInterval(r1ApiSyncInterval);
  if (runtimeEnv === 'r1') {
    state.progressInterval = setInterval(() => {
      if (state.isPlaying && state.durationMs > 0) {
        state.progressMs += 500;
        if (state.progressMs > state.durationMs) state.progressMs = state.durationMs;
        updateProgress();
      }
    }, 500);
    r1ApiSyncInterval = setInterval(() => syncNowPlayingFromApi(), 4000);
    return;
  }
  state.progressInterval = setInterval(() => {
    if (state.isPlaying && state.durationMs > 0) {
      state.progressMs += 500;
      if (state.progressMs > state.durationMs) state.progressMs = state.durationMs;
      updateProgress();
    }
  }, 500);
}

function formatTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

function renderPlaylists() {
  const container = document.getElementById('playlist-list');
  if (state.playlists.length === 0) {
    container.innerHTML = '<div class="loading">No playlists found</div>';
    return;
  }

  container.innerHTML = state.playlists.map((pl, i) => {
    const isPlaying = !!state.playingPlaylistUri && pl.uri === state.playingPlaylistUri;
    const meta = pl.owned
      ? (pl.trackCount > 0 ? `${pl.trackCount} tracks` : 'tap to open')
      : '▶ play only';
    return `
    <div class="list-item" data-index="${i}" data-id="${escapeAttr(pl.id)}" data-uri="${escapeAttr(pl.uri)}" data-name="${escapeAttr(pl.name)}" data-owned="${pl.owned ? '1' : '0'}">
      <div class="list-item-art">
        ${pl.image ? `<img src="${escapeAttr(pl.image)}" alt="">` : '♫'}
      </div>
      <div class="list-item-info">
        <div class="list-item-name">${escapeHtml(pl.name)}</div>
        <div class="list-item-meta">${meta}</div>
      </div>
      ${isPlaying ? '<span class="led" aria-label="Now playing"></span>' : ''}
    </div>
  `;
  }).join('');

  container.querySelectorAll('.list-item').forEach(item => {
    item.addEventListener('click', () => {
      fetchPlaylistTracks(item.dataset.id, item.dataset.name, item.dataset.uri, item.dataset.owned === '1');
    });
  });
}

function renderTracks() {
  const container = document.getElementById('track-list');
  if (state.currentPlaylistTracks.length === 0) {
    container.innerHTML = '<div class="loading">No tracks</div>';
    return;
  }

  container.innerHTML = state.currentPlaylistTracks.map((tr, i) => {
    const isActive = state.currentTrack?.uri === tr.uri;
    return `
      <div class="list-item ${isActive ? 'active-track' : ''}" data-index="${i}">
        <div class="list-item-art">
          ${tr.albumArt ? `<img src="${tr.albumArt}" alt="">` : '♫'}
        </div>
        <div class="list-item-info">
          <div class="list-item-name">${escapeHtml(tr.name)}</div>
          <div class="list-item-meta">${escapeHtml(tr.artist)}</div>
        </div>
        ${isActive ? '<span class="led" aria-label="Now playing"></span>' : ''}
      </div>
    `;
  }).join('');

  container.querySelectorAll('.list-item').forEach(item => {
    item.addEventListener('click', () => {
      gestureActivateAudioSync();
      const idx = parseInt(item.dataset.index);
      const uris = state.currentPlaylistTracks.map(t => t.uri);
      playTrackUris(uris, idx);
      state.playingPlaylistUri = state.currentPlaylistUri;
      setPlaybackStatus('song');
      showView('player');
    });
  });
}

function showToast(msg, duration = 2000) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), duration);
}

// ===========================================
// Voice Control
// ===========================================

function startVoiceListening() {
  state.wasPlayingBeforeVoice = state.isPlaying;
  state.isListening = true;

  if (state.isPlaying) {
    pausePlayback();
  }

  document.getElementById('voice-overlay').classList.remove('hidden');

  if (typeof CreationVoiceHandler !== 'undefined') {
    CreationVoiceHandler.postMessage('start');
  }
}

function stopVoiceListening() {
  state.isListening = false;
  document.getElementById('voice-overlay').classList.add('hidden');

  if (typeof CreationVoiceHandler !== 'undefined') {
    CreationVoiceHandler.postMessage('stop');
  }
}

function handleVoiceCommand(transcript) {
  if (!transcript || transcript.trim() === '') {
    if (state.wasPlayingBeforeVoice) resumePlayback();
    return;
  }

  const cmd = transcript.toLowerCase().trim();

  if (cmd.includes('pause') || cmd.includes('stop')) {
    pausePlayback();
    showToast('Paused');
  } else if (cmd === 'play' || cmd === 'resume') {
    resumePlayback();
    showToast('Resumed');
  } else if (cmd.includes('next') || cmd.includes('skip')) {
    nextTrack();
    showToast('Next track');
  } else if (cmd.includes('previous') || cmd.includes('back')) {
    prevTrack();
    showToast('Previous track');
  } else if (cmd.includes('play ')) {
    const query = cmd.replace(/^play\s+/, '');
    if (query.includes('playlist')) {
      searchAndPlay(query.replace('playlist', '').trim(), 'playlist');
    } else {
      searchAndPlay(query, 'track');
    }
  } else if (cmd.includes('playlists') || cmd.includes('browse')) {
    showView('playlists');
    if (state.wasPlayingBeforeVoice) resumePlayback();
  } else {
    // Use LLM to interpret the command
    interpretWithLLM(transcript);
  }
}

function interpretWithLLM(transcript) {
  if (typeof PluginMessageHandler !== 'undefined') {
    PluginMessageHandler.postMessage(JSON.stringify({
      message: `The user said: "${transcript}". This is a Spotify music player. Interpret their command and respond ONLY with valid JSON: {"action":"play|pause|next|previous|search|resume","query":"search term if action is search","type":"track|playlist"}. If unsure, use action "resume".`,
      useLLM: true
    }));
  } else {
    if (state.wasPlayingBeforeVoice) resumePlayback();
  }
}

// ===========================================
// Plugin Message Handler
// ===========================================

window.onPluginMessage = function(data) {
  // Handle STT result
  if (data.type === 'sttEnded' && data.transcript) {
    stopVoiceListening();
    handleVoiceCommand(data.transcript);
    return;
  }

  // Handle LLM response
  let response = data.data || data.message;
  if (!response) return;

  try {
    const parsed = parseLlmJson(response);

    if (parsed.action) {
      switch (parsed.action) {
        case 'play':
        case 'search':
          if (parsed.query) {
            searchAndPlay(parsed.query, parsed.type || 'track');
          } else {
            resumePlayback();
          }
          break;
        case 'pause':
          pausePlayback();
          showToast('Paused');
          break;
        case 'next':
          nextTrack();
          break;
        case 'previous':
          prevTrack();
          break;
        case 'resume':
        default:
          if (state.wasPlayingBeforeVoice) resumePlayback();
          break;
      }
    }
  } catch (e) {
    if (state.wasPlayingBeforeVoice) resumePlayback();
  }
};

// ===========================================
// Hardware Event Handlers
// ===========================================

window.addEventListener('scrollUp', () => {
  if (state.currentView === 'player') {
    openPlaylistBrowser();
  }
});

window.addEventListener('scrollDown', () => {
  if (state.currentView === 'playlists') {
    showView('player');
  } else if (state.currentView === 'tracks') {
    showView('playlists');
  }
});

window.addEventListener('sideClick', () => {
  gestureActivateAudioSync();
  if (state.currentView === 'player') {
    togglePlay();
  }
});

window.addEventListener('longPressStart', () => {
  if (state.currentView !== 'auth') {
    startVoiceListening();
  }
});

window.addEventListener('longPressEnd', () => {
  if (state.isListening) {
    stopVoiceListening();
  }
});

// ===========================================
// Initialization
// ===========================================

async function init() {
  const urlParams = new URLSearchParams(window.location.search);
  const oauthError = urlParams.get('error');

  if (isHelperMode()) {
    rememberPhoneSession(urlParams.get('session'));
    const pairSession = getPhoneSession();
    const code = urlParams.get('code');
    if (code) {
      bootStatus('Finishing login…');
      const success = await handleAuthCallback(code);
      if (!success) {
        showView('auth');
        configureAuthUIForEnv();
        return 'error';
      }
    }
    const tokens = await loadTokens();
    if (tokens?.accessToken && tokens?.refreshToken) {
      state.accessToken = tokens.accessToken;
      state.refreshToken = tokens.refreshToken;
      state.tokenExpiry = tokens.tokenExpiry || 0;
      if (state.tokenExpiry - Date.now() < 60000) {
        await refreshAccessToken();
      }
      if (pairSession && /^\d{6}$/.test(pairSession)) {
        try {
          await publishTokensToSession(pairSession);
          showHelperSentView();
          bootDone();
          return 'helper';
        } catch (e) {
          const msg = e.message || 'Could not send to R1';
          showAuthStatus(msg);
          showToast(msg, 6000);
          bootError(msg);
          return 'error';
        }
      }
      showHelperExportView(createLoginKeyFromState());
      bootDone();
      return 'helper';
    }
    showView('auth');
    configureAuthUIForEnv();
    return 'auth';
  }

  if (oauthError) {
    const msg = 'Spotify login cancelled: ' + oauthError;
    showAuthStatus(msg);
    showView('auth');
    configureAuthUIForEnv();
    window.history.replaceState({}, document.title, SPOTIFY_REDIRECT_URI);
    bootError(msg);
    return 'error';
  }

  const code = urlParams.get('code');

  if (code) {
    bootStatus('Spotify returned — finishing login…');
    const success = await handleAuthCallback(code);
    if (success) {
      initPlayer();
      installR1AudioUnlock();
      showView('player');
      fetchPlaylists();
      startProgressTimer();
      return 'player';
    }
    showView('auth');
    configureAuthUIForEnv();
    const btn = document.getElementById('btn-connect');
    if (btn) btn.disabled = false;
    return 'error';
  }

  const tokens = await loadTokens();
  if (tokens?.accessToken && tokens?.refreshToken) {
    stopCompanionPolling();
    state.accessToken = tokens.accessToken;
    state.refreshToken = tokens.refreshToken;
    state.tokenExpiry = tokens.tokenExpiry || 0;

    const tokenValid = state.tokenExpiry - Date.now() > 60000;
    const sessionOk = tokenValid || (await refreshAccessToken());
    if (sessionOk && state.accessToken) {
      showView('player');
      bootDone();
      initPlayer();
      installR1AudioUnlock();
      fetchPlaylists();
      startProgressTimer();
      return 'player';
    }
    await clearTokens();
    showAuthStatus('Session expired — log in on phone again');
  }

  showView('auth');
  configureAuthUIForEnv();
  console.info(`[Spotify R1] env=${runtimeEnv} — Redirect URI:`, SPOTIFY_REDIRECT_URI);
  return 'auth';
}

function bootStatus(msg) {
  if (window.__boot && window.__boot.status) window.__boot.status(msg);
}
function bootError(msg) {
  if (window.__boot && window.__boot.error) window.__boot.error(msg);
}
function bootDone() {
  const bootFallback = document.getElementById('boot-fallback');
  if (bootFallback) bootFallback.remove();
}

function renderDesktopShell() {
  document.documentElement.style.height = '100%';
  document.body.style.cssText =
    'margin:0;height:100vh;background:#15171a;display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;gap:28px;' +
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#888;';
  document.body.innerHTML = '';

  const frame = document.createElement('div');
  frame.style.cssText =
    'width:240px;height:282px;transform:scale(2);transform-origin:center center;' +
    'border-radius:10px;overflow:hidden;background:#000;' +
    'box-shadow:0 0 0 2px #2a2a2a,0 20px 60px rgba(0,0,0,0.6);';

  const iframe = document.createElement('iframe');
  iframe.src = window.location.pathname + '?app=1&desktop=1';
  iframe.style.cssText = 'width:240px;height:282px;border:0;display:block;';
  frame.appendChild(iframe);
  document.body.appendChild(frame);

  const label = document.createElement('div');
  label.style.cssText = 'font-size:13px;text-align:center;max-width:520px;line-height:1.4;';
  label.textContent = 'R1 device preview — 240×282 shown at 2× (desktop only). The R1 displays this exact frame full-screen.';
  document.body.appendChild(label);
}

document.addEventListener('DOMContentLoaded', () => {
  if (window.__SHELL__) {
    renderDesktopShell();
    return;
  }
  try {
    bootStatus('Module running — wiring controls…');
    wireControls();
    bootStatus('Controls ready — starting app…');
    init()
      .then((result) => {
        if (result === 'error') return;
        bootDone();
      })
      .catch((e) => bootError('init() failed: ' + (e && e.message ? e.message : String(e))));
  } catch (e) {
    bootError('startup failed: ' + (e && e.message ? e.message : String(e)));
  }
});

/** R1 WebView: touchend + click (deduped); avoids missed taps on tiny buttons. */
function bindTap(el, handler) {
  if (!el) return;
  let lastFire = 0;
  const run = (e) => {
    const now = Date.now();
    if (now - lastFire < 350) return;
    lastFire = now;
    if (e.cancelable) e.preventDefault();
    gestureActivateAudioSync();
    handler();
  };
  el.addEventListener('click', run);
  el.addEventListener('touchend', run, { passive: false });
}

function wireControls() {
  // Connect button
  document.getElementById('btn-connect').addEventListener('click', startAuth);
  document.getElementById('btn-import-key').addEventListener('click', importLoginKeyFromInput);
  const btnCheckLogin = document.getElementById('btn-check-login');
  if (btnCheckLogin) {
    bindTap(btnCheckLogin, () => checkCompanionLogin());
  }

  bindTap(document.getElementById('btn-play'), () => togglePlay());
  bindTap(document.getElementById('btn-first'), () => firstTrack());
  bindTap(document.getElementById('btn-prev'), () => prevTrack());
  bindTap(document.getElementById('btn-next'), () => nextTrack());
  bindTap(document.getElementById('btn-last'), () => lastTrack());
  bindTap(document.getElementById('btn-library'), () => openPlaylistBrowser());
  bindTap(document.getElementById('btn-play-all'), () => playAllCurrent());

  const playbackStatus = document.getElementById('playback-status');
  playbackStatus.addEventListener('click', openCurrentPlayingList);
  playbackStatus.addEventListener('keydown', (e) => {
    if (e.code === 'Enter' || e.code === 'Space') {
      e.preventDefault();
      openCurrentPlayingList();
    }
  });

  const infoBtn = document.getElementById('btn-info');
  const controls = document.querySelector('.controls');
  let hintTimer = null;
  infoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const showing = controls.classList.toggle('show-hint');
    infoBtn.setAttribute('aria-expanded', showing ? 'true' : 'false');
    clearTimeout(hintTimer);
    if (showing) {
      hintTimer = setTimeout(() => {
        controls.classList.remove('show-hint');
        infoBtn.setAttribute('aria-expanded', 'false');
      }, 4000);
    }
  });

  const albumArt = document.getElementById('album-art');
  albumArt.addEventListener('click', toggleAlbumArtExpand);
  albumArt.addEventListener('keydown', (e) => {
    if (e.code === 'Enter' || e.code === 'Space') {
      e.preventDefault();
      toggleAlbumArtExpand();
    }
  });

  // Navigation
  document.getElementById('btn-back-player').addEventListener('click', () => showView('player'));
  document.getElementById('btn-back-playlists').addEventListener('click', () => showView('playlists'));

  // Keyboard fallback for dev
  if (typeof PluginMessageHandler === 'undefined') {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('sideClick'));
      } else if (e.code === 'KeyL' && state.currentView === 'player') {
        openPlaylistBrowser();
      }
    });
  }

}
