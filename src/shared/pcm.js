/*
 * Audio chunk conversions shared by the page capture and the service worker.
 *
 * Extension messages are JSON, which cannot carry binary, so a chunk travels
 * from the call window to the service worker as base64 and is turned back
 * into bytes before it goes to Speechmatics as a binary frame.
 *
 * Classic script for the service worker (importScripts) and Node tests; the
 * page capture script carries its own copy of floatTo16 because it runs in the
 * page's world, where extension files cannot be loaded.
 */
(function (root) {
    'use strict';

    /** Float samples in [-1, 1] → signed 16-bit little-endian PCM. */
    function floatTo16(samples) {
        var out = new Int16Array(samples.length);
        for (var i = 0; i < samples.length; i++) {
            var s = Math.max(-1, Math.min(1, samples[i]));
            out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        return out;
    }

    function toBase64(bytes) {
        var binary = '';
        var chunk = 0x8000;
        for (var i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
    }

    function fromBase64(text) {
        var binary = atob(text);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    root.DVCPcm = { floatTo16: floatTo16, toBase64: toBase64, fromBase64: fromBase64 };
})(typeof globalThis !== 'undefined' ? globalThis : this);
