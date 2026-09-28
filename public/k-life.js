/* The screen shown while switching between workspaces, and — branded, see show()'s `launch` param
   and the bottom of this file — the one shown for an ordinary cold launch too: a 5x5 block of cells
   running Conway's Game of Life, drawn like the board behind the Workspaces screen
   (src/components/workspace/LifeBackground.tsx): plain squares in the theme's text color, fading in
   and out, a newborn glowing in the accent color. Loaded as a plain script ahead of the app
   (index.html), so it can be up the instant the page starts loading — either after a workspace
   switch reloads the window (see src/lib/transitions.ts, which shows it as the old page zooms away
   and hides it once the new one is ready) or, for a cold launch, before Tauri's window has even
   finished setting up (see src/App.tsx, which hides it once its own startup resolves). A cold
   launch has no real "theme" loaded yet to draw from, so that case always uses the classic Erebos
   colors, not whatever the page's CSS custom properties currently say.

   The window has no native title bar (the app draws its own, src/components/TitleBar.tsx), and either the
   page it lives in is gone during a reload, or (a cold launch) hasn't loaded far enough to have drawn one
   yet. So this screen also puts up a plain title bar of its own, above it: a place to drag the window and
   the window buttons, in the theme's colors, the same height as the app's. It comes down once the real
   one is underneath it.

   The board wraps at its edges, like the Workspaces one. When it dies out or starts repeating it is
   seeded again with fresh cells. */
