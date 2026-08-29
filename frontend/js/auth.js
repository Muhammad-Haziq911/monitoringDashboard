/* Auth overlay: first-run registration, sign in, sign out. Shared by both pages. */

import { api, postJson, token, agentKey, Unauthorized } from './api.js';

let isFirstRun = false;

const el = (id) => document.getElementById(id);

function showOverlay(firstRun) {
    isFirstRun = firstRun;
    const overlay = el('auth');
    el('auth-title').textContent = firstRun ? 'Create admin account' : 'Sign in';
    el('auth-sub').textContent = firstRun
        ? 'No account exists yet. Choose the credentials that will secure this dashboard.'
        : 'Enter your credentials to reach the lab monitor.';
    el('auth-submit').innerHTML = firstRun
        ? '<span>Create account</span><i class="fa-solid fa-arrow-right"></i>'
        : '<span>Sign in</span><i class="fa-solid fa-arrow-right"></i>';
    overlay.classList.add('is-open');
    el('auth-form').addEventListener('submit', onSubmit);
    el('auth-username').focus();
}

async function onSubmit(event) {
    event.preventDefault();
    const errorEl = el('auth-error');
    const submitEl = el('auth-submit');
    errorEl.textContent = '';
    submitEl.disabled = true;

    try {
        const response = await postJson(
            isFirstRun ? '/api/auth/register' : '/api/auth/login',
            { username: el('auth-username').value, password: el('auth-password').value },
        );

        if (!response.ok) {
            const detail = await response.json().catch(() => ({}));
            errorEl.textContent = detail.detail || 'Authentication failed.';
            return;
        }

        const data = await response.json();
        token.set(data.token);
        if (data.agent_auth_key) agentKey.set(data.agent_auth_key);

        // Reload rather than hand-wiring the post-login state: one code path
        // to reason about, and the page is static anyway.
        window.location.reload();
    } catch (err) {
        console.error('Authentication request failed:', err);
        errorEl.textContent = 'Cannot reach the server.';
    } finally {
        submitEl.disabled = false;
    }
}

/**
 * Resolve the session before anything else renders.
 * Returns true when the dashboard may load, false when the overlay took over.
 */
export async function ensureAuthenticated() {
    if (token.get()) {
        // Confirm the stored token is still valid, otherwise the dashboard
        // flashes into view and then bounces back to the login screen.
        try {
            const response = await api('/api/auth/agent-key');
            if (response.ok) {
                const data = await response.json();
                if (data.agent_auth_key) agentKey.set(data.agent_auth_key);
                return true;
            }
        } catch (err) {
            if (!(err instanceof Unauthorized)) {
                // Server unreachable rather than session expired: let the page
                // load so the connection indicator can report the outage.
                console.warn('Could not verify session:', err);
                return true;
            }
        }
        token.clear();
    }

    let usersExist = true;
    try {
        const response = await fetch(`${window.location.origin}/api/auth/status`);
        if (response.ok) usersExist = (await response.json()).users_exist;
    } catch (err) {
        console.error('Auth status check failed:', err);
    }

    showOverlay(!usersExist);
    return false;
}

export async function logout() {
    const current = token.get();
    if (current) {
        try {
            await postJson('/api/auth/logout', { token: current });
        } catch (err) {
            console.error('Logout request failed:', err);
        }
    }
    token.clear();
    window.location.reload();
}
