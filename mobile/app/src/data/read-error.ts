/** G-11's copy for DAPI unavailability (UX_SPEC §5.12). */
export const UNAVAILABLE_MESSAGE = 'Dash Platform is temporarily unavailable. Please try again in a few moments.';
export const GENERIC_MESSAGE = "This couldn't be loaded. Please try again.";

const TRANSPORT = /timed? ?out|timeout|unavailable|network|fetch|disconnect|restart|deadline|503|504|ECONN/i;

/**
 * The inline error a failed read shows (PRD G-11): the unavailability copy
 * for transport failures, else a plain sentence. Raw SDK text never reaches
 * the screen.
 */
export function readErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return GENERIC_MESSAGE;
  const code = (error as { code?: unknown }).code;
  if (code === 'NOT_SUPPORTED') return 'This contract does not support this view.';
  return TRANSPORT.test(`${error.name} ${error.message} ${String(code ?? '')}`) ? UNAVAILABLE_MESSAGE : GENERIC_MESSAGE;
}
