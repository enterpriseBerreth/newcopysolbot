import { createLogger } from "../logger.js";

const log = createLogger("telegram");
const MAX_MESSAGE_LENGTH = 3500;

export function splitTelegramMessage(text: string): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? [""]) {
    if (current.length + line.length > MAX_MESSAGE_LENGTH && current) {
      chunks.push(current);
      current = "";
    }
    current += line;
    while (current.length > MAX_MESSAGE_LENGTH) {
      chunks.push(current.slice(0, MAX_MESSAGE_LENGTH));
      current = current.slice(MAX_MESSAGE_LENGTH);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export interface NotifierLike {
  send(text: string): Promise<void>;
}

export class TelegramNotifier implements NotifierLike {
  constructor(private botToken: string, private chatId: string) {}

  get enabled(): boolean {
    return Boolean(this.botToken && this.chatId);
  }

  async send(text: string): Promise<void> {
    await this.deliver(text);
  }

  async sendReport(text: string): Promise<boolean> {
    return this.deliver(text);
  }

  private async deliver(text: string): Promise<boolean> {
    if (!this.enabled) return false;
    const chunks = splitTelegramMessage(text);
    for (const chunk of chunks) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: this.chatId, text: chunk }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          log.warn(`sendMessage -> HTTP ${res.status}`);
          return false;
        }
      } catch (err) {
        log.warn(`sendMessage failed: ${String(err)}`);
        return false;
      }
    }
    return true;
  }
}
