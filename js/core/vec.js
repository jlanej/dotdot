// @ts-check
/**
 * Growable typed-array vectors. Structure-of-arrays storage everywhere keeps
 * the hot loops monomorphic and GC-free; these are the only "collections" the
 * engine allocates while matching.
 */

export class F64Vec {
  /** @param {number} [cap] */
  constructor(cap = 1024) {
    this.a = new Float64Array(cap);
    this.n = 0;
  }
  /** @param {number} v */
  push(v) {
    if (this.n === this.a.length) {
      const b = new Float64Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  /** Copy out a right-sized array (frees the growth slack). */
  done() {
    return this.a.slice(0, this.n);
  }
}

export class F32Vec {
  /** @param {number} [cap] */
  constructor(cap = 1024) {
    this.a = new Float32Array(cap);
    this.n = 0;
  }
  /** @param {number} v */
  push(v) {
    if (this.n === this.a.length) {
      const b = new Float32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  done() {
    return this.a.slice(0, this.n);
  }
}

export class U32Vec {
  /** @param {number} [cap] */
  constructor(cap = 1024) {
    this.a = new Uint32Array(cap);
    this.n = 0;
  }
  /** @param {number} v */
  push(v) {
    if (this.n === this.a.length) {
      const b = new Uint32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  done() {
    return this.a.slice(0, this.n);
  }
}

export class U8Vec {
  /** @param {number} [cap] */
  constructor(cap = 1024) {
    this.a = new Uint8Array(cap);
    this.n = 0;
  }
  /** @param {number} v */
  push(v) {
    if (this.n === this.a.length) {
      const b = new Uint8Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  done() {
    return this.a.slice(0, this.n);
  }
}
