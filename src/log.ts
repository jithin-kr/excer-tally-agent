// Timestamped logging.
//
// The agent runs as a Windows Service with stdout/stderr redirected to files by NSSM. Those files
// are the only record of what happened on a machine we cannot easily reach, so every line carries
// an ISO timestamp — "when did the agent post this voucher?" must be answerable from the log alone.

function line(tag: string, message: string): string {
  return `${new Date().toISOString()} [${tag}] ${message}`;
}

export const log = {
  info(tag: string, message: string): void {
    console.log(line(tag, message));
  },
  warn(tag: string, message: string): void {
    console.warn(line(tag, message));
  },
  error(tag: string, message: string): void {
    console.error(line(tag, message));
  },
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
