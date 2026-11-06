/**
 * tok-speed — live inference speed in the footer stats line.
 *
 * Replaces the built-in footer with a lookalike that inserts a tokens/sec
 * counter on the same line as the token and context usage counters (after
 * the output-token count). While an assistant response streams, shows a live
 * estimate; after it finalizes, re-computes from provider-reported usage when
 * available and keeps that value until the next response starts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatCwd(cwd: string, home?: string): string {
	if (!home) return cwd;
	const rel = cwd.startsWith(home + "/") ? cwd.slice(home.length + 1) : "";
	return rel === "" ? "~" : rel ? `~/${rel}` : cwd;
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

interface Totals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	latestCacheHitRate?: number;
}

function addUsage(t: Totals, u: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } }) {
	t.input += u.input ?? 0;
	t.output += u.output ?? 0;
	t.cacheRead += u.cacheRead ?? 0;
	t.cacheWrite += u.cacheWrite ?? 0;
	t.cost += u.cost?.total ?? 0;
}

/** Same accounting as the built-in footer: all session entries, not just the branch. */
function computeTotals(entries: unknown[]): Totals {
	const t: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, any>;
		if (e.type === "usage" && e.usage) addUsage(t, e.usage);
		else if (e.type === "message" && e.message?.role === "assistant") {
			addUsage(t, e.message.usage ?? {});
			const prompt = (e.message.usage?.input ?? 0) + (e.message.usage?.cacheRead ?? 0) + (e.message.usage?.cacheWrite ?? 0);
			t.latestCacheHitRate = prompt > 0 ? ((e.message.usage.cacheRead ?? 0) / prompt) * 100 : undefined;
		} else if (e.type === "message" && e.message?.role === "toolResult" && e.message.usage) addUsage(t, e.message.usage);
		else if ((e.type === "branch_summary" || e.type === "compaction") && e.usage) addUsage(t, e.usage);
	}
	return t;
}

export default function (pi: ExtensionAPI) {
	let streamStart = 0; // Date.now() when the current assistant message started
	let firstTokenAt = 0; // when output tokens first appeared (excludes time-to-first-token)
	let lastRender = 0;
	let rate: number | null = null; // latest computed tok/s
	let finalRate = false; // true once computed from a finalized message
	let tuiRef: { requestRender(): void } | undefined; // set by the footer factory

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
		if (ctx.mode !== "tui") return;

		let statsCache: { key: string; totals: Totals } | undefined;

		ctx.ui.setFooter((tui, theme, footerData) => {
			tuiRef = tui;
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					// --- pwd line (dim) ---
					let pwd = formatCwd(ctx.cwd, process.env.HOME || process.env.USERPROFILE);
					const branch = footerData.getGitBranch();
					if (branch) pwd += ` (${branch})`;
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd += ` • ${sessionName}`;

					// --- stats line: token totals + tok/s + context % | model ---
					const entries = ctx.sessionManager.getEntries();
					const key = `${ctx.sessionManager.getLeafId()}:${entries.length}:${ctx.model?.id ?? ""}`;
					if (!statsCache || statsCache.key !== key) {
						statsCache = { key, totals: computeTotals(entries) };
					}
					const t = statsCache.totals;

					type Part = { text: string; color?: "accent" | "success" | "warning" | "error" };
					const parts: Part[] = [];
					if (t.input) parts.push({ text: `↑${formatTokens(t.input)}` });
					if (t.output) parts.push({ text: `↓${formatTokens(t.output)}` });

					// tok/s counter, right after the output tokens
					if (rate !== null) {
						const label = finalRate ? `${rate.toFixed(1)} tok/s` : `~${Math.round(rate)} tok/s`;
						parts.push({ text: `⚡ ${label}`, color: finalRate ? "success" : "accent" });
					}

					if (t.cacheRead) parts.push({ text: `R${formatTokens(t.cacheRead)}` });
					if (t.cacheWrite) parts.push({ text: `W${formatTokens(t.cacheWrite)}` });
					if ((t.cacheRead > 0 || t.cacheWrite > 0) && t.latestCacheHitRate !== undefined) {
						parts.push({ text: `CH${t.latestCacheHitRate.toFixed(1)}%` });
					}
					if (t.cost > 0) parts.push({ text: `$${t.cost.toFixed(3)}` });

					const contextWindow = ctx.model?.contextWindow ?? 0;
					const percent = ctx.getContextUsage()?.percent;
					const display = `${percent === null || percent === undefined ? "?" : percent.toFixed(1)}%/${formatTokens(contextWindow)}`;
					parts.push({ text: display, color: (percent ?? 0) > 90 ? "error" : (percent ?? 0) > 70 ? "warning" : undefined });

					const left = parts.map((p) => (p.color ? theme.fg(p.color, p.text) : theme.fg("dim", p.text))).join(" ");

					let right = ctx.model?.id || "no-model";
					if (ctx.thinkingLevel && ctx.thinkingLevel !== "off") right += ` • ${ctx.thinkingLevel}`;
					right = theme.fg("dim", right);

					const leftW = visibleWidth(left);
					const rightW = visibleWidth(right);
					let line: string;
					if (leftW + 2 + rightW <= width) {
						line = left + " ".repeat(width - leftW - rightW) + right;
					} else if (width - leftW > 2) {
						const avail = width - leftW - 2;
						line = left + "  " + truncateToWidth(right, avail, "");
					} else {
						line = truncateToWidth(left, width, "...");
					}

					const lines = [truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")), line];

					// Keep other extensions' setStatus() lines working
					const statuses = footerData.getExtensionStatuses();
					if (statuses.size > 0) {
						const statusLine = Array.from(statuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatusText(text))
							.join(" ");
						lines.push(truncateToWidth(theme.fg("dim", statusLine), width, theme.fg("dim", "...")));
					}
					return lines;
				},
			};
		});
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
		tuiRef?.requestRender();
	});

	pi.on("message_end", async (event) => {
		const msg = event.message as AssistantLike | undefined;
		if (!msg || msg.role !== "assistant") return;
		if (!streamStart) streamStart = Date.now();

		rate = computeRate(currentTokens(msg));
		finalRate = true;
		tuiRef?.requestRender();
	});
}
