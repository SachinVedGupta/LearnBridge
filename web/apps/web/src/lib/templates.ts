import type { ComponentType, SVGProps } from 'react';
import {
  AcademicCapIcon,
  BeakerIcon,
  DocumentPlusIcon,
  PencilSquareIcon,
  ScaleIcon,
} from '@heroicons/react/24/outline';

export interface Template {
  id: string;
  name: string;
  description: string;
  content: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

export const templates: Template[] = [
  {
    id: 'blank',
    name: 'Blank Document',
    description: 'Start with an empty page',
    icon: DocumentPlusIcon,
    content: '',
  },
  {
    id: 'five-paragraph',
    name: '5-Paragraph Essay',
    description: 'Classic essay structure for high school and college',
    icon: PencilSquareIcon,
    content: `<h1>[Your Essay Title]</h1>
<h2>Introduction</h2>
<p><em>Hook:</em> Start with an interesting fact, quote, or question to grab the reader's attention.</p>
<p><em>Background:</em> Provide context and background information on your topic.</p>
<p><em>Thesis Statement:</em> Clearly state your main argument or position in one or two sentences.</p>
<h2>Body Paragraph 1</h2>
<p><em>Topic Sentence:</em> Introduce the first main point that supports your thesis.</p>
<p><em>Evidence:</em> Provide specific examples, facts, or quotes.</p>
<p><em>Analysis:</em> Explain how this evidence supports your thesis.</p>
<p><em>Transition:</em> Connect to the next paragraph.</p>
<h2>Body Paragraph 2</h2>
<p><em>Topic Sentence:</em> Introduce the second main point that supports your thesis.</p>
<p><em>Evidence:</em> Provide specific examples, facts, or quotes.</p>
<p><em>Analysis:</em> Explain how this evidence supports your thesis.</p>
<p><em>Transition:</em> Connect to the next paragraph.</p>
<h2>Body Paragraph 3</h2>
<p><em>Topic Sentence:</em> Introduce the third main point that supports your thesis.</p>
<p><em>Evidence:</em> Provide specific examples, facts, or quotes.</p>
<p><em>Analysis:</em> Explain how this evidence supports your thesis.</p>
<p><em>Transition:</em> Lead into your conclusion.</p>
<h2>Conclusion</h2>
<p><em>Restate Thesis:</em> Summarize your main argument in different words.</p>
<p><em>Summary:</em> Briefly recap your three main points.</p>
<p><em>Closing Thought:</em> End with a final thought, call to action, or broader implication.</p>`,
  },
  {
    id: 'research-paper',
    name: 'Research Paper',
    description: 'Academic research paper structure',
    icon: AcademicCapIcon,
    content: `<h1>[Research Paper Title]</h1>
<h2>Abstract</h2>
<p>Brief summary of your research (150-250 words): Include purpose, methods, key findings, and conclusions.</p>
<h2>1. Introduction</h2>
<p><em>Background:</em> Introduce the research topic and its significance.</p>
<p><em>Problem Statement:</em> Clearly define the research problem or question.</p>
<p><em>Research Objectives:</em> State what you aim to achieve with this research.</p>
<p><em>Thesis Statement:</em> Present your main argument or hypothesis.</p>
<h2>2. Literature Review</h2>
<p><em>Overview:</em> Summarize existing research on your topic.</p>
<p><em>Key Studies:</em> Discuss relevant previous studies and their findings.</p>
<p><em>Research Gap:</em> Identify what's missing in current research.</p>
<p><em>Your Contribution:</em> Explain how your research fills this gap.</p>
<h2>3. Methodology</h2>
<p><em>Research Design:</em> Describe your research approach (qualitative, quantitative, mixed).</p>
<p><em>Data Collection:</em> Explain how you gathered your data.</p>
<p><em>Data Analysis:</em> Describe how you analyzed the data.</p>
<p><em>Limitations:</em> Acknowledge any limitations in your methodology.</p>
<h2>4. Results</h2>
<p><em>Key Findings:</em> Present your main research findings.</p>
<p><em>Data Presentation:</em> Include tables, charts, or graphs as needed.</p>
<p><em>Statistical Analysis:</em> Report relevant statistics or measurements.</p>
<h2>5. Discussion</h2>
<p><em>Interpretation:</em> Explain what your findings mean.</p>
<p><em>Comparison:</em> Compare your results with previous research.</p>
<p><em>Implications:</em> Discuss the significance of your findings.</p>
<p><em>Limitations:</em> Address limitations of your study.</p>
<h2>6. Conclusion</h2>
<p><em>Summary:</em> Recap your main findings.</p>
<p><em>Significance:</em> Emphasize the importance of your research.</p>
<p><em>Future Research:</em> Suggest directions for future studies.</p>
<h2>References</h2>
<p>List all sources cited in your paper in appropriate citation format.</p>`,
  },
  {
    id: 'lab-report',
    name: 'Lab Report',
    description: 'Scientific lab report format',
    icon: BeakerIcon,
    content: `<h1>[Lab Report Title]</h1>
<p><strong>Name:</strong> [Your Name]<br>
<strong>Date:</strong> [Date of Experiment]<br>
<strong>Lab Partner(s):</strong> [Partner Names]<br>
<strong>Course:</strong> [Course Name/Number]</p>
<h2>Title</h2>
<p>Descriptive title of your experiment.</p>
<h2>Objective/Purpose</h2>
<p>State the purpose of the experiment and what you aim to discover or prove.</p>
<h2>Hypothesis</h2>
<p>State your prediction about the outcome of the experiment based on scientific principles.</p>
<h2>Materials</h2>
<ul>
<li>Material 1</li>
<li>Material 2</li>
<li>Material 3</li>
<li>Equipment 1</li>
<li>Equipment 2</li>
<li>Add all materials and equipment used</li>
</ul>
<h2>Procedure</h2>
<ol>
<li>Step 1: Describe the first step in detail</li>
<li>Step 2: Describe the second step</li>
<li>Step 3: Continue with each step in chronological order</li>
<li>Include safety precautions if applicable</li>
<li>Be specific enough that someone could replicate your experiment</li>
</ol>
<h2>Observations/Data</h2>
<p>Record your observations during the experiment. Include data tables, measurements, or qualitative observations.</p>
<p><em>Example table format:</em> Trial | Variable 1 | Variable 2 | Result</p>
<h2>Results</h2>
<p>Summarize what happened during the experiment. Present calculations if applicable. Describe patterns or trends in the data.</p>
<h2>Analysis/Discussion</h2>
<p><em>Explain your results:</em> Why did this happen?</p>
<p><em>Compare results to hypothesis:</em> Was your hypothesis supported?</p>
<p><em>Discuss sources of error or unexpected results.</em></p>
<p><em>Connect findings to scientific concepts learned in class.</em></p>
<h2>Conclusion</h2>
<p>Restate the purpose of the experiment. Summarize key findings. State whether hypothesis was supported or refuted. Discuss real-world applications or significance. Suggest improvements or future experiments.</p>
<h2>References</h2>
<p>List any sources used, including lab manual, textbooks, or other resources.</p>`,
  },
  {
    id: 'argumentative',
    name: 'Argumentative Essay',
    description: 'Persuasive essay with counter-arguments',
    icon: ScaleIcon,
    content: `<h1>[Argumentative Essay Title]</h1>
<h2>Introduction</h2>
<p><em>Hook:</em> Start with a compelling fact, statistic, or scenario related to your topic.</p>
<p><em>Context:</em> Provide background information on the controversial issue.</p>
<p><em>Opposing View:</em> Briefly acknowledge that people have different opinions on this issue.</p>
<p><em>Thesis Statement:</em> Clearly state your position and main arguments you will present.</p>
<h2>Argument 1: [First Main Point]</h2>
<p><em>Topic Sentence:</em> State your first argument.</p>
<p><em>Evidence:</em> Provide facts, statistics, expert opinions, or examples.</p>
<p><em>Explanation:</em> Explain how this evidence supports your position.</p>
<p><em>Impact:</em> Discuss why this argument is important.</p>
<h2>Argument 2: [Second Main Point]</h2>
<p><em>Topic Sentence:</em> State your second argument.</p>
<p><em>Evidence:</em> Provide facts, statistics, expert opinions, or examples.</p>
<p><em>Explanation:</em> Explain how this evidence supports your position.</p>
<p><em>Impact:</em> Discuss why this argument is important.</p>
<h2>Argument 3: [Third Main Point]</h2>
<p><em>Topic Sentence:</em> State your third argument.</p>
<p><em>Evidence:</em> Provide facts, statistics, expert opinions, or examples.</p>
<p><em>Explanation:</em> Explain how this evidence supports your position.</p>
<p><em>Impact:</em> Discuss why this argument is important.</p>
<h2>Counter-Argument and Rebuttal</h2>
<p><em>Counter-Argument:</em> Present the strongest argument against your position.</p>
<p><em>Acknowledgment:</em> Recognize why some people hold this view.</p>
<p><em>Rebuttal:</em> Explain why this counter-argument is flawed or less convincing.</p>
<p><em>Evidence:</em> Provide evidence that refutes the counter-argument.</p>
<h2>Conclusion</h2>
<p><em>Restate Position:</em> Reaffirm your thesis in different words.</p>
<p><em>Summary:</em> Briefly recap your main arguments.</p>
<p><em>Counter-Argument Recap:</em> Remind readers why the opposition is wrong.</p>
<p><em>Call to Action:</em> End with a powerful statement or call readers to take action.</p>
<p><em>Final Thought:</em> Leave readers with something to think about.</p>`,
  },
];

export function getTemplateById(id: string): Template | undefined {
  return templates.find(t => t.id === id);
}
