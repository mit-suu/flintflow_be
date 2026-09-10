/**
 * JsonStreamExtractor
 * Extracts the "reply" string in real-time from a streaming JSON LLM response,
 * filtering out any reasoning/thinking tokens and preamble before "reply",
 * unescaping escape characters on the fly, while accumulating the full raw response
 * for final JSON / schema parsing.
 */
export class JsonStreamExtractor {
  private buffer = ""
  private inReply = false
  private replyDone = false
  private emittedReply = ""
  private fullRaw = ""
  private quoteChar = '"'

  public push(chunk: string): string {
    this.fullRaw += chunk
    if (this.replyDone) return ""

    this.buffer += chunk

    if (!this.inReply) {
      // Look for "reply" or 'reply' followed by ":" and opening quote
      const replyMatch = this.buffer.match(/(?:'|")reply(?:'|")\s*:\s*(['"])/i)
      if (replyMatch && replyMatch.index !== undefined) {
        this.inReply = true
        this.quoteChar = replyMatch[1]
        this.buffer = this.buffer.slice(replyMatch.index + replyMatch[0].length)
      } else {
        // Discard buffer if it has reached a complete thinking block </think>
        const thinkEnd = this.buffer.lastIndexOf("</think>")
        if (thinkEnd !== -1) {
          this.buffer = this.buffer.slice(thinkEnd + 8)
        }
        return ""
      }
    }

    // Inside the JSON string value for "reply":
    let delta = ""
    let i = 0
    while (i < this.buffer.length) {
      const char = this.buffer[i]

      if (char === "\\") {
        if (i + 1 < this.buffer.length) {
          const nextChar = this.buffer[i + 1]
          if (nextChar === "n") delta += "\n"
          else if (nextChar === "t") delta += "\t"
          else if (nextChar === "r") delta += "\r"
          else if (nextChar === '"') delta += '"'
          else if (nextChar === "'") delta += "'"
          else if (nextChar === "\\") delta += "\\"
          else if (nextChar === "/") delta += "/"
          else if (nextChar === "u" && i + 5 < this.buffer.length) {
            const hex = this.buffer.slice(i + 2, i + 6)
            if (/^[0-9a-fA-F]{4}$/.test(hex)) {
              delta += String.fromCharCode(parseInt(hex, 16))
              i += 6
              continue
            } else {
              delta += nextChar
            }
          } else {
            delta += nextChar
          }
          i += 2
          continue
        } else {
          // Trailing backslash, wait for next chunk
          break
        }
      } else if (char === this.quoteChar) {
        // Closing quote of "reply" reached!
        // Immediately STOP streaming deltas to the chat bubble.
        this.replyDone = true
        this.buffer = ""
        this.emittedReply += delta
        return delta
      } else {
        delta += char
        i++
      }
    }

    this.buffer = this.buffer.slice(i)
    this.emittedReply += delta
    return delta
  }

  public finish(): { reply: string; fullRaw: string } {
    if (!this.replyDone && this.buffer.length > 0 && this.inReply) {
      this.emittedReply += this.buffer
      this.buffer = ""
    }

    let finalReply = this.emittedReply.trim()
    if (!finalReply) {
      let cleaned = this.fullRaw
      const thinkIdx = cleaned.lastIndexOf("</think>")
      if (thinkIdx !== -1) {
        cleaned = cleaned.slice(thinkIdx + 8).trim()
      }
      try {
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0])
          if (parsed.reply) finalReply = parsed.reply
        }
      } catch (_) {}
      if (!finalReply) finalReply = cleaned
    }

    return {
      reply: finalReply,
      fullRaw: this.fullRaw
    }
  }

  public getFullRaw(): string {
    return this.fullRaw
  }

  public getEmittedReply(): string {
    return this.emittedReply
  }
}
