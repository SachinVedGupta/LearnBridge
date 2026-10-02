export interface WritingStats {
  wordCount: number;
  charCount: number;
  charCountNoSpaces: number;
  sentenceCount: number;
  paragraphCount: number;
  avgSentenceLength: number;
  readingTimeMinutes: number;
  readabilityScore: number;
  readabilityLevel: string;
  vocabularyDiversity: number;
}

/**
 * Count syllables in a word (simple approximation)
 */
function countSyllables(word: string): number {
  word = word.toLowerCase();
  if (word.length <= 3) return 1;
  
  // Remove silent 'e' at the end
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '');
  word = word.replace(/^y/, '');
  
  // Count vowel groups
  const matches = word.match(/[aeiouy]{1,2}/g);
  return matches ? Math.max(1, matches.length) : 1;
}

/**
 * Calculate Flesch Reading Ease score
 * Score ranges: 90-100 (Very Easy), 60-70 (Standard), 0-30 (Very Difficult)
 */
function calculateFleschScore(words: number, sentences: number, syllables: number): number {
  if (sentences === 0 || words === 0) return 0;
  
  const avgWordsPerSentence = words / sentences;
  const avgSyllablesPerWord = syllables / words;
  
  const score = 206.835 - (1.015 * avgWordsPerSentence) - (84.6 * avgSyllablesPerWord);
  return Math.max(0, Math.min(100, score));
}

/**
 * Convert Flesch score to readable level
 */
function getReadabilityLevel(score: number): string {
  if (score >= 90) return 'Very Easy';
  if (score >= 80) return 'Easy';
  if (score >= 70) return 'Fairly Easy';
  if (score >= 60) return 'Standard';
  if (score >= 50) return 'Fairly Difficult';
  if (score >= 30) return 'Difficult';
  return 'Very Difficult';
}

/**
 * Analyze text and return comprehensive writing statistics
 */
export function analyzeText(text: string): WritingStats {
  // Handle empty text
  if (!text || text.trim().length === 0) {
    return {
      wordCount: 0,
      charCount: 0,
      charCountNoSpaces: 0,
      sentenceCount: 0,
      paragraphCount: 0,
      avgSentenceLength: 0,
      readingTimeMinutes: 0,
      readabilityScore: 0,
      readabilityLevel: 'N/A',
      vocabularyDiversity: 0,
    };
  }

  // Character counts
  const charCount = text.length;
  const charCountNoSpaces = text.replace(/\s+/g, '').length;

  // Word count
  const words = text
    .trim()
    .split(/\s+/)
    .filter(word => word.length > 0 && /[a-zA-Z0-9]/.test(word));
  const wordCount = words.length;

  // Sentence count (split by . ! ?)
  const sentences = text
    .split(/[.!?]+/)
    .filter(s => s.trim().length > 0);
  const sentenceCount = Math.max(1, sentences.length);

  // Paragraph count (split by double newlines or single newlines in markdown)
  const paragraphs = text
    .split(/\n\s*\n|\n/)
    .filter(p => p.trim().length > 0);
  const paragraphCount = Math.max(1, paragraphs.length);

  // Average sentence length
  const avgSentenceLength = wordCount / sentenceCount;

  // Reading time (average 200 words per minute)
  const readingTimeMinutes = wordCount / 200;

  // Count syllables for all words
  const totalSyllables = words.reduce((sum, word) => {
    // Remove punctuation
    const cleanWord = word.replace(/[^a-zA-Z]/g, '');
    return sum + (cleanWord.length > 0 ? countSyllables(cleanWord) : 0);
  }, 0);

  // Calculate readability
  const readabilityScore = calculateFleschScore(wordCount, sentenceCount, totalSyllables);
  const readabilityLevel = getReadabilityLevel(readabilityScore);

  // Vocabulary diversity (unique words / total words)
  const uniqueWords = new Set(
    words.map(w => w.toLowerCase().replace(/[^a-z0-9]/g, ''))
  );
  const vocabularyDiversity = wordCount > 0 ? uniqueWords.size / wordCount : 0;

  return {
    wordCount,
    charCount,
    charCountNoSpaces,
    sentenceCount,
    paragraphCount,
    avgSentenceLength: Math.round(avgSentenceLength * 10) / 10,
    readingTimeMinutes: Math.round(readingTimeMinutes * 10) / 10,
    readabilityScore: Math.round(readabilityScore),
    readabilityLevel,
    vocabularyDiversity: Math.round(vocabularyDiversity * 100) / 100,
  };
}

/**
 * Get color class for readability score
 */
export function getReadabilityColor(score: number): string {
  if (score >= 70) return 'text-green-400';
  if (score >= 50) return 'text-yellow-400';
  return 'text-red-400';
}

