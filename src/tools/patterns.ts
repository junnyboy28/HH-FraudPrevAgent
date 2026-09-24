// Detection for the five documented fraud patterns, plus the undocumented case.
//
// Definitions come from the "five known fraud patterns" section of
// data/HHGOA_IEEE/README.md. They are deliberately implemented here rather than
// in GSQL: they are sequence and threshold questions over one card's timeline,
// which is far easier to get right and to debug in TypeScript. The graph
// supplies the linkage evidence these read (shared devices, prior fraud), which
// is the part a graph is genuinely better at. See graph/queries/README.md.
//
// Every detector returns the transaction ids it is claiming, so the case file's
// affected_txn_ids and exposure_usd are derived from evidence rather than
// asserted.

import type { AccountProfile, SharedDeviceLink, Txn } from './evidence-types.js';

/** The seven values the answer format's `pattern` field accepts. */
export type PatternId =
  | 'card_testing'
  | 'card_not_present_fraud'
  | 'card_not_present_new_device'
  | 'out_of_region_use'
  | 'account_takeover'
  | 'undocumented'
  | 'none';

export interface PatternEvidence {
  /** Plain-language claim, for the case file's evidence[].claim. */
  readonly claim: string;
  /** Which query or signal it rests on, for evidence[].ref. */
  readonly ref: string;
  readonly entityIds: readonly string[];
}

export interface PatternMatch {
  readonly pattern: PatternId;
  /** 0 to 1. How well the observed activity fits this pattern's definition. */
  readonly strength: number;
  readonly affectedTxnIds: readonly string[];
  readonly evidence: readonly PatternEvidence[];
  /** Set only for `undocumented`. */
  readonly description?: string;
}

const HOUR = 3600;
const DAY = 86400;

/** Policy R5 calls these "small" authorizations; the README says often under $5. */
const SMALL_AUTH_MAX = 5;
/** R5: "a purchase over $100 has already cleared" escalates the response. */
const CLEARED_PURCHASE_THRESHOLD = 100;

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function sum(txns: readonly Txn[]): number {
  return txns.reduce((a, t) => a + Math.abs(t.amount), 0);
}

/** Transactions strictly before the flagged one, which define "their history". */
function historyBefore(timeline: readonly Txn[], flagged: Txn): readonly Txn[] {
  return timeline.filter((t) => t.dt < flagged.dt);
}

function windowAround(timeline: readonly Txn[], flagged: Txn, seconds: number): readonly Txn[] {
  return timeline.filter((t) => Math.abs(t.dt - flagged.dt) <= seconds);
}

/**
 * Pattern 1, card testing. Three or more tiny online authorizations on the card
 * within an hour, followed by a larger purchase. The sequence itself is the
 * confirmation, so this is the one pattern that does not need corroboration.
 */
export function detectCardTesting(timeline: readonly Txn[], flagged: Txn): PatternMatch | null {
  // Look across a day around the alert, then require the tight hour cluster.
  const nearby = windowAround(timeline, flagged, DAY);
  const small = nearby.filter((t) => t.channel === 'online' && Math.abs(t.amount) <= SMALL_AUTH_MAX);
  if (small.length < 3) return null;

  // Find the tightest run of >=3 small authorizations inside one hour.
  const sorted = [...small].sort((a, b) => a.dt - b.dt);
  let best: Txn[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const run = sorted.filter((t) => {
      const start = sorted[i];
      return start !== undefined && t.dt >= start.dt && t.dt - start.dt <= HOUR;
    });
    if (run.length > best.length) best = run;
  }
  if (best.length < 3) return null;

  const lastSmall = best[best.length - 1];
  if (lastSmall === undefined) return null;

  // A larger purchase after the run, within a day of it.
  const larger = timeline
    .filter((t) => t.dt > lastSmall.dt && t.dt - lastSmall.dt <= DAY)
    .filter((t) => Math.abs(t.amount) > SMALL_AUTH_MAX * 2)
    .sort((a, b) => a.dt - b.dt);
  const followUp = larger[0];

  const affected = [...best, ...(followUp ? [followUp] : [])];
  const cleared = followUp !== undefined && Math.abs(followUp.amount) > CLEARED_PURCHASE_THRESHOLD;

  const evidence: PatternEvidence[] = [
    {
      claim:
        `${best.length} online authorizations of ${best.map((t) => money(Math.abs(t.amount))).join(', ')} ` +
        `on card ${flagged.cardId} within ${Math.round((lastSmall.dt - (best[0]?.dt ?? 0)) / 60)} minutes`,
      ref: `query:getCardTimeline(card_id=${flagged.cardId})`,
      entityIds: best.map((t) => t.txnId),
    },
  ];
  if (followUp) {
    evidence.push({
      claim:
        `followed by a ${money(Math.abs(followUp.amount))} ${followUp.channel} purchase ` +
        `${Math.round((followUp.dt - lastSmall.dt) / 60)} minutes later` +
        (cleared ? ', which has already cleared' : ''),
      ref: `query:getCardTimeline(card_id=${flagged.cardId})`,
      entityIds: [followUp.txnId],
    });
  }

  // The full sequence is the strongest form; the run alone is suggestive.
  const strength = followUp ? (best.length >= 4 ? 0.9 : 0.82) : 0.55;
  return { pattern: 'card_testing', strength, affectedTxnIds: affected.map((t) => t.txnId), evidence };
}

