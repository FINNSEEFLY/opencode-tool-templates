export const makeToolContext = (overrides: Record<string, unknown> = {}): any => ({
  sessionID: "ses_test",
  agent: "build",
  messageID: "msg_test",
  id: "call_test",
  signal: new AbortController().signal,
  progress: async () => {},
  ...overrides,
});
