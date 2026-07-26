export function buildCapabilityRegistry({
  dailyWork,invoice,knowledgeIngest,assistantWork,contracts,enabled
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
  if (enabled["assistant-work"]) {
    if (!assistantWork||assistantWork.name!=="assistant-work"||
        typeof assistantWork.handle!=="function"||
        contracts["assistant-work"]?.capability!=="assistant-work"||
        contracts["assistant-work"]?.supports_continuation!==true) {
      throw new Error("invalid_capability_registry");
    }
    registry.push({
      ...assistantWork,
      routingContract:structuredClone(contracts["assistant-work"])
    });
  }
  return registry;
}