/**
 * Patterns 2 and 3, card-not-present fraud, optionally from a new device.
 * Online use with amounts or products that do not fit the cardholder's history,
 * often a burst of two to four within 48 hours. One unusual online purchase on
 * its own is explicitly ambiguous and must be verified, not blocked.
 */
export function detectCardNotPresent(
  timeline: readonly Txn[],
  flagged: Txn,
  profile: AccountProfile,
): PatternMatch | null {
  if (flagged.channel !== 'online') return null;

  const history = historyBefore(timeline, flagged);
  const evidence: PatternEvidence[] = [];
  let oddness = 0;

  // Amount out of line with their own history.
  if (history.length >= 10 && Math.abs(flagged.amount) > profile.medianAmount * 4) {
    oddness += 1;
    evidence.push({
      claim:
        `${money(Math.abs(flagged.amount))} is more than four times this cardholder's ` +
        `median transaction of ${money(profile.medianAmount)} across ${profile.nTransactions} transactions`,
      ref: `query:getAccountProfile(account_id=${profile.accountId})`,
      entityIds: [flagged.txnId],
    });
  }

  // A product code they have never used.
  const priorProducts = new Set(history.map((t) => t.productCd));
  if (history.length >= 10 && !priorProducts.has(flagged.productCd)) {
    oddness += 1;
    evidence.push({
      claim: `product code ${flagged.productCd} has never been used on this account before`,
      ref: `query:getAccountProfile(account_id=${profile.accountId})`,
      entityIds: [flagged.txnId],
    });
  }

  // A burst of online activity around the alert.
  const burst = windowAround(timeline, flagged, 2 * DAY).filter((t) => t.channel === 'online');
  if (burst.length >= 2 && burst.length <= 6) {
    oddness += 1;
    evidence.push({
      claim: `${burst.length} online transactions on this card within 48 hours, totalling ${money(sum(burst))}`,
      ref: `query:getCardTimeline(card_id=${flagged.cardId})`,
      entityIds: burst.map((t) => t.txnId),
    });
  }

  if (oddness === 0) return null;

  // Pattern 3 is the same shape with the device marked New for this account.
  const newDevice = flagged.deviceNew === 'New';
  const behindProxy = flagged.proxy !== '' && flagged.proxy !== 'transparent';
  if (newDevice) {
    evidence.push({
      claim:
        `the identity record marks the device "${flagged.deviceProfile}" as New for this account` +
        (behindProxy ? `, behind a ${flagged.proxy} proxy` : ''),
      ref: `query:getEntityNeighborhood(txn_id=${flagged.txnId})`,
      entityIds: [flagged.txnId, flagged.deviceProfile],
    });
  }

  const affected = burst.length >= 2 ? burst : [flagged];
  // A single odd purchase is ambiguous by definition, so it stays below the
  // 0.70 that policy R1 uses as its verify-before-blocking threshold.
  const base = oddness >= 3 ? 0.72 : oddness === 2 ? 0.58 : 0.42;
  const strength = newDevice ? Math.min(0.88, base + 0.15) : base;

  return {
    pattern: newDevice ? 'card_not_present_new_device' : 'card_not_present_fraud',
    strength,
    affectedTxnIds: affected.map((t) => t.txnId),
    evidence,
  };
}

