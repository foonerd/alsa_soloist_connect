'use strict';
// Minimal kew-compatible promise wrapper (Volumio core expects .fail/.fin)

class QPromise {
  constructor(nativePromise) {
    this._p = nativePromise;
  }
  then(onOk, onErr) {
    return new QPromise(this._p.then(onOk, onErr));
  }
  fail(onErr) {
    return new QPromise(this._p.catch(onErr));
  }
  catch(onErr) {
    return this.fail(onErr);
  }
  fin(fn) {
    return new QPromise(this._p.finally(fn));
  }
  finally(fn) {
    return this.fin(fn);
  }
}

module.exports = {
  defer() {
    const d = {};
    const p = new Promise((resolve, reject) => {
      d.resolve = resolve;
      d.reject = reject;
    });
    d.promise = new QPromise(p);
    return d;
  },
  resolve(v) {
    return new QPromise(Promise.resolve(v));
  },
  reject(e) {
    return new QPromise(Promise.reject(e));
  },
};
