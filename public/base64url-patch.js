/**
 * Patch the buffer polyfill to support base64url encoding.
 * Runs immediately AND re-applies after Buffer becomes available
 * (webpack loads the buffer polyfill asynchronously).
 */
(function patchBase64Url() {
  function apply() {
    if (typeof Buffer !== 'undefined') {
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

    // Also patch Uint8Array.toString for direct calls
    if (typeof Uint8Array !== 'undefined') {
      const origU8 = Uint8Array.prototype.toString;
      Uint8Array.prototype.toString = function (encoding) {
        if (encoding && typeof encoding === 'string') {
          const lower = encoding.toLowerCase().replace(/-/g, '');
          if (lower === 'base64url') return origU8.call(this, 'base64');
        }
        return origU8.apply(this, arguments);
      };
    }
  }

  // Apply immediately
  apply();

  // Re-apply periodically until Buffer is patched
  // (webpack chunks load asynchronously and may overwrite our patch)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      apply();
      // Some webpack chunks load even after DOMContentLoaded
      setTimeout(apply, 1000);
      setTimeout(apply, 3000);
    });
  } else {
    apply();
    setTimeout(apply, 1000);
    setTimeout(apply, 3000);
  }
})();
