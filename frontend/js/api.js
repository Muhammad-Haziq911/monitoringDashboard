/* Thin transport layer: token storage plus a fetch that carries the session. */

const TOKEN_KEY = 'auth_token';
const AGENT_KEY = 'agent_auth_key';

export const token = {
    get:   () => localStorage.getItem(TOKEN_KEY),
    set:   (value) => localStorage.setItem(TOKEN_KEY, value),
    clear: () => {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(AGENT_KEY);
    },
};

export const agentKey = {
    get: () => localStorage.getItem(AGENT_KEY),
    set: (value) => localStorage.setItem(AGENT_KEY, value),
};

/** Raised when the server rejects the session, so callers can bail out. */
export class Unauthorized extends Error {}

const base = window.location.origin;

/** Fetch with the bearer token attached; throws Unauthorized on a 401. */
export async function api(path, options = {}) {
    const current = token.get();
    const headers = { ...(options.headers || {}) };
    if (current) headers.Authorization = `Bearer ${current}`;

    const response = await fetch(`${base}${path}`, { ...options, headers });
    if (response.status === 401) throw new Unauthorized('Session rejected');
    return response;
}

/** Unauthenticated POST used by login and first-run registration. */
export async function postJson(path, body) {
    return fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

export async function getJson(path) {
    const response = await api(path);
    if (!response.ok) throw new Error(`${path} responded ${response.status}`);
    return response.json();
}

export const streamUrl = () => `${base}/api/stream?token=${encodeURIComponent(token.get() || '')}`;
