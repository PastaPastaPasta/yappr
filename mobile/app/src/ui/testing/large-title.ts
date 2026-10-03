import type { ReactTestInstance } from 'react-test-renderer';

/** A host (native) view's component name, such as `RCTScrollView`; null for a React component. */
const hostName = (node: ReactTestInstance): string | null => (typeof node.type === 'string' ? (node.type as string) : null);

/** The host (native) views under `node`, in order, looking through components. */
function hostChildren(node: ReactTestInstance): ReactTestInstance[] {
  return node.children.flatMap((child) => {
    if (typeof child === 'string') return [];
    return hostName(child) !== null ? [child] : hostChildren(child);
  });
}

/**
 * The scroll view an iOS large title tracks on the last mounted screen:
 * UIKit (and react-native-screens) follow each view's first subview down
 * from the screen and take the first scroll view they meet. Null when
 * something else comes first, as a banner above the list would; then the
 * large title stays drawn over the rows instead of collapsing (D-L4i-004).
 */
export function largeTitleScrollView(root: ReactTestInstance): ReactTestInstance | null {
  const screens = root.findAll((node) => hostName(node) === 'RNSScreen');
  let node: ReactTestInstance | undefined = screens[screens.length - 1];
  while (node) {
    if (hostName(node) === 'RCTScrollView') return node;
    node = hostChildren(node)[0];
  }
  return null;
}
