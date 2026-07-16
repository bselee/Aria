/**
 * Patch the buffer polyfill to support base64url encoding.
 * The @supabase/auth-js library uses Buffer.from(str, 'base64url')
 * internally for JWT handling. Webpack's buffer polyfill v6.x doesn't
 * support this encoding (it was added to Node core in v15.7).
 *
 * This patch extends Uint8Array.prototype.toString and the Buffer
 * constructor to handle 'base64url' as an alias for 'base64'.
 */
(function patchBase64Url() {
  if (typeof Uint8Array === 'undefined') return;

  const origToString = Uint8Array.prototype.toString;
  const origFrom = Uint8Array.from;
  const origBufferFrom = typeof Buffer !== 'undefined' ? Buffer.from : null;

  function normalizeEncoding(enc) {
    if (!enc || typeof enc !== 'string') return enc;
    const lower = enc.toLowerCase().replace(/-/g, '');
    if (lower === 'base64url') return 'base64';
    return enc;
  }

  // Patch Uint8Array.toString (called by Buffer.toString)
  Uint8Array.prototype.toString = function (encoding) {
    if (encoding) {
      const normalized = normalizeEncoding(encoding);
      if (normalized !== encoding) {
        return origToString.call(this, normalized);
      }
    }
    return origToString.apply(this, arguments);
  };

  // Patch Uint8Array.from (called by Buffer.from in browser polyfill)
  if (Uint8Array.from) {
    Uint8Array.from = function (source, encoding) {
      if (encoding) {
        const normalized = normalizeEncoding(encoding);
        if (normalized !== encoding) {
          return origFrom.call(this, source, normalized);
        }
      }
      return origFrom.apply(this, arguments);
    };
  }

  // Patch Buffer.from if available
  if (origBufferFrom) {
    Buffer.from = function (value, encodingOrOffset, length) {
      if (encodingOrOffset) {
        const normalized = normalizeEncoding(encodingOrOffset);
        if (normalized !== encodingOrOffset) {
          return origBufferFrom.call(this, value, normalized, length);
        }
      }
      return origBufferFrom.apply(this, arguments);
    };
  }

  // Patch Buffer.prototype.toString
  if (typeof Buffer !== 'undefined' && Buffer.prototype && Buffer.prototype.toString) {
    const origBufToString = Buffer.prototype.toString;
    Buffer.prototype.toString = function (encoding, start, end) {
      if (encoding) {
        const normalized = normalizeEncoding(encoding);
        if (normalized !== encoding) {
          return origBufToString.call(this, normalized, start, end);
        }
      }
      return origBufToString.apply(this, arguments);
    };
  }
})();
