export function createDailyWorkCapability({service}) {
  return {
    name: "daily-work",
    handle: (message,context) => service.handleMessage(message,context)
  };
}
