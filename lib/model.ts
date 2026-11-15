// Token Radar's model: one sealed snapshot in, one ranked board out.
//
// The board ranks every pre-token protocol the snapshot's own rules admit: the 40 on the
// watchlist plus every other pre-token protocol below (and above) the floor that is not a
// wrapped, staked or bridged product of a token that already trades. A protocol is pre-token
// when its record carries no token at all: no market cap, no CoinGecko id, no symbol.
// Live-token protocols are kept apart and shown with their market caps, never ranked.
//
// Implied value follows only from the snapshot's own figures, in one function:
//
//   peerMultiple(category) = shrink(median(mcap_usd / tvl_usd) over the tokenized
//                            protocols in that category, globalMedian, n)
//   growthMult             = 1 + clamp(change_7d, -60, 120) / 100 * 0.5
//   maturityMult           = 0.6 + min(age_days, 1095) / 1095 * 0.4
//   implied                = max(1, round(tvl_usd * peerMultiple * growthMult * maturityMult))
//
// The multiple is the model's edge, and it is peer-derived, not a house constant: what a
// token is worth per dollar of TVL is read from the tokenized protocols in the same
// category, in this snapshot. A category with few live peers is shrunk toward the global
// median (prior weight 5), so one outlier cannot set a rank; a category with no live peers
// at all uses the global median. The result is clamped to [0.05, 1.0]. Growth is the
// seven-day change in TVL, clamped so one wild week cannot decide a rank. Maturity is how
// long the protocol has run with no token, and an unknown listing date is read as one
// year. No protocol name is ever special-cased: the same function scores every row, and
// the dashboard recomputes every row from the same figures and shows its derivation.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  multiple_floor: number;
  multiple_cap: number;
  prior_weight: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  multiple_floor: 0.05,
  multiple_cap: 1.0,
  prior_weight: 5,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-3';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    category_peers: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  category_multiple: number;
  category_peers: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** One category's peer multiple, for the dashboard's live comparison. */
