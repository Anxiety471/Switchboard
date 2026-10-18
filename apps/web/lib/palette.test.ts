import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import {
  contrastRatio,
  darkPalette,
  lightPalette,
  paletteCss,
  type Palette,
} from './palette';

function assertTextContrast(palette: Palette): void {
  const pairs: Array<[string, string]> = [
    [palette.ink, palette.paper],
    [palette.ink, palette.sheet],
    [palette.muted, palette.paper],
    [palette.muted, palette.sheet],
    [palette.umber, palette.paper],
    [palette.umber, palette.sheet],
    [palette.onUmber, palette.umber],
    [palette.online, palette.sheet],
    [palette.alert, palette.paper],
  ];
  for (const [foreground, background] of pairs) {
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
  }
  expect(contrastRatio(palette.umber, palette.paper)).toBeGreaterThanOrEqual(3);
}

test('ledger palettes meet WCAG AA contrast', () => {
  assertTextContrast(lightPalette);
  assertTextContrast(darkPalette);
  const css = paletteCss();
  expect(css).toContain(lightPalette.paper);
  expect(css).toContain(darkPalette.ink);
  expect(css).toContain('prefers-color-scheme: dark');
  expect(css).toContain('data-theme="light"');
  expect(css).toContain('data-theme="dark"');

  const globals = readFileSync(
    new URL('../app/globals.css', import.meta.url),
    'utf8',
  );
  expect(globals).not.toMatch(/color:\s*var\(--rule\)/);
  expect(globals).toContain('IBM Plex');
});
