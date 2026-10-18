import { resolveAppConfig } from '../config';
import { VARIANTS, type Variant } from '../variants';
import { resolveLink, type LinkOptions } from './deep-links';
import { webHandoffUrl, webUrl } from './web-urls';

const ID = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijk';

describe.each(Object.keys(VARIANTS) as Variant[])('%s web handoffs', (variant) => {
  const v = VARIANTS[variant];
  const config = resolveAppConfig(v.applicationId, { variant }, '1.0.0');
  const options: LinkOptions = { initial: false, allowAppRoutes: false, webBasePath: config.webBasePath };

  it('keeps polls, private posts, stores and blogs in the selected deployment', () => {
    expect(webUrl(config, '/post', { id: ID })).toBe(`${v.webBaseUrl}/post?id=${ID}`);
    for (const path of ['/store', '/blog', '/item', '/checkout', '/orders']) {
      const url = webUrl(config, path, { id: ID });
      expect(resolveLink(url, options)).toEqual({ kind: 'browser', url });
      expect(resolveLink(`${v.scheme}://${path.slice(1)}?id=${ID}`, options)).toEqual({ kind: 'browser', url });
    }
    expect(resolveLink(`${v.webBaseUrl}/post?id=${ID}`, options)).toEqual({ kind: 'route', route: `/post/${ID}` });
  });

  it('keeps root-form store and blog content links on this deployment', () => {
    for (const path of ['/store/', '/blog/', '/blog/post/']) {
      expect(webHandoffUrl(config, `https://yap.pr${path}?id=${ID}#read`)).toBe(`${v.webBaseUrl}${path}?id=${ID}#read`);
    }
    expect(webHandoffUrl(config, 'https://example.com/store?id=x')).toBe('https://example.com/store?id=x');
    expect(webHandoffUrl(config, 'https://yap.pr/testing/store?id=x')).toBe('https://yap.pr/testing/store?id=x');
  });

  it.each(['https://foo.com:x', 'https://a:b:c', 'https://ex%zz.com'])('leaves malformed content links to the browser: %s', (url) => {
    expect(webHandoffUrl(config, url)).toBe(url);
  });

  it('encodes identifiers and omits absent query values', () => {
    expect(webUrl(config, '/post', { id: 'id/&?#', reply: undefined })).toBe(`${v.webBaseUrl}/post?id=id%2F%26%3F%23`);
  });

  it('refuses other prefixed deployments', () => {
    for (const prefix of ['/staging', '/testing', '/devnet'].filter((path) => path !== config.webBasePath)) {
      expect(resolveLink(`https://yap.pr${prefix}/post?id=${ID}`, options).kind).toBe('unsupported');
    }
  });
});
