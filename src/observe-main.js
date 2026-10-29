/*
 * Observe-only mode, page side (MAIN world, every vaihde.dna.fi page, from
 * document start). Reports what DNA does that cannot be seen in the DOM: the
 * browser notifications it raises and the sounds it plays (a ringtone).
 * Nothing is changed: each wrapper calls the original unchanged.
 *
 * The isolated script records the reports only while observe mode is on in the
 * extension's options; otherwise they are dropped.
 */
(function () {
    'use strict';

    if (window.__dvcObserveMain) {
        return;
    }
    window.__dvcObserveMain = true;

    function report(kind, data) {
        try {
            window.postMessage({ source: 'dvc-observe-page', kind: kind, data: data }, location.origin);
        } catch (e) { /* reporting must never break DNA */ }
    }

    var NativeNotification = window.Notification;
    if (NativeNotification) {
        var Wrapped = function (title, options) {
            report('notification', { title: String(title), body: options && options.body ? String(options.body) : '', tag: options && options.tag || '' });
            return new NativeNotification(title, options);
        };
        Wrapped.prototype = NativeNotification.prototype;
        Object.setPrototypeOf(Wrapped, NativeNotification);
        Object.defineProperty(Wrapped, 'permission', { get: function () { return NativeNotification.permission; } });
        Wrapped.requestPermission = NativeNotification.requestPermission.bind(NativeNotification);
        window.Notification = Wrapped;
    }

    if (window.ServiceWorkerRegistration && ServiceWorkerRegistration.prototype.showNotification) {
        var nativeShow = ServiceWorkerRegistration.prototype.showNotification;
        ServiceWorkerRegistration.prototype.showNotification = function (title, options) {
            report('sw-notification', { title: String(title), body: options && options.body ? String(options.body) : '' });
            return nativeShow.apply(this, arguments);
        };
    }

    var nativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
        report('media-play', { src: String(this.currentSrc || this.src || '').slice(0, 200), loop: !!this.loop, tag: this.tagName });
        return nativePlay.apply(this, arguments);
    };

    var nativeOpen = window.open;
    window.open = function (url, target) {
        report('window-open', { url: String(url || '').slice(0, 300), target: String(target || '') });
        return nativeOpen.apply(this, arguments);
    };
})();
