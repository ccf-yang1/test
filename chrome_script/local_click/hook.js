(function () {
  'use strict';
  if (window.__capExports) return;

  const note = (inst) => {
    if (inst && inst.exports && typeof inst.exports.solve_pow === 'function') {
      window.__capExports = inst.exports;
    }
  };

  try {
    const f = WebAssembly.instantiate;
    WebAssembly.instantiate = function (...a) {
      return f.apply(this, a).then((r) => {
        note(r && r.instance ? r.instance : r);
        return r;
      });
    };
  } catch (_) {}

  try {
    const f = WebAssembly.instantiateStreaming;
    if (f) {
      WebAssembly.instantiateStreaming = function (...a) {
        return f.apply(this, a).then((r) => {
          note(r && r.instance);
          return r;
        });
      };
    }
  } catch (_) {}
})();
