import { Composio } from '@composio/core';
import { AppError, appOrigin } from './auth';
import { EMAIL_TOOL_CONTRACT, createHostedEmailOnboarding } from './email-onboarding-service.mjs';

export function hostedEmailOnboarding(userId: string) {
  const secret = process.env.COMPOSIO_API_KEY;
  if (!secret) throw new AppError('Selected email imports need the existing app-connection configuration.', 503);
  const client = new Composio({ apiKey: secret, allowTracking: false, disableVersionCheck: true, toolkitVersions: { gmail: EMAIL_TOOL_CONTRACT.version } });
  const transport = {
    async listAccounts(owner: string, signal: AbortSignal) {
      const result = await client.connectedAccounts.list({ userIds: [owner], toolkitSlugs: ['gmail'], accountType: 'PRIVATE', statuses: ['ACTIVE'], limit: 100 }, { signal });
      return { partial: Boolean(result.nextCursor), items: result.items.map(account => ({ id: account.id, provider: account.toolkit.slug, owner_id: owner,
        shared: account.experimental?.accountType === 'SHARED', status: account.isDisabled ? 'DISABLED' : account.status,
        configured: Boolean(process.env.COMPOSIO_AUTH_GMAIL) && !account.authConfig.isDisabled && account.authConfig.id === process.env.COMPOSIO_AUTH_GMAIL })) };
    },
    async schemas(signal: AbortSignal) {
      return Promise.all([EMAIL_TOOL_CONTRACT.search, EMAIL_TOOL_CONTRACT.read].map(async slug => {
        const tool = await client.tools.getRawComposioToolBySlug(slug, { version: EMAIL_TOOL_CONTRACT.version }, { signal });
        const parameters = tool.inputParameters as { properties?: Record<string, unknown> };
        return { slug: tool.slug, version: tool.version, input_fields: Object.keys(parameters.properties || {}) };
      }));
    },
    async execute(owner: string, accountId: string, slug: string, args: Record<string, unknown>, signal: AbortSignal) {
      if (slug !== EMAIL_TOOL_CONTRACT.search && slug !== EMAIL_TOOL_CONTRACT.read) throw new AppError('This tool is outside the selected email import.', 403);
      const result = await client.tools.execute(slug, { userId: owner, connectedAccountId: accountId, arguments: args, version: EMAIL_TOOL_CONTRACT.version, allowTracing: false }, { signal });
      if (result.error || result.successful === false) throw new AppError('The selected Gmail account could not complete this read. Check its existing permissions and access; no new permissions were requested.', 502);
      return result.data;
    },
  };
  return createHostedEmailOnboarding({ transport, secret, origin: appOrigin(), userId });
}
export function emailOperationError(error: unknown) {
  if (error instanceof AppError) return error;
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'PROVIDER_FAILURE';
  const messages: Record<string, [string, number]> = {
    AUTH_REQUIRED: ['Sign in to your own LearnBridge account.', 401],
    CONSENT_REQUIRED: ['The account or reviewed message selection changed or expired. Refresh and select it again.', 403],
    SCOPE_DENIED: ['This source is outside the selected email import.', 403],
    INVALID_INPUT: ['Choose your Gmail account, one supported folder, up to 90 UTC days and a specific subject phrase without search operators.', 400],
    BUDGET_EXCEEDED: ['The selected response exceeds the import limit. Choose a narrower date range, fewer messages or a manual excerpt.', 413],
    VERSION_MISMATCH: ['The tool schema or selected message metadata changed. Search and review again.', 409],
    UNSUPPORTED: ['This message has no supported inline UTF-8/ASCII plain-text body. HTML-only messages, attachments and other encodings need a separately reviewed manual excerpt.', 422],
    CANCELLED: ['The selected email operation was cancelled. No bundle was prepared.', 409],
    PROVIDER_FAILURE: ['The selected account did not return a compatible message. Check access and the existing connection.', 502],
  };
  const [message, status] = messages[code] || messages.PROVIDER_FAILURE; return new AppError(message, status);
}
