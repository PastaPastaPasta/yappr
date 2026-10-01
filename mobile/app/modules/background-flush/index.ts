import { requireOptionalNativeModule } from 'expo';

interface BackgroundFlushModule {
  begin(): number;
  end(id: number): void;
}

/** iOS only; Android keeps the process alive long enough without help, so these are no-ops there. */
const native = requireOptionalNativeModule<BackgroundFlushModule>('BackgroundFlush');

/**
 * Run `work` inside an iOS background task (`beginBackgroundTask`), so a
 * flush started as the app goes to the background is not frozen half way.
 */
export async function withBackgroundTask<T>(work: () => Promise<T>): Promise<T> {
  const id = native?.begin();
  try {
    return await work();
  } finally {
    if (id !== undefined) native?.end(id);
  }
}
