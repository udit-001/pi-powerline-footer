// Minimal ANSI color helpers for the footer border and separator.

export const ansi = {
  getFgAnsi: (r: number, g: number, b: number): string => `\x1b[38;2;${r};${g};${b}m`,
  reset: "\x1b[0m",
};

// Separator / border gray (ANSI 256, kept from the original oh-my-pi palette).
export const SEP = "\x1b[38;5;244m";