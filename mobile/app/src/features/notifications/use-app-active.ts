import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

/** True while the app is in the foreground. At launch the state may still read `unknown`, which counts. */
export function useAppActive(): boolean {
  const [active, setActive] = useState(
    AppState.currentState !== 'background' && AppState.currentState !== 'inactive',
  );
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => setActive(next === 'active'));
    return () => subscription.remove();
  }, []);
  return active;
}