(function () {
    var KEY = 'k-transition';
    var LOOK = 'k-transition-look';
    var LABEL = 'k-transition-label';
    var BAR = 'k-transition-bar';
    var SIZE = 5;
    var CELL = 12; // css pixels, like the Workspaces board's
    var GAP = 3;
    var STEP_MS = 150;
    var MIN_MS = 500;
    var ALIVE = 0.3; // how strong a fully alive cell is (the Workspaces board is fainter: it's only texture there)
    var BAR_HEIGHT = '1.75rem'; // --k-titlebar-height in index.css
    // The Kinesis "K", traced from src/assets/kinesis.png — the same path
    // src/assets/logo-marks.ts/components/BrandLogo.tsx draw from, copied here since this script
    // runs before any of that has loaded (see the cold-launch case in show() below).
    var MARK_PATH = "M308 799.4C306.1 799.2 299.6 798.5 293.6 798C146.9 783.8 24.2 666 3.6 519.5C0.1 495.1 0 486.5 0 248.5C0 19.9 0.1 10.3 1.8 7.1C5.6 0.1 6 -0 48.5 0C86.4 0 98.6 0.6 119.5 3.6C222.6 18.1 316.2 85.2 363.8 178.7C383 216.4 393.8 253.1 398.4 295.5C399.6 307.1 399.8 293 399.9 159.5C400 -7.3 399.4 5.9 407.1 1.8C411.9 -0.8 787 -1.1 792.3 1.5C799.7 5.1 799.5 3.4 799.5 52C799.5 104.9 797.9 120.8 789.5 153.4C755.1 286.9 642.7 383.5 504.5 398.4C492.9 399.6 507 399.8 640.5 399.9C807.3 400 794.1 399.4 798.2 407.1C801.2 412.6 801 787.9 798 792.8C793.6 800 793.8 800 752.5 800C684.9 800 649.6 794.2 603.9 775.5C554.4 755.3 505.1 718.5 472.5 677.5C431.5 626.1 403.9 556.3 400.8 496.2C400.6 493.6 400.3 559.1 400 641.7L399.5 792L395.7 795.7L392 799.5L351.7 799.6C329.6 799.7 309.9 799.6 308 799.4Z";
    var overlay = null;
    var bar = null;
    var timer = null;
    var shownAt = 0;
    var fallback = null;
    var html = document.documentElement;

    function readLook() {
        try { return JSON.parse(sessionStorage.getItem(LOOK) || 'null'); } catch (e) { return null; }
    }

    // `brand` (only true for the cold-launch case in show() below) prepends the Kinesis logo and
    // wordmark above the board — there's no real page underneath yet for a cold launch to imply
    // "returning to where you were" the way the plain board does for a workspace switch, so this
    // spells out what's actually loading instead.
    function build(look, fade, label, brand) {
        var el = document.createElement('div');
        el.id = 'k-life';
        el.setAttribute('aria-hidden', 'true');
        el.style.cssText = 'position:fixed;top:' + BAR_HEIGHT + ';left:0;right:0;bottom:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:' + look.bg +
            ';opacity:' + (fade ? '0' : '1') + ';transition:opacity .22s ease-out;pointer-events:all;overflow:hidden;-webkit-user-select:none;user-select:none;';
        el.style.flexDirection = 'column';
        el.style.gap = '22px';
        if (brand) {
            var NS = 'http://www.w3.org/2000/svg';
            var row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:14px;';
            var svg = document.createElementNS(NS, 'svg');
            svg.setAttribute('viewBox', '0 0 800 800');
            svg.setAttribute('width', '40');
            svg.setAttribute('height', '40');
            var path = document.createElementNS(NS, 'path');
            path.setAttribute('fill', look.accent);
            path.setAttribute('fill-rule', 'evenodd');
            path.setAttribute('d', MARK_PATH);
            svg.appendChild(path);
            row.appendChild(svg);
            var word = document.createElement('div');
            word.style.cssText = 'font:700 24px/1 "Roboto","Inter",system-ui,-apple-system,sans-serif;letter-spacing:.01em;white-space:nowrap;';
            var prefix = document.createElement('span');
            prefix.textContent = 'Kin';
            prefix.style.color = look.accent;
            var suffix = document.createElement('span');
            suffix.textContent = 'esis';
            suffix.style.color = look.fg;
            word.appendChild(prefix);
            word.appendChild(suffix);
            row.appendChild(word);
            el.appendChild(row);
        }
        var grid = document.createElement('div');
        grid.style.cssText = 'display:grid;grid-template-columns:repeat(' + SIZE + ',' + CELL + 'px);grid-template-rows:repeat(' + SIZE + ',' + CELL + 'px);gap:' + GAP + 'px;';
        var cells = [];
        for (var i = 0; i < SIZE * SIZE; i++) {
            var c = document.createElement('div');
            c.style.cssText = 'background:' + look.fg + ';opacity:0;';
            grid.appendChild(c);
            cells.push(c);
        }
        el.appendChild(grid);
        // Which workspace is loading, under the board (or, for a cold launch, a plain "Initializing..."):
        // the same size and color as Search's "No search results" (text-xl) normally, a step smaller and
        // dimmer alongside the brand row above, so it reads as a caption rather than competing with it.
        var text = document.createElement('div');
        text.textContent = label;
        text.style.cssText = 'font:400 ' + (brand ? '13px/20px' : '20px/28px') + ' system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:' + look.fg +
            (brand ? ';opacity:.55' : '') + ';max-width:70vw;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        el.appendChild(text);
        return { el: el, cells: cells };
    }

    // The window buttons go straight to the window API, the way its JavaScript package does (this runs before the app).
    function windowCommand(name) {
        return function () {
            try {
                var t = window.__TAURI_INTERNALS__;
                t.invoke('plugin:window|' + name, { label: t.metadata.currentWindow.label });
            } catch (e) { /* not in the app window */ }
        };
    }

    // The app's own title bar as it was when the switch began (src/lib/transitions.ts saved it, styles written in), so
    // the bar looks untouched through the switch. Its window buttons still work; the rest is only a picture until the
    // new page's bar takes over. The workspace's name and switch button are hidden in it.
    function buildSnapshotBar(snapshot, label, arriving) {
        var el = document.createElement('div');
        el.id = 'k-life-bar';
        el.style.cssText = 'position:fixed;top:0;left:0;right:0;height:' + BAR_HEIGHT + ';z-index:2147483001;';
        el.innerHTML = snapshot;
        var buttons = el.querySelectorAll('[data-k-cmd]');
        for (var i = 0; i < buttons.length; i++) {
            buttons[i].addEventListener('click', windowCommand(buttons[i].getAttribute('data-k-cmd')));
        }
        // The workspace's name and its switch button are hidden during the switch (they stay in place, so nothing shifts);
        // the new page's bar shows them again.
        var hidden = el.querySelectorAll('[data-workspace-name], [data-workspace-switch]');
        // Every copied element states its own visibility, so hiding the wrapper alone leaves what is inside showing.
        for (var j = 0; j < hidden.length; j++) {
            hidden[j].style.visibility = 'hidden';
            var inner = hidden[j].querySelectorAll('*');
            for (var m = 0; m < inner.length; m++) inner[m].style.visibility = 'hidden';
        }
        return el;
    }

    function buildBar(look, label, arriving) {
        var snapshot = null;
        try { snapshot = sessionStorage.getItem(BAR); } catch (e) { /* storage blocked */ }
        if (snapshot) return buildSnapshotBar(snapshot, label, arriving);
        var el = document.createElement('div');
        el.id = 'k-life-bar';
        el.setAttribute('data-tauri-drag-region', '');
        el.style.cssText = 'position:fixed;top:0;left:0;right:0;height:' + BAR_HEIGHT + ';z-index:2147483001;display:flex;justify-content:flex-end;' +
            'align-items:stretch;background:' + look.bg + ';border-bottom:1px solid rgba(128,128,128,.25);user-select:none;';
        var NS = 'http://www.w3.org/2000/svg';
        var icons = {
            minimize: 'M5 12h14',
            toggle_maximize: 'M6 6h12v12H6z',
            close: 'M6 6l12 12M18 6L6 18'
        };
        ['minimize', 'toggle_maximize', 'close'].forEach(function (name) {
            var b = document.createElement('button');
            b.type = 'button';
            b.style.cssText = 'width:40px;border:0;padding:0;background:transparent;cursor:pointer;color:' + look.fg + ';opacity:.6;display:flex;align-items:center;justify-content:center;';
            var svg = document.createElementNS(NS, 'svg');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('width', '14');
            svg.setAttribute('height', '14');
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', 'currentColor');
            svg.setAttribute('stroke-width', '2');
            var path = document.createElementNS(NS, 'path');
            path.setAttribute('d', icons[name]);
            svg.appendChild(path);
            b.appendChild(svg);
            b.addEventListener('click', windowCommand(name));
            b.addEventListener('mouseenter', function () {
                b.style.opacity = '1';
                b.style.background = name === 'close' ? look.accent : 'rgba(128,128,128,.2)';
            });
            b.addEventListener('mouseleave', function () { b.style.opacity = '.6'; b.style.background = 'transparent'; });
            el.appendChild(b);
        });
        return el;
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

    // `launch` is the cold-launch case (see the bottom of this file): the classic Erebos colors
    // always, hardcoded, rather than read off the page's CSS custom properties — there's no theme
    // applied yet at all this early (nothing's loaded to apply one), and even once the real app
    // loads behind this screen, the user's actual theme might not be Erebos, so reading it live
    // would be reading a value that's about to change anyway. Brand row on, default label
    // "Initializing...". Same overlay/bar/timer state as a workspace switch, safely: the two
    // cases are mutually exclusive per page load (see the bottom of this file), never both up.
    function show(fade, remember, label, launch) {
        if (overlay) return;
        // No scrollbars while the page zooms about and reloads (see .k-switching in index.css).
        html.classList.add('k-switching');
        // The page's own title bar stays hidden while the screen's copy of it is up (see index.css).
        html.classList.add('k-bar-swap');
        var look;
        if (launch) {
            look = { bg: '#0f0f0f', fg: '#ffffff', accent: '#dc2626' };
        } else {
            var style = getComputedStyle(html);
            look = {
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
        }
        if (!label) {
            try { label = sessionStorage.getItem(LABEL); } catch (e) { /* storage blocked */ }
        }
        var defaultLabel = launch ? 'Initializing...' : 'Loading workspace';
        var built = build(look, fade, label || defaultLabel, launch);
        overlay = built.el;
        html.appendChild(overlay);
        bar = buildBar(look, label || defaultLabel, !remember);
        html.appendChild(bar);
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
                setTimeout(function () {
                    html.classList.remove('k-switching');
                    html.classList.remove('k-bar-swap');
                    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
                    bar = null;
                    try { sessionStorage.removeItem(BAR); } catch (e) { /* storage blocked */ }
                }, 450);
            }, 260);
        }, wait);
    }

    window.kLife = { show: show, hide: hide };

    // Arriving from a workspace switch: up straight away, before the app's own scripts have loaded.
    // Otherwise, a cold launch: the same screen, branded (see show()'s `launch` param) — so there's
    // an illusion of "loading" instead of the plain #0f0f0f background (see index.html/App.tsx's
    // own comments) staring back at the user for however long Tauri and the app take to actually
    // get going. App.tsx calls the same hide() once its own startup (flags, workspace labels, the
    // real theme/layout settings) has resolved.
    try {
        if (sessionStorage.getItem(KEY) === 'enter') show(false, false);
        else show(false, false, undefined, true);
    } catch (e) { /* storage blocked: no interstitial */ }
})();
