import type { ReactTestInstance } from 'react-test-renderer';

/**
 * The nearest host `View` above an element: its native parent when that view
 * is not flattened. A test pins `collapsable={false}` on it, so a state change
 * can't move the element between native parents (mobile/CLAUDE.md, "Native
 * view structure").
 */
export function hostViewAbove(element: ReactTestInstance): ReactTestInstance | null {
  let node = element.parent;
  // Host elements have a string type; a test renderer's are React Native's names, not JSX's.
  while (node && (node.type as string) !== 'View') node = node.parent;
  return node;
}
