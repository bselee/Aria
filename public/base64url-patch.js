/**
 * Patch the buffer polyfill to support base64url encoding.
 * The @supabase framework uses base64url encoding for JWT/Auth operations.
 * Webpack's buffer polyfill v6.x doesn't support this encoding.
 *
 * Strategy: patch Buffer.isEncoding to accept base64url, and patch
 * Buffer.from and toString to convert base64url to base64.
 * Runs eagerly at script load and re-applies via MutationObserver
 * to catch webpack's deferred module evaluation.
 */
(function () {
  'use strict';

  function patch() {
    // Patch Buffer if available
    if (typeof Buffer !== 'undefined') {
      // Patch isEncoding to accept base64url
      if (Buffer.isEncoding) {
        const origIsEncoding = Buffer.isEncoding;
        Buffer.isEncoding = function (enc) {
          if (enc && typeof enc === 'string') {
            const lower = enc.toLowerCase().replace(/-/g, '');
            if (lower === 'base64url') return true;
          }
          return origIsEncoding.call(this, enc);
        };
      }

      // Patch Buffer.from
      const origFrom = Buffer.from;
      Buffer.from = function (value, encodingOrOffset, length) {
        if (encodingOrOffset && typeof encodingOrOffset === 'string') {
          const lower = encodingOrOffset.toLowerCase().replace(/-/g, '');
          if (lower === 'base64url') return origFrom.call(this, value, 'base64', length);
        }
        return origFrom.apply(this, arguments);
      };

      // Patch Buffer.prototype.toString
      const origToString = Buffer.prototype.toString;
      Buffer.prototype.toString = function (encoding, start, end) {
        if (encoding && typeof encoding === 'string') {
          const lower = encoding.toLowerCase().replace(/-/g, '');
          if (lower === 'base64url') return origToString.call(this, 'base64', start, end);
        }
        return origToString.apply(this, arguments);
      };
    }

    // Patch Uint8Array.prototype.toString (called by buffer polyfill)
    if (typeof Uint8Array !== 'undefined') {
      const origU8toString = Uint8Array.prototype.toString;
      Uint8Array.prototype.toString = function (encoding) {
        if (encoding && typeof encoding === 'string') {
          const lower = encoding.toLowerCase().replace(/-/g, '');
          if (lower === 'base64url') return origU8toString.call(this, 'base64');
        }
        return origU8toString.apply(this, arguments);
      };
    }
  }

  // Apply synchronously (catches eagerly evaluated modules)
  patch();

  // Watch for Buffer to be defined (webpack evaluates modules lazily)
  var target = typeof Buffer !== 'undefined' ? Buffer : null;
  Object.defineProperty(window, 'Buffer', {
    get: function () { return target; },
    set: function (v) {
      target = v;
      patch(); // Re-patch when Buffer is set by webpack
    },
    configurable: true,
    enumerable: true,
  });

  // Also re-patch on DOMContentLoaded and at intervals
  function reapply() {
    patch();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', reapply);
  }
  setTimeout(reapply, 500);
  setTimeout(reapply, 2000);
  setTimeout(reapply, 5000);
})();
