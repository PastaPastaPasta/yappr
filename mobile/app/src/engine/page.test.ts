import { bootstrapScript, composeInlineHtml, composeLoaderHtml } from './page';

describe('engine page', () => {
  const html = '<!doctype html><html><head><meta charset="utf-8"><script>ENGINE</script></head><body></body></html>';

  it('puts the CSP and the bootstrap ahead of the engine script', () => {
    const page = composeInlineHtml(html, 'BOOT');
    expect(page.indexOf('Content-Security-Policy')).toBeLessThan(page.indexOf('<script>BOOT</script>'));
    expect(page.indexOf('<script>BOOT</script>')).toBeLessThan(page.indexOf('ENGINE'));
    expect(page).toContain("default-src 'none'");
  });

  it('assigns the snapshot as a property, with no markup that could end the script', () => {
    const script = bootstrapScript({ local: { note: '</script><script>alert(1)</script>' }, secure: {} }, null);
    expect(script.startsWith('window.__YAPPR_ENGINE_STORAGE__=')).toBe(true);
    expect(script).not.toMatch(/<\/script/i);
    const assigned: { __YAPPR_ENGINE_STORAGE__?: unknown } = {};
    // The snapshot part is a JS assignment whose value is plain JSON.
    const json = script.slice('window.__YAPPR_ENGINE_STORAGE__='.length, script.indexOf(';(function'));
    assigned.__YAPPR_ENGINE_STORAGE__ = JSON.parse(json);
    expect(assigned.__YAPPR_ENGINE_STORAGE__).toEqual({ local: { note: '</script><script>alert(1)</script>' }, secure: {} });
  });

  it('loads engine.js after the CSP, the bootstrap and the bundle hash (Android)', () => {
    const page = composeLoaderHtml('BOOT', 'abc');
    expect(page.indexOf('<script>BOOT</script>')).toBeLessThan(page.indexOf('__YAPPR_ENGINE_BUNDLE_HASH__="abc"'));
    expect(page.indexOf('__YAPPR_ENGINE_BUNDLE_HASH__')).toBeLessThan(page.indexOf("s.src='engine.js'"));
  });

  it('simulates Lockdown Mode by removing WebAssembly before the engine runs', () => {
    expect(bootstrapScript({ local: {}, secure: {} }, 'no-webassembly')).toContain('delete window.WebAssembly;');
    expect(bootstrapScript({ local: {}, secure: {} }, null)).not.toContain('delete window.WebAssembly');
  });
});
