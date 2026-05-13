import { sendEmail as logSend } from './providers/log'
import { sendEmail as resendSend } from './providers/resend'

const provider = process.env.EMAIL_PROVIDER ?? 'log'

export function sendEmail(to: string, subject: string, body: string): Promise<{ messageId: string }> {
  if (provider === 'resend') return resendSend(to, subject, body)
  return logSend(to, subject, body)
}
