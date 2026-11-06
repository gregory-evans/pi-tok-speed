/**
 * tok-speed — live inference speed in the Pi footer stats line.
 *
 * Uses the shared footer from ../lib/footer-shared.ts and registers a
 * tokens/sec counter that is appended at the end of the stats line (after
 * the context usage). Shows a "-- tok/s" placeholder until the first
 * measurement; while an assistant response streams, shows a live estimate;
 * after it finalizes, re-computes from provider-reported usage when available
 * and keeps that value until the next response starts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installSharedFooter, registerFooterExtra } from "./lib/footer-shared";

const CHARS_PER_TOKEN = 4; // rough heuristic for the live estimate
const RENDER_INTERVAL_MS = 250;

type AssistantLike = {
	role: string;
	content?: unknown[];
	usage?: { output?: number } | null;
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
	let streamStart = 0; // Date.now() when the current assistant message started
	let firstTokenAt = 0; // when output tokens first appeared (excludes time-to-first-token)
	let lastRender = 0;
	let rate: number | null = null; // latest computed tok/s
	let finalRate = false; // true once computed from a finalized message

	function currentTokens(msg: AssistantLike): number {
		return (msg.usage?.output ?? 0) > 0 ? msg.usage!.output! : estimateOutputTokens(msg);
	}

	function computeRate(tokens: number): number | null {
		const genSec = firstTokenAt ? (Date.now() - firstTokenAt) / 1000 : 0;
		const elapsedSec = genSec >= 0.5 ? genSec : (Date.now() - streamStart) / 1000;
		if (tokens <= 0 || elapsedSec < 0.25) return null;
		return tokens / elapsedSec;
	}

	pi.on("session_start", async (_event, ctx) => {
		streamStart = 0;
		rate = null;
		finalRate = false;

		registerFooterExtra(
			"tok-speed",
			100,
			() =>
				rate === null
					? { text: "-- tok/s" }
					: finalRate
						? { text: `${rate.toFixed(1)} tok/s`, color: "success" }
						: { text: `~${Math.round(rate)} tok/s`, color: "accent" },
		);

		if (ctx.mode === "tui") installSharedFooter(ctx);
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

		const now = Date.now();
		if (now - lastRender < RENDER_INTERVAL_MS) return;
		lastRender = now;

		rate = computeRate(tokens);
		finalRate = false;
	});

	pi.on("message_end", async (event) => {
		const msg = event.message as AssistantLike | undefined;
		if (!msg || msg.role !== "assistant") return;
		if (!streamStart) streamStart = Date.now();

		rate = computeRate(currentTokens(msg));
		finalRate = true;
	});
}
