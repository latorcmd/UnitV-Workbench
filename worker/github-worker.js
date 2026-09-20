const GITHUB_API = 'https://api.github.com';
const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API_VERSION = '2026-03-10';
const SESSION_COOKIE = 'unitv_github_session';
const FLOW_COOKIE = 'unitv_github_flow';
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_CLIENT_ID = 'Iv23liZ2I16zO6vmGEnu';
const DEFAULT_APP_SLUG = 'unitv-browser-lab';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function json(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

function apiError(message, status = 400, details) {
  return json({ error: message, ...(details ? { details } : {}) }, { status });
}

function githubClientId(env) {
  return env.GITHUB_CLIENT_ID || DEFAULT_CLIENT_ID;
}

function githubAppSlug(env) {
  return env.GITHUB_APP_SLUG || DEFAULT_APP_SLUG;
}

function isSameOrigin(request) {
  const origin = request.headers.get('Origin');
  return origin === new URL(request.url).origin;
}

function cookieValue(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  for (const item of cookie.split(';')) {
    const [key, ...value] = item.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function sessionKey(env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET is not configured.');
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(env.SESSION_SECRET));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function seal(value, env, purpose) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await sessionKey(env);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(`unitv-browser-lab:${purpose}:v1`) },
    key,
    encoder.encode(JSON.stringify(value))
  );
  return `${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

async function unseal(value, env, purpose) {
  if (!value) return null;
  try {
    const [ivPart, ciphertextPart, extra] = value.split('.');
    if (!ivPart || !ciphertextPart || extra) return null;
    const key = await sessionKey(env);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64UrlDecode(ivPart), additionalData: encoder.encode(`unitv-browser-lab:${purpose}:v1`) },
      key,
      base64UrlDecode(ciphertextPart)
    );
    return JSON.parse(decoder.decode(plaintext));
  } catch {
    return null;
  }
}

function cookie(name, value, maxAge) {
  return `${name}=${value}; Path=/api/github; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAge))}`;
}

function clearCookie(name) {
  return cookie(name, '', 0);
}

async function githubFetch(path, token, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/vnd.github+json');
  headers.set('X-GitHub-Api-Version', GITHUB_API_VERSION);
  headers.set('User-Agent', 'UnitV-Browser-Lab');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(`${GITHUB_API}${path}`, { ...init, headers });
}

async function githubJson(path, token, init = {}) {
  const response = await githubFetch(path, token, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || `GitHub API returned HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function readSession(request, env) {
  const session = await unseal(cookieValue(request, SESSION_COOKIE), env, 'session');
  if (!session?.accessToken || !session.expiresAt || session.expiresAt <= Date.now()) return null;
  return session;
}

async function startDeviceFlow(request, env) {
  if (!isSameOrigin(request)) return apiError('Invalid request origin.', 403);
  const response = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'UnitV-Browser-Lab' },
    body: new URLSearchParams({ client_id: githubClientId(env) })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) return apiError(data.error_description || 'GitHubログインを開始できませんでした。', 502);

  const now = Date.now();
  const interval = Math.max(5, Number(data.interval) || 5);
  const expiresIn = Math.min(900, Number(data.expires_in) || 900);
  const flow = await seal({
    deviceCode: data.device_code,
    expiresAt: now + expiresIn * 1000,
    interval,
    nextPollAt: now + interval * 1000
  }, env, 'flow');

  return json({
    userCode: data.user_code,
    verificationUri: data.verification_uri || 'https://github.com/login/device',
    expiresIn,
    interval
  }, { headers: { 'Set-Cookie': cookie(FLOW_COOKIE, flow, expiresIn) } });
}

