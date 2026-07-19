export function buildCapabilityRegistry({dailyWork,invoice,enabled}) {
  const registry=[];
  if (enabled["daily-work"]) registry.push(dailyWork);
  if (enabled.invoice) registry.push(invoice);
  return registry;
}
