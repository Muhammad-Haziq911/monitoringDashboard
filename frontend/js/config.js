/* Tunables that used to be scattered as literals across the UI code. */

// A node is considered offline this many seconds after its last report.
export const OFFLINE_AFTER = 15;

// Electricity rate used for the running cost estimate.
export const KWH_RATE = 0.29;

// Watts -> dollars/month:  W / 1000 * 24h * 30d * rate
export const MONTHLY_COST_PER_WATT = (24 * 30 / 1000) * KWH_RATE;

// Alert thresholds. Each has a separate recovery point (hysteresis) so a
// metric hovering on the line does not flap between alarm and clear.
export const THRESHOLDS = {
    cpu:     { trip: 85, clear: 75, label: 'CPU load' },
    temp:    { trip: 80, clear: 72, label: 'CPU temperature' },
    gpuUtil: { trip: 85, clear: 75, label: 'GPU load' },
    gpuTemp: { trip: 80, clear: 72, label: 'GPU temperature' },
};

// Points at which a meter shifts from neutral to amber to red.
export const LOAD_WARN = 75;
export const LOAD_CRIT = 90;

export const TEMP_WARN = 65;
export const TEMP_CRIT = 80;

export const LATENCY_WARN = 60;
export const LATENCY_CRIT = 150;

// Sparkline ring-buffer length.
export const HISTORY_POINTS = 40;

// Minimum gap between alarm chimes.
export const CHIME_THROTTLE_MS = 20000;
