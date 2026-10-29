/*
 * An incoming call ringing on this softphone: what to do next, from what the
 * ERP says about it. Pure, so it is tested without a browser
 * (test/shared.test.js).
 *
 *  - 'answer-in-dna'      this employee pressed *Vastaa* in the ERP, and DNA
 *                         still rings: the page answers it.
 *  - 'answered-elsewhere' a colleague took it: stop treating it as ringing here.
 *  - 'gone'               it stopped ringing everywhere (missed) or is over.
 *  - 'wait'               still ringing, or answered here and waiting for the
 *                         call window.
 */
(function (global) {
    'use strict';

    var OVER = ['missed', 'ended', 'failed', 'cancelled'];

    /**
     * @param {{askedToAnswer?: boolean, windowBound?: boolean}} entry What this softphone did.
     * @param {{status: string, is_mine: boolean}} call The ERP's view of the call.
     * @returns {'answer-in-dna'|'answered-elsewhere'|'gone'|'wait'}
     */
    function decide(entry, call) {
        if (!call) {
            return 'gone';
        }
        if (call.is_mine) {
            if (call.status === 'connected' && !entry.windowBound && !entry.askedToAnswer) {
                return 'answer-in-dna';
            }
            return OVER.indexOf(call.status) !== -1 ? 'gone' : 'wait';
        }
        if (call.status === 'connected' || (OVER.indexOf(call.status) !== -1 && call.user_name)) {
            return 'answered-elsewhere';
        }
        return OVER.indexOf(call.status) !== -1 ? 'gone' : 'wait';
    }

    global.DVCIncoming = { decide: decide };
})(typeof self !== 'undefined' ? self : globalThis);
