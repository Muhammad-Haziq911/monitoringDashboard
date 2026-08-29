/* Server-Sent Events client with backoff, shared by the devices and services pages. */

import { streamUrl } from './api.js';
import { setLinkState } from './shell.js';

const RECONNECT_MIN = 2000;
const RECONNECT_MAX = 30000;

/**
 * Open the metrics stream.
 * @param {Object<string, function>} handlers  event name -> parsed-payload callback
 */
export function connectStream(handlers) {
    let source = null;
    let backoff = RECONNECT_MIN;
    let retryTimer = null;

    function open() {
        setLinkState('idle');
        source = new EventSource(streamUrl());

        source.onopen = () => {
            backoff = RECONNECT_MIN;
            setLinkState('live');
        };

        for (const [name, handler] of Object.entries(handlers)) {
            source.addEventListener(name, (event) => {
                try {
                    handler(JSON.parse(event.data));
                } catch (err) {
                    console.error(`Malformed "${name}" event:`, err);
                }
            });
        }

        source.onerror = () => {
            setLinkState('down');
            source.close();
            clearTimeout(retryTimer);
            retryTimer = setTimeout(open, backoff);
            // Ease off a server that is down rather than hammering it every 3s.
            backoff = Math.min(backoff * 2, RECONNECT_MAX);
        };
    }

    open();
    return { close: () => { clearTimeout(retryTimer); source?.close(); } };
}
