/* Canvas charts. All colours are read from the CSS tokens so the palette
   still lives in exactly one place. */

const cache = new Map();

/** Resolve a CSS custom property once and remember it. */
function cssVar(name) {
    if (!cache.has(name)) {
        cache.set(name, getComputedStyle(document.documentElement).getPropertyValue(name).trim());
    }
    return cache.get(name);
}

/** Size the backing store for the display density and return the CSS box. */
function prepare(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return null;

    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
    }

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return { ctx, width, height };
}

function withAlpha(color, alpha) {
    // Tokens are hex; convert so the area fill can fade out.
    const hex = color.replace('#', '');
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Small inline trend line over the caller's ring buffer of percentages.
 * The series always spans the full width: while the buffer is still filling
 * a fixed window would draw a stub pinned to the right edge, which reads as
 * a broken chart rather than a young one.
 */
export function drawSparkline(canvas, history, colorToken) {
    const box = prepare(canvas);
    if (!box || !history || history.length < 2) return;

    const { ctx, width, height } = box;
    const color = cssVar(colorToken);
    const step = width / (history.length - 1);
    const y = (value) => height - 1.5 - (Math.max(0, Math.min(100, value)) / 100) * (height - 3);

    ctx.beginPath();
    history.forEach((value, i) => {
        if (i === 0) ctx.moveTo(i * step, y(value));
        else ctx.lineTo(i * step, y(value));
    });

    // Fill under the curve first, then stroke on top of it.
    ctx.save();
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, withAlpha(color, 0.22));
    gradient.addColorStop(1, withAlpha(color, 0));
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    history.forEach((value, i) => {
        if (i === 0) ctx.moveTo(i * step, y(value));
        else ctx.lineTo(i * step, y(value));
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
}

function timeLabel(unixSeconds, range) {
    const d = new Date(unixSeconds * 1000);
    if (range === '6h' || range === '24h') {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    if (range === '7d') {
        return d.toLocaleDateString([], { weekday: 'short' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function fullLabel(unixSeconds, range) {
    const d = new Date(unixSeconds * 1000);
    if (range === '6h' || range === '24h') {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${
        d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

const PAD = { top: 14, right: 10, bottom: 22, left: 38 };

/**
 * Lab power over time, with a hover crosshair and readout.
 * Returns a controller so the page can push new data and force redraws.
 */
export function createTrendChart(canvas, tip) {
    let points = [];
    let range = '6h';
    let hoverIndex = -1;
    let peak = 50;

    function geometry() {
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        return {
            width,
            height,
            plotW: width - PAD.left - PAD.right,
            plotH: height - PAD.top - PAD.bottom,
        };
    }

    function draw() {
        const box = prepare(canvas);
        if (!box) return;
        const { ctx, width, height } = box;
        const g = geometry();

        if (points.length < 2) {
            ctx.fillStyle = cssVar('--fg-faint');
            ctx.font = `500 12px ${cssVar('--font-ui') || 'Inter, sans-serif'}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('Accumulating telemetry…', width / 2, height / 2);
            return;
        }

        peak = Math.max(50, ...points.map((p) => p.power)) * 1.12;
        const xAt = (i) => PAD.left + (i / (points.length - 1)) * g.plotW;
        const yAt = (w) => PAD.top + g.plotH - (w / peak) * g.plotH;

        // Horizontal grid with watt labels on the left gutter.
        ctx.strokeStyle = cssVar('--border');
        ctx.fillStyle = cssVar('--fg-faint');
        ctx.font = '500 10px Inter, sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 1;

        for (let i = 0; i <= 3; i++) {
            const value = (peak / 3) * i;
            const y = Math.round(yAt(value)) + 0.5;
            ctx.beginPath();
            ctx.moveTo(PAD.left, y);
            ctx.lineTo(width - PAD.right, y);
            ctx.stroke();
            ctx.fillText(`${Math.round(value)}W`, PAD.left - 8, y);
        }

        const color = cssVar('--m-power');

        // Area fill.
        ctx.beginPath();
        ctx.moveTo(xAt(0), yAt(points[0].power));
        points.forEach((p, i) => ctx.lineTo(xAt(i), yAt(p.power)));
        ctx.lineTo(xAt(points.length - 1), PAD.top + g.plotH);
        ctx.lineTo(xAt(0), PAD.top + g.plotH);
        ctx.closePath();
        const gradient = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + g.plotH);
        gradient.addColorStop(0, withAlpha(color, 0.2));
        gradient.addColorStop(1, withAlpha(color, 0));
        ctx.fillStyle = gradient;
        ctx.fill();

        // Trend line.
        ctx.beginPath();
        points.forEach((p, i) => {
            const x = xAt(i);
            const y = yAt(p.power);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.75;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();

        // Time axis: four evenly spaced labels.
        ctx.fillStyle = cssVar('--fg-faint');
        ctx.font = '500 10px Inter, sans-serif';
        ctx.textBaseline = 'top';
        const ticks = [0, 0.33, 0.66, 1].map((f) => Math.round(f * (points.length - 1)));
        ticks.forEach((i, n) => {
            ctx.textAlign = n === 0 ? 'left' : n === ticks.length - 1 ? 'right' : 'center';
            ctx.fillText(timeLabel(points[i].time, range), xAt(i), height - PAD.bottom + 8);
        });

        // Hover crosshair.
        if (hoverIndex >= 0 && hoverIndex < points.length) {
            const x = xAt(hoverIndex);
            const y = yAt(points[hoverIndex].power);
            ctx.strokeStyle = cssVar('--border-strong');
            ctx.beginPath();
            ctx.moveTo(Math.round(x) + 0.5, PAD.top);
            ctx.lineTo(Math.round(x) + 0.5, PAD.top + g.plotH);
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(x, y, 3.5, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
            ctx.strokeStyle = cssVar('--surface-1');
            ctx.lineWidth = 2;
            ctx.stroke();
        }
    }

    function onMove(event) {
        if (points.length < 2) return;
        const rect = canvas.getBoundingClientRect();
        const g = geometry();
        const ratio = (event.clientX - rect.left - PAD.left) / g.plotW;
        const index = Math.round(Math.max(0, Math.min(1, ratio)) * (points.length - 1));

        if (index !== hoverIndex) {
            hoverIndex = index;
            draw();
        }

        const p = points[index];
        tip.innerHTML = `<b>${p.power.toFixed(0)} W</b><br><span>${fullLabel(p.time, range)}</span>`;
        tip.style.left = `${PAD.left + (index / (points.length - 1)) * g.plotW}px`;
        tip.style.top = `${PAD.top + g.plotH - (p.power / peak) * g.plotH - 10}px`;
        tip.classList.add('is-visible');
    }

    function onLeave() {
        hoverIndex = -1;
        tip.classList.remove('is-visible');
        draw();
    }

    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);
    window.addEventListener('resize', draw);

    return {
        setData(nextPoints, nextRange) {
            points = nextPoints || [];
            if (nextRange) range = nextRange;
            draw();
        },
        get points() { return points; },
        redraw: draw,
    };
}