async function pollDeviceFlow(request, env) {
  if (!isSameOrigin(request)) return apiError('Invalid request origin.', 403);
  const flow = await unseal(cookieValue(request, FLOW_COOKIE), env, 'flow');
  if (!flow?.deviceCode || flow.expiresAt <= Date.now()) {
    return apiError('確認コードの有効期限が切れました。もう一度ログインしてください。', 410, 'expired_token');
  }
  if (flow.nextPollAt > Date.now()) {
    return json({ status: 'pending', retryAfter: Math.ceil((flow.nextPollAt - Date.now()) / 1000) }, { status: 202 });
  }

  const response = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'UnitV-Browser-Lab' },
    body: new URLSearchParams({
      client_id: githubClientId(env),
      device_code: flow.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return apiError('GitHubの認証状態を確認できませんでした。', 502);

  if (data.error) {
    if (data.error === 'authorization_pending' || data.error === 'slow_down') {
      const interval = flow.interval + (data.error === 'slow_down' ? 5 : 0);
      const nextFlow = await seal({ ...flow, interval, nextPollAt: Date.now() + interval * 1000 }, env, 'flow');
      return json({ status: 'pending', retryAfter: interval }, {
        status: 202,
        headers: { 'Set-Cookie': cookie(FLOW_COOKIE, nextFlow, Math.ceil((flow.expiresAt - Date.now()) / 1000)) }
      });
    }
    const messages = {
      access_denied: 'GitHubでの許可がキャンセルされました。',
      expired_token: '確認コードの有効期限が切れました。もう一度ログインしてください。',
      incorrect_device_code: '確認コードが無効です。もう一度ログインしてください。',
      device_flow_disabled: 'GitHub AppのDevice Flowが有効になっていません。'
    };
    return apiError(messages[data.error] || data.error_description || 'GitHubログインに失敗しました。', 400, data.error);
  }

  if (!data.access_token) return apiError('GitHubからアクセストークンを取得できませんでした。', 502);
  const expiresIn = Math.min(28800, Number(data.expires_in) || 28800);
  const session = await seal({ accessToken: data.access_token, expiresAt: Date.now() + expiresIn * 1000 }, env, 'session');
  return json({ status: 'authenticated' }, {
    headers: [
      ['Set-Cookie', cookie(SESSION_COOKIE, session, expiresIn)],
      ['Set-Cookie', clearCookie(FLOW_COOKIE)]
    ]
  });
}

async function listRepositories(token, env) {
  const installationsData = await githubJson('/user/installations?per_page=100', token);
  const installations = (installationsData.installations || []).filter(item => item.app_slug === githubAppSlug(env));
  const repositoryPages = await Promise.all(installations.map(installation =>
    githubJson(`/user/installations/${installation.id}/repositories?per_page=100`, token)
  ));
  const repositories = repositoryPages.flatMap((page, index) => (page.repositories || []).map(repository => ({
    id: repository.id,
    installationId: installations[index].id,
    fullName: repository.full_name,
    owner: repository.owner.login,
    name: repository.name,
    defaultBranch: repository.default_branch,
    private: repository.private,
    htmlUrl: repository.html_url
  })));
  repositories.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return {
    repositories,
    installations: installations.map(installation => ({
      id: installation.id,
      account: installation.account?.login || '',
      repositorySelection: installation.repository_selection,
      manageUrl: installation.html_url || null
    }))
  };
}

async function getSession(request, env) {
  const session = await readSession(request, env);
  if (!session) return apiError('GitHubにログインしていません。', 401);
  try {
    const [user, access] = await Promise.all([
      githubJson('/user', session.accessToken),
      listRepositories(session.accessToken, env)
    ]);
    return json({
      authenticated: true,
      user: { login: user.login, name: user.name, avatarUrl: user.avatar_url, htmlUrl: user.html_url },
      ...access,
      installUrl: `https://github.com/apps/${githubAppSlug(env)}/installations/new`,
      expiresAt: session.expiresAt
    });
  } catch (error) {
    if (error.status === 401) return apiError('GitHubのログイン期限が切れました。もう一度ログインしてください。', 401);
    return apiError(error.message || 'GitHubの情報を取得できませんでした。', error.status || 502);
  }
}

function isAllowedGithubRequest(method, target) {
  let url;
  try {
    url = new URL(target, GITHUB_API);
  } catch {
    return false;
  }
  if (url.origin !== GITHUB_API) return false;
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 5 || segments[0] !== 'repos') return false;
  const resource = segments.slice(3).join('/');
  if (!/^[A-Za-z0-9_.-]+$/.test(segments[1]) || !/^[A-Za-z0-9_.-]+$/.test(segments[2])) return false;

  if (method === 'GET') {
    if (resource === 'commits') return [...url.searchParams.keys()].every(key => ['sha', 'path', 'per_page'].includes(key));
    if (resource.startsWith('contents/')) return [...url.searchParams.keys()].every(key => key === 'ref');
    if (resource.startsWith('git/ref/heads/')) return !url.search;
    if (/^git\/commits\/[0-9a-f]{40}$/i.test(resource)) return !url.search;
    return false;
  }
  if (method === 'POST') return ['git/blobs', 'git/trees', 'git/commits'].includes(resource) && !url.search;
  if (method === 'PATCH') return resource.startsWith('git/refs/heads/') && !url.search;
  return false;
}

async function readBodyLimited(request) {
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel();
      throw new Error('送信データが大きすぎます。');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

async function proxyGithubRequest(request, env) {
  if (request.method !== 'GET' && !isSameOrigin(request)) return apiError('Invalid request origin.', 403);
  const session = await readSession(request, env);
  if (!session) return apiError('GitHubにログインしてください。', 401);
  const requestUrl = new URL(request.url);
  const path = requestUrl.searchParams.get('path') || '';
  if (!isAllowedGithubRequest(request.method, path)) return apiError('許可されていないGitHub API操作です。', 403);

  let body;
  try {
    body = ['POST', 'PATCH'].includes(request.method) ? await readBodyLimited(request) : undefined;
  } catch (error) {
    return apiError(error.message, 413);
  }
  const response = await githubFetch(path, session.accessToken, {
    method: request.method,
    body,
    headers: body ? { 'Content-Type': 'application/json' } : undefined
  });
  const headers = new Headers();
  headers.set('Content-Type', response.headers.get('Content-Type') || 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, headers });
}

async function logout(request) {
  if (!isSameOrigin(request)) return apiError('Invalid request origin.', 403);
  return json({ authenticated: false }, {
    headers: [
      ['Set-Cookie', clearCookie(SESSION_COOKIE)],
      ['Set-Cookie', clearCookie(FLOW_COOKIE)]
    ]
  });
}

async function handleApi(request, env) {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/api/github/device/start' && request.method === 'POST') return startDeviceFlow(request, env);
  if (pathname === '/api/github/device/poll' && request.method === 'POST') return pollDeviceFlow(request, env);
  if (pathname === '/api/github/session' && request.method === 'GET') return getSession(request, env);
  if (pathname === '/api/github/request' && ['GET', 'POST', 'PATCH'].includes(request.method)) return proxyGithubRequest(request, env);
  if (pathname === '/api/github/logout' && request.method === 'POST') return logout(request);
  return apiError('API not found.', 404);
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/github/')) return await handleApi(request, env);
      if (env.ASSETS?.fetch) return env.ASSETS.fetch(request);
      return new Response('Not found', { status: 404 });
    } catch (error) {
      console.error(JSON.stringify({ event: 'github_worker_error', message: error instanceof Error ? error.message : String(error) }));
      return apiError('サーバー処理でエラーが発生しました。', 500);
    }
  }
};

export { isAllowedGithubRequest, seal, unseal };
