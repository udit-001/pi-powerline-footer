import type { ColorScheme } from "./types.js";

// Named color themes. Each is a full map of semantic roles → color.
// Hex values are from well-known terminal palettes; token names (muted, dim,
// warning, …) resolve through pi's native theme so light/dark + fallback work.
export type ThemeName = "zen" | "catppuccin" | "tokyo-night" | "nord" | "gruvbox" | "solarized";

export const DEFAULT_THEME: ThemeName = "zen";

export const THEMES: Record<ThemeName, ColorScheme> = {
  // Monochrome. Only warning (yellow) and error (red) carry colour.
  zen: {
    pi: "dim",
    model: "muted",
    path: "muted",
    git: "dim",
    gitDirty: "dim",
    gitClean: "dim",
    thinking: "dim",
    thinkingHigh: "muted",
    context: "dim",
    contextWarn: "warning",
    contextError: "error",
    tokens: "muted",
    separator: "dim",
    border: "borderMuted",
  },

  // Catppuccin Mocha — modern pastel dark.
  catppuccin: {
    pi: "#fab387",       // peach
    model: "#cba6f7",    // mauve
    path: "#89b4fa",     // blue
    git: "#a6e3a1",      // green
    gitDirty: "#f9e2af", // yellow
    gitClean: "#a6e3a1", // green
    thinking: "#b4befe", // lavender
    thinkingHigh: "#f5c2e7", // pink
    context: "#89dceb",  // sky
    contextWarn: "#f9e2af", // yellow
    contextError: "#f38ba8", // red
    tokens: "#94e2d5",   // teal
    separator: "#585b70", // surface2
    border: "#585b70",
  },

  // Tokyo Night — cool blue neon.
  "tokyo-night": {
    pi: "#ff9e64",        // orange
    model: "#7dcfff",     // cyan
    path: "#7aa2f7",      // blue
    git: "#9ece6a",       // green
    gitDirty: "#e0af68",  // yellow
    gitClean: "#9ece6a",
    thinking: "#bb9af7",  // purple
    thinkingHigh: "#7dcfff",
    context: "#7aa2f7",
    contextWarn: "#e0af68",
    contextError: "#f7768e",
    tokens: "#7dcfff",
    separator: "#565f89",
    border: "#565f89",
  },

  // Nord — icy calm.
  nord: {
    pi: "#d08770",        // orange
    model: "#88c0d0",     // frost cyan
    path: "#8fbcbb",      // frost
    git: "#a3be8c",       // aurora green
    gitDirty: "#ebcb8b",  // aurora yellow
    gitClean: "#a3be8c",
    thinking: "#81a1c1",  // frost blue
    thinkingHigh: "#88c0d0",
    context: "#81a1c1",
    contextWarn: "#ebcb8b",
    contextError: "#bf616a",
    tokens: "#81a1c1",
    separator: "#4c566a",
    border: "#4c566a",
  },

  // Gruvbox Dark — warm retro.
  gruvbox: {
    pi: "#fe8019",        // orange
    model: "#d3869b",     // purple
    path: "#8ec07c",      // aqua
    git: "#b8bb26",       // green
    gitDirty: "#fabd2f",  // yellow
    gitClean: "#b8bb26",
    thinking: "#83a598",  // blue
    thinkingHigh: "#d3869b",
    context: "#83a598",
    contextWarn: "#fabd2f",
    contextError: "#fb4934",
    tokens: "#83a598",
    separator: "#665c54",
    border: "#665c54",
  },

  // Solarized Dark — classic, proven.
  solarized: {
    pi: "#cb4b16",        // orange
    model: "#d33682",     // magenta
    path: "#2aa198",      // cyan
    git: "#859900",       // green
    gitDirty: "#b58900",  // yellow
    gitClean: "#859900",
    thinking: "#268bd2",  // blue
    thinkingHigh: "#d33682",
    context: "#268bd2",
    contextWarn: "#b58900",
    contextError: "#dc322f",
    tokens: "#268bd2",
    separator: "#839496",
    border: "#839496",
  },
};

export const THEME_LABELS: Record<ThemeName, string> = {
  zen: "Zen (monochrome)",
  catppuccin: "Catppuccin",
  "tokyo-night": "Tokyo Night",
  nord: "Nord",
  gruvbox: "Gruvbox",
  solarized: "Solarized",
};

export const THEME_HINTS: Record<ThemeName, string> = {
  zen: "monochrome · color only for alerts",
  catppuccin: "mauve · blue · peach",
  "tokyo-night": "cyan · blue · orange",
  nord: "frost · blue",
  gruvbox: "purple · aqua · orange",
  solarized: "magenta · cyan · orange",
};