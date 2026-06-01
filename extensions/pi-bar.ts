/**
 * pi-bar — footer / statusline extension.
 *
 * Replaces pi's built-in footer with left-aligned segments:
 *   <directory> ❯ <model> ❯ think:<level> ❯ <context% / window> ❯ <tokens/s>
 *
 * Example:
 *   foo  ❯  claude-opus-4.7  ❯  think:med  ❯  2.6% / 1.0M  ❯  45 t/s
 *
 * Re-renders on model change, thinking-level change, status updates, and after
 * each assistant turn so context usage stays current.
 *
 * Environment variables:
 *   PI_BAR_SHOW     comma-separated list of segments to show
 *   PI_BAR_CONFIG   override the persisted pi-bar config path
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type AssistantMessageEvent } from "@earendil-works/pi-ai";
import {
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SettingItem,
  SettingsList,
  truncateToWidth,
} from "@earendil-works/pi-tui";

type SegmentName = "directory" | "model" | "thinking" | "context" | "tokens";
type GlobalBarConfig = {
  segments?: SegmentName[];
};

const CONFIG_PATH =
  process.env.PI_BAR_CONFIG ?? join(homedir(), ".pi", "agent", "pi-bar.json");

const DEFAULT_SEGMENTS: SegmentName[] = [
  "directory",
  "model",
  "thinking",
  "context",
  "tokens",
];
const ALL_SEGMENTS: readonly SegmentName[] = [
  "directory",
  "model",
  "thinking",
  "context",
  "tokens",
];
const SEGMENT_LABELS: Record<SegmentName, string> = {
  directory: "CWD",
  model: "Model",
  thinking: "Thinking level",
  context: "Context usage",
  tokens: "Tokens/s",
};
const SEGMENT_SEPARATOR = "❯";

function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const value = n / 1_000_000;
    return value >= 10 ? `${Math.round(value)}M` : `${value.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const value = n / 1_000;
    return value >= 10 ? `${Math.round(value)}k` : `${value.toFixed(1)}k`;
  }
  return `${n}`;
}

function formatCwd(cwd: string, homeDir: string): string {
  if (cwd === homeDir) return "~";
  if (cwd === "/") return "/";
  const base = cwd.split("/").filter(Boolean).pop() ?? cwd;
  return truncateToWidth(base, 20);
}

function formatModelName(id: string | undefined): string {
  if (!id) return "no-model";
  const base = id.includes("/") ? (id.split("/").pop() ?? id) : id;
  return base.replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

function thinkingColor(level: string): ThemeColor {
  switch (level) {
    case "off":
      return "thinkingOff";
    case "minimal":
    case "min":
      return "thinkingMinimal";
    case "low":
      return "thinkingLow";
    case "medium":
    case "med":
      return "thinkingMedium";
    case "high":
      return "thinkingHigh";
    case "xhigh":
    case "extra-high":
      return "thinkingXhigh";
    default:
      return "thinkingText";
  }
}

function isSegmentName(value: string): value is SegmentName {
  return (ALL_SEGMENTS as readonly string[]).includes(value);
}

function parseSegments(): SegmentName[] {
  const raw = process.env.PI_BAR_SHOW;
  if (!raw) return DEFAULT_SEGMENTS;

  const requested = raw
    .split(",")
    .map((segment) => segment.trim().toLowerCase())
    .filter(isSegmentName);

  return requested.length > 0 ? requested : DEFAULT_SEGMENTS;
}

function serializeSegments(segments: readonly SegmentName[]): SegmentName[] {
  return ALL_SEGMENTS.filter((segment) => segments.includes(segment));
}

function parseSerializedSegments(value: unknown): SegmentName[] | null {
  if (!Array.isArray(value)) return null;
  const segments = value.filter(
    (segment): segment is SegmentName => typeof segment === "string" && isSegmentName(segment),
  );
  return serializeSegments(segments);
}

function splitSegmentNames(raw: string): SegmentName[] {
  return raw
    .split(/[\s,]+/)
    .map((segment) => segment.trim().toLowerCase())
    .filter(isSegmentName);
}

function describeSegments(segments: readonly SegmentName[]): string {
  if (segments.length === 0) return "showing none";
  return `showing: ${segments.map((segment) => SEGMENT_LABELS[segment]).join(", ")}`;
}

function readGlobalConfig(): GlobalBarConfig {
  try {
    const data = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
    return {
      segments: parseSerializedSegments(data.segments) ?? undefined,
    };
  } catch {
    return {};
  }
}

function readGlobalSegments(): SegmentName[] {
  const fromConfig = process.env.PI_BAR_SHOW ? parseSegments() : (readGlobalConfig().segments ?? null);
  // Union with defaults so new default segments (e.g. tokens) are always included
  // even when an older persisted config is present.
  if (fromConfig) {
    return Array.from(new Set([...DEFAULT_SEGMENTS, ...fromConfig]));
  }
  return DEFAULT_SEGMENTS;
}

function writeGlobalConfig(config: GlobalBarConfig): void {
  const data = JSON.stringify(config, null, 2);
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  const tmpPath = `${CONFIG_PATH}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${data}\n`, "utf8");
  renameSync(tmpPath, CONFIG_PATH);
}

function writeGlobalSegments(segments: readonly SegmentName[]): void {
  const existing = readGlobalConfig();
  writeGlobalConfig({ ...existing, segments: serializeSegments(segments) });
}

/* HSL → RGB, returns {r, g, b} in [0,255]. */
function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r1 = 0, g1 = 0, b1 = 0;
  if (h < 60) { r1 = c; g1 = x; }
  else if (h < 120) { r1 = x; g1 = c; }
  else if (h < 180) { g1 = c; b1 = x; }
  else if (h < 240) { g1 = x; b1 = c; }
  else if (h < 300) { r1 = x; b1 = c; }
  else { r1 = c; g1 = x; }
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

