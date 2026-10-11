/**
 * Application-side domain inventory composition.
 *
 * Pass the tenant-visible result of `McpClient.listEntityTypes()`. This helper
 * performs no network request and is not an authorization boundary.
 */

export type VisibleTypeInventory = Record<string, unknown>;

export interface DomainTypeCount {
  type: string;
  rows: number;
}

export interface DomainSummary {
  domain: string;
  total_rows: number;
  types: DomainTypeCount[];
  suggested_queries: string[];
}

export interface DomainSummaryResult {
  domain: string;
  summaries: DomainSummary[];
}

const PROFILES: ReadonlyArray<DomainSummary> = [
  {
    domain: "financial",
    types: ["BankAccount", "FinancialTransaction", "CryptoWallet", "AmlAlert", "Transaction", "WireTransferHop"].map((type) => ({ type, rows: 0 })),
    suggested_queries: [
      "SELECT * FROM FinancialTransaction ORDER BY amount DESC LIMIT 20",
      "SELECT * FROM AmlAlert WHERE risk_score > 70 LIMIT 10",
      "SELECT * FROM CryptoWallet LIMIT 20",
    ],
    total_rows: 0,
  },
  {
    domain: "telco",
    types: ["MsisdnRecord", "CallRecord", "CdrRecord", "ImsiRecord", "TowerDump"].map((type) => ({ type, rows: 0 })),
    suggested_queries: ["SELECT * FROM CallRecord LIMIT 20", "SELECT * FROM MsisdnRecord LIMIT 20", "SELECT * FROM TowerDump LIMIT 10"],
    total_rows: 0,
  },
  {
    domain: "cyber",
    types: ["ThreatIndicator", "MalwareRecord", "DomainRecord", "NetworkEvent", "IpAddress"].map((type) => ({ type, rows: 0 })),
    suggested_queries: [
      "SELECT * FROM ThreatIndicator WHERE threat_score > 50 LIMIT 20",
      "SELECT * FROM MalwareRecord LIMIT 10",
      "SELECT * FROM NetworkEvent LIMIT 20",
    ],
    total_rows: 0,
  },
  {
    domain: "humint",
    types: ["SourceReport", "DocumentSource", "CaseFile"].map((type) => ({ type, rows: 0 })),
    suggested_queries: ["SELECT * FROM DocumentSource LIMIT 10", "SELECT * FROM CaseFile LIMIT 10", "SELECT * FROM SourceReport LIMIT 10"],
    total_rows: 0,
  },
  {
    domain: "narcotics",
    types: ["Person", "Organization", "CaseFile", "Transaction", "Vehicle"].map((type) => ({ type, rows: 0 })),
    suggested_queries: ["SELECT * FROM Person LIMIT 20"],
    total_rows: 0,
  },
  {
    domain: "fara",
    types: ["Person", "Organization", "Transaction", "SanctionEntry", "PepRecord"].map((type) => ({ type, rows: 0 })),
    suggested_queries: ["SELECT * FROM Person LIMIT 20"],
    total_rows: 0,
  },
  {
    domain: "maritime",
    types: ["VesselRecord", "FlightRecord", "Location"].map((type) => ({ type, rows: 0 })),
    suggested_queries: ["SELECT * FROM Person LIMIT 20"],
    total_rows: 0,
  },
  {
    domain: "border",
    types: ["PassportRecord", "VisaRecord", "BorderCrossing", "Person"].map((type) => ({ type, rows: 0 })),
    suggested_queries: ["SELECT * FROM Person LIMIT 20"],
    total_rows: 0,
  },
  {
    domain: "sanctions",
    types: ["SanctionEntry", "WatchlistEntry", "PepRecord", "Person", "Organization"].map((type) => ({ type, rows: 0 })),
    suggested_queries: ["SELECT * FROM SanctionEntry LIMIT 20", "SELECT * FROM WatchlistEntry WHERE status = 'active' LIMIT 20", "SELECT * FROM PepRecord LIMIT 10"],
    total_rows: 0,
  },
];

const VALID_DOMAINS = [...PROFILES.map((profile) => profile.domain), "all"];

/** Compose the former domain-summary shape from caller-visible type metadata. */
export function summarizeDomain(domain: string, inventory: VisibleTypeInventory): DomainSummaryResult {
  if (!VALID_DOMAINS.includes(domain)) {
    throw new RangeError(`unknown domain: ${domain}. Valid: ${VALID_DOMAINS.join(", ")}`);
  }
  const counts = new Map<string, number>();
  const rawTypes = inventory["types"];
  if (rawTypes !== undefined && !Array.isArray(rawTypes)) {
    throw new TypeError("list_entity_types inventory must contain a types array");
  }
  for (const rawItem of (rawTypes ?? []) as unknown[]) {
    const item = rawItem as Record<string, unknown> | null;
    if (
      !item ||
      typeof item["type"] !== "string" ||
      !Number.isSafeInteger(item["rows"]) ||
      (item["rows"] as number) < 0
    ) {
      throw new TypeError("list_entity_types inventory must contain { type, rows } entries");
    }
    counts.set(item["type"] as string, item["rows"] as number);
  }
  const selected = PROFILES.filter((profile) => domain === "all" || profile.domain === domain);
  const summaries = selected.map((profile) => {
    const types = profile.types.map(({ type }) => ({ type, rows: counts.get(type) ?? 0 }));
    return {
      domain: profile.domain,
      types,
      total_rows: types.reduce((sum, item) => sum + item.rows, 0),
      suggested_queries: [...profile.suggested_queries],
    };
  });
  return { domain, summaries };
}
