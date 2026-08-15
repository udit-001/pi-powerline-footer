import type { ExtensionAPI, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

import type { ColorScheme, CodexUsageSummary, SegmentContext, StatusLinePreset, StatusLineSegmentId } from "./types.js";
import { getPreset, PRESETS } from "./presets.js";
import { getSeparator } from "./separators.js";
import { renderSegment } from "./segments.js";
import { getGitStatus, invalidateGitStatus, invalidateGitBranch } from "./git-status.js";
import { ansi, getFgAnsiCode } from "./colors.js";
import { getDefaultColors } from "./theme.js";
import { fetchCodexUsageSummary, fetchZaiUsageSummary } from "./usage-monitor.js";
import { TokenRateTracker } from "./token-rate-monitor.js";

type UsageProvider = "zai" | "openai";

function getProviderFromModelId(modelId: string | undefined): UsageProvider {
  const id = (modelId || "").toLowerCase().trim();
  if (id.startsWith("glm")) return "zai";
  if (id.startsWith("gpt")) return "openai";
  if (id.includes("z.ai") || id.startsWith("zai/") || id.startsWith("z.ai/")) return "zai";
  return "openai";
}

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

interface PowerlineConfig {
  preset: StatusLinePreset;
  disabledSegments: StatusLineSegmentId[];
  customSegments?: StatusLineSegmentId[];
}

let config: PowerlineConfig = {
  preset: "default",
  disabledSegments: [],
};

// Canonical order of every selectable segment.
const ALL_SEGMENTS: StatusLineSegmentId[] = [
  "pi", "model", "thinking", "path", "git", "subagents", "extension_statuses",
  "context_pct", "context_total", "token_in", "token_out", "token_total",
  "cache_read", "cache_write", "usage_status", "token_rate",
  "time_spent", "time", "session", "hostname",
];

// Human labels for the segment picker.
const SEGMENT_LABELS: Record<StatusLineSegmentId, string> = {
  pi: "Pi logo",
  model: "Model",
  thinking: "Thinking level",
  path: "Folder",
  git: "Git",
  subagents: "Subagents",
  extension_statuses: "Extension status",
  context_pct: "Context used",
  context_total: "Context total",
  token_in: "Tokens in",
  token_out: "Tokens out",
  token_total: "Tokens total",
  cache_read: "Cache read",
  cache_write: "Cache write",
  usage_status: "Usage",
  token_rate: "Speed",
  time_spent: "Elapsed time",
  time: "Clock",
  session: "Session ID",
  hostname: "Machine",
};

// Grouping for the picker (headers).
const SEGMENT_GROUPS: { title: string; ids: StatusLineSegmentId[] }[] = [
  { title: "Identity", ids: ["pi", "model", "path", "session", "hostname"] },
  { title: "Activity", ids: ["thinking", "git", "subagents", "extension_statuses"] },
  { title: "Context", ids: ["context_pct", "context_total"] },
  { title: "Tokens", ids: ["token_in", "token_out", "token_total", "cache_read", "cache_write"] },
  { title: "Usage & speed", ids: ["usage_status", "token_rate", "time_spent", "time"] },
];

// Single source of truth: the ordered list to render.
// A custom list overrides; otherwise the preset minus disabled segments.
function getEffectiveSegments(): StatusLineSegmentId[] {
  if (config.customSegments) return config.customSegments;
  const def = getPreset(config.preset);
  const base = [...def.leftSegments, ...def.rightSegments, ...(def.secondarySegments ?? [])];
  return base.filter((s) => !config.disabledSegments.includes(s));
}

// ─── Persistence (settings.json → powerline key) ────────────────────────────
function getSettingsPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homeDir, ".pi", "agent");
  return join(agentDir, "settings.json");
}

