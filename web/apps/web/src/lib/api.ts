import { AskIn, AskOut, EditIn, EditOut } from '@assignment-ai/shared';
async function post<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, {method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload), signal: AbortSignal.timeout(45000)});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}
export const askAPI = (payload: AskIn) => post<AskOut>('ask', payload);
export const editAPI = (payload: EditIn) => post<EditOut>('edit', payload);
