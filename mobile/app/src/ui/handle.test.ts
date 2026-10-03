import { keepHandlesWhole } from './handle';

const WJ = '⁠';

describe('keepHandlesWhole (D-L3i-006)', () => {
  it('leaves no break or hyphenation point inside a handle, and none elsewhere changes', () => {
    // iOS's menu split "Unfollow @siob-han76" across two lines.
    const title = keepHandlesWhole('Unfollow @siobhan76');
    expect(title).toBe(`Unfollow ${['@', 's', 'i', 'o', 'b', 'h', 'a', 'n', '7', '6'].join(WJ)}`);
    // Only invisible joiners were added: it reads the same.
    expect(title.replace(/⁠/g, '')).toBe('Unfollow @siobhan76');
  });

  it("makes a handle's own hyphens non-breaking", () => {
    const title = keepHandlesWhole('Block @sigrid-tea-3');
    expect(title).not.toContain('-');
    expect(title.replace(/⁠/g, '')).toBe('Block @sigrid‑tea‑3');
  });

  it('leaves titles without a handle alone', () => {
    expect(keepHandlesWhole('View post engagements')).toBe('View post engagements');
    expect(keepHandlesWhole('Block Siobhán Bianchi')).toBe('Block Siobhán Bianchi');
  });
});
