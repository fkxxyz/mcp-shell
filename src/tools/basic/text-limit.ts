export const DEFAULT_MAX_LINES = 2_000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

export class BoundedTextTail {
  private readonly decoder = new TextDecoder();
  private text = "";
  private wasTruncated = false;

  append(chunk: Buffer): void {
    this.text += this.decoder.decode(chunk, { stream: true });
    this.trim();
  }

  finish(): { text: string; truncated: boolean } {
    this.text += this.decoder.decode();
    this.trim();
    return { text: this.text, truncated: this.wasTruncated };
  }

  private trim(): void {
    const bytes = Buffer.from(this.text, "utf8");
    if (bytes.byteLength > DEFAULT_MAX_BYTES) {
      let start = bytes.byteLength - DEFAULT_MAX_BYTES;
      while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) start++;
      this.text = bytes.subarray(start).toString("utf8");
      this.wasTruncated = true;
    }

    const lines = this.text.split("\n");
    if (lines.length > DEFAULT_MAX_LINES) {
      this.text = lines.slice(lines.length - DEFAULT_MAX_LINES).join("\n");
      this.wasTruncated = true;
    }
  }
}