export interface PeerMultiple {
  category: string;
  peers: number;
  median: number;
  multiple: number;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  global_multiple: number;
  global_comps: number;
  peer_multiples: PeerMultiple[];
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/**
 * The market's own multiple: the median market-cap-per-TVL over the live-token protocols
 * in this snapshot. The median, not the mean, so one outlier cannot move it. A market cap
 * of zero or less is bad data and is left out, as is a protocol with no TVL.
 */
export function globalMultiple(snapshot: Snapshot): { multiple: number; comps: number } {
  const ratios: number[] = [];
  for (const p of snapshot.protocols) {
    if (isPreToken(p)) continue;
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    ratios.push(p.mcap_usd / p.tvl_usd);
  }
  ratios.sort((a, b) => a - b);
  if (ratios.length === 0) return { multiple: 0.2, comps: 0 };
  const mid = ratios.length >> 1;
  const median = ratios.length % 2 === 1 ? ratios[mid]! : (ratios[mid - 1]! + ratios[mid]!) / 2;
  return { multiple: median, comps: ratios.length };
}

/**
 * Every category's peer multiple: the median market-cap-per-TVL of the tokenized
 * protocols in that category, shrunk toward the global median by sample size (prior
 * weight 5), then clamped to [0.05, 1.0]. A category with no live peers gets the global
 * median with zero peers. The shrinkage is the safeguard: one peer at 3x TVL cannot set
 * a whole category's rank on its own.
 */
export function categoryMultiples(snapshot: Snapshot, model: ModelConstants): { byCategory: Map<string, PeerMultiple>; global: number; comps: number } {
  const { multiple: global, comps } = globalMultiple(snapshot);
  const byCat = new Map<string, number[]>();
  for (const p of snapshot.protocols) {
    if (isPreToken(p)) continue;
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const cat = p.category ?? 'Other';
    const list = byCat.get(cat);
    if (list === undefined) byCat.set(cat, [p.mcap_usd / p.tvl_usd]);
    else list.push(p.mcap_usd / p.tvl_usd);
  }
  const byCategory = new Map<string, PeerMultiple>();
  for (const [cat, ratios] of byCat) {
    ratios.sort((a, b) => a - b);
    const mid = ratios.length >> 1;
    const median = ratios.length % 2 === 1 ? ratios[mid]! : (ratios[mid - 1]! + ratios[mid]!) / 2;
    const shrunk = (ratios.length * median + model.prior_weight * global) / (ratios.length + model.prior_weight);
    byCategory.set(cat, {
      category: cat,
      peers: ratios.length,
      median: round4(median),
      multiple: round4(Math.min(model.multiple_cap, Math.max(model.multiple_floor, shrunk))),
    });
  }
  return { byCategory, global, comps };
}

/** A category's multiple: its peer multiple, or the global median when it has no peers. */
export function multipleFor(category: string | null, multiples: Map<string, PeerMultiple>, global: number): PeerMultiple {
  const found = category === null ? undefined : multiples.get(category);
  if (found !== undefined) return found;
  return { category: category ?? 'Other', peers: 0, median: round4(global), multiple: round4(global) };
}

/** The three multipliers and the implied value one protocol gets. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  multiple: number,
  model: ModelConstants,
): { implied: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const cappedAge = Math.min(Math.max(ageForModel, 0), model.maturity_days);
  const maturityMult = model.maturity_floor + (cappedAge / model.maturity_days) * model.maturity_range;
  const base = protocol.tvl_usd * multiple;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult));
  return { implied, growthPct, growthMult, maturityMult, age };
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** A name carrying a whole word wrapped, staked or staking is a product of a token that trades. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
/** Categories that are a wrapped, staked or bridged product, not a protocol awaiting a launch. */
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
/** Names that begin with an exchange's name are that exchange's product. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/**
 * Whether a protocol is one the board may rank: pre-token, and not a wrapped, staked or
 * bridged product of a protocol whose token already trades. This is the watchlist's own
 * rule, applied to the whole universe instead of only the floor: a product below the floor
 * is no more a launch candidate than one above it.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIXES.some((e) => p.name.startsWith(e))) return false;
  return true;
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(
  snapshot: Snapshot,
  model: ModelConstants = MODEL,
): { board: BoardRow[]; multiples: Map<string, PeerMultiple>; global: number; comps: number } {
  const { byCategory, global, comps } = categoryMultiples(snapshot, model);
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug it names is ranked, whatever its figures.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other rankable pre-token protocol in the snapshot, above or below
  // the floor. The floor is where the house's reading started, not where this radar stops.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const peer = multipleFor(p.category, byCategory, global);
    const { implied, growthPct, growthMult, maturityMult, age } = impliedValue(p, snapshot.as_of, peer.multiple, model);
    return { p, implied, growthPct, growthMult, maturityMult, age, peer };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const board = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token' as const,
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      category_multiple: s.peer.multiple,
      category_peers: s.peer.peers,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
  return { board, multiples: byCategory, global, comps };
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 200;
  if (p.tvl_usd >= 250_000_000) return 150;
  if (p.tvl_usd >= 50_000_000) return 100;
  return 50;
}

/**
 * One transaction's gas on a chain, in dollars, from what that chain charges in practice:
 * Ethereum is the expensive one, Solana and the fast L1s are near free, the L2s sit in
 * between, and anything unlisted is read as a dollar. The plan's costs follow the
 * protocol's own main chain, so two protocols in the same category can still cost
 * different amounts to farm.
 */
function gasFor(chain: string): number {
  if (chain === 'Ethereum') return 8;
  if (chain === 'Solana' || chain === 'Sui' || chain === 'Aptos' || chain === 'Near') return 0.02;
  if (chain === 'Tron') return 0.3;
  if (chain === 'Binance') return 0.2;
  if (
    chain === 'Base' ||
    chain === 'Arbitrum' ||
    chain === 'Optimism' ||
    chain === 'Ink' ||
    chain === 'Polygon' ||
    chain === 'Avalanche' ||
    chain === 'Blast' ||
    chain === 'Mode' ||
    chain === 'Linea' ||
    chain === 'Scroll' ||
    chain === 'Mantle' ||
    chain === 'zkSync Era' ||
    chain === 'Gnosis' ||
    chain === 'Celo' ||
    chain === 'Fantom'
  ) {
    return 0.3;
  }
  return 1;
}

/** A gas figure as the plan writes it: $8, $1, $0.30, $0.02. */
function gasText(gas: number): string {
  return gas >= 1 ? `$${gas}` : `$${gas.toFixed(2)}`;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/**
 * The core action for a category: what the farmer actually does with the capital, in the
 * words a reader can follow. Derived from the category and the chains only, never a name.
 */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Lend $${capital} of USDC to ${name} on ${chain} and leave the loan open.`;
  }
  if (c.includes('dex') || c.includes('leveraged farm')) {
    return `Add $${capital} of liquidity to ${name}'s deepest pool on ${chain} and keep the position open.`;
  }
  if (c.includes('yield aggregator') || c.includes('yield')) {
    return `Deposit $${capital} of USDC into ${name}'s highest-yield vault on ${chain} and hold the shares.`;
  }
  if (c.includes('risk curators') || c.includes('onchain capital allocator') || c.includes('curator') || c.includes('allocator')) {
    return `Deposit $${capital} into a curated ${name} vault on ${chain} and hold the vault shares.`;
  }
  if (c.includes('rwa')) {
    return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it in the farming wallet.`;
  }
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('options')) {
    return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged trade on ${chain}.`;
  }
  if (c.includes('basis trading')) {
    return `Open a $${capital} basis position on ${name} and keep it delta-neutral for the full hold.`;
  }
  if (c.includes('staking pool') || c.includes('staking') || c.includes('restak')) {
    return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token.`;
  }
  if (c.includes('liquidity manager')) {
    return `Deposit $${capital} into ${name}'s managed liquidity position on ${chain} and leave it running.`;
  }
  if (c.includes('bridge') || c.includes('cross chain')) {
    return `Bridge $${capital} of USDC to ${chain} through ${name}, then use the bridged funds in its own app.`;
  }
  if (c.includes('payment')) {
    return `Move $${capital} through ${name} on ${chain} and keep a balance in its payment flow.`;
  }
  if (c.includes('chain')) {
    return `Bridge $${capital} to ${name}'s chain and use its flagship app at least once a week.`;
  }
  if (c.includes('prediction')) {
    return `Fund $${capital} and place one market position on ${name} on ${chain}.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  }
  if (c.includes('stable')) {
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** A second, different qualifying action for the same category, for the weekly step. */
function weeklyActionFor(p: SnapshotProtocol, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Borrow $20 against the deposit once a week and repay it the same day.`;
  }
  if (c.includes('dex') || c.includes('leveraged farm')) {
    return `Swap $10 through the pool each week and add the proceeds back to the position.`;
  }
  if (c.includes('yield aggregator') || c.includes('yield') || c.includes('risk curators') || c.includes('onchain capital allocator') || c.includes('curator') || c.includes('allocator')) {
    return `Claim the vault's yield once a week and redeposit it into the same vault.`;
  }
  if (c.includes('rwa')) {
    return `Check the asset's yield accrual once a week and record the balance in the farm log.`;
  }
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('options') || c.includes('basis trading')) {
    return `Rebalance the position once a week so the hedge stays close to neutral.`;
  }
  if (c.includes('staking pool') || c.includes('staking') || c.includes('restak')) {
    return `Restake the staking rewards once a week instead of leaving them idle.`;
  }
  if (c.includes('liquidity manager')) {
    return `Review the managed range once a week and let the manager rebalance it.`;
  }
  if (c.includes('bridge') || c.includes('cross chain')) {
    return `Bridge a small $10 test amount once a week so the wallet stays active on ${chain}.`;
  }
  if (c.includes('payment')) {
    return `Send one small payment through ${name} each week to keep the wallet active.`;
  }
  if (c.includes('chain')) {
    return `Use one more app on the chain each week, beyond the flagship one.`;
  }
  if (c.includes('prediction')) {
    return `Settle or roll the market position once a week and keep a record of the outcome.`;
  }
  if (c.includes('insurance')) {
    return `Check the policy's coverage once a week and top it up if the position grew.`;
  }
  if (c.includes('stable')) {
    return `Move $10 of the stable asset through ${name} once a week to keep the wallet active.`;
  }
  return `Make one qualifying action each week, such as a deposit, a swap or a vote.`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is
 * derived from the protocol's own record (category, chains, TVL, age), never from a
 * hand-written list of names. Steps 2, 3 and 6 change with the category and the chains; the
 * rest are the discipline every farm needs.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasFor(chain);
  const secondChain = p.chains.length > 1 ? p.chains[1]! : null;
  const secondGas = secondChain === null ? gas : gasFor(secondChain);
  const sixth: FarmStep =
    secondChain !== null
      ? {
          text: `Repeat the core deposit on ${secondChain} with half the capital, so the wallet is active on two chains.`,
          cost: `$${Math.floor(capital / 2)} of capital and about ${gasText(secondGas)} of gas`,
          time: '15 minutes',
        }
      : {
          text: `Use a second feature of ${p.name}, such as its rewards or governance page, with $25, so the wallet shows two kinds of activity.`,
          cost: `$25 of capital and about ${gasText(gas)} of gas`,
          time: '15 minutes',
        };
  return [
    {
      text: `Open a fresh wallet that holds only the funds you plan to farm, and write its seed phrase on paper kept offline.`,
      cost: `about ${gasText(gas)} of gas for the first transaction on ${chain}`,
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and about ${gasText(gas)} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: weeklyActionFor(p, chain),
      cost: `about ${gasText(gas)} of gas a week on ${chain}`,
      time: '10 minutes a week',
    },
    {
      text: `Open ${p.name}'s own points or rewards page and confirm the wallet is listed as eligible.`,
      cost: 'no fee to check',
      time: '10 minutes',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity spans more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    sixth,
    {
      text: `Before you withdraw, claim only from the link the protocol itself publishes, and write the wallet, the dates and every transaction in a farm log.`,
      cost: 'no fee to check, and never pay to claim',
      time: '15 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    category_multiple: row.model.category_multiple,
    category_peers: row.model.category_peers,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const { board, multiples, global, comps } = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const peerMultiples = [...multiples.values()].sort((a, b) => b.peers - a.peers || (a.category < b.category ? -1 : 1));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    global_multiple: round4(global),
    global_comps: comps,
    peer_multiples: peerMultiples,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
