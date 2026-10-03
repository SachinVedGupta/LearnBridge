export type CopyOutcome = 'copied' | 'failed';
export type ClipboardWriter = { writeText: (text: string) => Promise<void> };

/** Observe success only after the browser confirms its write. Collection is
 * optional; an unavailable observer must never turn a successful copy into a
 * product failure. This function stores no event or browser/account identity. */
export async function copyPrompt(
  text: string,
  clipboard: ClipboardWriter | undefined,
  onSuccess?: () => void | Promise<void>,
): Promise<CopyOutcome> {
  if (!clipboard || typeof clipboard.writeText !== 'function') return 'failed';
  try {
    await clipboard.writeText(text);
  } catch {
    return 'failed';
  }
  try {
    void Promise.resolve(onSuccess?.()).catch(() => {});
  } catch {
    // Optional measurement must not block setup or copying.
  }
  return 'copied';
}