function readPersistedPowerline(): Partial<PowerlineConfig> | null {
  const settingsPath = getSettingsPath();
  try {
    if (!existsSync(settingsPath)) return null;
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const pw = settings?.powerline;
    if (!pw || typeof pw !== "object" || Array.isArray(pw)) return null;

    const out: Partial<PowerlineConfig> = {};
    const presetVal = pw.preset;
    if (typeof presetVal === "string" && (Object.keys(PRESETS) as string[]).includes(presetVal)) {
      out.preset = presetVal as StatusLinePreset;
    }
    if (Array.isArray(pw.disabledSegments)) {
      out.disabledSegments = pw.disabledSegments.filter(
        (s): s is StatusLineSegmentId => typeof s === "string" && ALL_SEGMENTS.includes(s as StatusLineSegmentId)
      );
    }
    if (Array.isArray(pw.customSegments) && pw.customSegments.length > 0) {
      const segs = pw.customSegments.filter(
        (s): s is StatusLineSegmentId => typeof s === "string" && ALL_SEGMENTS.includes(s as StatusLineSegmentId)
      );
      if (segs.length > 0) out.customSegments = segs;
    }
    return out;
  } catch {
    return null;
  }
}

function persistPowerlineConfig(): boolean {
  const settingsPath = getSettingsPath();
  let settings: Record<string, unknown> = {};
  try {
    if (existsSync(settingsPath)) {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        settings = parsed as Record<string, unknown>;
      }
    }
  } catch {
    return false;
  }
  settings.powerline = {
    preset: config.preset,
    disabledSegments: config.disabledSegments,
    customSegments: config.customSegments,
  };
  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Status Line Builder
// ═══════════════════════════════════════════════════════════════════════════

/** Render a single segment and return its content with width */
function renderSegmentWithWidth(
  segId: StatusLineSegmentId,
  ctx: SegmentContext
): { content: string; width: number; visible: boolean } {
  const rendered = renderSegment(segId, ctx);
  if (!rendered.visible || !rendered.content) {
    return { content: "", width: 0, visible: false };
  }
  return { content: rendered.content, width: visibleWidth(rendered.content), visible: true };
}

/** Build content string from pre-rendered parts */
function buildContentFromParts(
  parts: string[],
  presetDef: ReturnType<typeof getPreset>
): string {
  if (parts.length === 0) return "";
  const separatorDef = getSeparator(presetDef.separator);
  const sepAnsi = getFgAnsiCode("sep");
  const sep = separatorDef.left;
  return " " + parts.join(` ${sepAnsi}${sep}${ansi.reset} `) + ansi.reset + " ";
}

/**
 * Responsive segment layout - fits segments into top bar, overflows to secondary row.
 * When terminal is wide enough, secondary segments move up to top bar.
 * When narrow, top bar segments overflow down to secondary row.
 */
