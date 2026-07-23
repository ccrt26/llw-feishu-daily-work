export function buildCapabilityRegistry({dailyWork,invoice,contracts,enabled}) {
  const registry=[];
  if (enabled["daily-work"]) registry.push({...dailyWork,routingContract:structuredClone(contracts["daily-work"])});
  if (enabled.invoice) registry.push({...invoice,routingContract:structuredClone(contracts.invoice)});
  return registry;
}
