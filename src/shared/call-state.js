/*
 * Reads where a DNA call is from what the call window shows.
 *
 * DNA exposes no call-state API to the page, so the state is read from the
 * call window's own text, as observed on real calls (October 2026):
 *   ringing    — "<name> ringing"
 *   connected  — "Call with <name>" and a call timer "mm:ss" that advances
 *   unavailable— "<name> is not available"
 *   ended      — window title "Call ended | DNA Ohjelmistopuhelin"
 *
 * Microphone readiness, the WebRTC connection and audio activity are NOT signs
 * of an answered call: the audio path is up while it is still ringing. Only a
 * timer seen to advance counts as connected.
 *
 * Loaded as a classic script (content script and Node tests), so it attaches
 * to globalThis instead of exporting.
 */
(function (root) {
    'use strict';

    var TIMER = /\b(\d{1,2}):([0-5]\d)\b/;

    /**
     * @param {{title: string, text: string}} snapshot
     * @returns {{state: string, timerSeconds: (number|null)}}
     */
    function read(snapshot) {
        var title = snapshot.title || '';
        var text = snapshot.text || '';

        if (/call ended/i.test(title)) {
            return { state: 'ended', timerSeconds: null };
        }
        if (/\bis not available\b/i.test(text)) {
            return { state: 'unavailable', timerSeconds: null };
        }
        var withMatch = /\bcall with\b/i.test(text);
        var timer = withMatch ? text.slice(text.search(/\bcall with\b/i)).match(TIMER) : null;
        if (withMatch && timer) {
            return { state: 'in_call', timerSeconds: Number(timer[1]) * 60 + Number(timer[2]) };
        }
        if (/\bringing\b/i.test(text)) {
            return { state: 'ringing', timerSeconds: null };
        }

        return { state: 'unknown', timerSeconds: null };
    }

    /**
     * Turns successive snapshots into the events a call goes through:
     * `connected` once (when the timer is seen to advance), then `ended` or
     * `failed` once. Nothing is reported twice.
     */
    function Tracker() {
        this.connected = false;
        this.finished = false;
        this.lastTimer = null;
    }

    /**
     * @returns {string|null} 'connected', 'ended', 'failed' or null.
     */
    Tracker.prototype.update = function (snapshot) {
        if (this.finished) {
            return null;
        }
        var reading = read(snapshot);

        if (reading.state === 'in_call') {
            var advanced = this.lastTimer !== null && reading.timerSeconds > this.lastTimer;
            this.lastTimer = reading.timerSeconds;
            if (!this.connected && advanced) {
                this.connected = true;
                return 'connected';
            }
            return null;
        }

        if (reading.state === 'ended' || reading.state === 'unavailable') {
            this.finished = true;
            return this.connected ? 'ended' : 'failed';
        }

        return null;
    };

    /** The window closed: whatever was going on is over. */
    Tracker.prototype.closed = function () {
        if (this.finished) {
            return null;
        }
        this.finished = true;
        return this.connected ? 'ended' : 'failed';
    };

    root.DVCCallState = { read: read, Tracker: Tracker };
})(typeof globalThis !== 'undefined' ? globalThis : this);