function computeResponsiveLayout(
  ctx: SegmentContext,
  presetDef: ReturnType<typeof getPreset>,
  availableWidth: number
): { topContent: string; secondaryContent: string } {
  const separatorDef = getSeparator(presetDef.separator);
  const sepWidth = visibleWidth(separatorDef.left) + 2; // separator + spaces around it
  
  // The full ordered list; the layout auto-splits top bar vs second row by width.
  const segmentIds = getEffectiveSegments();
  
  // Render all segments and get their widths
  const renderedSegments: { id: StatusLineSegmentId; content: string; width: number }[] = [];
  for (const segId of segmentIds) {
    const { content, width, visible } = renderSegmentWithWidth(segId, ctx);
    if (visible) {
      renderedSegments.push({ id: segId, content, width });
    }
  }
  
  if (renderedSegments.length === 0) {
    return { topContent: "", secondaryContent: "" };
  }
  
  // Calculate how many segments fit in top bar
  // Account for: leading space (1) + trailing space (1) = 2 chars overhead
  const baseOverhead = 2;
  let currentWidth = baseOverhead;
  let topSegments: string[] = [];
  let secondarySegments: string[] = [];
  let overflow = false;
  
  for (let i = 0; i < renderedSegments.length; i++) {
    const seg = renderedSegments[i];
    // Width needed: segment width + separator (except for first segment)
    const neededWidth = seg.width + (topSegments.length > 0 ? sepWidth : 0);
    
    if (!overflow && currentWidth + neededWidth <= availableWidth) {
      // Fits in top bar
      topSegments.push(seg.content);
      currentWidth += neededWidth;
    } else {
      // Overflow to secondary row
      overflow = true;
      secondarySegments.push(seg.content);
    }
  }
  
  return {
    topContent: buildContentFromParts(topSegments, presetDef),
    secondaryContent: buildContentFromParts(secondarySegments, presetDef),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension
// ═══════════════════════════════════════════════════════════════════════════

export default function powerlineFooter(pi: ExtensionAPI) {
  // Restore persisted config (settings.json → powerline) before first render.
  const persisted = readPersistedPowerline();
  if (persisted) {
    config = { ...config, ...persisted };
  }

  let enabled = true;
  let sessionStartTime = Date.now();
  let currentCtx: any = null;
  let footerDataRef: ReadonlyFooterDataProvider | null = null;
  let getThinkingLevelFn: (() => string) | null = null;
  let isStreaming = false;
  let tuiRef: any = null; // Store TUI reference for forcing re-renders
  
  // Cache for responsive layout (shared between editor and widget for consistency)
  let lastLayoutWidth = 0;
  let lastLayoutResult: { topContent: string; secondaryContent: string } | null = null;
  let lastLayoutTimestamp = 0;

  let codexUsage: CodexUsageSummary | null = null;
  let codexUsageTimer: NodeJS.Timeout | null = null;
  let codexUsageInFlight: Promise<void> | null = null;
  const CODEX_USAGE_REFRESH_MS = 5 * 60 * 1000;

  const refreshCodexUsage = async () => {
    if (codexUsageInFlight) return;

    codexUsageInFlight = (async () => {
      try {
        // Choose provider based on currently selected model
        const modelId = currentCtx?.model?.id;
        const provider = getProviderFromModelId(modelId);

        if (provider === "zai") {
          codexUsage = await fetchZaiUsageSummary();
        } else {
          codexUsage = await fetchCodexUsageSummary();
        }
      } catch {
        codexUsage = null;
      } finally {
        codexUsageInFlight = null;
        tuiRef?.requestRender();
      }
    })();
  };

  // ─── oc-tps style token-rate tracking (live TPS / avg TPS / avg TTFT) ─────
  const tokenRateTracker = new TokenRateTracker();
  let lastRateRender = 0;
  const requestRateRender = () => {
    const now = Date.now();
    if (now - lastRateRender >= 200) {
      lastRateRender = now;
      tuiRef?.requestRender();
    }
  };

  pi.on("message_start", (event, _ctx) => {
    tokenRateTracker.handleMessageStart(event.message);
  });
  pi.on("message_update", (event, _ctx) => {
    tokenRateTracker.handleMessageUpdate({
      role: event.message?.role,
      type: event.assistantMessageEvent?.type,
      delta:
        (event.assistantMessageEvent as any)?.type === "text_delta" ||
        (event.assistantMessageEvent as any)?.type === "thinking_delta"
          ? (event.assistantMessageEvent as any)?.delta
          : undefined,
      partial: (event.assistantMessageEvent as any)?.partial,
    });
    requestRateRender();
  });
  pi.on("message_end", (event, _ctx) => {
    tokenRateTracker.handleMessageEnd(event.message as any);
    requestRateRender();
  });

  // Track session start
  pi.on("session_start", async (_event, ctx) => {
    sessionStartTime = Date.now();
    currentCtx = ctx;
    
    // Store thinking level getter if available (modern pi exposes it as a ctx property)
    if (typeof ctx?.thinkingLevel === "string") {
      getThinkingLevelFn = () => ctx.thinkingLevel;
    }
    

    if (codexUsageTimer) {
      clearInterval(codexUsageTimer);
      codexUsageTimer = null;
    }
    void refreshCodexUsage();
    codexUsageTimer = setInterval(() => {
      void refreshCodexUsage();
    }, CODEX_USAGE_REFRESH_MS);
    
    if (enabled && ctx.hasUI) {
      setupCustomEditor(ctx);
    }
  });

  // Check if a bash command might change git branch
  const mightChangeGitBranch = (cmd: string): boolean => {
    const gitBranchPatterns = [
      /\bgit\s+(checkout|switch|branch\s+-[dDmM]|merge|rebase|pull|reset|worktree)/,
      /\bgit\s+stash\s+(pop|apply)/,
    ];
    return gitBranchPatterns.some(p => p.test(cmd));
  };

  // Invalidate git status on file changes, trigger re-render on potential branch changes
  pi.on("tool_result", async (event, _ctx) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      invalidateGitStatus();
    }
    // Check for bash commands that might change git branch
    if (event.toolName === "bash" && event.input?.command) {
      const cmd = String(event.input.command);
      if (mightChangeGitBranch(cmd)) {
        // Invalidate caches since working tree state changes with branch
        invalidateGitStatus();
        invalidateGitBranch();
        // Small delay to let git update, then re-render
        setTimeout(() => tuiRef?.requestRender(), 100);
      }
    }
  });

  // Also catch user escape commands (! prefix)
  // Note: This fires BEFORE execution, so we use a longer delay and multiple re-renders
  // to ensure we catch the update after the command completes.
  pi.on("user_bash", async (event, _ctx) => {
    if (mightChangeGitBranch(event.command)) {
      // Invalidate immediately so next render fetches fresh data
      invalidateGitStatus();
      invalidateGitBranch();
      // Multiple staggered re-renders to catch fast and slow commands
      setTimeout(() => tuiRef?.requestRender(), 100);
      setTimeout(() => tuiRef?.requestRender(), 300);
      setTimeout(() => tuiRef?.requestRender(), 500);
    }
  });

  // Track streaming state (footer only shows status during streaming)
  pi.on("agent_start", async (_event, _ctx) => {
    isStreaming = true;
  });

  pi.on("agent_end", async (_event, _ctx) => {
    isStreaming = false;
  });

  // Disable the footer and restore pi defaults.
  function disablePowerline(ctx: any) {
    enabled = false;
    ctx.ui.setEditorComponent(undefined);
    ctx.ui.setFooter(undefined);
    ctx.ui.setHeader(undefined);
    ctx.ui.setWidget("powerline-secondary", undefined);
    ctx.ui.setWidget("powerline-status", undefined);
    footerDataRef = null;
    tuiRef = null;
    lastLayoutResult = null;
    ctx.ui.notify("Powerline off", "info");
  }

  // Pick a preset (a named template). Shows each preset's segments first.
  async function pickPreset(ctx: any) {
    const items = Object.entries(PRESETS).map(([name, def]) => {
      const segs = [...def.leftSegments, ...def.rightSegments, ...(def.secondarySegments ?? [])].join(" · ");
      return `${name}  →  ${segs}`;
    });
    const choice = await ctx.ui.select("Pick a preset", items);
    if (!choice) return;
    const name = (choice.split("  →  ")[0] ?? "").trim() as StatusLinePreset;
    if (!(name in PRESETS)) return;
    config.preset = name;
    config.customSegments = undefined;
    config.disabledSegments = [];
    lastLayoutResult = null;
    if (enabled) setupCustomEditor(ctx);
    persistPowerlineConfig();
    ctx.ui.notify(`Preset: ${name}`, "info");
  }

  // Toggle individual segments. Saves to blacklist or custom list, then persists.
  async function editSegments(ctx: any) {
    const selected = new Set<StatusLineSegmentId>(getEffectiveSegments());
    while (true) {
      const labels: string[] = [];
      const ids: (StatusLineSegmentId | null)[] = [];
      for (const group of SEGMENT_GROUPS) {
        labels.push(`── ${group.title} ──`);
        ids.push(null);
        for (const s of group.ids) {
          labels.push(`${selected.has(s) ? "✓" : "✗"} ${SEGMENT_LABELS[s]}`);
          ids.push(s);
        }
      }
      labels.push("Done — save and apply");
      ids.push(null);

      const choice = await ctx.ui.select("Toggle segments", labels);
      if (!choice || choice.startsWith("Done")) break;
      const idx = labels.indexOf(choice);
      const seg = ids[idx];
      if (!seg) continue;
      if (selected.has(seg)) selected.delete(seg); else selected.add(seg);
    }

    const ordered = ALL_SEGMENTS.filter((s) => selected.has(s));
    if (ordered.length === 0) {
      ctx.ui.notify("No segments selected — footer unchanged", "error");
      return;
    }

    const def = getPreset(config.preset);
    const presetList = [...def.leftSegments, ...def.rightSegments, ...(def.secondarySegments ?? [])];
    const addedBeyondPreset = ordered.some((s) => !presetList.includes(s));
    if (addedBeyondPreset) {
      config.customSegments = ordered;
      config.disabledSegments = [];
    } else {
      config.disabledSegments = presetList.filter((s) => !selected.has(s));
      config.customSegments = undefined;
    }

    lastLayoutResult = null;
    if (enabled) setupCustomEditor(ctx);
    persistPowerlineConfig();
    ctx.ui.notify(`Footer updated (${ordered.length} segments)`, "info");
  }

  pi.registerCommand("powerline", {
    description: "Configure powerline status bar",
    handler: async (args, ctx) => {
      currentCtx = ctx;

      if (args && args.trim().toLowerCase() === "off") {
        disablePowerline(ctx);
        return;
      }

      const choice = await ctx.ui.select("Powerline", [
        "Pick a preset",
        "Edit segments",
        "Turn off",
      ]);
      if (!choice) return;

      if (choice === "Pick a preset") await pickPreset(ctx);
      else if (choice === "Edit segments") await editSegments(ctx);
      else if (choice === "Turn off") disablePowerline(ctx);
    },
  });

  function buildSegmentContext(ctx: any, width: number, theme: Theme): SegmentContext {
    const presetDef = getPreset(config.preset);
    const colors: ColorScheme = presetDef.colors ?? getDefaultColors();

    // Build usage stats and get thinking level from session
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
    let lastAssistant: AssistantMessage | undefined;
    let thinkingLevelFromSession = "off";
    
    const sessionEvents = ctx.sessionManager?.getBranch?.() ?? [];
    for (const e of sessionEvents) {
      // Check for thinking level change entries
      if (e.type === "thinking_level_change" && e.thinkingLevel) {
        thinkingLevelFromSession = e.thinkingLevel;
      }
      if (e.type === "message" && e.message.role === "assistant") {
        const m = e.message as AssistantMessage;
        if (m.stopReason === "error" || m.stopReason === "aborted") {
          continue;
        }
        input += m.usage.input;
        output += m.usage.output;
        cacheRead += m.usage.cacheRead;
        cacheWrite += m.usage.cacheWrite;
        lastAssistant = m;
      }
    }

    // Calculate context percentage of the CURRENT session context window.
    // Prefer the session's canonical getContextUsage(): it uses the live model's
    // context window, skips aborted/error/zero-usage assistant messages, includes
    // trailing tokens after the last assistant usage, and reports null when the
    // value is genuinely unknown (e.g. right after compaction, before the next
    // LLM response). Fall back to the last assistant message's usage only when
    // getContextUsage() is unavailable (very old pi) or the model has no context
    // window (custom/rerouted providers where contextWindow is 0/undefined).
    let contextPercent = 0;
    let contextWindow = ctx.model?.contextWindow || 0;
    let contextUnknown = false;

    let usage;
    try {
      usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
    } catch {
      usage = undefined;
    }

    if (usage && usage.contextWindow > 0) {
      contextWindow = usage.contextWindow;
      if (usage.tokens != null && usage.percent != null) {
        contextPercent = usage.percent;
      } else {
        // Tokens unknown until the next LLM response (e.g. right after compaction).
        contextUnknown = true;
      }
    } else if (contextWindow > 0) {
      const contextTokens = lastAssistant
        ? lastAssistant.usage.input + lastAssistant.usage.output +
          lastAssistant.usage.cacheRead + lastAssistant.usage.cacheWrite
        : 0;
      contextPercent = (contextTokens / contextWindow) * 100;
    }

    // Get git status (cached)
    const gitBranch = footerDataRef?.getGitBranch() ?? null;
    const gitStatus = getGitStatus(gitBranch);

    return {
      model: ctx.model,
      thinkingLevel: thinkingLevelFromSession || getThinkingLevelFn?.() || "off",
      sessionId: ctx.sessionManager?.getSessionId?.(),
      usageStats: { input, output, cacheRead, cacheWrite },
      contextPercent,
      contextWindow,
      contextUnknown,
      autoCompactEnabled: ctx.settingsManager?.getCompactionSettings?.()?.enabled ?? true,
      sessionStartTime,
      tokenRate: tokenRateTracker.getStats(),
      codexUsage,
      git: gitStatus,
      extensionStatuses: footerDataRef?.getExtensionStatuses() ?? new Map(),
      options: presetDef.segmentOptions ?? {},
      width,
      theme,
      colors,
    };
  }

  /**
   * Get cached responsive layout or compute fresh one.
   * Layout is cached per render cycle (same width = same layout).
   */
  function getResponsiveLayout(width: number, theme: Theme): { topContent: string; secondaryContent: string } {
    const now = Date.now();
    // Cache is valid if same width and within 50ms (same render cycle)
    if (lastLayoutResult && lastLayoutWidth === width && now - lastLayoutTimestamp < 50) {
      return lastLayoutResult;
    }
    
    const presetDef = getPreset(config.preset);
    const segmentCtx = buildSegmentContext(currentCtx, width, theme);
    // Available width for status bar content (no fill, full width)
    const topBarAvailable = width;
    
    lastLayoutWidth = width;
    lastLayoutResult = computeResponsiveLayout(segmentCtx, presetDef, topBarAvailable);
    lastLayoutTimestamp = now;
    
    return lastLayoutResult;
  }

  function setupCustomEditor(ctx: any) {
    // Import CustomEditor dynamically and create wrapper
    import("@earendil-works/pi-coding-agent").then(({ CustomEditor }) => {
      let currentEditor: any = null;
      let autocompleteFixed = false;

      const editorFactory = (tui: any, editorTheme: any, keybindings: any) => {
        // Create custom editor that overrides render for status bar below content
        const editor = new CustomEditor(tui, editorTheme, keybindings);
        currentEditor = editor;
        
        const originalHandleInput = editor.handleInput.bind(editor);
        editor.handleInput = (data: string) => {
          if (!autocompleteFixed && !(editor as any).autocompleteProvider) {
            autocompleteFixed = true;
            ctx.ui.setEditorComponent(editorFactory);
            currentEditor?.handleInput(data);
            return;
          }
          originalHandleInput(data);
        };
        
        // Store original render
        const originalRender = editor.render.bind(editor);
        
        // Override render: status bar, top rule, prompted content, bottom rule
        //  status content
        //  ──────────────────────────────────────
        //  > first line of input
        //    continuation lines
        //  ──────────────────────────────────────
        // + autocomplete items (if showing)
        editor.render = (width: number): string[] => {
          // Fall back to original render on extremely narrow terminals
          if (width < 10) {
            return originalRender(width);
          }
          
          const bc = (s: string) => `${getFgAnsiCode("sep")}${s}${ansi.reset}`;
          const prompt = `${ansi.getFgAnsi(200, 200, 200)}>${ansi.reset}`;
          
          // Content area: 3 chars for prompt prefix (" > " / "   ")
          const promptPrefix = ` ${prompt} `;
          const contPrefix = "   ";
          const contentWidth = Math.max(1, width - 3);
          const lines = originalRender(contentWidth);
          
          if (lines.length === 0 || !currentCtx) return lines;
          
          // Find bottom border (plain ─ or scroll indicator ─── ↓ N more)
          // Lines after it are autocomplete items
          let bottomBorderIndex = lines.length - 1;
          for (let i = lines.length - 1; i >= 1; i--) {
            const stripped = lines[i]?.replace(/\x1b\[[0-9;]*m/g, "") || "";
            if (stripped.length > 0 && /^─{3,}/.test(stripped)) {
              bottomBorderIndex = i;
              break;
            }
          }
          
          const result: string[] = [];
          
          // Status bar above top border
          const layout = getResponsiveLayout(width, ctx.ui.theme);
          result.push(layout.topContent);
          
          // Top border (plain rule, 1-char margins)
          result.push(" " + bc("─".repeat(width - 2)));
          
          // Content lines: first line gets "> " prompt, rest indented to match
          for (let i = 1; i < bottomBorderIndex; i++) {
            const prefix = i === 1 ? promptPrefix : contPrefix;
            result.push(`${prefix}${lines[i] || ""}`);
          }
          
          // If only had top/bottom borders (empty editor), show prompt
          if (bottomBorderIndex === 1) {
            result.push(`${promptPrefix}${" ".repeat(contentWidth)}`);
          }
          
          // Bottom border
          result.push(" " + bc("─".repeat(width - 2)));
          
          // Append any autocomplete lines that come after the bottom border
          for (let i = bottomBorderIndex + 1; i < lines.length; i++) {
            result.push(lines[i] || "");
          }
          
          return result;
        };
        
        return editor;
      };

      ctx.ui.setEditorComponent(editorFactory);

      // Set up footer data provider access (needed for git branch, extension statuses)
      // Status bar is rendered inside the editor override, footer is empty
      ctx.ui.setFooter((tui: any, _theme: Theme, footerData: ReadonlyFooterDataProvider) => {
        footerDataRef = footerData;
        tuiRef = tui; // Store TUI reference for re-renders on git branch changes
        const unsub = footerData.onBranchChange(() => tui.requestRender());

        return {
          dispose: unsub,
          invalidate() {},
          render(): string[] {
            return [];
          },
        };
      });

      // Set up secondary row as a widget below editor (above sub bar)
      // Shows overflow segments when top bar is too narrow
      ctx.ui.setWidget("powerline-secondary", (_tui: any, theme: Theme) => {
        return {
          dispose() {},
          invalidate() {},
          render(width: number): string[] {
            if (!currentCtx) return [];
            
            // Use responsive layout - secondary row shows overflow from top bar
            const layout = getResponsiveLayout(width, theme);
            
            // Only show secondary row if there's overflow content that fits
            if (layout.secondaryContent) {
              const contentWidth = visibleWidth(layout.secondaryContent);
              // Don't render if content exceeds terminal width (graceful degradation)
              if (contentWidth <= width) {
                return [layout.secondaryContent];
              }
            }
            
            return [];
          },
        };
      }, { placement: "belowEditor" });

      // Set up status notifications widget above editor
      // Shows extension status messages that look like notifications (e.g., "[pi-annotate] Received: CANCEL")
      // Compact statuses (e.g., "MCP: 6 servers") stay in the powerline bar via extension_statuses segment
      ctx.ui.setWidget("powerline-status", () => {
        return {
          dispose() {},
          invalidate() {},
          render(width: number): string[] {
            if (!currentCtx || !footerDataRef) return [];
            
            const statuses = footerDataRef.getExtensionStatuses();
            if (!statuses || statuses.size === 0) return [];
            
            // Collect notification-style statuses (those starting with "[extensionName]")
            const notifications: string[] = [];
            for (const value of statuses.values()) {
              if (value && value.trimStart().startsWith('[')) {
                // Account for leading space when checking width
                const lineContent = ` ${value}`;
                const contentWidth = visibleWidth(lineContent);
                if (contentWidth <= width) {
                  notifications.push(lineContent);
                }
              }
            }
            
            return notifications;
          },
        };
      }, { placement: "aboveEditor" });
    });
  }

}
