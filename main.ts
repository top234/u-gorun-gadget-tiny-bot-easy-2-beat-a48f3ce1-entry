// Tiny Bot: two-horizon trend follower on hourly Solana bars.
//
// Idea (original): most hourly moves in this universe are noise, but short
// bursts of momentum persist for a few bars, and genuine multi-day trends
// persist for much longer. So the bot runs two independent trend sleeves:
//
//   CORE (slow): EMA(6) crossing above EMA(16) while the 12h return tops 2%.
//     Buys up to 20% of equity per symbol, rides the trend with a volatility
//     trailing stop (3x trailing 48h hourly volatility), a -6% stop and a
//     +50% take-profit, and exits when EMA(6) crosses back under EMA(16).
//   SLEEVE (fast): EMA(4) crossing above EMA(8) while the 3h return tops
//     0.5%. Small 5% stakes, tight -2% stop / +5% take / 8-bar max hold:
//     it harvests the frequent short bursts and, just as importantly, keeps
//     the bot trading through flat stretches instead of sitting idle.
//
// Risk: long only, at most 5 open positions, at most 25% weight per symbol
// (the harness cap, enforced again here via weightRoom), sells first then
// buys, never more than 16 orders a bar, 1% slippage cap per order so a
// gapped open is skipped rather than chased. Everything is deterministic:
// plain float64 math in a fixed order, no clock, no randomness, no env.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const BPS = 10_000n;
const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on
const MAX_POSITIONS = 5;

// Core (slow trend) parameters.
const CORE_FAST = 6;
const CORE_SLOW = 16;
const CORE_MOM_BARS = 12;
const CORE_MOM_MIN = 0.02; // 12h return must top 2%
const CORE_WEIGHT_BPS = 2000n; // 20% of equity per symbol
const CORE_STOP = -0.06; // -6% vs cost
const CORE_ROI = 0.5; // +50% vs cost
const CORE_TRAIL_MULT = 3; // trailing stop: 3x trailing hourly volatility
const CORE_VOL_BARS = 48;

// Fast sleeve parameters.
const FAST_FAST = 4;
const FAST_SLOW = 8;
const FAST_MOM_BARS = 3;
const FAST_MOM_MIN = 0.005; // 3h return must top 0.5%
const FAST_WEIGHT_BPS = 500n; // 5% of equity per symbol
const FAST_STOP = -0.02;
const FAST_TAKE = 0.05;
const FAST_MAX_HOLD = 8; // bars

interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

interface Series {
  coreFast: Ema;
  coreSlow: Ema;
  fastFast: Ema;
  fastSlow: Ema;
  /** fast - slow after the previous bar, once both EMAs are set. */
  coreGap: number | null;
  coreNow: number | null;
  fastGap: number | null;
  fastNow: number | null;
  /** Closes, oldest first, for momentum and volatility. */
  closes: number[];
  /** True while the EMA(6) > EMA(16) down-cross signal is holding. */
  coreDown: boolean;
  fastDown: boolean;
}

interface Meta {
  kind: 'core' | 'sleeve';
  entrySeq: number;
  trailHigh: number;
}

const series = new Map<string, Series>();
const meta = new Map<string, Meta>();
/** Buys sent but not yet seen as a position, with the seq they were decided on. */
const pendingBuy = new Map<string, { kind: 'core' | 'sleeve'; seq: number }>();

function makeEma(span: number): Ema {
  return { span, warm: [], value: null };
}

function step(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

function push(bar: Bar): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = {
      coreFast: makeEma(CORE_FAST), coreSlow: makeEma(CORE_SLOW),
      fastFast: makeEma(FAST_FAST), fastSlow: makeEma(FAST_SLOW),
      coreGap: null, coreNow: null, fastGap: null, fastNow: null,
      closes: [], coreDown: false, fastDown: false,
    };
    series.set(bar.symbol, s);
  }
  const c = Number(bar.c);
  step(s.coreFast, c);
  step(s.coreSlow, c);
  step(s.fastFast, c);
  step(s.fastSlow, c);
  s.closes.push(c);
  s.coreGap = s.coreNow;
  s.coreNow = s.coreFast.value !== null && s.coreSlow.value !== null ? s.coreFast.value - s.coreSlow.value : null;
  s.fastGap = s.fastNow;
  s.fastNow = s.fastFast.value !== null && s.fastSlow.value !== null ? s.fastFast.value - s.fastSlow.value : null;
  if (s.coreNow === null || s.coreNow >= 0) s.coreDown = false;
  else if (s.coreGap !== null && s.coreGap >= 0) s.coreDown = true;
  if (s.fastNow === null || s.fastNow >= 0) s.fastDown = false;
  else if (s.fastGap !== null && s.fastGap >= 0) s.fastDown = true;
  return s;
}

/** Momentum over the last `bars` closes, or null without enough history. */
function momentum(s: Series, bars: number): number | null {
  const n = s.closes.length;
  if (n <= bars) return null;
  return s.closes[n - 1] / s.closes[n - 1 - bars] - 1;
}

