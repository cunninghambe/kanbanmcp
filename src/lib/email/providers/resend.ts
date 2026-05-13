/**
 * Resend email provider — stub for M2/M3.
 * Full Resend wiring (API key, domain verification, template) is deferred.
 */
export async function sendEmail(
  _to: string,
  _subject: string,
  _body: string
): Promise<{ messageId: string }> {
  throw new Error('Not implemented in M1')
}
