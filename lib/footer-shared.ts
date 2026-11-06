/**
 * Shared footer infrastructure for Pi extensions.
 *
 * Lives in `extensions/lib/` — a subdirectory WITHOUT index.ts, so pi's
 * extension discovery does not load it as an extension on its own.
 *
 * Multiple extensions can replace the built-in footer and still coexist:
 * each one calls installSharedFooter(ctx) (idempotent in effect — every
 * installation renders from the live registry) and registers named parts
 * that are appended at the end of the stats line, after the context usage.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface FooterPart {
	text: string;
	color?: "accent" | "success" | "warning" | "error";
}

interface RegisteredExtra {
	order: number;
	provide(): FooterPart | null;
}

const G = globalThis as Record<string, unknown>;

function registry(): Map<string, RegisteredExtra> {
	let map = G.__piFooterExtras as Map<string, RegisteredExtra> | undefined;
	if (!map) {
		map = new Map();
		G.__piFooterExtras = map;
	}
	return map;
}

/** Register (or replace) a footer part. `order` controls position: ascending. */
export function registerFooterExtra(key: string, order: number, provide: () => FooterPart | null): void {
	registry().set(key, { order, provide });
}

/** Force the active shared footer to re-render now (no-op if none is installed). */
export function requestFooterRender(): void {
	const tui = G.__piFooterTui as { requestRender?(): void } | undefined;
	tui?.requestRender?.();
}

// ---------------------------------------------------------------------------
// Formatting helpers (mirrors the built-in footer)
// ---------------------------------------------------------------------------

export function formatTokens(count: number): string {
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

// ---------------------------------------------------------------------------
// Footer installation
// ---------------------------------------------------------------------------

/**
 * Install the shared footer (built-in lookalike + registered extras at the end
 * of the stats line). Safe to call from multiple extensions: every instance
 * renders from the same live registry, so whichever installation is active
 * shows all parts.
 */
export function installSharedFooter(ctx: ExtensionContext): void {
	let statsCache: { key: string; totals: Totals } | undefined;

	ctx.ui.setFooter((tui, theme, footerData) => {
		G.__piFooterTui = tui;
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

				// --- stats line: token totals + context % + extras | model ---
				const entries = ctx.sessionManager.getEntries();
				const key = `${ctx.sessionManager.getLeafId()}:${entries.length}:${ctx.model?.id ?? ""}`;
				if (!statsCache || statsCache.key !== key) {
					statsCache = { key, totals: computeTotals(entries) };
				}
				const t = statsCache.totals;

				type Part = FooterPart;
				const parts: Part[] = [];
				if (t.input) parts.push({ text: `↑${formatTokens(t.input)}` });
				if (t.output) parts.push({ text: `↓${formatTokens(t.output)}` });
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

				// Registered extension parts (e.g. tok/s counters), in order
				const extras = Array.from(registry().values()).sort((a, b) => a.order - b.order);
				for (const extra of extras) {
					try {
						const part = extra.provide();
						if (part && part.text) parts.push(part);
					} catch {
						/* a failing provider must not break the footer */
					}
				}

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
}
