/**
 * Markdown → Slack mrkdwn — spec §4.8 format.ts. Escaping comes first so model
 * output can never ping a channel or spoof a link label. (WI-3)
 */
import { describe, it, expect } from 'vitest'
import { markdownToMrkdwn } from '../../../src/lib/slack/format'

describe('slack/format markdownToMrkdwn', () => {
  it('escapes &, < and > across the whole input before anything else', () => {
    expect(markdownToMrkdwn('a & b')).toBe('a &amp; b')
    expect(markdownToMrkdwn('a < b > c')).toBe('a &lt; b &gt; c')
    expect(markdownToMrkdwn('x &amp; y')).toBe('x &amp;amp; y')
  })

  it('neuters channel/here/user/channel-ref pings that the model might emit', () => {
    expect(markdownToMrkdwn('<!channel> all hands')).toBe('&lt;!channel&gt; all hands')
    expect(markdownToMrkdwn('<!here>')).toBe('&lt;!here&gt;')
    expect(markdownToMrkdwn('cc <@U123>')).toBe('cc &lt;@U123&gt;')
    expect(markdownToMrkdwn('see <#C1|general>')).toBe('see &lt;#C1|general&gt;')
  })

  it('converts bold, italics, headings and bullets', () => {
    expect(markdownToMrkdwn('**bold** and __also__')).toBe('*bold* and *also*')
    expect(markdownToMrkdwn('*it* and _it_')).toBe('_it_ and _it_')
    expect(markdownToMrkdwn('# Heading\ntext')).toBe('*Heading*\ntext')
    expect(markdownToMrkdwn('### Small heading')).toBe('*Small heading*')
    expect(markdownToMrkdwn('- one\n- two\n* three')).toBe('• one\n• two\n• three')
  })

  it('keeps code fences (escaped inside)', () => {
    expect(markdownToMrkdwn('```\nif (a < b) {}\n```')).toBe('```\nif (a &lt; b) {}\n```')
  })

  it('emits <url|label> only for allowlisted http(s) targets, with the normalized href', () => {
    expect(markdownToMrkdwn('[docs](https://Example.com/x)')).toBe('<https://example.com/x|docs>')
    expect(markdownToMrkdwn('[x](javascript:alert(1))')).toBe('x')
    expect(markdownToMrkdwn('[x](data:text/html,hi)')).toBe('x')
    expect(markdownToMrkdwn('[x](//evil.example)')).toBe('x')
    expect(markdownToMrkdwn('[x](/relative)')).toBe('x')
  })

  it('a label-spoofed link keeps only the allowlisted target and cannot break out of the span', () => {
    expect(markdownToMrkdwn('[https://intranet.corp/invoice](https://evil.example)')).toBe(
      '<https://evil.example/|https://intranet.corp/invoice>'
    )
    expect(markdownToMrkdwn('[a|b<c>](https://ok.example)')).toBe(
      '<https://ok.example/|ab&lt;c&gt;>'
    )
    // a pipe smuggled into the URL must not become the label boundary
    expect(markdownToMrkdwn('[Details](https://evil.example/?r=|https://intranet.corp/x)')).toBe(
      '<https://evil.example/?r=%7Chttps://intranet.corp/x|Details>'
    )
  })

  it('strips other markdown it cannot express', () => {
    expect(markdownToMrkdwn('> quoted')).toBe('quoted')
    expect(markdownToMrkdwn('---')).toBe('')
    expect(markdownToMrkdwn('![alt](https://img.example/a.png)')).toBe('alt')
  })

  it('handles a realistic composer body', () => {
    const md =
      '# Update\n\nHi **team** — see [the plan](https://docs.google.com/document/d/1/edit).\n\n- Ship & test\n- Tell <@U1>\n'
    expect(markdownToMrkdwn(md)).toBe(
      '*Update*\n\nHi *team* — see <https://docs.google.com/document/d/1/edit|the plan>.\n\n• Ship &amp; test\n• Tell &lt;@U1&gt;'
    )
  })
})
