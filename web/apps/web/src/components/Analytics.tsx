'use client';

import { type WritingStats, getReadabilityColor } from '@/lib/analytics';
import {
  AcademicCapIcon,
  Bars3BottomLeftIcon,
  ChartBarSquareIcon,
  ChatBubbleLeftRightIcon,
  ClockIcon,
  DocumentTextIcon,
  RectangleStackIcon,
  SparklesIcon,
  Squares2X2Icon,
} from '@heroicons/react/24/outline';

interface AnalyticsProps {
  stats: WritingStats;
}

export default function Analytics({ stats }: AnalyticsProps) {
  if (stats.wordCount === 0) {
    return (
      <div className="rounded-2xl border border-gray-800/80 bg-gray-900/80 p-5 shadow-inner shadow-black/20">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-200">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-500/10 text-blue-300">
            <ChartBarSquareIcon className="h-5 w-5" />
          </span>
          Writing Stats
        </div>
        <p className="mt-3 text-xs text-gray-500">
          Start writing to see live analytics for your document.
        </p>
      </div>
    );
  }

  const coreMetrics = [
    {
      label: 'Words',
      value: stats.wordCount.toLocaleString(),
      Icon: DocumentTextIcon,
      iconAccent: 'bg-sky-500/10 text-sky-300',
    },
    {
      label: 'Characters',
      value: stats.charCount.toLocaleString(),
      Icon: RectangleStackIcon,
      iconAccent: 'bg-indigo-500/10 text-indigo-300',
    },
    {
      label: 'Sentences',
      value: stats.sentenceCount.toLocaleString(),
      Icon: ChatBubbleLeftRightIcon,
      iconAccent: 'bg-emerald-500/10 text-emerald-300',
    },
    {
      label: 'Paragraphs',
      value: stats.paragraphCount.toLocaleString(),
      Icon: Squares2X2Icon,
      iconAccent: 'bg-purple-500/10 text-purple-300',
    },
    {
      label: 'Reading Time',
      value:
        stats.readingTimeMinutes < 1
          ? '<1 min'
          : `${Math.ceil(stats.readingTimeMinutes)} min`,
      Icon: ClockIcon,
      iconAccent: 'bg-amber-500/10 text-amber-300',
    },
    {
      label: 'Avg Sentence',
      value: `${stats.avgSentenceLength} words`,
      Icon: Bars3BottomLeftIcon,
      iconAccent: 'bg-cyan-500/10 text-cyan-300',
    },
  ] as const;

  return (
    <div className="space-y-4 rounded-2xl border border-gray-800/80 bg-gray-900/80 p-5 shadow-inner shadow-black/20 backdrop-blur">
      <div className="flex items-center gap-2 text-sm font-semibold text-gray-200">
        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-500/10 text-blue-300">
          <ChartBarSquareIcon className="h-5 w-5" />
        </span>
        Writing Stats
      </div>

      <div className="grid grid-cols-2 gap-3">
        {coreMetrics.map(({ label, value, Icon, iconAccent }) => (
          <div
            key={label}
            className="group rounded-xl border border-gray-800 bg-gray-800/70 p-3 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-gray-600 hover:bg-gray-800"
          >
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[11px] uppercase tracking-wide text-gray-400/80">
                  {label}
                </p>
                <p className="mt-1 text-lg font-semibold text-gray-100">
                  {value}
                </p>
              </div>
              <span
                className={`ml-3 flex h-9 w-9 items-center justify-center rounded-lg ${iconAccent}`}
              >
                <Icon className="h-5 w-5" />
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-3">
        <div className="rounded-xl border border-gray-800 bg-gray-800/70 p-4 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-gray-300">Reading Level</p>
              <p
                className={`mt-1 text-sm font-semibold ${getReadabilityColor(
                  stats.readabilityScore,
                )}`}
              >
                {stats.readabilityLevel}
              </p>
            </div>
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-500/10 text-violet-300">
              <AcademicCapIcon className="h-5 w-5" />
            </span>
          </div>
          <div className="mt-4 h-2 rounded-full bg-gray-700/80">
            <div
              className={`h-2 rounded-full transition-all ${
                stats.readabilityScore >= 70
                  ? 'bg-emerald-400'
                  : stats.readabilityScore >= 50
                  ? 'bg-amber-400'
                  : 'bg-rose-500'
              }`}
              style={{ width: `${Math.min(stats.readabilityScore, 100)}%` }}
            />
          </div>
          <p className="mt-2 text-[11px] text-gray-500">
            Flesch score {stats.readabilityScore}/100
          </p>
        </div>

        <div className="rounded-xl border border-gray-800 bg-gray-800/70 p-4 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-gray-300">
                Vocabulary Diversity
              </p>
              <p className="mt-1 text-sm font-semibold text-indigo-300">
                {(stats.vocabularyDiversity * 100).toFixed(0)}%
              </p>
              <p className="mt-1 text-[11px] text-gray-500">
                Unique words per total words
              </p>
            </div>
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-300">
              <SparklesIcon className="h-5 w-5" />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
