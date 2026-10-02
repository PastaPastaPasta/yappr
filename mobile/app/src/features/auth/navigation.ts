import { router, useNavigation } from 'expo-router';

/**
 * Closes the whole sign-in modal from any of its screens, back to wherever
 * the user was (PD-7). The screens sit in the sign-in stack, whose parent is
 * the root stack that presented it. After a sign-in, `AuthGates` then shows
 * the terms gate if this identity has not accepted the current terms
 * (AUTH-09). (Replacing the sign-in modal with the gate from inside its
 * nested stack crashes Fabric on Android: "addViewAt: The specified child
 * already has a parent".)
 */
export function useCloseSignIn(): () => void {
  const navigation = useNavigation();
  return () => {
    const parent = navigation.getParent();
    if (parent?.canGoBack()) parent.goBack();
    else if (router.canGoBack()) router.back();
    else router.replace('/');
  };
}
