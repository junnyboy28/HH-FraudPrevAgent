// The shape of everything the investigation can learn about a case, and the
// interface that supplies it.
//
// Two implementations exist. `TigerGraphEvidenceSource` runs the GSQL queries in
// graph/queries/ and is what the submission uses. `LocalEvidenceSource` reads
// the prepared CSVs in graph/load/prepared/ and exists so the orchestrator,
// pattern detection and answer-file writer can be built and tested without a
// live database. Both must return identical shapes.

/** One transaction as the investigation sees it. */
export interface Txn {
  readonly txnId: string;
  readonly accountId: string;
  readonly cardId: string;
  /** Seconds from the dataset start. Use for gaps and ordering. */
  readonly dt: number;
  /** "YYYY-MM-DD HH:MM:SS". */
  readonly ts: string;
  readonly amount: number;
  readonly productCd: string;
  /** "in_person" (product code W) or "online". */
  readonly channel: string;
  readonly riskScore: number;
  /** Billing region code (addr1), "" when absent. */
  readonly addr1: string;
  /** Billing country code (addr2). 87 is the home country. */
  readonly addr2: string;
  readonly pEmailDomain: string;
  readonly hasIdentity: boolean;
  /** "DeviceInfo | OS | browser | screen", "" for in-person. */
  readonly deviceProfile: string;
  /** id_15: "New" or "Found" for this account, "" when unknown. */
  readonly deviceNew: string;
  /** id_23: proxy status. */
  readonly proxy: string;
  /** id_34: match status. */
  readonly matchStatus: string;
}

/** A cardholder's baseline behaviour, used for "does not fit their history". */
export interface AccountProfile {
  readonly accountId: string;
  readonly cardIds: readonly string[];
  readonly nTransactions: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly regionsUsed: readonly string[];
  readonly channelsUsed: readonly string[];
  readonly productCodesUsed: readonly string[];
  readonly emailDomainsUsed: readonly string[];
  readonly deviceProfilesUsed: readonly string[];
  readonly minAmount: number;
  readonly maxAmount: number;
  readonly medianAmount: number;
}

/**
 * How much identifying power a shared device profile actually has.
 *
 * The profile key is "DeviceInfo | OS | browser | screen", which the answer
 * format requires, but that is a device *description* and not a fingerprint.
 * Measured over the dataset: 2,251 profiles are shared by 2 to 3 cards (a real
 * signal), while 961 are shared by 11 or more, and one empty profile
 * (" | | |") covers 1,013 cards. Treating the generic ones as identity would
 * invent fraud rings out of everyone who owns the same laptop.
 */
export type DeviceLinkStrength = 'strong' | 'ring' | 'moderate' | 'generic';

/** A device profile shared between this account and another. */
export interface SharedDeviceLink {
  readonly deviceProfile: string;
  readonly otherAccountId: string;
  readonly nTransactions: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  /** How many cards in the whole dataset use this profile. */
  readonly nCardsOnProfile: number;
  /**
   * True when the DeviceInfo component names a concrete device build
   * ("SM-G935F Build/NRD90M") rather than a platform ("Windows", "iOS Device").
   * This is what decides whether a high card count is a fraud ring or just a
   * popular laptop.
   */
  readonly isConcreteDevice: boolean;
  /**
   * 'strong' when few cards share the profile (a genuinely shared device),
   * 'ring' when a concrete device build is shared by many cardholders,
   * 'moderate' otherwise, 'generic' for profiles that identify nothing.
   */
  readonly strength: DeviceLinkStrength;
}

/** One of the bank's 5,565 finished investigations. */
export interface ClosedCase {
  readonly caseId: string;
  readonly accountId: string;
  readonly cardId: string;
  readonly openedAt: string;
  readonly closedAt: string;
  /** "confirmed_fraud" or "cleared". */
  readonly outcome: string;
  /** One of the seven pattern values, or "none" for cleared cases. */
  readonly pattern: string;
  readonly firstFraudTxnId: string;
  readonly txnIds: readonly string[];
  readonly exposureUsd: number;
  readonly connectedCardIds: readonly string[];
  readonly actionsTaken: readonly string[];
  readonly reportFiled: string;
  readonly analystNotes: string;
}

/** A closed case retrieved as memory, with why it was retrieved. */
export interface SimilarCase extends ClosedCase {
  readonly score: number;
  readonly basis: readonly string[];
}

/** Prior confirmed fraud reachable from this account. */
export interface LinkedFraud {
  readonly direct: readonly ClosedCase[];
  readonly viaSharedDevice: readonly ClosedCase[];
}

/** The local subgraph around a flagged transaction. */
export interface Neighborhood {
  readonly flagged: Txn;
  readonly cardId: string;
  readonly accountId: string;
  readonly siblingCardIds: readonly string[];
  readonly deviceProfile: string;
  readonly region: string;
  readonly emailDomain: string;
  /** Accounts reached through the same device profile. */
  readonly deviceLinkedAccountIds: readonly string[];
  /** Closed cases that already involve this exact transaction. */
  readonly existingCaseIds: readonly string[];
}

/** One of the 20 exam cases. */
export interface CasePackEntry {
  readonly caseId: string;
  readonly openedAt: string;
  /** "risk_score", "customer_report" or "analyst_request". */
  readonly triggerType: string;
  readonly triggerText: string;
  readonly flaggedTxnId: string;
  readonly cardId: string;
  readonly customerId: string;
  /** Filled only for risk_score triggers, otherwise null. */
  readonly riskScore: number | null;
}

/**
 * Everything the investigation can ask. Each method maps to one query in
 * graph/queries/, so `evidence[].ref` in the answer file can name its source.
 */
export interface EvidenceSource {
  /** Which backend this is, for the record in the case trace. */
  readonly kind: 'tigergraph' | 'local-csv';

  /** graph/queries/getEntityNeighborhood.gsql */
  getEntityNeighborhood(txnId: string): Promise<Neighborhood>;

  /** graph/queries/getCardTimeline.gsql */
  getCardTimeline(cardId: string): Promise<readonly Txn[]>;

  /** graph/queries/getAccountProfile.gsql */
  getAccountProfile(accountId: string): Promise<AccountProfile>;

  /** graph/queries/findSharedDevicesAcrossAccounts.gsql */
  findSharedDevicesAcrossAccounts(accountId: string): Promise<readonly SharedDeviceLink[]>;

  /** graph/queries/findLinkedFraudHistory.gsql */
  findLinkedFraudHistory(accountId: string): Promise<LinkedFraud>;

  /** graph/queries/findSimilarClosedCases.gsql */
  findSimilarClosedCases(
    accountId: string,
    pattern: string,
    region: string,
    topK: number,
  ): Promise<readonly SimilarCase[]>;

  /**
   * Accounts active on a device profile within `days` of a timestamp. Policy R6
   * turns on several cards showing one origin "in one window", so the cohort
   * matters more than the lifetime card count.
   */
  getDeviceCohort(deviceProfile: string, aroundTs: string, days: number): Promise<readonly string[]>;

  /** The 20 exam cases from case_pack.csv. */
  getCasePack(): Promise<readonly CasePackEntry[]>;

  /** True when the id exists in the dataset. Every id in an answer file must. */
  txnExists(txnId: string): Promise<boolean>;
}
