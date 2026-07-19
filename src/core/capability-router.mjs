export function routeCapability(event, context, capabilities) {
  if (!Array.isArray(capabilities)) throw new Error("invalid_capabilities");
  const matches = capabilities.filter(capability => {
    if (!capability || typeof capability.name !== "string" || !capability.name || typeof capability.match !== "function") {
      throw new Error("invalid_capability");
    }
    return capability.match(event, context) === true;
  });
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  const names = matches.map(item => item.name).sort().join(",");
  throw new Error(`route_conflict:${names}`);
}
