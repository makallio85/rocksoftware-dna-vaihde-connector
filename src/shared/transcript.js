/*
 * Collects the final lines Speechmatics sends for one call and hands them to
 * the ERP in batches.
 *
 * Each side of the call is its own stream, so the channel is known from the
 * stream a message came in on. A line keeps its sequence number for good: a
 * batch that failed to post is sent again with the same numbers, and the ERP
 * stores each (channel, sequence) once.
 *
 * Classic script for the service worker (importScripts) and Node tests.
 */
(function (root) {
    'use strict';

    function Collector() {
        this.queue = [];
        this.sequences = { employee: 0, customer: 0, ai: 0 };
        this.offsets = { employee: 0, customer: 0, ai: 0 };
    }

    /**
     * A finished line from a source that gives text without timings (the AI
     * agent's own transcripts): placed at `atMs` after the call connected.
     *
     * @returns {object|null} The line queued, or null.
     */
    Collector.prototype.addText = function (channel, text, atMs) {
        var clean = String(text || '').replace(/\s+/g, ' ').trim();
        if (clean === '' || !(channel in this.sequences)) {
            return null;
        }
        var at = Math.max(0, Math.round(atMs || 0));
        var segment = { channel: channel, sequence: this.sequences[channel]++, start_ms: at, end_ms: at, text: clean };
        this.queue.push(segment);

        return segment;
    };

    /**
     * Where a stream's own clock starts, in milliseconds after the call
     * connected, so both sides' lines sort on one timeline.
     */
    Collector.prototype.setOffset = function (channel, offsetMs) {
        this.offsets[channel] = Math.max(0, Math.round(offsetMs));
    };

    /**
     * @param {string} channel 'employee' or 'customer'
     * @param {object} message A parsed Speechmatics server message.
     * @returns {object|null} The line queued, or null.
     */
    Collector.prototype.accept = function (channel, message) {
        if (!message || message.message !== 'AddTranscript' || !(channel in this.sequences)) {
            return null;
        }
        var meta = message.metadata || {};
        var text = String(meta.transcript || '').replace(/\s+/g, ' ').trim();
        if (text === '') {
            return null;
        }
        var offset = this.offsets[channel];
        var segment = {
            channel: channel,
            sequence: this.sequences[channel]++,
            start_ms: offset + Math.round((Number(meta.start_time) || 0) * 1000),
            end_ms: offset + Math.round((Number(meta.end_time) || 0) * 1000),
            text: text,
        };
        this.queue.push(segment);

        return segment;
    };

    /** Takes up to `max` queued lines off the front. */
    Collector.prototype.take = function (max) {
        return this.queue.splice(0, max || 100);
    };

    /** Puts lines that failed to post back at the front, in order. */
    Collector.prototype.putBack = function (segments) {
        this.queue = segments.concat(this.queue);
    };

    Collector.prototype.pending = function () {
        return this.queue.length;
    };

    root.DVCTranscript = { Collector: Collector };
})(typeof globalThis !== 'undefined' ? globalThis : this);
