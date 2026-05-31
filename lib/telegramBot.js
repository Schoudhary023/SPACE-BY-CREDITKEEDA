const { EventEmitter } = require("events");

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_LONG_POLL_TIMEOUT_SECONDS = 30;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TelegramBot extends EventEmitter {
  constructor(token, options = {}) {
    super();

    if (!token) {
      throw new Error("Telegram bot token is required");
    }

    this.token = token;
    this.apiBaseUrl = `https://api.telegram.org/bot${token}`;
    this.fileBaseUrl = `https://api.telegram.org/file/bot${token}`;
    this.pollIntervalMs = Number(options.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS;
    this.longPollTimeoutSeconds = Number(options.longPollTimeoutSeconds) || DEFAULT_LONG_POLL_TIMEOUT_SECONDS;
    this.polling = Boolean(options.polling);
    this.offset = 0;
    this.abortController = null;
    this.pollLoopPromise = null;

    if (this.polling) {
      this.startPolling();
    }
  }

  async callApi(method, payload = {}) {
    const response = await fetch(`${this.apiBaseUrl}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    let body;
    try {
      body = await response.json();
    } catch (error) {
      const parseError = new Error(`Telegram API ${method} returned a non-JSON response`);
      parseError.cause = error;
      parseError.statusCode = response.status;
      throw parseError;
    }

    if (!response.ok || !body.ok) {
      const error = new Error(body?.description || `Telegram API ${method} failed`);
      error.statusCode = response.status;
      error.code = body?.error_code || response.status;
      error.response = body;
      throw error;
    }

    return body.result;
  }

  async getUpdates(signal) {
    return this.callApi("getUpdates", {
      offset: this.offset,
      timeout: this.longPollTimeoutSeconds,
      allowed_updates: ["message", "callback_query"],
    }, signal);
  }

  async startPolling() {
    if (this.pollLoopPromise) {
      return this.pollLoopPromise;
    }

    this.polling = true;
    this.abortController = new AbortController();

    this.pollLoopPromise = (async () => {
      while (this.polling) {
        try {
          const response = await fetch(`${this.apiBaseUrl}/getUpdates`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              offset: this.offset,
              timeout: this.longPollTimeoutSeconds,
              allowed_updates: ["message", "callback_query"],
            }),
            signal: this.abortController.signal,
          });

          const body = await response.json();
          if (!response.ok || !body.ok) {
            const error = new Error(body?.description || "Telegram getUpdates failed");
            error.statusCode = response.status;
            error.code = body?.error_code || response.status;
            throw error;
          }

          for (const update of body.result || []) {
            this.offset = Math.max(this.offset, Number(update.update_id) + 1);

            if (update.message) {
              this.emit("message", update.message);
            }

            if (update.callback_query) {
              this.emit("callback_query", update.callback_query);
            }
          }
        } catch (error) {
          if (!this.polling) {
            break;
          }

          if (error.name === "AbortError") {
            break;
          }

          this.emit("polling_error", error);
          await sleep(this.pollIntervalMs);
        }
      }
    })();

    try {
      await this.pollLoopPromise;
    } finally {
      this.pollLoopPromise = null;
      this.abortController = null;
    }
  }

  async stopPolling() {
    this.polling = false;

    if (this.abortController) {
      this.abortController.abort();
    }

    if (this.pollLoopPromise) {
      await this.pollLoopPromise.catch(() => {});
    }
  }

  async sendMessage(chatId, text, options = {}) {
    return this.callApi("sendMessage", {
      chat_id: chatId,
      text,
      ...options,
    });
  }

  async answerCallbackQuery(callbackQueryId, options = {}) {
    return this.callApi("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...options,
    });
  }

  async deleteMessage(chatId, messageId) {
    return this.callApi("deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
  }

  async editMessageText(text, options = {}) {
    return this.callApi("editMessageText", {
      text,
      ...options,
    });
  }

  async editMessageReplyMarkup(replyMarkup, options = {}) {
    return this.callApi("editMessageReplyMarkup", {
      reply_markup: replyMarkup,
      ...options,
    });
  }

  async sendChatAction(chatId, action) {
    return this.callApi("sendChatAction", {
      chat_id: chatId,
      action,
    });
  }

  async getFile(fileId) {
    return this.callApi("getFile", {
      file_id: fileId,
    });
  }

  async getFileLink(fileId) {
    const file = await this.getFile(fileId);
    if (!file?.file_path) {
      throw new Error("Telegram file path not found");
    }
    return `${this.fileBaseUrl}/${file.file_path}`;
  }
}

module.exports = TelegramBot;
