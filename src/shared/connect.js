/*
 * Connecting the extension to a backend, and the guard on where call audio may
 * go. Pure, so it is tested without a browser (test/shared.test.js).
 *
 * A backend connects the extension by opening the extension's page
 *   chrome-extension://<id>/connect.html#api=<API base address>&token=<token>
 * in the user's browser (see README). The part after # never reaches a server.
 * The user confirms on that page. A link never replaces a connection to
 * another backend: that is changed on the options page only, so a web page
 * cannot quietly move an extension to a server of its own.
 *
 * Classic script for the service worker (importScripts), extension pages and
 * Node tests.
 */
(function (global) {
    'use strict';

    var MAX_TOKEN_LENGTH = 512;

    /** Same address whatever its trailing slashes. */
    function normalise(apiUrl) {
        return String(apiUrl || '').trim().replace(/\/+$/, '');
    }

    /** https anywhere, plain http only on localhost (development). */
    function isApiUrl(apiUrl) {
        var url;
        try {
            url = new URL(apiUrl);
        } catch (e) {
            return false;
        }
        if (url.username || url.password || url.search || url.hash) {
            return false;
        }
        return url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost');
    }

    /**
     * @param {string} hash The connect page's location.hash.
     * @returns {{apiUrl: string, token: string}|{error: string}}
     */
    function parseLink(hash) {
        var params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
        var apiUrl = normalise(params.get('api'));
        var token = String(params.get('token') || '');
        if (!apiUrl || !token) {
            return { error: 'Yhdistämislinkistä puuttuu osoite tai token.' };
        }
        if (!isApiUrl(apiUrl)) {
            return { error: 'Yhdistämislinkin osoite ei kelpaa: sen pitää alkaa https://.' };
        }
        if (token.length > MAX_TOKEN_LENGTH || /\s/.test(token)) {
            return { error: 'Yhdistämislinkin token ei kelpaa.' };
        }
        return { apiUrl: apiUrl, token: token };
    }

    /**
     * What a connect link may do, given the connection already saved.
     *
     * @param {?string} currentApiUrl The saved API address, if any.
     * @param {string} apiUrl The link's address.
     * @returns {'connect'|'renew'|'refuse'} `renew` replaces the token of the
     *          same backend; `refuse`: another backend is connected.
     */
    function decide(currentApiUrl, apiUrl) {
        var current = normalise(currentApiUrl);
        if (!current) {
            return 'connect';
        }
        return current === normalise(apiUrl) ? 'renew' : 'refuse';
    }

    /**
     * Call audio leaves the browser only for the transcription and AI services
     * the extension was built for, whatever address a backend hands out.
     *
     * @param {string} url A WebSocket address from the backend.
     * @returns {boolean}
     */
    function isProviderStream(url) {
        var parsed;
        try {
            parsed = new URL(url);
        } catch (e) {
            return false;
        }
        if (parsed.protocol !== 'wss:') {
            return false;
        }
        return /^([a-z0-9-]+\.)*rt\.speechmatics\.com$/.test(parsed.hostname) || parsed.hostname === 'api.openai.com';
    }

    global.DVCConnect = {
        normalise: normalise,
        isApiUrl: isApiUrl,
        parseLink: parseLink,
        decide: decide,
        isProviderStream: isProviderStream,
    };
})(typeof self !== 'undefined' ? self : globalThis);
