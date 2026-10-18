/** Shared saved metadata is not proof that this tab restored its signing keys. */
let readIdentity: () => string | null = () => null

export function currentIdentityId(): string | null {
  return readIdentity()
}

/** Bind service reads to the live controller without importing React or the SDK. */
export function bindCurrentIdentity(read: () => string | null): () => void {
  readIdentity = read
  return () => { if (readIdentity === read) readIdentity = () => null }
}
