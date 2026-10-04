/** G-11's copy for DAPI unavailability (UX_SPEC §5.12). */
export const UNAVAILABLE_MESSAGE = 'Dash Platform is temporarily unavailable. Please try again in a few moments.';
export const GENERIC_MESSAGE = "This couldn't be loaded. Please try again.";
/** A view the network's contracts don't offer (`NOT_SUPPORTED`, UX_SPEC §5.12): nothing about contracts. */
export const NOT_SUPPORTED_MESSAGE = "This isn't available yet.";

const TRANSPORT = /timed? ?out|timeout|unavailable|network|fetch|disconnect|restart|deadline|503|504|ECONN|request error|sending request/i;

/**
 * A failure of the way to Dash Platform (DAPI, the quorum service, the
 * engine), by its text: G-11's "unavailable" category. A proof or quorum
 * verification failure is not one: trying again later won't clear it.
 */
export function isTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return TRANSPORT.test(`${error.name} ${error.message} ${String(code ?? '')}`);
}

const codeOf = (error: unknown) =>
  typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;

/** Engine and RPC codes for a Dash Platform, or an engine, that could not be reached right now. */
const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  'ENGINE_UNAVAILABLE',
  'ENGINE_BUSY',
  'ENGINE_RESTARTED',
  'ENGINE_DISCONNECTED',
  'ENGINE_HELLO_TIMEOUT',
  'RPC_TIMEOUT',
  'UNAVAILABLE',
  'TIMEOUT',
]);

/**
 * G-11's "temporarily unavailable" category, the one place it is decided: an
 * engine code for an unreachable Platform or engine (a call turned away
 * because too many were waiting too), or a transport failure by its text (an
 * SDK error keeps its own code). Every screen's categorized copy shows
 * UX_SPEC §5.12's unavailability message for these (or the network message,
 * for `NETWORK`), and these are the reads NET-03's backoff reads again
 * (`read-retry.ts`), so the copy and the retry always agree. Not a refusal,
 * a missing session or a failed proof: those fail the same way every time.
 */
export function isTemporaryReadFailure(error: unknown): boolean {
  const code = codeOf(error);
  if (code === 'NOT_SIGNED_IN') return false;
  return (typeof code === 'string' && UNAVAILABLE_CODES.has(code)) || isTransportFailure(error);
}

/**
 * The inline error a failed read shows (PRD G-11): the unavailability copy
 * for {@link isTemporaryReadFailure}, else a plain sentence. Raw SDK text
 * never reaches the screen.
 */
export function readErrorMessage(error: unknown): string {
  if (codeOf(error) === 'NOT_SUPPORTED') return NOT_SUPPORTED_MESSAGE;
  return isTemporaryReadFailure(error) ? UNAVAILABLE_MESSAGE : GENERIC_MESSAGE;
}
