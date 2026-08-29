/* Services page: reachability of the self-hosted apps the APU box polls. */

import { ensureAuthenticated } from './auth.js';
import { mountShell } from './shell.js';
import { connectStream } from './stream.js';
import { getJson } from './api.js';
import { esc, slug, latencyTone } from './format.js';

let services = [];

const root = document.getElementById('service-groups');
const empty = document.getElementById('service-empty');

function updateSummary() {
    const online = services.filter((s) => s.online);
    const latencies = online.map((s) => s.latency).filter((v) => v > 0);
    const average = latencies.length
        ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;

    const set = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = value;
    };
    const tone = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.dataset.tone = value;
    };
    const down = services.length - online.length;

    set('stat-total', String(services.length));
    set('stat-total-foot', `${new Set(services.map((s) => s.category || 'General')).size} categories`);

    set('stat-up', `${online.length}<small> / ${services.length}</small>`);
    set('stat-up-foot', down ? `${down} unreachable` : 'All reachable');
    tone('stat-up-card', services.length && !down ? 'ok' : '');

    set('stat-down', String(down));
    set('stat-down-foot', down ? 'Not responding' : 'Nothing down');
    tone('stat-down-card', down ? 'crit' : '');

    set('stat-latency', average ? `${average.toFixed(0)}<small> ms</small>` : '—');
    set('stat-latency-foot', 'Mean response time');
}

/** Group by category, then render each group as its own labelled block. */
function render() {
    empty.hidden = services.length > 0;
    if (!services.length) {
        root.innerHTML = '';
        return;
    }

    const groups = new Map();
    services.forEach((service) => {
        const category = service.category || 'General';
        if (!groups.has(category)) groups.set(category, []);
        groups.get(category).push(service);
    });

    const sorted = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));

    root.innerHTML = sorted.map(([category, items]) => {
        const up = items.filter((s) => s.online).length;
        const cards = items
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((service) => {
                const state = service.online ? 'online' : 'offline';
                const meta = service.online
                    ? `<span data-tone="${latencyTone(service.latency)}">${service.latency.toFixed(0)} ms</span>`
                    : 'No response';
                return `
                    <article class="service" data-state="${state}" id="svc-${slug(service.name)}">
                        <span class="service__icon"><i class="fa-solid ${esc(service.icon || 'fa-globe')}"></i></span>
                        <div class="service__body">
                            <div class="service__name">${esc(service.name)}</div>
                            <div class="service__meta">${meta}</div>
                        </div>
                        <span class="status" data-state="${state}"><i class="status__dot"></i></span>
                    </article>`;
            }).join('');

        return `
            <section class="service-group">
                <div class="service-group__head">
                    <span class="service-group__title">${esc(category)}</span>
                    <span class="service-group__count">${up}/${items.length}</span>
                    <span class="service-group__rule"></span>
                </div>
                <div class="service-grid">${cards}</div>
            </section>`;
    }).join('');
}

function apply(payload) {
    services = payload || [];
    render();
    updateSummary();
}

async function start() {
    if (!await ensureAuthenticated()) return;

    mountShell();

    try {
        apply(await getJson('/api/services'));
    } catch (err) {
        console.error('Initial services request failed:', err);
    }

    connectStream({
        services_init: apply,
        services: apply,
    });
}

start();
