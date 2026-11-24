// Early-riser: a simple momentum bot for the pump.fun bonding-curve replay.
//
// Idea: most pump.fun curves bleed out right after launch, but the ones that
// survive the first minutes and start climbing tend to keep climbing for a
// while. So this bot only buys a curve once it is old enough to have shaken
// out the instant dumpers AND its price is rising and sitting near its recent
// high. It buys one fixed stake, then gets out on a stop-loss, a take-profit,
// a trailing stop once the trade is working, or a time limit. No pyramiding,
// no fancy tape analysis, no probes: one buy per curve, one clean exit.
//
// Deterministic by construction: no clock, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS_PER_SOL = 1_000_000_000n;

export interface Params {
  /** Slots since first seen before an entry is allowed. */
  minAge: number;
  /** Lookback window in slots for the rise / high check. */
  window: number;
  /** Price now must be at least this multiple of the price `window` slots ago. */
  minRise: number;
  /** Price now must be at least this share of the window high. */
  nearHigh: number;
  /** Real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** SOL to put into one position. */
  stakeSol: number;
  /** Smallest buy worth sending, in SOL. */
  minBuySol: number;
  /** Slippage on buys (bps); sells go out at 10000. */
  buySlipBps: number;
  /** Sell when mark value falls to this share of cost. */
  stopLoss: number;
  /** Sell when mark value reaches this multiple of cost. */
  takeProfit: number;
  /** Trailing stop arms once value reaches this multiple of cost. */
  trailArm: number;
  /** Once armed, sell when value falls to this share of the best value seen. */
  trail: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 200,
  window: 60,
  minRise: 1.08,
  nearHigh: 0.9,
  minRqSol: 1,
  maxRqSol: 80,
  stakeSol: 0.5,
  minBuySol: 0.01,
  buySlipBps: 1500,
  stopLoss: 0.92,
  takeProfit: 1.25,
  trailArm: 1.1,
  trail: 0.85,
  maxHold: 400,
  cooldown: 100,
  maxEntries: 2,
};

interface HistPoint {
  slot: number;
  price: number;
}

interface Held {
  buySlot: number;
  costLamports: bigint;
  bestValue: bigint;
  armed: boolean;
}