/**
 * Pattern 4, out-of-region use. Card-present purchases in a billing region the
 * cardholder has no history in, while their normal activity continues at home.
 * Several days of purchases in one new region is a trip, not a clone, so the
 * concurrency with home activity is the whole signal.
 */
export function detectOutOfRegion(
  timeline: readonly Txn[],
  flagged: Txn,
  profile: AccountProfile,
): PatternMatch | null {
  if (flagged.channel !== 'in_person') return null;
  if (flagged.addr1 === '') return null;

  const history = historyBefore(timeline, flagged);
  if (history.length < 10) return null;

  const priorRegions = new Set(history.map((t) => t.addr1).filter((r) => r !== ''));
  if (priorRegions.has(flagged.addr1)) return null;

  const evidence: PatternEvidence[] = [
    {
      claim:
        `card-present purchase of ${money(Math.abs(flagged.amount))} in billing region ${flagged.addr1}, ` +
        `which this cardholder has never used across ${history.length} prior transactions in ` +
        `${priorRegions.size} other regions`,
      ref: `query:getAccountProfile(account_id=${profile.accountId})`,
      entityIds: [flagged.txnId],
    },
  ];

  // Same new region, nearby in time: is this a cluster or a one-off?
  const inNewRegion = windowAround(timeline, flagged, 7 * DAY).filter((t) => t.addr1 === flagged.addr1);
  const spanDays =
    inNewRegion.length > 1
      ? (Math.max(...inNewRegion.map((t) => t.dt)) - Math.min(...inNewRegion.map((t) => t.dt))) / DAY
      : 0;

  // Home activity continuing at the same time is what separates a cloned card
  // from a cardholder on a trip.
  const sameDayElsewhere = timeline.filter(
    (t) =>
      Math.abs(t.dt - flagged.dt) <= DAY &&
      t.addr1 !== '' &&
      t.addr1 !== flagged.addr1 &&
      priorRegions.has(t.addr1),
  );

  let strength = 0.45;
  if (sameDayElsewhere.length > 0) {
    strength = 0.8;
    evidence.push({
      claim:
        `activity continued in the cardholder's usual region${sameDayElsewhere.length > 1 ? 's' : ''} ` +
        `(${[...new Set(sameDayElsewhere.map((t) => t.addr1))].join(', ')}) within a day of the ` +
        `out-of-region purchase, so the card was in two places at once`,
      ref: `query:getCardTimeline(card_id=${flagged.cardId})`,
      entityIds: sameDayElsewhere.map((t) => t.txnId),
    });
  } else if (spanDays >= 2) {
    // Several days in one new region and nothing at home: a trip.
    strength = 0.2;
    evidence.push({
      claim:
        `${inNewRegion.length} purchases in region ${flagged.addr1} spread over ` +
        `${spanDays.toFixed(1)} days with no concurrent activity elsewhere, which is consistent ` +
        `with travel rather than a cloned card`,
      ref: `query:getCardTimeline(card_id=${flagged.cardId})`,
      entityIds: inNewRegion.map((t) => t.txnId),
    });
  }

  return {
    pattern: 'out_of_region_use',
    strength,
    affectedTxnIds: (sameDayElsewhere.length > 0 ? inNewRegion : [flagged]).map((t) => t.txnId),
    evidence,
  };
}

/**
 * Pattern 5, account takeover. Mixed-channel activity inconsistent with the
 * cardholder, often with device and match-flag anomalies, pointing to stolen
 * credentials rather than a stolen card number.
 */
