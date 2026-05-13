import { nanoid } from 'nanoid'

export async function sendEmail(
  to: string,
  subject: string,
  body: string
): Promise<{ messageId: string }> {
  const messageId = `log-${nanoid(12)}`
  console.log(JSON.stringify({ provider: 'log', to, subject, body, messageId }))
  return { messageId }
}
