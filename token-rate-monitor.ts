/**
 * Token-Rate Monitor
 *
 * Mirrors Tarquinen/oc-tps for the pi powerline footer: a live tokens-per-second
 * gauge (5s sliding window), a session-average tokens/sec, and average
 * time-to-first-token (TTFT).
 *
 * Data sources (pi extension events):
 *  - message_start  (role = assistant): begin timing a generation (TTFT start).
 *  - message_update (assistantMessageEvent): streaming text/thinking deltas →
 *    live TPS in a 5s window + first-token timestamp.
 *  - message_end    (role = assistant): final usage.output + duration → session
 *    averages (avg TPS, avg TTFT).
 *
 * Not stateful across session reloads by design — it only tracks the live session.
 */

export interface TokenRateStats {
  /** Tokens/sec computed over the last ~5s of streaming; 0 when idle. */
  liveTps: number;
  /** Session mean tokens/sec across completed generations. */
  avgTps: number;
  /** Session mean time-to-first-token in milliseconds; 0 until a sample exists. */
  avgTtftMs: number;
  /** Whether a generation is currently streaming (deltas seen but not yet done). */
  isStreaming: boolean;
  /** Number of completed assistant generations included in the averages. */
  generationCount: number;
}

const LIVE_WINDOW_MS = 5000;
const FALLBACK_CHARS_PER_TOKEN = 4;

interface LiveSample {
  tokens: number;
  t: number;
}

interface UpdateEventLike {
  role?: string;
  type?: string;
  /** Incremental text for text_delta / thinking_delta. */
  delta?: string;
  /** The `partial` AssistantMessage carried by the stream event. */
  partial?: { usage?: { output?: number } };
}

export class TokenRateTracker {
  private liveWindow: LiveSample[] = [];
  private currentTokens = 0;

  // per-generation timing
  private genStartMs: number | null = null;
  private genFirstTokenMs: number | null = null;

  // session aggregates
  private totalGenOutput = 0;
  private totalGenMs = 0;
  private ttftSum = 0;
  private ttftCount = 0;

  liveTps = 0;
  avgTps = 0;
  avgTtftMs = 0;
  isStreaming = false;
  generationCount = 0;

  private now(): number {
    return Date.now();
  }

  private clearLiveWindow(): void {
    this.liveWindow = [];
    this.currentTokens = 0;
  }

  private pruneWindow(): void {
    const cutoff = this.now() - LIVE_WINDOW_MS;
    while (this.liveWindow.length > 0 && this.liveWindow[0].t < cutoff) {
      this.liveWindow.shift();
    }
  }

  private recomputeLiveTps(): void {
    this.pruneWindow();
    const n = this.liveWindow.length;
    if (n >= 2) {
      const oldest = this.liveWindow[0];
      const newest = this.liveWindow[n - 1];
      const dt = (newest.t - oldest.t) / 1000;
      const dtTokens = newest.tokens - oldest.tokens;
      this.liveTps = dt > 0 && dtTokens > 0 ? dtTokens / dt : 0;
    } else {
      this.liveTps = 0;
    }
  }

  /** message_start — begin timing a new assistant generation. */
  handleMessageStart(message: { role?: string }): void {
    if (message.role !== "assistant") return;
    this.clearLiveWindow();
    this.genStartMs = this.now();
    this.genFirstTokenMs = null;
  }

  /**
   * message_update — a streaming delta arrived.
   * Measures live TPS and records the time-to-first-token for this generation.
   */
  handleMessageUpdate(update: UpdateEventLike): void {
    if (update.role !== "assistant") return;

    const isTextDelta = update.type === "text_delta";
    const isThinkingDelta = update.type === "thinking_delta";
    const isTokenStreaming = isTextDelta || isThinkingDelta;

    if (isTokenStreaming && this.genStartMs != null && this.genFirstTokenMs == null) {
      this.genFirstTokenMs = this.now();
    }

    // Advance the cumulative token counter. Prefer the provider's streamed usage
    // when it actually advances; otherwise fall back to a character estimate so
    // providers that don't stream usage still get a live gauge.
    const usageOutput = update.partial?.usage?.output;
    if (typeof usageOutput === "number" && usageOutput > this.currentTokens) {
      this.currentTokens = usageOutput;
    } else if (typeof update.delta === "string" && update.delta.length > 0) {
      this.currentTokens += update.delta.length / FALLBACK_CHARS_PER_TOKEN;
    }

    this.liveWindow.push({ tokens: this.currentTokens, t: this.now() });
    this.isStreaming = true;
    this.recomputeLiveTps();
  }

  /**
   * message_end — finalize the current assistant generation and fold it into the
   * session averages (avg TPS, avg TTFT).
   */
  handleMessageEnd(message: { role?: string; usage?: { output?: number } }): void {
    if (message.role !== "assistant") return;

    const endMs = this.now();
    const output =
      typeof message.usage?.output === "number" && message.usage.output > 0
        ? message.usage.output
        : this.currentTokens;

    if (this.genStartMs != null) {
      const durationMs = endMs - this.genStartMs;
      if (durationMs > 0 && output > 0) {
        this.totalGenOutput += output;
        this.totalGenMs += durationMs;
        this.generationCount += 1;
        this.avgTps = (this.totalGenOutput / this.totalGenMs) * 1000;
      }
      if (this.genFirstTokenMs != null) {
        const ttft = this.genFirstTokenMs - this.genStartMs;
        if (ttft >= 0) {
          this.ttftSum += ttft;
          this.ttftCount += 1;
          this.avgTtftMs = this.ttftSum / this.ttftCount;
        }
      }
    }

    this.liveTps = 0;
    this.isStreaming = false;
    this.genStartMs = null;
    this.genFirstTokenMs = null;
    this.clearLiveWindow();
  }

  getStats(): TokenRateStats {
    return {
      liveTps: this.liveTps,
      avgTps: this.avgTps,
      avgTtftMs: this.avgTtftMs,
      isStreaming: this.isStreaming,
      generationCount: this.generationCount,
    };
  }
}