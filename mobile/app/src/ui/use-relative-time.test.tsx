import { transformSync } from '@babel/core';
import { act, render, screen } from '@testing-library/react-native';
import fs from 'fs';
import path from 'path';
import * as React from 'react';
import * as compilerRuntime from 'react/compiler-runtime';

import * as libAllowlist from '~/lib-allowlist';

import * as clock from './clock';
import { Text } from './Text';

const MINUTE = 60_000;
// Mid-minute, so the next minute tick is half a minute away.
const START = Date.UTC(2026, 9, 2, 23, 20, 30);

/**
 * `useRelativeTime` as the app ships it. babel-preset-expo runs the React
 * Compiler (app.config `experiments.reactCompiler`) under Metro only, never
 * under Jest, and a compiled hook that computes its label in the render body
 * memoizes it on `date` alone: the label froze at its first value on device
 * (QA D-L3i-007) while the uncompiled hook passed every test.
 */
function compiledUseRelativeTime(): (date: Date) => string {
  const file = path.join(__dirname, 'use-relative-time.ts');
  const output = transformSync(fs.readFileSync(file, 'utf8'), {
    filename: file,
    babelrc: false,
    configFile: false,
    presets: ['@babel/preset-typescript'],
    plugins: ['babel-plugin-react-compiler', '@babel/plugin-transform-modules-commonjs'],
  });
  const code = output?.code ?? '';
  expect(code).toContain('react/compiler-runtime');
  const modules: Record<string, unknown> = {
    react: React,
    'react/compiler-runtime': compilerRuntime,
    '~/lib-allowlist': libAllowlist,
    './clock': clock,
  };
  const module = { exports: {} as { useRelativeTime?: (date: Date) => string } };
  const load = new Function('require', 'module', 'exports', code) as (
    require: (id: string) => unknown,
    module: unknown,
    exports: unknown,
  ) => void;
  load((id) => modules[id], module, module.exports);
  if (!module.exports.useRelativeTime) throw new Error('use-relative-time.ts exports no useRelativeTime');
  return module.exports.useRelativeTime;
}

describe('useRelativeTime under the React Compiler (QA D-L3i-007)', () => {
  beforeEach(() => jest.useFakeTimers({ now: START }));
  afterEach(() => jest.useRealTimers());

  it('keeps ticking once compiled', () => {
    const useRelativeTime = compiledUseRelativeTime();
    // A stable `date`, as a memoized card passes it.
    const date = new Date(START - (38 * MINUTE + 45_000));
    function Time() {
      return <Text testID="time">{useRelativeTime(date)}</Text>;
    }
    render(<Time />);
    expect(screen.getByTestId('time')).toHaveTextContent('38m');

    act(() => jest.advanceTimersByTime(30_000));
    expect(screen.getByTestId('time')).toHaveTextContent('39m');

    act(() => jest.advanceTimersByTime(4 * MINUTE));
    expect(screen.getByTestId('time')).toHaveTextContent('43m');
  });
});
