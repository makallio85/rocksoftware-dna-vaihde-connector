/*
 * Counts what one call consumes from the paid services, as running totals in
 * the units the ERP prices them in:
 *
 *  - Speechmatics bills streamed audio time: each stream's bytes, at 16 kHz
 *    16-bit mono, are seconds.
 *  - OpenAI Realtime bills tokens, which it reports in every `response.done`.
 *    Cached tokens are part of the input counts; they are taken out of text and
 *    audio input and counted on their own, as they are billed.
 *  - OpenAI transcription of the customer bills audio time: the seconds of
 *    audio appended to the session, at 24 kHz 16-bit mono.
 *
 * The ERP keeps the larger of two totals, so reporting the same totals again
 * never counts anything twice.
 *
 * Classic script for the service worker (importScripts) and Node tests.
 */
(function (root) {
    'use strict';

    var BYTES_PER_SECOND_16K = 16000 * 2;
    var BYTES_PER_SECOND_24K = 24000 * 2;

    function Meter() {
        this.speechmaticsBytes = 0;
        this.openAiAudioBytes = 0;
        this.tokens = { text_in: 0, cached_in: 0, audio_in: 0, text_out: 0, audio_out: 0 };
    }

    /** One audio chunk streamed to Speechmatics. */
    Meter.prototype.addSpeechmaticsBytes = function (bytes) {
        this.speechmaticsBytes += bytes;
    };

    /** One audio chunk appended to the OpenAI session. */
    Meter.prototype.addOpenAiAudioBytes = function (bytes) {
        this.openAiAudioBytes += bytes;
    };

    /** The `usage` object of a Realtime `response.done`. */
    Meter.prototype.addRealtimeUsage = function (usage) {
        if (!usage) {
            return;
        }
        var input = usage.input_token_details || {};
        var output = usage.output_token_details || {};
        var cached = input.cached_tokens_details || {};
        var cachedText = Number(cached.text_tokens) || 0;
        var cachedAudio = Number(cached.audio_tokens) || 0;
        var cachedTotal = Number(input.cached_tokens) || cachedText + cachedAudio;

        this.tokens.text_in += Math.max(0, (Number(input.text_tokens) || 0) - cachedText);
        this.tokens.audio_in += Math.max(0, (Number(input.audio_tokens) || 0) - cachedAudio);
        this.tokens.cached_in += cachedTotal;
        this.tokens.text_out += Number(output.text_tokens) || 0;
        this.tokens.audio_out += Number(output.audio_tokens) || 0;
    };

    /** The running totals as the ERP's `usages` list; empty kinds are left out. */
    Meter.prototype.report = function () {
        var rows = [
            ['speechmatics_audio_seconds', Math.round(this.speechmaticsBytes / BYTES_PER_SECOND_16K)],
            ['openai_transcription_seconds', Math.round(this.openAiAudioBytes / BYTES_PER_SECOND_24K)],
            ['openai_text_input_tokens', this.tokens.text_in],
            ['openai_cached_input_tokens', this.tokens.cached_in],
            ['openai_audio_input_tokens', this.tokens.audio_in],
            ['openai_text_output_tokens', this.tokens.text_out],
            ['openai_audio_output_tokens', this.tokens.audio_out],
        ];
        return rows
            .filter(function (row) { return row[1] > 0; })
            .map(function (row) { return { type: row[0], quantity: row[1] }; });
    };

    root.DVCUsage = { Meter: Meter };
})(typeof globalThis !== 'undefined' ? globalThis : this);
