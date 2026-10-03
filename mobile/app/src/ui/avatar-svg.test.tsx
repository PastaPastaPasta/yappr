import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { svgFromDataUri } from './Avatar';
import { AVATAR_SVG_CACHE_MAX, AvatarSvgProvider, slimDicebearSvg, useDicebearSvg } from './avatar-svg';
import { FIXTURE_AVATARS } from './post/fixture-avatars';

/** The engine's DiceBear `thumbs` markup for Alice, exactly as rendered. */
const alice = svgFromDataUri(FIXTURE_AVATARS.alice.uri) ?? '';

const elements = (svg: string) => svg.match(/<[a-zA-Z][\w:]*/g) ?? [];

describe('slimDicebearSvg (D-L3a-011)', () => {
  it('drops the metadata and the identity viewbox mask, and keeps every drawn element', () => {
    expect(alice).toContain('<metadata');
    expect(alice).toContain('mask="url(#viewboxMask)"');

    const slim = slimDicebearSvg(alice);
    expect(slim).not.toMatch(/metadata|rdf:|dc:|viewboxMask|<mask/);
    // Everything else is byte for byte what DiceBear drew.
    const drawn = (svg: string) =>
      svg
        .replace(/<metadata[\s\S]*?<\/metadata>/, '')
        .replace(/<mask id="viewboxMask">[\s\S]*?<\/mask>/, '')
        .replace(' mask="url(#viewboxMask)"', '');
    expect(slim).toBe(drawn(alice));
    // The 8 metadata elements, the mask and its rect.
    expect(elements(alice).length - elements(slim).length).toBe(10);
    expect(slim.length).toBeLessThan(alice.length * 0.7);
    expect(slimDicebearSvg(slim)).toBe(slim);
  });

  it('keeps a mask that does something: rounded, or not the whole viewBox', () => {
    const rounded = alice.replace('rx="0" ry="0"', 'rx="10" ry="10"');
    expect(slimDicebearSvg(rounded)).toContain('mask="url(#viewboxMask)"');
    const smaller = alice.replace('<rect width="100" height="100" rx="0"', '<rect width="90" height="100" rx="0"');
    expect(smaller).not.toBe(alice);
    expect(slimDicebearSvg(smaller)).toContain('mask="url(#viewboxMask)"');
  });

  it('leaves any other SVG alone', () => {
    const other =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><mask id="m"><rect width="10" height="10" fill="#fff"/></mask><g mask="url(#m)"><path d="M0 0h10v10z"/></g></svg>';
    expect(slimDicebearSvg(other)).toBe(other);
  });
});

function Probe({ seed }: { seed: string }) {
  const svg = useDicebearSvg(`id-${seed}`, { style: 'thumbs', seed });
  return <Text testID={`svg-${seed}`}>{svg ?? 'loading'}</Text>;
}

describe('the DiceBear markup cache (D-L3a-011)', () => {
  it('keeps the slimmed markup, and only the most recently used recipes', () => {
    const resolve = jest.fn((_id: string, _style: string, seed: string) => (seed === 'first' ? alice : `<svg>${seed}</svg>`));
    const show = (seed: string) =>
      render(
        <AvatarSvgProvider resolve={resolve}>
          <Probe seed={seed} />
        </AvatarSvgProvider>,
      );

    show('first');
    expect(screen.getByTestId('svg-first')).toHaveTextContent(slimDicebearSvg(alice));

    // Fill the cache past its cap, touching `first` halfway so it stays.
    for (let i = 0; i < AVATAR_SVG_CACHE_MAX; i += 1) {
      show(`fill-${i}`).unmount();
      if (i === AVATAR_SVG_CACHE_MAX / 2) show('first').unmount();
    }
    expect(resolve).toHaveBeenCalledTimes(AVATAR_SVG_CACHE_MAX + 1);

    show('first').unmount();
    expect(resolve).toHaveBeenCalledTimes(AVATAR_SVG_CACHE_MAX + 1);
    // fill-0 was the least recently used, so it went.
    show('fill-0').unmount();
    expect(resolve).toHaveBeenCalledTimes(AVATAR_SVG_CACHE_MAX + 2);
  });

  it('keeps showing a mounted avatar whose recipe the cache has since evicted', () => {
    const resolve = jest.fn((_id: string, _style: string, seed: string) => `<svg>${seed}</svg>`);
    const tree = (seed: string, other?: string) => (
      <AvatarSvgProvider resolve={resolve}>
        <Probe seed={seed} />
        {other ? <Probe seed={other} /> : null}
      </AvatarSvgProvider>
    );
    // Cached by an earlier mount, so this one mounts on a cache hit.
    render(tree('kept')).unmount();
    const header = render(tree('kept'));
    const calls = resolve.mock.calls.length;
    expect(header.getByTestId('svg-kept')).toHaveTextContent('<svg>kept</svg>');

    // Long browsing pushes `kept` out of the shared cache...
    for (let i = 0; i <= AVATAR_SVG_CACHE_MAX; i += 1) render(tree(`evict-${i}`)).unmount();
    // ...then the still-mounted avatar re-renders.
    header.rerender(tree('kept', 'sibling'));
    expect(header.getByTestId('svg-kept')).toHaveTextContent('<svg>kept</svg>');
    expect(resolve).toHaveBeenCalledTimes(calls + AVATAR_SVG_CACHE_MAX + 2);
  });
});
