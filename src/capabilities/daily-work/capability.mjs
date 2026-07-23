export function createDailyWorkCapability({service}) {
  return {
    name: "daily-work",
    handle: message => service.handleMessage(message)
  };
}