export function detectAccountTakeover(
  timeline: readonly Txn[],
  flagged: Txn,
  profile: AccountProfile,
  sharedDevices: readonly SharedDeviceLink[],
): PatternMatch | null {
  const window = windowAround(timeline, flagged, 3 * DAY);
  if (window.length < 3) return null;

  const channels = new Set(window.map((t) => t.channel));
  const evidence: PatternEvidence[] = [];
  let signals = 0;

  // "Mixed-channel activity INCONSISTENT with the cardholder" is the definition,
  // so mixed channels only count when mixing is unusual for this account. Most
  // active cardholders use both channels routinely; counting that as a signal
  // fired this pattern on nearly every case.
  const history = historyBefore(timeline, flagged);
  const historicalOnlineShare =
    history.length > 0 ? history.filter((t) => t.channel === 'online').length / history.length : 0;
  const windowOnlineShare = window.filter((t) => t.channel === 'online').length / window.length;
  const channelShift = Math.abs(windowOnlineShare - historicalOnlineShare);
  const usesBothRoutinely = historicalOnlineShare > 0.15 && historicalOnlineShare < 0.85;

  if (channels.size > 1 && history.length >= 10 && !usesBothRoutinely && channelShift > 0.3) {
    signals += 1;
    evidence.push({
      claim:
        `${window.length} transactions across both channels within three days of the alert, ` +
        `against a history that is ${(historicalOnlineShare * 100).toFixed(0)}% online across ` +
        `${history.length} prior transactions`,
      ref: `query:getCardTimeline(card_id=${flagged.cardId})`,
      entityIds: window.map((t) => t.txnId),
    });
  }

  // Match-flag anomalies. Measured over the dataset, only match_status:0 and
  // :-1 are rare (0.3% of identity records combined). A blank is 46% and simply
  // means unknown, and match_status:1 is 12%. Counting anything other than :2
  // as anomalous fired this signal on the majority of transactions.
  const mismatched = window.filter(
    (t) => t.matchStatus === 'match_status:0' || t.matchStatus === 'match_status:-1',
  );
  if (mismatched.length > 0) {
    signals += 1;
    evidence.push({
      claim:
        `${mismatched.length} of those transactions carry identity match status ` +
        `${[...new Set(mismatched.map((t) => t.matchStatus))].join(', ')}, which appears on ` +
        `0.3% of identity records dataset-wide`,
      ref: `query:getEntityNeighborhood(txn_id=${flagged.txnId})`,
      entityIds: mismatched.map((t) => t.txnId),
    });
  }

  // A device marked New is 42.8% of all identity records, so on its own it is
  // not evidence: the README is explicit that people buy new phones. It counts
  // only when New is unusual for THIS cardholder.
  const newDevices = window.filter((t) => t.deviceNew === 'New');
  const historyWithDevice = history.filter((t) => t.deviceNew !== '');
  const historicalNewShare =
    historyWithDevice.length > 0
      ? historyWithDevice.filter((t) => t.deviceNew === 'New').length / historyWithDevice.length
      : 1;
  if (newDevices.length > 0 && historyWithDevice.length >= 5 && historicalNewShare < 0.3) {
    signals += 1;
    evidence.push({
      claim:
        `${newDevices.length} came from a device marked New for this account, against a history ` +
        `where only ${(historicalNewShare * 100).toFixed(0)}% of ${historyWithDevice.length} ` +
        `device-bearing transactions were new devices`,
      ref: `query:getEntityNeighborhood(txn_id=${flagged.txnId})`,
      entityIds: newDevices.map((t) => t.txnId),
    });
  }

  // A device this account shares with someone else, where the profile is
  // specific enough to identify a device at all.
  const strongLinks = sharedDevices.filter((l) => l.strength === 'strong');
  if (strongLinks.length > 0) {
    signals += 1;
    const link = strongLinks[0];
    if (link !== undefined) {
      evidence.push({
        claim:
          `a device profile on this account ("${link.deviceProfile}") is used by ` +
          `${strongLinks.length} other account${strongLinks.length > 1 ? 's' : ''} and only ` +
          `${link.nCardsOnProfile} cards dataset-wide, so it identifies a specific device`,
        ref: `query:findSharedDevicesAcrossAccounts(account_id=${profile.accountId})`,
        entityIds: strongLinks.slice(0, 5).map((l) => l.otherAccountId),
      });
    }
  }

  if (signals < 2) return null;
  const strength = signals >= 4 ? 0.84 : signals === 3 ? 0.68 : 0.5;
  return {
    pattern: 'account_takeover',
    strength,
    affectedTxnIds: window.map((t) => t.txnId),
    evidence,
  };
}

