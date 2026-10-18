export type Palette = {
  paper: string;
  sheet: string;
  ink: string;
  muted: string;
  umber: string;
  onUmber: string;
  rule: string;
  online: string;
  alert: string;
};

export const lightPalette: Palette = {
  paper: '#f4efe6',
  sheet: '#fbf7f0',
  ink: '#1c1612',
  muted: '#5c493a',
  umber: '#6e3a1e',
  onUmber: '#fffaf3',
  rule: '#cbbba4',
  online: '#14532d',
  alert: '#7f1d1d',
};

export const darkPalette: Palette = {
  paper: '#231c16',
  sheet: '#2c241c',
  ink: '#f4efe6',
  muted: '#d7c6b3',
  umber: '#efb07a',
  onUmber: '#2a160c',
  rule: '#4d4034',
  online: '#b7e0c6',
  alert: '#f0b4a8',
};

function channel(hex: string, shift: number): number {
  return (Number.parseInt(hex.slice(1), 16) >> shift) & 255;
}

function linear(channelValue: number): number {
  const value = channelValue / 255;
  if (value <= 0.04045) {
    return value / 12.92;
  }
  return ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  return (
    0.2126 * linear(channel(hex, 16)) +
    0.7152 * linear(channel(hex, 8)) +
    0.0722 * linear(channel(hex, 0))
  );
}

export function contrastRatio(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

function variables(palette: Palette, scheme: 'light' | 'dark'): string {
  return [
    `color-scheme:${scheme}`,
    `--paper:${palette.paper}`,
    `--sheet:${palette.sheet}`,
    `--ink:${palette.ink}`,
    `--muted:${palette.muted}`,
    `--umber:${palette.umber}`,
    `--on-umber:${palette.onUmber}`,
    `--rule:${palette.rule}`,
    `--online:${palette.online}`,
    `--alert:${palette.alert}`,
  ].join(';');
}

export function paletteCss(): string {
  const light = variables(lightPalette, 'light');
  const dark = variables(darkPalette, 'dark');
  return [
    `:root{${light}}`,
    `:root[data-theme="light"]{${light}}`,
    `:root[data-theme="dark"]{${dark}}`,
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${dark}}}`,
  ].join('');
}
