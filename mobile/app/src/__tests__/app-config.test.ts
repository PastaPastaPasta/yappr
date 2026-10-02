import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import appConfig, { resolveBuildNumber } from '../../app.config';
import pkg from '../../package.json';
import { VARIANTS, type Variant } from '../variants';

const APP_DIR = path.resolve(__dirname, '../..');

function configFor(variant: Variant, env: Record<string, string> = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, { APP_VARIANT: variant, YAPPR_ALLOW_PRODUCTION: '1' }, env);
  try {
    return appConfig({ config: {}, projectRoot: APP_DIR, staticConfigPath: null, packageJsonPath: null });
  } finally {
    process.env = saved;
  }
}

describe('resolveBuildNumber', () => {
  it('defaults to 1 for local builds', () => {
    expect(resolveBuildNumber(undefined)).toBe(1);
    expect(resolveBuildNumber('')).toBe(1);
  });

  it('accepts a positive integer up to the Play versionCode ceiling', () => {
    expect(resolveBuildNumber('42')).toBe(42);
    expect(resolveBuildNumber('2100000000')).toBe(2_100_000_000);
  });

  it.each(['0', '-3', '1.5', '1e3', 'abc', '2100000001'])('refuses %p', (raw) => {
    expect(() => resolveBuildNumber(raw)).toThrow(/YAPPR_BUILD_NUMBER/);
  });
});

describe.each(Object.keys(VARIANTS) as Variant[])('app.config for %s (store readiness)', (variant) => {
  const config = configFor(variant, { YAPPR_BUILD_NUMBER: '17' });

  it('takes the display name, version and build number from their sources', () => {
    expect(config.name).toBe(VARIANTS[variant].name);
    expect(config.version).toBe(pkg.version);
    expect(config.ios?.buildNumber).toBe('17');
    expect(config.android?.versionCode).toBe(17);
  });

  it('ships every icon it references', () => {
    const icons = [
      config.icon,
      ...Object.values(typeof config.ios?.icon === 'object' ? config.ios.icon : {}),
      config.android?.adaptiveIcon?.foregroundImage,
      config.android?.adaptiveIcon?.monochromeImage,
    ];
    expect(icons.every(Boolean)).toBe(true);
    for (const icon of icons) {
      expect(icon).toContain(`/icons/${variant}/`);
      expect(fs.existsSync(path.join(APP_DIR, icon!))).toBe(true);
    }
  });

  it('declares no tracking and no collected data', () => {
    expect(config.ios?.privacyManifests).toMatchObject({
      NSPrivacyTracking: false,
      NSPrivacyTrackingDomains: [],
      NSPrivacyCollectedDataTypes: [],
    });
    expect(config.ios?.config?.usesNonExemptEncryption).toBe(true);
  });

  it('keeps app data on the device and drops unused Android permissions', () => {
    expect(config.android?.allowBackup).toBe(false);
    expect(config.android?.blockedPermissions).toEqual(
      expect.arrayContaining([
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
        'android.permission.SYSTEM_ALERT_WINDOW',
      ]),
    );
    expect(config.plugins).toContain('./plugins/release-hardening');
  });
});

describe('release-ios.sh variant guard', () => {
  const script = fs.readFileSync(path.join(APP_DIR, 'scripts/release-ios.sh'), 'utf8');
  const guard = /^bundle_id_matches\(\) \{[\s\S]*?^\}$/m.exec(script)?.[0];

  function matches(applicationId: string, setting: string): boolean {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-ios-'));
    const pbxproj = path.join(dir, 'project.pbxproj');
    fs.writeFileSync(pbxproj, `\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = ${setting};\n`);
    try {
      execFileSync('bash', ['-c', `${guard}\nbundle_id_matches "$0" "$1"`, applicationId, pbxproj]);
      return true;
    } catch {
      return false;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('accepts the bundle id bare or quoted, as Expo prebuild may write it', () => {
    expect(guard).toBeDefined();
    expect(matches('pr.yap.app.dev', 'pr.yap.app.dev')).toBe(true);
    expect(matches('pr.yap.app.dev', '"pr.yap.app.dev"')).toBe(true);
  });

  it('rejects another variant, including look-alikes', () => {
    expect(matches('pr.yap.app.dev', 'pr.yap.app.beta')).toBe(false);
    expect(matches('pr.yap.app', 'pr.yap.app.dev')).toBe(false);
    expect(matches('pr.yap.app.dev', 'prXyapXappXdev')).toBe(false);
  });
});
