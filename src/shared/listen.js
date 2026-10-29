/*
 * Listening in on a live call, decided per session from what the ERP says and
 * what this call window has done so far. Pure, so it is tested without a
 * browser (test/shared.test.js).
 *
 * The ERP's session statuses: requested → offered → answered → ended.
 * What the window has done, per session id: 'offering' (asked the page for an
 * offer), 'offered' (posted it), 'answered' (applied the listener's answer),
 * 'ended'.
 */
(function (global) {
    'use strict';

    /**
     * @param {Array<{id: number, status: string, answer_sdp?: string, ice_servers?: Array}>} sessions
     * @param {Object<string, string>} done What this window has done, by session id.
     * @returns {Array<{action: 'offer'|'answer'|'stop', id: number, sdp?: string, iceServers?: Array}>}
     */
    function plan(sessions, done) {
        var actions = [];
        (sessions || []).forEach(function (session) {
            var mine = done[session.id];
            if (session.status === 'requested' && !mine) {
                actions.push({ action: 'offer', id: session.id, iceServers: session.ice_servers || [] });
            } else if (session.status === 'answered' && mine === 'offered' && session.answer_sdp) {
                actions.push({ action: 'answer', id: session.id, sdp: session.answer_sdp });
            } else if (session.status === 'ended' && mine && mine !== 'ended') {
                actions.push({ action: 'stop', id: session.id });
            }
        });
        return actions;
    }

    /** The state a window reaches by taking an action. */
    var AFTER = { offer: 'offering', answer: 'answered', stop: 'ended' };

    global.DVCListen = { plan: plan, AFTER: AFTER };
})(typeof self !== 'undefined' ? self : globalThis);
