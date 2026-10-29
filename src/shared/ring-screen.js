/*
 * Reading an incoming call off DNA's screen. Pure, so it is tested without a
 * browser (test/shared.test.js); the DNA tab (directory.js) feeds it what it
 * sees every few hundred milliseconds.
 *
 * What DNA shows while a call rings (seen on test calls, 2026-10-29):
 *  - a pop-up: a pulsing avatar (.call-animation), "Incoming call", the
 *    caller's number as a heading, and two round buttons: red = decline
 *    (left), green = answer (right);
 *  - the tab title "00358… is calling...".
 * When the caller hangs up, or the call is answered in another tab, the title
 * changes back and the pop-up closes about half a second later. DNA shows
 * nothing that tells those apart: the service worker does, by whether DNA's
 * call window opened.
 *
 * Classic script for the content script and Node tests.
 */
(function (global) {
    'use strict';

    /**
     * The pop-up closed this long ago: it stopped ringing. Short, so the ERP
     * stops saying "Saapuva puhelu" at once; it only rides over the moment the
     * title has changed back but the pop-up is still closing (test calls showed
     * no flicker of the pop-up itself).
     */
    var STOP_GRACE_MS = 300;
    /**
     * Answered in this tab: DNA's call window takes the call over and the ERP
     * hears "connected" from it. Stopped is reported only if that window has
     * not appeared by then (the worker ignores it if it has).
     */
    var ANSWERED_GRACE_MS = 15000;
    var TITLE_CALLING = /(\+?\d[\d\s-]{4,}\d)\s+(?:is calling|soittaa)/i;
    var NUMBER = /^\+?\d[\d\s-]{4,}\d$/;

    /**
     * @param {{title: string, popup: ?{heading: string}}} screen What DNA shows;
     *        `popup` is DNA's incoming-call pop-up, if open.
     * @returns {{ringing: boolean, number: ?string}} The number as DNA shows it
     *          (the ERP normalises it); null for a hidden number or a name.
     */
    function read(screen) {
        var title = TITLE_CALLING.exec(screen.title || '');
        var ringing = !!screen.popup || !!title;
        if (!ringing) {
            return { ringing: false, number: null };
        }
        // The title has the full international form (00358…); the heading is
        // the fallback when DNA's title is in another language.
        var number = title ? title[1] : null;
        if (!number && screen.popup) {
            var heading = String(screen.popup.heading || '').trim();
            number = NUMBER.test(heading) ? heading : null;
        }
        return { ringing: true, number: number ? number.replace(/[\s-]/g, '') : null };
    }

    /**
     * DNA's answer button is the green one ("rgb(18, 199, 0)"); the decline
     * button next to it is red. Nothing else is ever pressed.
     *
     * @param {string} colour A computed background colour.
     * @returns {boolean}
     */
    function isAnswerColour(colour) {
        var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(colour || '');
        if (!m) {
            return false;
        }
        var r = Number(m[1]), g = Number(m[2]), b = Number(m[3]);
        return g >= 120 && g > r * 1.5 && g > b * 1.5;
    }

    /**
     * Turns the screen readings into the moments of a call: `ringing` once when
     * it starts, `stopped` once when it has not rung for STOP_GRACE_MS, or
     * ANSWERED_GRACE_MS once answered in this tab. A call that starts again
     * within the grace is the same call.
     */
    function Watcher() {
        this.active = false;
        this.answered = false;
        this.number = null;
        this.quietSince = null;
    }

    /** The answer button of the ringing call was pressed in this tab. */
    Watcher.prototype.markAnswered = function () {
        if (this.active) {
            this.answered = true;
        }
    };

    /**
     * @param {{ringing: boolean, number: ?string}} seen
     * @param {number} now
     * @returns {?{event: 'ringing'|'stopped', number: ?string}}
     */
    Watcher.prototype.update = function (seen, now) {
        if (seen.ringing) {
            if (this.active && this.quietSince !== null && seen.number !== this.number) {
                // Another caller within the grace: the first one stopped, and
                // the next reading reports the new one.
                return this.stop();
            }
            this.quietSince = null;
            if (!this.active) {
                this.active = true;
                this.number = seen.number;
                return { event: 'ringing', number: seen.number };
            }
            return null;
        }
        if (!this.active) {
            return null;
        }
        if (this.quietSince === null) {
            this.quietSince = now;
        }
        if (now - this.quietSince >= (this.answered ? ANSWERED_GRACE_MS : STOP_GRACE_MS)) {
            return this.stop();
        }
        return null;
    };

    Watcher.prototype.stop = function () {
        var number = this.number;
        this.active = false;
        this.answered = false;
        this.number = null;
        this.quietSince = null;
        return { event: 'stopped', number: number };
    };

    global.DVCRingScreen = {
        read: read,
        isAnswerColour: isAnswerColour,
        Watcher: Watcher,
        STOP_GRACE_MS: STOP_GRACE_MS,
        ANSWERED_GRACE_MS: ANSWERED_GRACE_MS,
    };
})(typeof self !== 'undefined' ? self : globalThis);
