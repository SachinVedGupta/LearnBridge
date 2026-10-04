import { Composio } from '@composio/core';
import { AppError, appOrigin } from './auth';
import { CLOUD_TOOL_CONTRACTS, createHostedCloudOnboarding } from './cloud-onboarding-service.mjs';

type Provider = 'googledocs' | 'notion';
export function hostedCloudOnboarding(userId: string) {
  const secret = process.env.COMPOSIO_API_KEY;
  if (!secret) throw new AppError('Selected cloud imports need the existing app-connection configuration.', 503);
  const client = new Composio({ apiKey: secret, allowTracking: false, disableVersionCheck: true,
    toolkitVersions: { googledocs: CLOUD_TOOL_CONTRACTS.googledocs.version, notion: CLOUD_TOOL_CONTRACTS.notion.version } });
  const transport = {
    async listAccounts(owner: string, signal: AbortSignal) {
      // The server-verified owner is the only identity passed to the provider.
      // Copy metadata only, never response.state/data/params credential fields.
      const result = await client.connectedAccounts.list({ userIds: [owner], toolkitSlugs: ['googledocs', 'notion'], accountType: 'PRIVATE', statuses: ['ACTIVE'], limit: 100 }, { signal });
      return { partial: Boolean(result.nextCursor), items: result.items.map(account => ({ id: account.id, provider: account.toolkit.slug,
        owner_id: owner, shared: account.experimental?.accountType === 'SHARED', status: account.isDisabled ? 'DISABLED' : account.status,
        configured: Boolean(process.env[`COMPOSIO_AUTH_${account.toolkit.slug.toUpperCase()}`]) && !account.authConfig.isDisabled
          && account.authConfig.id === process.env[`COMPOSIO_AUTH_${account.toolkit.slug.toUpperCase()}`] })) };
    },
    async schemas(provider: Provider, signal: AbortSignal) {
      const contract = CLOUD_TOOL_CONTRACTS[provider];
      return Promise.all([contract.search, contract.read].map(async slug => {
        const tool = await client.tools.getRawComposioToolBySlug(slug, { version: contract.version }, { signal });
        const parameters = tool.inputParameters as { properties?: Record<string, unknown> };
        return { slug: tool.slug, version: tool.version, input_fields: Object.keys(parameters.properties || {}) };
      }));
    },
    async execute(owner: string, choice: { provider: Provider; account_id: string }, slug: string, args: Record<string, unknown>, signal: AbortSignal) {
      const contract = CLOUD_TOOL_CONTRACTS[choice.provider];
      if (![contract.search, contract.read].includes(slug)) throw new AppError('This tool is outside the selected read-only import.', 403);
      const result = await client.tools.execute(slug, { userId: owner, connectedAccountId: choice.account_id, arguments: args, version: contract.version, allowTracing: false }, { signal });
      if (result.error || result.successful === false) throw new AppError('The selected account could not return this item. Check access or reconnect.', 502);
      return result.data;
    },
  };
  return createHostedCloudOnboarding({ transport, secret, origin: appOrigin(), userId });
}

export async function cloudRequestBody(request: Request, maxBytes = 180000) {
  if (!request.body) throw new AppError('Choose a valid selected-source operation.');
  const reader = request.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) { const result = await reader.read(); if (result.done) break; size += result.value.byteLength; if (size > maxBytes) { await reader.cancel(); throw new AppError('This selected-source request is too large.', 413); } chunks.push(result.value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new AppError('Choose a valid selected-source operation.'); }
}

export function cloudOperationError(error: unknown) {
  if (error instanceof AppError) return error;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : 'PROVIDER_FAILURE';
  const errors: Record<string, [string, number]> = {
    AUTH_REQUIRED: ['Sign in to your own LearnBridge account.', 401],
    CONSENT_REQUIRED: ['This account or reviewed selection is no longer available. Refresh and select it again.', 403],
    SCOPE_DENIED: ['This source is outside the selected read-only import.', 403],
    INVALID_INPUT: ['Choose an active account, a specific search and up to three valid items.', 400],
    BUDGET_EXCEEDED: ['The selected response exceeds the import limit. Choose a smaller document or a manual excerpt.', 413],
    VERSION_MISMATCH: ['The provider tool schema or reviewed selection changed. Refresh before continuing.', 409],
    CANCELLED: ['The selected-source operation was cancelled. No bundle was prepared.', 409],
    PROVIDER_FAILURE: ['The selected account could not return compatible content. Check access or reconnect.', 502],
  };
  const [message, status] = errors[String(code)] || errors.PROVIDER_FAILURE; return new AppError(message, status);
}
