/** Ports describe future adapters. Parsing a record does not authenticate its owner. */
export type UUID = string;
export type Edition = 'local' | 'hosted';
export type LocalIdentity = Readonly<{ edition: 'local'; student_id: UUID }>;
export type HostedIdentity = Readonly<{ edition: 'hosted'; user_id: UUID; session_ref: string }>;
export type Identity = LocalIdentity | HostedIdentity;
export type CapabilityState = 'available' | 'requires_auth' | 'requires_scope' | 'unsupported' | 'degraded' | 'unknown';
export type ExecutionDestination =
  | Readonly<{ surface: 'local_ui' | 'local_worker'; processor: null }>
  | Readonly<{ surface: 'cloud_host' | 'embedded_cloud_agent'; processor: string }>;
export interface ScopedPrincipal {
  /** Constructed by the edition's verified auth/policy adapter, never HTTP body claims. */
  readonly identity: Identity;
  readonly active_grant_ids: readonly UUID[];
  readonly destination: ExecutionDestination;
  readonly purpose: string;
}
export type Deadline =
  | Readonly<{ precision: 'unknown'; reason?: string; original?: string }>
  | Readonly<{ precision: 'date'; date: string; timezone?: string; original?: string }>
  | Readonly<{ precision: 'instant'; instant: string; timezone?: string; original?: string }>;
export interface VersionedRecord {
  readonly id: UUID;
  readonly student_id: UUID;
  readonly schema_version: number;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
}
export interface RecordRepository<T extends VersionedRecord> {
  get(principal: ScopedPrincipal, id: UUID): Promise<T | null>;
  list(principal: ScopedPrincipal, query: { limit: number; cursor?: string }): Promise<{
    items: readonly T[]; next_cursor: string | null;
  }>;
  create(principal: ScopedPrincipal, record: T, idempotency_key: string): Promise<T>;
  /** Check and update atomically; conflicts must preserve the previous record. */
  update(principal: ScopedPrincipal, record: T, expected_revision: number): Promise<T>;
  remove(principal: ScopedPrincipal, id: UUID, expected_revision: number): Promise<void>;
}
export interface StorageAdapter {
  readonly edition: Edition;
  /** Transaction callback must not perform external network side effects. */
  transaction<T>(work: () => Promise<T>): Promise<T>;
  migrate(expected_schema: number): Promise<{ schema_version: number }>;
  verifyIntegrity(): Promise<{ valid: boolean; failures: readonly string[] }>;
  close(): Promise<void>;
}
export interface IdentityAdapter {
  readonly edition: Edition;
  /** Hosted implementation uses Supabase verification; local uses pairing/IPC auth. */
  verify(request: unknown): Promise<Identity>;
}
export interface AgentAdapter {
  readonly id: string;
  probe(): Promise<{ state: CapabilityState; version: string | null; inference_verified: boolean }>;
  start(input: { principal: ScopedPrincipal; recipe_id: string; signal: AbortSignal }): AsyncIterable<{
    sequence: number; type: string; payload_ref: UUID | null;
  }>;
  /** Limits/auth errors never imply permission to select a different billing mode. */
  cancel(run_id: UUID): Promise<void>;
}
export declare function assertEditionIdentity(edition: Edition, identity: unknown): Identity;
export declare function parseExecutionDestination(value: unknown): ExecutionDestination;
