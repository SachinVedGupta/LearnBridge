import { Suggestion } from './contracts';

export type { Suggestion, EditOut } from './contracts';

// Helper for front-end mapping
export interface MappedSuggestion extends Suggestion {
  absoluteFrom: number;
  absoluteTo: number;
  stale?: boolean;
}

