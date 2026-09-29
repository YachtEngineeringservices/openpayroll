/**
 * Exact decimal arithmetic for payroll.
 *
 * All values are exact rationals (bigint numerator/denominator). Nothing is ever a
 * binary float, and rounding happens only where the agency method says it does,
 * via an explicit call. Money leaves the engine as integer cents or "1234.56" strings.
 */

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
}

export class Dec {
  readonly n: bigint;
  readonly d: bigint;

  private constructor(n: bigint, d: bigint) {
    if (d === 0n) throw new Error("division by zero");
    if (d < 0n) { n = -n; d = -d; }
    const g = gcd(n, d) || 1n;
    this.n = n / g;
    this.d = d / g;
  }

  static of(v: string | number | bigint | Dec): Dec {
    if (v instanceof Dec) return v;
    if (typeof v === "bigint") return new Dec(v, 1n);
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error(`not a finite number: ${v}`);
      if (Number.isInteger(v)) return new Dec(BigInt(v), 1n);
      // Numbers with fractions are refused: use strings so no float ever enters.
      throw new Error(`fractional numbers must be passed as strings, got ${v}`);
    }
    const s = v.trim().replace(/[$,_\s]/g, "");
    const m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(s);
    if (!m || (m[2] === "" && (m[3] ?? "") === "")) throw new Error(`not a decimal: "${v}"`);
    const sign = m[1] === "-" ? -1n : 1n;
    const intPart = m[2] || "0";
    const frac = m[3] ?? "";
    const n = BigInt(intPart + frac) * sign;
    const d = 10n ** BigInt(frac.length);
    return new Dec(n, d);
  }

  static cents(c: bigint | number): Dec {
    return new Dec(BigInt(c), 100n);
  }

  static readonly ZERO = new Dec(0n, 1n);

  add(o: Dec | string): Dec { const b = Dec.of(o); return new Dec(this.n * b.d + b.n * this.d, this.d * b.d); }
  sub(o: Dec | string): Dec { const b = Dec.of(o); return new Dec(this.n * b.d - b.n * this.d, this.d * b.d); }
  mul(o: Dec | string | bigint): Dec { const b = Dec.of(o); return new Dec(this.n * b.n, this.d * b.d); }
  div(o: Dec | string | bigint): Dec { const b = Dec.of(o); return new Dec(this.n * b.d, this.d * b.n); }
  neg(): Dec { return new Dec(-this.n, this.d); }

  cmp(o: Dec | string): number { const b = Dec.of(o); const l = this.n * b.d, r = b.n * this.d; return l < r ? -1 : l > r ? 1 : 0; }
  lt(o: Dec | string) { return this.cmp(o) < 0; }
  lte(o: Dec | string) { return this.cmp(o) <= 0; }
  gt(o: Dec | string) { return this.cmp(o) > 0; }
  gte(o: Dec | string) { return this.cmp(o) >= 0; }
  eq(o: Dec | string) { return this.cmp(o) === 0; }
  isZero() { return this.n === 0n; }
  isNeg() { return this.n < 0n; }

  static max(a: Dec, b: Dec): Dec { return a.gte(b) ? a : b; }
  static min(a: Dec, b: Dec): Dec { return a.lte(b) ? a : b; }
  /** max(0, x) */
  floor0(): Dec { return this.isNeg() ? Dec.ZERO : this; }

  /**
   * Round to `places` decimals, half away from zero (the convention agencies use
   * for "round to the nearest cent/dollar").
   */
  round(places = 2): Dec {
    const scale = 10n ** BigInt(places);
    const scaled = this.n * scale;
    const q = scaled / this.d;
    const r = scaled % this.d;
    const twiceR = (r < 0n ? -r : r) * 2n;
    let out = q;
    if (twiceR >= this.d) out += scaled < 0n ? -1n : 1n;
    return new Dec(out, scale);
  }

  /** Integer cents; throws unless the value is already a whole number of cents. */
  toCents(): bigint {
    const c = this.mul(100n);
    if (c.d !== 1n) throw new Error(`not a whole number of cents: ${this.toString()} (round first)`);
    return c.n;
  }

  /** "1234.56" (exactly two decimals; rounds half away from zero) */
  toMoney(): string {
    const c = this.round(2).mul(100n).n;
    const neg = c < 0n;
    const a = neg ? -c : c;
    const s = `${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`;
    return neg ? `-${s}` : s;
  }

  toString(): string {
    if (this.d === 1n) return this.n.toString();
    // exact decimal expansion when the denominator is 2^a*5^b, else a 10-place approximation
    let d = this.d; let places = 0;
    while (d % 10n === 0n) { d /= 10n; places++; }
    while (d % 2n === 0n || d % 5n === 0n) { d = d % 2n === 0n ? d / 2n : d / 5n; places++; }
    const p = d === 1n ? places : 10;
    const r = this.round(p);
    const scale = 10n ** BigInt(p);
    const v = r.n * (scale / r.d);
    const neg = v < 0n; const a = neg ? -v : v;
    const intPart = a / scale; const frac = (a % scale).toString().padStart(p, "0").replace(/0+$/, "");
    return `${neg ? "-" : ""}${intPart}${frac ? "." + frac : ""}${d === 1n ? "" : "…"}`;
  }

  /** For display only. Never use for arithmetic. */
  toNumber(): number { return Number(this.toMoney()); }
}

export const D = Dec.of;