/* Gradient from red (1 t/s) → yellow (mid) → bright green (≥ceiling t/s). */
function tokenRateAnsiColor(rate: number, ceiling: number): string {
  const t = Math.max(0, Math.min(1, (Math.max(1, rate) - 1) / (ceiling - 1)));
  const hue = 120 * t; // 0 (red) → 120 (green)
  const { r, g, b } = hslToRgb(hue, 1, 0.55);
  return `\x1b[38;2;${r};${g};${b}m`;
}

/* Gradient from bright green (0%) → yellow (~50%) → red (100%). */
function contextAnsiColor(percent: number): string {
  const t = Math.max(0, Math.min(1, percent / 100));
  const hue = 120 * (1 - t); // 120 (green) → 0 (red)
  const { r, g, b } = hslToRgb(hue, 1, 0.55);
  return `\x1b[38;2;${r};${g};${b}m`;
}

// Rough token estimate from accumulated text content.
// ~4 chars/token is a common average for English; good enough for a live rate display.
const CHARS_PER_TOKEN = 4;

function estimateTokensFromContent(content: readonly unknown[] | undefined): number {
  if (!content) return 0;
  let charCount = 0;
  for (const part of content) {
    if (part && typeof part === "object") {
      const record = part as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") {
        charCount += record.text.length;
      }
      if (record.type === "thinking" && typeof record.thinking === "string") {
        charCount += record.thinking.length;
      }
      if (record.type === "toolCall") {
        charCount += String(record.name ?? "").length;
        if (record.arguments) {
          try { charCount += JSON.stringify(record.arguments).length; } catch { /* skip */ }
        }
      }
    }
  }
  return Math.max(1, Math.round(charCount / CHARS_PER_TOKEN));
}

class TokenRateTracker {
  private emaRate = 0;
  private lastTokenCount = 0;
  private lastTimestamp = 0;
  private _isStreaming = false;
  // Session-level average: total tokens / total streaming time (seconds).
  private _totalTokens = 0;
  private _totalStreamingSeconds = 0;
  // Per-turn streaming time: accumulated only between token arrivals
  // (dTokens > 0), so idle gaps and tool-execution time are excluded.
  private _turnStreamingSeconds = 0;
  // Per-turn deltas for snapshot (appended as session entry at message_end).
  private _turnDeltaTokens = 0;
  private _turnDeltaSeconds = 0;
  private _destroyed = false;

  get isStreaming(): boolean { return this._isStreaming; }
  get rate(): number { return this.emaRate; }
  get sum(): number { return this._totalTokens; }
  get count(): number { return this._totalStreamingSeconds; }

  start(): void {
    if (this._destroyed) return;
    this._isStreaming = true;
    this.lastTokenCount = 0;
    this.lastTimestamp = 0;
    this.emaRate = 0;
    this._turnStreamingSeconds = 0;
  }

  record(event: AssistantMessageEvent): void {
    if (event.type !== "text_delta" && event.type !== "thinking_delta" && event.type !== "toolcall_delta") return;
    if (!this._isStreaming) this.start();
    const now = performance.now();
    const usageTokens = event.partial.usage.output ?? 0;
    const charEstimate = estimateTokensFromContent(event.partial.content);
    const tokens = Math.max(usageTokens, charEstimate);
    if (this.lastTimestamp > 0) {
      const dt = Math.max(0.05, (now - this.lastTimestamp) / 1000);
      const dTokens = tokens - this.lastTokenCount;
      if (dTokens > 0) {
        const instant = dTokens / dt;
        this.emaRate = 0.15 * instant + 0.85 * this.emaRate;
        // Accumulate actual elapsed time (no floor) only when tokens arrive.
        this._turnStreamingSeconds += (now - this.lastTimestamp) / 1000;
      }
    }
    this.lastTimestamp = now;
    this.lastTokenCount = tokens;
  }

