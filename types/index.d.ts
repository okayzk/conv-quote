// One quote waiting to be sent with the next prompt.
// `id` is the transcript message uuid (the row's ui.render requestId); absent when
// the selection spanned several rows and no single message contains it.
export type Quote = {
  n: number
  id?: string
  role?: 'user' | 'assistant'
  time?: number
  seq?: number
  text: string
  // Span [start, end) of the quote in the raw message text, and up to 25 raw chars on each side;
  // absent when the rendered selection could not be matched back to the raw text.
  start?: number
  end?: number
  before?: string
  after?: string
  // The selection ran across several messages; `id` is the first of them, start/end its part.
  spans?: true
}

// The quoted message outlined for a few seconds after a jump from a sent quote.
export type Flash = { id: string; n: number; text: string; token: number }

declare module 'claude-code' {
  interface PluginState {
    'conv-quote': {
      quotes: Shaped<Quote[]>
      // Bumped whenever the transcript index gains entries, so rows drawn before
      // their JSONL line existed redraw with their time.
      rev: number
      flash: Flash | null
    }
  }
}
