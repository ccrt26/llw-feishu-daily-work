export function buildCapabilityRegistry({
  dailyWork,invoice,knowledgeIngest,contracts,enabled
}) {
  const registry=[];
  if (enabled["daily-work"]) registry.push({...dailyWork,routingContract:structuredClone(contracts["daily-work"])});
  if (enabled.invoice) registry.push({...invoice,routingContract:structuredClone(contracts.invoice)});
  if (enabled["knowledge-ingest"]) {
    if (!knowledgeIngest||knowledgeIngest.name!=="knowledge-ingest"||
        typeof knowledgeIngest.handle!=="function"||
        contracts["knowledge-ingest"]?.capability!=="knowledge-ingest") {
      throw new Error("invalid_capability_registry");
    }
    registry.push({
      ...knowledgeIngest,
      routingContract:structuredClone(contracts["knowledge-ingest"])
    });
  }
  return registry;
}
