/**
 * Secret-store entries no build writes any more, removed wherever they are
 * still found: the password-era auth vault's data key (`avd_<identityId>`).
 * With the vault documents, which are public on chain, it would open the
 * keys the vault sealed, and nothing else clears it since the vault is gone.
 */
const RETIRED_ENTRIES = ['avd_']

/** Removes the retired entries under `prefix` (the secret store's key prefix) from `storage`. */
export function purgeRetiredSecrets(storage: Storage, prefix: string): void {
  const retired: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key && RETIRED_ENTRIES.some((entry) => key.startsWith(prefix + entry))) retired.push(key)
  }
  for (const key of retired) storage.removeItem(key)
}
