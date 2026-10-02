'use client';

import { MappedSuggestion } from '@assignment-ai/shared';

interface InlineSuggestionWidgetProps {
  suggestion: MappedSuggestion;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
}

export function InlineSuggestionWidget({ suggestion, onAccept, onReject }: InlineSuggestionWidgetProps) {
  // Truncate long replacements for display
  const displayText = suggestion.replacement.length > 100 
    ? suggestion.replacement.substring(0, 97) + '...'
    : suggestion.replacement;
    
  return (
    <span className="inline-suggestion-widget">
      <span className="inline-suggestion-replacement" title={suggestion.replacement}>
        {displayText}
      </span>
      <span className="inline-suggestion-controls">
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onAccept(suggestion.id);
          }}
          className="inline-suggestion-btn inline-suggestion-accept"
          title={suggestion.reason}
        >
          ✓ Accept
        </button>
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onReject(suggestion.id);
          }}
          className="inline-suggestion-btn inline-suggestion-reject"
        >
          ✗ Reject
        </button>
      </span>
    </span>
  );
}