  stop(): void {
    this._isStreaming = false;
    const turnTokens = this.lastTokenCount;
    const turnSeconds = this._turnStreamingSeconds;
    if (turnTokens > 0 && turnSeconds > 0) {
      this._totalTokens += turnTokens;
      this._totalStreamingSeconds += turnSeconds;
      this._turnDeltaTokens = turnTokens;
      this._turnDeltaSeconds = turnSeconds;
    } else {
      this._turnDeltaTokens = 0;
      this._turnDeltaSeconds = 0;
    }
  }

  resetTiming(): void {
    this.lastTimestamp = 0;
  }

  destroy(): void {
    this._destroyed = true;
    this._isStreaming = false;
  }

  snapshot(): { sum: number; count: number } {
    return { sum: this._turnDeltaTokens, count: this._turnDeltaSeconds };
  }

  restore(sum: number, count: number): void {
    this._totalTokens = sum;
    this._totalStreamingSeconds = count;
  }
}

export default function (pi: ExtensionAPI) {
  let requestRender: (() => void) | undefined;
  let visibleSegments: SegmentName[] = readGlobalSegments();
  const refresh = () => requestRender?.();
  const tracker = new TokenRateTracker();

  const setVisibleSegments = (segments: readonly SegmentName[]) => {
    visibleSegments = serializeSegments(segments);
    writeGlobalSegments(visibleSegments);
    refresh();
  };

  const openSegmentConfigurator = async (ctx: ExtensionContext) => {
    await ctx.ui.custom((tui, theme, _kb, done) => {
      const segmentVisibility = new Map(
        ALL_SEGMENTS.map(
          (segment): [SegmentName, boolean] => [segment, visibleSegments.includes(segment)],
        ),
      );
      const persistSegmentsFromVisibility = () => {
        setVisibleSegments(
          ALL_SEGMENTS.filter((segment) => segmentVisibility.get(segment)),
        );
      };

      const segmentItems: SettingItem[] = ALL_SEGMENTS.map((segment): SettingItem => ({
        id: `segment:${segment}`,
        label: SEGMENT_LABELS[segment],
        description: "Footer segment visibility",
        currentValue: segmentVisibility.get(segment) ? "shown" : "hidden",
        values: ["shown", "hidden"],
      }));

      const container = new Container();
      container.addChild(
        new (class {
          render(_width: number) {
            return [
              theme.fg("accent", theme.bold("pi-bar visibility")),
              theme.fg("dim", "Footer segments · Enter/Space toggles · Esc closes"),
              "",
            ];
          }
          invalidate() {}
        })(),
      );

      const settingsList = new SettingsList(
        segmentItems,
        Math.min(segmentItems.length + 2, 18),
        getSettingsListTheme(),
        (id, newValue) => {
          if (id.startsWith("segment:")) {
            const segment = id.slice("segment:".length);
            if (!isSegmentName(segment)) return;
            segmentVisibility.set(segment, newValue === "shown");
            persistSegmentsFromVisibility();
          }
        },
        () => done(undefined),
        { enableSearch: true },
      );

      container.addChild(settingsList);

      return {
        render(width: number) {
          return container.render(width);
        },
        invalidate() {
          container.invalidate();
        },
        handleInput(data: string) {
          settingsList.handleInput?.(data);
          tui.requestRender();
        },
      };
    });
  };

  pi.registerCommand("bar", {
    description: "Configure pi-bar footer visibility",
    handler: async (args, ctx) => {
      const [section, action, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (!section || section === "config" || section === "configure" || section === "edit") {
        await openSegmentConfigurator(ctx);
        return;
      }
      if (section === "list" || section === "ls") {
        ctx.ui.notify(`pi-bar footer: ${describeSegments(visibleSegments)}`, "info");
        return;
      }

      if (section === "segment" || section === "segments" || section === "footer") {
        const segments = splitSegmentNames(rest.join(" "));
        if ((action === "only" || action === "show" || action === "hide") && segments.length === 0) {
          ctx.ui.notify(
            `Segments: ${ALL_SEGMENTS.join(", ")}`,
            "warning",
          );
          return;
        }

        switch (action) {
          case undefined:
          case "config":
          case "configure":
          case "edit":
            await openSegmentConfigurator(ctx);
            return;
          case "list":
          case "ls":
            ctx.ui.notify(`pi-bar footer: ${describeSegments(visibleSegments)}`, "info");
            return;
          case "all":
            setVisibleSegments(ALL_SEGMENTS);
            break;
          case "none":
            setVisibleSegments([]);
            break;
          case "only":
            setVisibleSegments(segments);
            break;
          case "hide":
            setVisibleSegments(
              visibleSegments.filter((segment) => !segments.includes(segment)),
            );
            break;
          case "show":
            setVisibleSegments([...visibleSegments, ...segments]);
            break;
          default:
            ctx.ui.notify(
              "Usage: /bar [config] or /bar segments [list|all|none|only <segments>|show <segments>|hide <segments>]",
              "warning",
            );
            return;
        }

        ctx.ui.notify(`pi-bar footer: ${describeSegments(visibleSegments)}`, "info");
        return;
      }

      ctx.ui.notify(
        "Usage: /bar [config] or /bar segments [list|all|none|only <segments>|show <segments>|hide <segments>]",
        "warning",
      );
    },
  });

  pi.on("model_select", async () => refresh());
  pi.on("thinking_level_select", async () => refresh());
  pi.on("turn_end", async () => refresh());
  pi.on("message_start", async (event) => {
    if (visibleSegments.includes("tokens") && event.message?.role === "assistant") {
      tracker.start();
    }
  });
  pi.on("message_update", async (event) => {
    if (visibleSegments.includes("tokens")) tracker.record(event.assistantMessageEvent);
    refresh();
  });
  pi.on("tool_call", async () => {
    if (visibleSegments.includes("tokens")) tracker.resetTiming();
  });
  pi.on("message_end", async (event) => {
    if (visibleSegments.includes("tokens") && event.message?.role === "assistant") {
      tracker.stop();
      const snap = tracker.snapshot();
      if (snap.count > 0) {
        pi.appendEntry("pi-bar-token-avg", snap);
      }
    }
    refresh();
  });
  pi.on("session_before_tree", async () => {
    tracker.stop();
  });

  pi.on("session_start", async (_event, ctx) => {
    visibleSegments = readGlobalSegments();

    // Restore session-lifetime token average from prior entries.
    let totalSum = 0,
      totalCount = 0;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "pi-bar-token-avg") {
        const data = entry.data as { sum?: number; count?: number };
        totalSum += data.sum ?? 0;
        totalCount += data.count ?? 0;
      }
    }
    if (totalCount > 0) tracker.restore(totalSum, totalCount);

    if (!ctx.hasUI) return;

    ctx.ui.setFooter((tui, theme) => {
      requestRender = () => tui.requestRender();

      return {
        dispose() {
          requestRender = undefined;
        },
        invalidate() {},
        render(width: number): string[] {
          const modelName = formatModelName(ctx.model?.id);
          const thinkingLevel = String(pi.getThinkingLevel());
          const usage = ctx.getContextUsage();

          const contextText = usage
            ? `${usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "—%"} / ${formatTokens(usage.contextWindow)}`
            : "—";
          const contextSegmentText = usage?.percent !== null
            ? contextAnsiColor(usage.percent) + contextText + "\x1b[0m"
            : theme.fg("dim", contextText);

          const rawAvgRate = tracker.count > 0 ? tracker.sum / tracker.count : null;
          const gradientCeiling = Math.max(2, rawAvgRate != null ? rawAvgRate : 20);
          const avgRate = rawAvgRate != null ? Math.round(rawAvgRate) : null;
          const avgText = avgRate != null ? `${avgRate} t/s` : `- t/s`;

          const instantRate = tracker.isStreaming && tracker.rate > 0 ? tracker.rate : null;
          const instantText = tracker.isStreaming
            ? `${Math.round(tracker.rate)} t/s`
            : `- t/s`;

          let tokenSegmentText: string;
          if (instantRate != null) {
            tokenSegmentText = tokenRateAnsiColor(instantRate, gradientCeiling) + instantText + "\x1b[0m"
              + ` ${theme.fg("muted", "/")} ${theme.fg("muted", avgText)}`;
          } else {
            tokenSegmentText = theme.fg("muted", `${instantText} / ${avgText}`);
          }

          const segmentRenderers: Record<SegmentName, string | null> = {
            directory: theme.fg("accent", formatCwd(ctx.cwd, homedir())),
            model: theme.fg("accent", modelName),
            thinking: theme.fg(thinkingColor(thinkingLevel), `think:${thinkingLevel}`),
            context: contextSegmentText,
            tokens: tokenSegmentText,
          };

          const separator = `  ${theme.fg("muted", SEGMENT_SEPARATOR)}  `;
          const line = visibleSegments
            .map((segment) => segmentRenderers[segment])
            .filter((segment): segment is string => segment !== null)
            .join(separator);

          return [truncateToWidth(line, width)];
        },
      };
    });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    tracker.destroy();
    if (ctx.hasUI) ctx.ui.setFooter(undefined);
  });
}