function priceOf(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken === 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  // Price history per mint, in slot order; pruned to the last ~400 slots.
  const hist = new Map<Pubkey, HistPoint[]>();
  // First slot each mint was seen.
  const firstSeen = new Map<Pubkey, number>();
  // My open positions, by mint.
  const held = new Map<Pubkey, Held>();
  // Entries per curve, and last exit slot per curve.
  const entries = new Map<Pubkey, number>();
  const lastExit = new Map<Pubkey, number>();
  // Stake sized once hello arrives.
  let stakeLamports = BigInt(Math.round(p.stakeSol * 1e9));

  function priceAt(mint: Pubkey, slot: number): number | null {
    const h = hist.get(mint);
    if (!h || h.length === 0) return null;
    let out: number | null = null;
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].slot <= slot) {
        out = h[i].price;
        break;
      }
    }
    return out;
  }

  function highOver(mint: Pubkey, fromSlot: number, toSlot: number): number {
    const h = hist.get(mint);
    if (!h) return 0;
    let high = 0;
    for (const pt of h) {
      if (pt.slot >= fromSlot && pt.slot <= toSlot && pt.price > high) high = pt.price;
    }
    return high;
  }

  return {
    onHello(state: BotState) {
      const capital = BigInt(state.hello.capital.lamports);
      const byCapital = capital / 40n;
      if (byCapital < stakeLamports) stakeLamports = byCapital;
      const min = BigInt(Math.round(p.minBuySol * 1e9));
      if (stakeLamports < min) stakeLamports = min;
    },

    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const slot = batch.slot;
      const orders: OrderInput[] = [];
      const caps = state.hello.caps;
      const tx = state.txFeeLamports();
      let free = state.freeCashLamports();
      let slotsLeft = caps.max_open_positions - state.committedPositionCount();

      // Record this batch's prices and first-seen slots.
      for (const [mint, curve] of state.curves) {
        if (curve.complete) continue;
        if (!firstSeen.has(mint)) firstSeen.set(mint, curve.created_slot ?? slot);
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price <= 0) continue;
        let h = hist.get(mint);
        if (h === undefined) {
          h = [];
          hist.set(mint, h);
        }
        const last = h[h.length - 1];
        if (last === undefined || last.slot < slot) h.push({ slot, price });
        else last.price = price;
        while (h.length > 0 && h[0].slot < slot - 400) h.shift();
      }
      // Prune stale curves from history (not seen for 600 slots).
      for (const [mint, h] of hist) {
        const last = h[h.length - 1];
        if (last === undefined || last.slot < slot - 600) {
          hist.delete(mint);
          firstSeen.delete(mint);
        }
      }

      // Sync held positions with the account: drop ones the harness closed.
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint)) {
          held.delete(mint);
          lastExit.set(mint, slot);
        }
      }
      // Register newly filled buys (cost basis from the account).
      for (const [mint, holding] of state.positions) {
        if (!held.has(mint)) {
          held.set(mint, {
            buySlot: slot,
            costLamports: holding.cost_lamports,
            bestValue: holding.cost_lamports,
            armed: false,
          });
        }
      }

      // Exits first: sell whole holdings that hit a rule.
      for (const [mint, holding] of state.positions) {
        const info = held.get(mint);
        if (info === undefined) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price <= 0) continue;
        const value = (holding.token_amount * BigInt(Math.round(price * 1e12))) / 1000000000000n;
        if (value > info.bestValue) info.bestValue = value;
        if (value >= (info.costLamports * BigInt(Math.round(p.trailArm * 100))) / 100n) info.armed = true;
        const heldSlots = slot - info.buySlot;
        const stopHit = value <= (info.costLamports * BigInt(Math.round(p.stopLoss * 100))) / 100n;
        const profitHit = value >= (info.costLamports * BigInt(Math.round(p.takeProfit * 100))) / 100n;
        const trailHit = info.armed && value <= (info.bestValue * BigInt(Math.round(p.trail * 100))) / 100n;
        const timeHit = heldSlots >= p.maxHold;
        if (stopHit || profitHit || trailHit || timeHit) {
          if (orders.length >= caps.max_orders_per_batch) break;
          orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: 10000 });
          held.delete(mint);
          lastExit.set(mint, slot);
        }
      }

      // Entries: young-enough curves that are rising and near their window high.
      for (const [mint, curve] of state.curves) {
        if (orders.length >= caps.max_orders_per_batch) break;
        if (slotsLeft <= 0) break;
        if (curve.complete) continue;
        if (state.positions.has(mint)) continue;
        const seen = firstSeen.get(mint);
        if (seen === undefined) continue;
        if (slot - seen < p.minAge) continue;
        if ((entries.get(mint) ?? 0) >= p.maxEntries) continue;
        const last = lastExit.get(mint);
        if (last !== undefined && slot - last < p.cooldown) continue;
        const rqSol = Number(curve.real_quote_reserves) / 1e9;
        if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;
        const priceNow = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (priceNow <= 0) continue;
        const priceThen = priceAt(mint, slot - p.window);
        if (priceThen === null || priceThen <= 0) continue;
        if (priceNow < priceThen * p.minRise) continue;
        const high = highOver(mint, slot - p.window, slot);
        if (high <= 0 || priceNow < high * p.nearHigh) continue;
        const cap = state.maxBuyLamports(mint);
        if (cap < BigInt(Math.round(p.minBuySol * 1e9))) continue;
        const amount = cap < stakeLamports ? cap : stakeLamports;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
        entries.set(mint, (entries.get(mint) ?? 0) + 1);
        free -= amount + tx;
        slotsLeft -= 1;
      }

      return orders;
    },
  };
}
