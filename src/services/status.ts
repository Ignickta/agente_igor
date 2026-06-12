interface ErrorLog {
  timestamp: string;
  message: string;
  subagent?: string;
}

let lastMessageProcessedAt = "";
const recentErrors: ErrorLog[] = [];
const startedAt = new Date().toISOString();

export function recordMessageProcessed(): void {
  lastMessageProcessedAt = new Date().toISOString();
}

export function recordError(message: string, subagent?: string): void {
  recentErrors.unshift({
    timestamp: new Date().toISOString(),
    message,
    subagent
  });
  if (recentErrors.length > 10) {
    recentErrors.pop();
  }
}

export function getUptimeSeconds(): number {
  return Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
}

export function getRecentErrors(): ErrorLog[] {
  return recentErrors;
}

export function getLastMessageProcessedAt(): string {
  return lastMessageProcessedAt;
}

export { startedAt };
