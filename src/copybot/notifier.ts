import { createLogger } from "../logger.js";

const log = createLogger("telegram");

export interface NotifierLike {
  send(text: string): Promise<void>;
}

export class TelegramNotifier implements NotifierLike {
  constructor(private botToken: string, private chatId: string) {}

  get enabled(): boolean {
    return Boolean(this.botToken && this.chatId);
  }

  async send(text: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) log.warn(`sendMessage -> HTTP ${res.status}`);
    } catch (err) {
      log.warn(`sendMessage failed: ${String(err)}`);
    }
  }
}
