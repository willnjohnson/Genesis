/* The screen shown while switching between workspaces: a 5x5 block of cells running Conway's Game of
   Life, drawn like the board behind the Workspaces screen (src/components/workspace/LifeBackground.tsx):
   plain squares in the theme's text color, fading in and out, a newborn glowing in the accent color.
   Loaded as a plain script ahead of the app (index.html), so it can be up the instant the page starts
   loading after a switch reloads the window (see src/lib/transitions.ts, which shows it as the old page
   zooms away and hides it once the new one is ready).

   The board wraps at its edges, like the Workspaces one. When it dies out or starts repeating it is
   seeded again with fresh cells. */
(function () {
    var KEY = 'k-transition';
    var LOOK = 'k-transition-look';
    var LABEL = 'k-transition-label';
    var SIZE = 5;
    var CELL = 12; // css pixels, like the Workspaces board's
    var GAP = 3;
    var STEP_MS = 150;
    var MIN_MS = 500;
    var ALIVE = 0.3; // how strong a fully alive cell is (the Workspaces board is fainter: it's only texture there)
    var overlay = null;
    var timer = null;
    var shownAt = 0;
    var fallback = null;
    var html = document.documentElement;

    function readLook() {
        try { return JSON.parse(sessionStorage.getItem(LOOK) || 'null'); } catch (e) { return null; }
    }

    function build(look, fade, label) {
        var el = document.createElement('div');
        el.id = 'k-life';
        el.setAttribute('aria-hidden', 'true');
        el.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:' + look.bg +
            ';opacity:' + (fade ? '0' : '1') + ';transition:opacity .22s ease-out;pointer-events:all;overflow:hidden;';
        var grid = document.createElement('div');
        grid.style.cssText = 'display:grid;grid-template-columns:repeat(' + SIZE + ',' + CELL + 'px);grid-template-rows:repeat(' + SIZE + ',' + CELL + 'px);gap:' + GAP + 'px;';
        var cells = [];
        for (var i = 0; i < SIZE * SIZE; i++) {
            var c = document.createElement('div');
            c.style.cssText = 'background:' + look.fg + ';opacity:0;';
            grid.appendChild(c);
            cells.push(c);
        }
        el.style.flexDirection = 'column';
        el.style.gap = '22px';
        el.appendChild(grid);
        // Which workspace is loading, under the board: the same size and color as Search's "No search results" (text-xl).
        var text = document.createElement('div');
        text.textContent = label;
        text.style.cssText = 'font:400 20px/28px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:' + look.fg +
            ';max-width:70vw;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        el.appendChild(text);
        return { el: el, cells: cells };
    }

    function seed() {
        var s, n;
        do {
            s = [];
            n = 0;
            for (var i = 0; i < SIZE * SIZE; i++) { var a = Math.random() < 0.34; s.push(a); if (a) n++; }
        } while (n < 6);
        return s;
    }

    function next(s) {
        var out = [];
        for (var y = 0; y < SIZE; y++) {
            for (var x = 0; x < SIZE; x++) {
                var n = 0;
                for (var dy = -1; dy <= 1; dy++) {
                    for (var dx = -1; dx <= 1; dx++) {
                        if (dx === 0 && dy === 0) continue;
                        if (s[((y + dy + SIZE) % SIZE) * SIZE + ((x + dx + SIZE) % SIZE)]) n++;
                    }
                }
                var alive = s[y * SIZE + x];
                out.push(alive ? (n === 2 || n === 3) : n === 3);
            }
        }
        return out;
    }

    // Fade in quickly, out slowly; a newborn starts in the accent color and settles into the text color.
    function paint(cells, prev, s, look) {
        for (var i = 0; i < cells.length; i++) {
            var c = cells[i];
            if (s[i] === prev[i]) continue;
            if (s[i]) {
                c.style.transition = 'none';
                c.style.background = look.accent;
                c.style.opacity = String(ALIVE + 0.3);
                void c.offsetWidth; // start the settling from the accent, not from wherever it was
                c.style.transition = 'background-color .24s ease-out, opacity .09s ease-out';
                c.style.background = look.fg;
                c.style.opacity = String(ALIVE);
            } else {
                c.style.transition = 'opacity .32s ease-out';
                c.style.opacity = '0';
            }
        }
    }

    function run(cells, look) {
        var state = seed();
        var prev = [];
        for (var i = 0; i < SIZE * SIZE; i++) prev.push(false);
        var history = [];
        paint(cells, prev, state, look);
        timer = setInterval(function () {
            var n = next(state);
            var key = n.join();
            var count = n.filter(Boolean).length;
            var stuck = count < 3 || history.indexOf(key) !== -1;
            history.push(key);
            if (history.length > 8) history.shift();
            var after = stuck ? seed() : n;
            if (stuck) history = [];
            paint(cells, state, after, look);
            state = after;
        }, STEP_MS);
    }

    function show(fade, remember, label) {
        if (overlay) return;
        // No scrollbars while the page zooms about and reloads (see .k-switching in index.css).
        html.classList.add('k-switching');
        var style = getComputedStyle(html);
        var look = {
            bg: (style.getPropertyValue('--k-bg') || '').trim(),
            fg: (style.getPropertyValue('--k-text-white') || '').trim(),
            accent: (style.getPropertyValue('--k-accent') || '').trim()
        };
        var saved = readLook();
        if (remember && look.bg && look.fg && look.accent) {
            try { sessionStorage.setItem(LOOK, JSON.stringify(look)); } catch (e) { /* storage blocked */ }
        }
        look.bg = look.bg || (saved && saved.bg) || '#0f0f0f';
        look.fg = look.fg || (saved && saved.fg) || '#ffffff';
        look.accent = look.accent || (saved && saved.accent) || '#dc2626';
        if (!label) {
            try { label = sessionStorage.getItem(LABEL); } catch (e) { /* storage blocked */ }
        }
        var built = build(look, fade, label || 'Loading workspace');
        overlay = built.el;
        html.appendChild(overlay);
        shownAt = Date.now();
        run(built.cells, look);
        if (fade) {
            // Two frames, so the browser has the starting opacity before it's asked to change.
            requestAnimationFrame(function () { requestAnimationFrame(function () { if (overlay) overlay.style.opacity = '1'; }); });
        }
        // Never leave the screen up for good if the app fails to say it's ready.
        fallback = setTimeout(hide, 10000);
    }

    function hide() {
        if (!overlay) return;
        var el = overlay;
        var wait = Math.max(0, MIN_MS - (Date.now() - shownAt));
        setTimeout(function () {
            el.style.opacity = '0';
            setTimeout(function () {
                clearInterval(timer);
                clearTimeout(fallback);
                if (el.parentNode) el.parentNode.removeChild(el);
                if (overlay === el) overlay = null;
                // The new page's zoom-in (about 0.4s) is under way; keep scrollbars away until it's done.
                setTimeout(function () { html.classList.remove('k-switching'); }, 450);
            }, 260);
        }, wait);
    }

    window.kLife = { show: show, hide: hide };

    // Arriving from a workspace switch: up straight away, before the app's own scripts have loaded.
    try {
        if (sessionStorage.getItem(KEY) === 'enter') show(false, false);
    } catch (e) { /* storage blocked: no interstitial */ }
})();
