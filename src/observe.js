/*
 * Observe-only mode (isolated world, every vaihde.dna.fi page).
 *
 * While switched on in the extension's options, records what DNA shows — to
 * learn how an incoming call looks before building on it: the window's title
 * and address, dialogs and notices, the visible buttons and their labels,
 * phone numbers on screen, and lines that speak of calls. Only CHANGES are
 * recorded, every half second. Nothing is clicked or changed.
 *
 * The record stays in this browser (chrome.storage.local) until downloaded or
 * cleared on the options page.
 */
(function () {
    'use strict';

    var TICK_MS = 500;
    var OWN = '#dvc-calls-status';
    var CALL_WORDS = /\b(incoming|calling|ringing|answer|answered|decline|reject|missed|queue|transfer|saapuva|soittaa|soi|vastaa|vastattu|hylkää|ohita|jono|siirrä|vastaamaton)\b/i;
    var PHONE = /(?:\+|\b0)\d[\d\s-]{6,}\d/g;
    var DIALOGS = '[role="dialog"],[role="alertdialog"],[role="alert"],[role="status"],[aria-live],'
        + '.MuiSnackbar-root,.MuiDialog-root,.MuiPopover-root,[class*="notification" i],[class*="incoming" i],[class*="toast" i]';

    var on = false;
    var last = {};
    var timer = null;

    function where() {
        return location.pathname.indexOf('/join/') === 0 ? 'call-window' : (location.pathname.indexOf('/cwp/') === 0 ? 'directory' : 'other');
    }

    function record(kind, data) {
        chrome.runtime.sendMessage({ type: 'observe-log', entry: { t: new Date().toISOString(), page: where(), path: location.pathname + location.hash, kind: kind, data: data } }, function () {
            void chrome.runtime.lastError;
        });
    }

    function visible(el) {
        return !!(el.offsetParent || el.getClientRects().length) && !el.closest(OWN);
    }

    function label(b) {
        return [b.getAttribute('aria-label'), b.getAttribute('title'), b.getAttribute('data-tooltip'), (b.textContent || '').trim()]
            .filter(Boolean).join(' | ').replace(/\s+/g, ' ').slice(0, 120);
    }

    function changed(key, value) {
        var serialised = JSON.stringify(value);
        if (last[key] === serialised) {
            return false;
        }
        last[key] = serialised;
        return true;
    }

    function tick() {
        if (!document.body) {
            return;
        }
        if (changed('title', document.title)) {
            record('title', document.title);
        }
        if (changed('url', location.href)) {
            record('url', location.href);
        }

        var dialogs = Array.prototype.filter.call(document.querySelectorAll(DIALOGS), visible)
            .map(function (d) { return (d.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 400); })
            .filter(Boolean);
        if (changed('dialogs', dialogs)) {
            record('dialogs', dialogs);
        }

        var buttons = Array.prototype.filter.call(document.querySelectorAll('button,[role="button"]'), visible)
            .map(function (b) { return label(b) + (b.disabled ? ' (disabled)' : ''); })
            .filter(function (l) { return l !== '' && l !== ' (disabled)'; });
        var unique = buttons.filter(function (l, i) { return buttons.indexOf(l) === i; }).sort();
        if (changed('buttons', unique)) {
            record('buttons', unique);
        }

        var text = document.body.innerText || '';
        var phones = (text.match(PHONE) || []).map(function (p) { return p.replace(/\s+/g, ' ').trim(); });
        var uniquePhones = phones.filter(function (p, i) { return phones.indexOf(p) === i; }).slice(0, 20);
        if (changed('phones', uniquePhones)) {
            record('phones', uniquePhones);
        }

        var lines = text.split('\n').map(function (l) { return l.trim(); })
            .filter(function (l) { return l && l.length < 160 && CALL_WORDS.test(l); });
        var uniqueLines = lines.filter(function (l, i) { return lines.indexOf(l) === i; }).slice(0, 30);
        if (changed('call-lines', uniqueLines)) {
            record('call-lines', uniqueLines);
        }
    }

    function start() {
        if (timer) {
            return;
        }
        last = {};
        record('observe-start', { userAgent: navigator.userAgent.slice(0, 120) });
        tick();
        timer = setInterval(tick, TICK_MS);
    }

    function stop() {
        clearInterval(timer);
        timer = null;
    }

    window.addEventListener('message', function (event) {
        var data = event.data;
        if (on && event.source === window && data && data.source === 'dvc-observe-page') {
            record(data.kind, data.data);
        }
    });

    function apply(value) {
        on = !!value;
        if (on) { start(); } else { stop(); }
    }

    chrome.storage.local.get(['observe']).then(function (s) { apply(s.observe); });
    chrome.storage.onChanged.addListener(function (changes, area) {
        if (area === 'local' && changes.observe) {
            apply(changes.observe.newValue);
        }
    });
    window.addEventListener('pagehide', function () {
        if (on) {
            record('pagehide', { title: document.title });
        }
    });
})();