/** Trailing hourly volatility (std of log returns) over up to `bars` closes. */
function trailingVol(s: Series, bars: number): number {
  const n = s.closes.length;
  const start = Math.max(1, n - bars);
  let count = 0;
  let mean = 0;
  const rets: number[] = [];
  for (let i = start; i < n; i++) {
    const r = Math.log(s.closes[i] / s.closes[i - 1]);
    rets.push(r);
    mean += r;
    count++;
  }
  if (count < 2) return 0.01;
  mean /= count;
  let ss = 0;
  for (const r of rets) ss += (r - mean) * (r - mean);
  return Math.sqrt(ss / (count - 1));
}

await runBars({
  onBatch(state: BarsState, batch) {
    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      push(bar);
      fresh.add(bar.symbol);
    }
    // Warm-up batches build history only; every order on one is rejected.
    if (state.warmingUp) return [];

    const { caps, fees } = state.hello;
    const minNotional = BigInt(fees.min_notional_quote_units);

    // Record entries that filled: a position that appeared since last batch.
    // A buy the market refused (e.g. the open gapped past the slippage cap)
    // never becomes a position: drop its pending tag so it cannot mislabel
    // a later, unrelated position in the same symbol.
    for (const [symbol, pending] of pendingBuy) {
      if (!state.positions.has(symbol) && pending.seq < state.seq) pendingBuy.delete(symbol);
    }
    for (const [symbol, held] of state.positions) {
      const pending = pendingBuy.get(symbol);
      if (pending !== undefined && !meta.has(symbol)) {
        const close = state.close(symbol);
        meta.set(symbol, { kind: pending.kind, entrySeq: state.seq, trailHigh: close === null ? 0 : Number(close) });
        pendingBuy.delete(symbol);
      }
    }

    const sells: SellInput[] = [];
    const sold = new Set<string>();
    for (const { symbol } of state.hello.symbols) {
      const held = state.positions.get(symbol);
      if (held === undefined) continue;
      const s = series.get(symbol);
      if (s === undefined) continue;
      const m = meta.get(symbol);
      const close = state.close(symbol);
      const value = state.value(symbol, held.qty);
      const roi = Number(value) / Number(held.cost) - 1;
      let exit = false;
      if (m === undefined || m.kind === 'core') {
        // Core exit: down-cross, stop, take-profit, or volatility trail.
        if (s.coreDown) exit = true;
        if (roi <= CORE_STOP || roi >= CORE_ROI) exit = true;
        if (close !== null && m !== undefined) {
          if (Number(close) > m.trailHigh) m.trailHigh = Number(close);
          const trail = m.trailHigh * (1 - CORE_TRAIL_MULT * trailingVol(s, CORE_VOL_BARS));
          if (Number(close) < trail) exit = true;
        }
      } else {
        // Sleeve exit: down-cross, tight stop/take, or max hold reached.
        if (s.fastDown) exit = true;
        if (roi <= FAST_STOP || roi >= FAST_TAKE) exit = true;
        if (state.seq - m.entrySeq >= FAST_MAX_HOLD) exit = true;
      }
      if (exit) {
        sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        sold.add(symbol);
        meta.delete(symbol);
      }
    }

    // Entries, ranked by momentum so the strongest trend gets the slot.
    const coreCands: { symbol: string; mom: number }[] = [];
    const fastCands: { symbol: string; mom: number }[] = [];
    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol) || state.positions.has(symbol) || sold.has(symbol)) continue;
      const s = series.get(symbol)!;
      const bar = batch.bars.find((b) => b.symbol === symbol)!;
      if (bar.v === '0') continue; // a zero-volume bar signals nothing
      const coreMom = momentum(s, CORE_MOM_BARS);
      if (s.coreNow !== null && s.coreGap !== null && s.coreNow > 0 && s.coreGap <= 0 && coreMom !== null && coreMom > CORE_MOM_MIN) {
        coreCands.push({ symbol, mom: coreMom });
      }
      const fastMom = momentum(s, FAST_MOM_BARS);
      if (s.fastNow !== null && s.fastGap !== null && s.fastNow > 0 && s.fastGap <= 0 && fastMom !== null && fastMom > FAST_MOM_MIN) {
        fastCands.push({ symbol, mom: fastMom });
      }
    }
    coreCands.sort((a, b) => b.mom - a.mom);
    fastCands.sort((a, b) => b.mom - a.mom);

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    let room = MAX_POSITIONS - state.positions.size;
    let cash = state.cash;
    const buy = (symbol: string, weightBps: bigint, kind: 'core' | 'sleeve'): void => {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) return;
      let slice = (weightBps * state.equity) / BPS;
      const byWeight = state.weightRoom(symbol);
      if (slice > byWeight) slice = byWeight;
      if (slice > cash) slice = cash;
      if (slice === 0n || slice < minNotional) return;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      pendingBuy.set(symbol, { kind, seq: state.seq });
      cash -= slice;
      room--;
    };
    for (const c of coreCands) buy(c.symbol, CORE_WEIGHT_BPS, 'core');
    for (const c of fastCands) buy(c.symbol, FAST_WEIGHT_BPS, 'sleeve');
    return orders;
  },
});
