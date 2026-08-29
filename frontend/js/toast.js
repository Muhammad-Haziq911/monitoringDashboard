/* Transient alert notifications, plus the synthesised alarm chime. */

import { esc } from './format.js';
import { CHIME_THROTTLE_MS } from './config.js';

let audioCtx = null;
let lastChime = 0;

/** Build the alarm tone with the Web Audio API, so no audio files ship. */
export function chime() {
    const now = Date.now();
    if (now - lastChime < CHIME_THROTTLE_MS) return;
    lastChime = now;

    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();

        const t = audioCtx.currentTime;
        const carrier = audioCtx.createOscillator();
        const body = audioCtx.createOscillator();
        const gain = audioCtx.createGain();

        carrier.connect(gain);
        body.connect(gain);
        gain.connect(audioCtx.destination);

        carrier.type = 'sine';
        carrier.frequency.setValueAtTime(880, t);
        carrier.frequency.exponentialRampToValueAtTime(587.33, t + 0.15);
        carrier.frequency.exponentialRampToValueAtTime(440, t + 0.4);

        body.type = 'triangle';
        body.frequency.setValueAtTime(440, t);
        body.frequency.setValueAtTime(220, t + 0.15);

        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.1, t + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.65);

        carrier.start(t);
        body.start(t);
        carrier.stop(t + 0.7);
        body.stop(t + 0.7);
    } catch (err) {
        console.warn('Alarm chime blocked until first interaction:', err);
    }
}

/** Browsers suspend audio until the user interacts with the page. */
export function unlockAudioOnInteraction() {
    window.addEventListener('click', () => {
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    }, { passive: true });
}

export function toast(message, { host = '', tone = 'crit' } = {}) {
    const container = document.getElementById('toasts');
    if (!container) return;

    const node = document.createElement('div');
    node.className = 'toast';
    node.dataset.tone = tone;
    node.innerHTML = `
        <i class="fa-solid ${tone === 'ok' ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i>
        <div>
            ${host ? `<span class="toast__host">${esc(host)}</span>` : ''}
            <span>${esc(message)}</span>
        </div>`;

    container.appendChild(node);
    requestAnimationFrame(() => node.classList.add('is-in'));

    setTimeout(() => {
        node.classList.remove('is-in');
        setTimeout(() => node.remove(), 250);
    }, 6000);
}
