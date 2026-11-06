/**
 * tok-speed — live decode speed and prefill speed in the Pi footer stats line.
 *
 * Uses the shared footer from ./lib/footer-shared.ts and registers two
 * counters appended at the end of the stats line:
 *
 *   S<value>ts    — decode speed (output tokens/sec), rounded integer
 *   PFL<value>ts  — prefill speed (input tokens/sec), rounded integer
 *
 * Both show a placeholder (`S--ts`, `PFL--ts`) until the first measurement,
 * an accent-colored live estimate while streaming, and a green exact value
 * once the response finalizes.
 *
 * Decode measurement:
 *   - tokens: provider-reported cumulative usage.output when available,
 *     otherwise estimated from the growing partial message (~4 chars/token);
 *   - timing: first output token → last (excludes time-to-first-token);
 *     falls back to request start for very short responses (<0.5 s).
 *
 * Prefill measurement (per provider call):
 *   t0      = before_provider_headers (right before the HTTP request; falls
 *             back to before_provider_request if the headers hook does not fire)
 *   t_first = first output token observed on the assistant stream
 *   prefill time = t_first - t0  (includes network RTT + provider queueing,
 *                  so for cloud APIs this is "apparent" prefill speed)
 *   tokens  = live: estimate from serialized request payload (~4 chars/token)
 *             final: exact usage.input + cacheRead + cacheWrite on message_end
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installSharedFooter, registerFooterExtra, requestFooterRender } from "./lib/footer-shared";

const CHARS_PER_TOKEN = 4; // rough heuristic for live estimates
const RENDER_INTERVAL_MS = 250;
const MIN_PREFILL_MS = 25; // ignore implausibly short prefill windows (retries, local echo)

type AssistantLike = {
	role: string;
	content?: unknown[];
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | null;
};

function estimateOutputTokens(msg: AssistantLike): number {
	let chars = 0;
	for (const block of msg.content ?? []) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		switch (b.type) {
			case "text":
				if (typeof b.text === "string") chars += b.text.length;
				break;
			case "thinking":
				if (typeof b.thinking === "string") chars += b.thinking.length;
				break;
			case "toolCall":
				try {
					chars += JSON.stringify(b.arguments ?? {}).length;
				} catch {
					/* ignore unserializable arguments */
				}
				break;
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

export default function (pi: ExtensionAPI) {
	// --- decode speed state ---
	let streamStart = 0; // Date.now() when the current assistant message started
	let firstTokenAt = 0; // when output tokens first appeared (excludes time-to-first-token)
	let lastRender = 0;
	let rate: number | null = null; // latest computed decode tok/s
	let finalRate = false; // true once computed from a finalized message

	// --- prefill speed state (per provider call) ---
	let t0 = 0; // request start anchor (ms, Date.now())
	let estInputTokens = 0; // payload-based estimate of input tokens for this call
	let pflFirstTokenAt = 0; // when the first output token appeared for this call
	let prefillMs: number | null = null; // fixed once the first token arrives
	let failed = false; // non-2xx response for this call
	let pflFinalRate: number | null = null; // exact rate from finalized usage

	function resetPrefill() {
		t0 = 0;
		estInputTokens = 0;
		pflFirstTokenAt = 0;
		prefillMs = null;
		failed = false;
		pflFinalRate = null; // drop the previous call's value: show placeholder until measured
	}

	function currentTokens(msg: AssistantLike): number {
		return (msg.usage?.output ?? 0) > 0 ? msg.usage!.output! : estimateOutputTokens(msg);
	}

	function computeDecodeRate(tokens: number): number | null {
		const genSec = firstTokenAt ? (Date.now() - firstTokenAt) / 1000 : 0;
		const elapsedSec = genSec >= 0.5 ? genSec : (Date.now() - streamStart) / 1000;
		if (tokens <= 0 || elapsedSec < 0.25) return null;
		return tokens / elapsedSec;
	}

	pi.on("session_start", async (_event, ctx) => {
		streamStart = 0;
		rate = null;
		finalRate = false;
		resetPrefill();

		registerFooterExtra(
			"tok-speed",
			100,
			() => {
				if (rate === null) return { text: "S--ts" }; // placeholder
				const value = Math.round(rate); // round, don't truncate
				return finalRate ? { text: `S${value}ts`, color: "success" } : { text: `S${value}ts`, color: "accent" };
			},
		);

		registerFooterExtra(
			"pfl-speed",
			200, // after the decode counter: PFL sits at the very end of the line
			() => {
				if (pflFinalRate !== null) return { text: `PFL${Math.round(pflFinalRate)}ts`, color: "success" };
				if (prefillMs !== null && estInputTokens > 0) {
					const estimate = estInputTokens / (prefillMs / 1000);
					return { text: `PFL${Math.max(1, Math.round(estimate))}ts`, color: "accent" };
				}
				return { text: "PFL--ts" }; // placeholder until first measurement
			},
		);

		if (ctx.mode === "tui") installSharedFooter(ctx);
	});

	pi.on("before_provider_request", async (event) => {
		resetPrefill();
		try {
			const payload = event.payload;
			if (payload !== undefined && payload !== null) estInputTokens = Math.ceil(JSON.stringify(payload).length / CHARS_PER_TOKEN);
		} catch {
			estInputTokens = 0;
		}
		t0 = Date.now(); // fallback anchor if the headers hook does not fire
	});

	pi.on("before_provider_headers", async () => {
		if (t0) t0 = Date.now(); // tighter anchor: right before the HTTP call
	});

	pi.on("after_provider_response", async (event) => {
		failed = event.status >= 400;
	});

	pi.on("message_start", async (event) => {
		const msg = event.message as AssistantLike | undefined;
		if (!msg || msg.role !== "assistant") return;
		streamStart = Date.now();
		firstTokenAt = 0;
		rate = null;
		finalRate = false;
	});

	pi.on("message_update", async (event) => {
		const msg = event.message as AssistantLike | undefined;
		if (!msg || msg.role !== "assistant") return;
		if (!streamStart) streamStart = Date.now();

		const tokens = currentTokens(msg);
		if (tokens > 0 && !firstTokenAt) firstTokenAt = Date.now();

		// prefill: fix the measurement window on the first output token
		if (t0 && tokens > 0 && pflFirstTokenAt === 0) {
			pflFirstTokenAt = Date.now();
			prefillMs = pflFirstTokenAt - t0;
		}

		const now = Date.now();
		if (now - lastRender < RENDER_INTERVAL_MS) return;
		lastRender = now;

		rate = computeDecodeRate(tokens);
		finalRate = false;
		requestFooterRender();
	});

	pi.on("message_end", async (event) => {
		const msg = event.message as AssistantLike | undefined;
		if (!msg || msg.role !== "assistant") return;
		if (!streamStart) streamStart = Date.now();

		rate = computeDecodeRate(currentTokens(msg));
		finalRate = true;

		const u = msg.usage;
		if (u && prefillMs !== null && !failed && pflFirstTokenAt) {
			const inputTokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
			pflFinalRate = inputTokens > 0 && prefillMs >= MIN_PREFILL_MS ? inputTokens / (prefillMs / 1000) : null;
		}

		requestFooterRender();
	});
}
