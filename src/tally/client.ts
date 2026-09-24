// Thin HTTP client around the Tally Prime XML gateway.

import { request } from "undici";
import { loadConfig, TallyConfig } from "./config.js";
import { isFailureEnvelope, parseTallyXml } from "./xml.js";

export class TallyClient {
  /**
   * EXCER ADDITION: every request is queued behind the previous one.
   *
   * Tally handles one request at a time per company, and a heavy one freezes the operator's
   * screen. The poll loop, the voucher pushes and the doctor all share this client, so this chain
   * is the single place that guarantees we never stack requests on top of each other.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(public readonly config: TallyConfig = loadConfig()) {}

  /** POST a Tally XML envelope and return the raw response body. Requests run one at a time. */
  send(xml: string): Promise<string> {
    const next = this.queue.then(() => this.sendNow(xml));
    // Keep the chain alive after a failure — one rejected request must not poison the rest.
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async sendNow(xml: string): Promise<string> {
    // The timeout starts when the request actually goes out, not while it waits in the queue.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await request(this.config.url, {
        method: "POST",
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          "Content-Length": Buffer.byteLength(xml, "utf8").toString(),
        },
        body: xml,
        signal: controller.signal,
      });
      const body = await res.body.text();
      if (res.statusCode >= 400) {
        throw new Error(
          `Tally HTTP ${res.statusCode}: ${body.slice(0, 500)}`
        );
      }
      const failure = isFailureEnvelope(body);
      if (failure.failed) {
        throw new Error(
          `Tally returned failure status` +
            (failure.reason ? `: ${failure.reason}` : "")
        );
      }
      return body;
    } catch (err: any) {
      if (err?.name === "AbortError") {
        throw new Error(
          `Tally request timed out after ${this.config.timeoutMs}ms (host ${this.config.url}).`
        );
      }
      // Friendly hint for the most common failure: gateway not enabled.
      if (
        err?.code === "ECONNREFUSED" ||
        err?.cause?.code === "ECONNREFUSED"
      ) {
        throw new Error(
          `Could not connect to Tally at ${this.config.url}. ` +
            `Open Tally Prime, then F1 (Help) > Settings > Connectivity > Client/Server configuration. ` +
            `Set "TallyPrime acts as = Both / Server" and Port = ${this.config.port}.`
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Convenience: send + parse to JS object. */
  async sendAndParse(xml: string): Promise<any> {
    const body = await this.send(xml);
    return parseTallyXml(body);
  }
}