/**
 * A coordinated ring: one concrete device build used by many cardholders in a
 * tight window. This fits none of the five documented patterns, which are all
 * described from a single cardholder's point of view, so it reports
 * `undocumented` as policy rule R9 requires.
 *
 * HHG-014 is exactly this shape, and its trigger text says so: "several cards
 * this month show purchases from the same unusual device profile".
 */
export function detectDeviceRing(
  flagged: Txn,
  sharedDevices: readonly SharedDeviceLink[],
  cohortAccountIds: readonly string[],
): PatternMatch | null {
  const ringLinks = sharedDevices.filter(
    (l) => l.strength === 'ring' && l.deviceProfile === flagged.deviceProfile,
  );
  if (ringLinks.length === 0) return null;
  const link = ringLinks[0];
  if (link === undefined) return null;
  // A handful of cardholders on one handset is unremarkable; dozens inside a
  // month is not.
  if (cohortAccountIds.length < 5) return null;

  const evidence: PatternEvidence[] = [
    {
      claim:
        `the flagged transaction came from device profile "${flagged.deviceProfile}", a specific ` +
        `handset build used by ${link.nCardsOnProfile} cards dataset-wide and by ` +
        `${cohortAccountIds.length} different cardholders within a month of this alert`,
      ref: `query:findSharedDevicesAcrossAccounts(account_id=${flagged.accountId})`,
      entityIds: [flagged.txnId, flagged.deviceProfile, ...cohortAccountIds.slice(0, 10)],
    },
  ];
  if (flagged.deviceNew === 'New') {
    evidence.push({
      claim: `the identity record marks that device as New for this account`,
      ref: `query:getEntityNeighborhood(txn_id=${flagged.txnId})`,
      entityIds: [flagged.txnId],
    });
  }
  if (flagged.proxy !== '' && flagged.proxy.toUpperCase().includes('ANONYMOUS')) {
    evidence.push({
      claim: `the transaction was made behind an anonymous proxy (${flagged.proxy})`,
      ref: `query:getEntityNeighborhood(txn_id=${flagged.txnId})`,
      entityIds: [flagged.txnId],
    });
  }

  const strength = Math.min(0.9, 0.55 + Math.min(cohortAccountIds.length, 40) / 100 + evidence.length * 0.05);
  return {
    pattern: 'undocumented',
    strength,
    affectedTxnIds: [flagged.txnId],
    evidence,
    description:
      `A single concrete device build ("${flagged.deviceProfile}") is being used across ` +
      `${cohortAccountIds.length} unrelated cardholders within a one-month window, ` +
      `${flagged.deviceNew === 'New' ? 'appearing as a new device on each account' : 'across multiple accounts'}` +
      `${flagged.proxy.toUpperCase().includes('ANONYMOUS') ? ' and behind an anonymous proxy' : ''}. ` +
      `This is coordinated abuse from one origin rather than a compromise of any single cardholder, ` +
      `so it fits none of the five documented patterns, which are each defined from one ` +
      `cardholder's perspective. Found by pivoting from the flagged transaction to its device ` +
      `profile and back out to every other card that used it.`,
  };
}

/**
 * Runs every detector and returns the matches, strongest first. The caller
 * decides what to do with competing matches: the LLM reasoning layer picks the
 * pattern and the policy engine picks the action, so this stays purely
 * descriptive.
 */
export function detectAllPatterns(args: {
  readonly timeline: readonly Txn[];
  readonly flagged: Txn;
  readonly profile: AccountProfile;
  readonly sharedDevices: readonly SharedDeviceLink[];
  /** Accounts on the flagged transaction's device profile near its date. */
  readonly deviceCohort: readonly string[];
}): readonly PatternMatch[] {
  const { timeline, flagged, profile, sharedDevices, deviceCohort } = args;
  const matches = [
    detectCardTesting(timeline, flagged),
    detectCardNotPresent(timeline, flagged, profile),
    detectOutOfRegion(timeline, flagged, profile),
    detectAccountTakeover(timeline, flagged, profile, sharedDevices),
    detectDeviceRing(flagged, sharedDevices, deviceCohort),
  ].filter((m): m is PatternMatch => m !== null);
  return matches.sort((a, b) => b.strength - a.strength);
}
