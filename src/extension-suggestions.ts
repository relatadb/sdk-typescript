/**
 * Application-side extension recommendations composed from the result of
 * `McpClient.listEntityTypes()`. This helper makes no request and is not an
 * authorization boundary; `no_data` means no matching type name occurs in
 * the supplied inventory, not that a package is globally absent.
 */

export interface ExtensionInventory {
  types: unknown[];
}

export interface ExtensionSuggestion {
  pack: string;
  relevance: "no_data" | "partial" | "full";
  active_types: string[];
  all_types: string[];
}

export interface ExtensionSuggestions {
  extensions: ExtensionSuggestion[];
  store_types: string[];
}

const PROFILES: ReadonlyArray<{ pack: string; types: readonly string[] }> = [
  { pack: "telco", types: ["MsisdnRecord", "CallRecord", "CdrRecord", "ImsiRecord", "TowerDump"] },
  { pack: "finint", types: ["BankAccount", "FinancialTransaction", "CryptoWallet", "AmlAlert", "WireTransferHop"] },
  { pack: "fara", types: ["Organization", "Transaction", "SanctionEntry", "PepRecord"] },
  { pack: "cyber", types: ["ThreatIndicator", "MalwareRecord", "DomainRecord", "NetworkEvent"] },
  { pack: "maritime", types: ["VesselRecord", "FlightRecord"] },
  { pack: "border", types: ["PassportRecord", "VisaRecord", "BorderCrossing"] },
];

/** Compose the former `suggest_extensions` result from a supplied inventory. */
export function suggestExtensions(inventory: unknown): ExtensionSuggestions {
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) {
    throw new TypeError("list_entity_types result must be an object with a types array");
  }
  const rawTypes = (inventory as ExtensionInventory).types;
  if (!Array.isArray(rawTypes)) {
    throw new TypeError("list_entity_types result must contain a types array");
  }
  const storeTypes = rawTypes.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TypeError("list_entity_types entries must be objects");
    }
    const item = raw as Record<string, unknown>;
    if (typeof item["type"] !== "string" || !Number.isSafeInteger(item["rows"]) || (item["rows"] as number) < 0) {
      throw new TypeError("list_entity_types entries must contain { type, rows }");
    }
    return item["type"] as string;
  });
  const present = new Set(storeTypes);
  const extensions = PROFILES.map(({ pack, types }) => {
    const active = types.filter((name) => present.has(name));
    const relevance: ExtensionSuggestion["relevance"] = active.length === 0
      ? "no_data"
      : active.length === types.length ? "full" : "partial";
    return { pack, relevance, active_types: active, all_types: [...types] };
  });
  return { extensions, store_types: storeTypes };
}
