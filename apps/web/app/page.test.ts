import { isValidElement, type ReactElement } from 'react';
import { expect, test } from 'vitest';
import HomePage from './page';

test('home page element is a Switchboard heading', () => {
  const page: ReactElement<{ children: ReactElement<{ children: string }> }> =
    HomePage();

  expect(isValidElement(page)).toBe(true);
  expect(page.type).toBe('main');
  expect(isValidElement(page.props.children)).toBe(true);
  expect(page.props.children.type).toBe('h1');
  expect(page.props.children.props.children).toBe('Switchboard');
});
