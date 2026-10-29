/*
 * The softphone's own decisions, pure so they are tested without a browser
 * (test/shared.test.js):
 *
 *  - which DNA directory tab dials, when several are open;
 *  - how long to wait before asking the backend again after it failed to answer;
 *  - the state reported to the backend every 5 seconds;
 *  - the checklist the options page's *Tarkista* shows.
 */
(function (global) {
    'use strict';

    /** A directory tab that has not polled for this long is gone. */
    var TAB_STALE_MS = 10000;
    var BACKOFF_FIRST_MS = 2000;
    var BACKOFF_MAX_MS = 30000;

    /**
     * Forgets tabs that stopped polling and names the one that dials: the
     * oldest still open, so opening a second tab never takes calls from the
     * first.
     *
     * @param {Object<string, {firstSeen: number, lastSeen: number}>} tabs By tab id; pruned in place.
     * @param {number} now
     * @returns {number|null} The dialling tab's id.
     */
    function primaryTab(tabs, now) {
        var primary = null;
        Object.keys(tabs).forEach(function (id) {
            if (now - tabs[id].lastSeen > TAB_STALE_MS) {
                delete tabs[id];
                return;
            }
            if (primary === null || tabs[id].firstSeen < tabs[primary].firstSeen) {
                primary = id;
            }
        });
        return primary === null ? null : Number(primary);
    }

    /**
     * The wait before the next poll: 2 s normally; after failures 4, 8, 16 and
     * at most 30 s, so an unreachable backend is not asked every 2 seconds by every
     * employee's browser.
     *
     * @param {number} failures Failed polls in a row.
     * @returns {number} Milliseconds.
     */
    function backoff(failures) {
        if (failures <= 0) {
            return BACKOFF_FIRST_MS;
        }
        return Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * Math.pow(2, failures));
    }

    /**
     * The report sent to `POST call-softphones/add`.
     *
     * @param {{version: string, tabs: Object, dialerReady: ?boolean, microphone: ?string, popupsBlocked: boolean}} state
     * @returns {Object}
     */
    function report(state) {
        var tabCount = Object.keys(state.tabs).length;
        return {
            extension_version: state.version,
            directory_open: tabCount > 0,
            directory_tabs: tabCount,
            dialer_ready: tabCount > 0 && state.dialerReady === true,
            microphone_allowed: state.microphone === 'granted' ? true : state.microphone === 'denied' ? false : null,
            popups_blocked: !!state.popupsBlocked,
        };
    }

    /**
     * The *Tarkista* checklist: each line ok, a warning or a problem, with what
     * to do about it.
     *
     * @param {{settings: boolean, backend: ?string, tabs: number, dialerReady: ?boolean,
     *          microphone: ?string, popupsBlocked: boolean, softphone: ?Object}} s
     *   `backend` is null when the backend answered, otherwise its error.
     * @returns {Array<{label: string, tone: 'ok'|'warning'|'error', detail: string}>}
     */
    function diagnose(s) {
        var lines = [];
        function line(label, tone, detail) { lines.push({ label: label, tone: tone, detail: detail }); }

        if (!s.settings) {
            line('Taustajärjestelmä', 'error', 'Aseta taustajärjestelmän API-osoite ja oma API-token yllä.');
        } else if (s.backend) {
            line('Taustajärjestelmä', 'error', s.backend);
        } else {
            line('Taustajärjestelmä', 'ok', 'Taustajärjestelmä vastaa ja hyväksyy tokenin.');
        }

        if (s.tabs === 0) {
            line('DNA-vaihde', 'error', 'Avaa vaihde.dna.fi ja sen Yhteystiedot-näkymä.');
        } else if (s.tabs > 1) {
            line('DNA-vaihde', 'warning', 'Auki ' + s.tabs + ' välilehdellä. Vain vanhin soittaa – sulje muut.');
        } else {
            line('DNA-vaihde', 'ok', 'Auki yhdellä välilehdellä.');
        }

        if (s.tabs > 0) {
            if (s.dialerReady) {
                line('DNA-kirjautuminen', 'ok', 'DNA:n numeronvalinta löytyi – laajennus tunnistaa DNA:n näkymän.');
            } else {
                line('DNA-kirjautuminen', 'error', 'DNA:n numeronvalintaa ei löydy. Kirjaudu ja avaa Yhteystiedot-näkymä. '
                    + 'Jos olet jo siellä, DNA:n sivu on voinut muuttua – ilmoita ylläpidolle.');
            }
        }

        if (s.microphone === 'granted') {
            line('Mikrofoni', 'ok', 'Sallittu vaihde.dna.fi:lle.');
        } else if (s.microphone === 'denied') {
            line('Mikrofoni', 'error', 'Estetty. Salli mikrofoni vaihde.dna.fi:n osoiterivin lukkokuvakkeesta.');
        } else {
            line('Mikrofoni', 'warning', 'Ei vielä kysytty. Selain kysyy ensimmäisessä puhelussa – vastaa Salli.');
        }

        line('Ponnahdusikkunat', s.popupsBlocked ? 'error' : 'ok', s.popupsBlocked
            ? 'Selain esti DNA:n puheluikkunan viimeksi. Salli ponnahdusikkunat vaihde.dna.fi:lle.'
            : 'Puheluikkuna on avautunut (tai puhelua ei ole vielä soitettu).');

        var softphone = s.softphone;
        if (softphone && softphone.warnings) {
            softphone.warnings.forEach(function (w) {
                if (w.code === 'extension_outdated' || w.code === 'token_expiring') {
                    line(w.code === 'token_expiring' ? 'API-token' : 'Laajennuksen versio', 'warning', w.message);
                }
            });
        }
        return lines;
    }

    /**
     * The DNA tab's status line, from the backend's answer to the last report: the
     * same reasons and warnings the backend shows. Problems come
     * first; warnings show only when nothing blocks calls.
     *
     * @param {?{allowed: boolean, reasons: Array<{message: string}>, warnings: Array<{message: string}>}} softphone
     *   null until the backend has answered a report.
     * @returns {{text: string, tone: 'ok'|'warning'|'problem'}}
     */
    function status(softphone) {
        if (!softphone) {
            return { text: 'yhteys taustajärjestelmään kunnossa, odotetaan puheluita.', tone: 'ok' };
        }
        function messages(list) {
            return (list || []).map(function (item) { return item.message; }).join(' ');
        }
        if (!softphone.allowed && (softphone.reasons || []).length) {
            return { text: 'ei valmis. ' + messages(softphone.reasons), tone: 'problem' };
        }
        if ((softphone.warnings || []).length) {
            return { text: 'valmis. ' + messages(softphone.warnings), tone: 'warning' };
        }
        return { text: 'valmis, odotetaan puheluita.', tone: 'ok' };
    }

    /**
     * The host permission the backend address needs. No backend address is built into
     * the extension: the options page asks the browser for this one when the
     * address is saved. Chrome's patterns carry no port.
     *
     * @param {string} apiUrl
     * @returns {?string} e.g. "https://api.example.fi/*"; null if not a valid address.
     */
    function originPattern(apiUrl) {
        var url;
        try {
            url = new URL(apiUrl);
        } catch (e) {
            return null;
        }
        if (url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost')) {
            return url.protocol + '//' + url.hostname + '/*';
        }
        return null;
    }

    global.DVCSoftphone = {
        TAB_STALE_MS: TAB_STALE_MS,
        originPattern: originPattern,
        primaryTab: primaryTab,
        backoff: backoff,
        report: report,
        diagnose: diagnose,
        status: status,
    };
})(typeof self !== 'undefined' ? self : globalThis);
