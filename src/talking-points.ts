import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

export const TalkingPointsSchema = z.object({
  overview: z.string().describe('Two or three sentences framing what the discussion could focus on'),
  themes: z.array(z.string()).describe('Major themes of the book, a short phrase each'),
  questions: z
    .array(
      z.object({
        category: z.string().describe('e.g. Characters, Plot, Themes, Style, Personal connection'),
        question: z.string(),
        why: z.string().describe('One sentence on what this question tends to open up'),
      }),
    )
    .describe('Open-ended discussion questions, ordered from easy warm-ups to deeper ones'),
  icebreaker: z.string().describe('A light opening question anyone can answer, even if they did not finish'),
});

export type TalkingPoints = z.infer<typeof TalkingPointsSchema>;

export interface BookForPrompt {
  title: string;
  authors: string;
  description?: string | null;
  categories?: string | null;
  published?: string | null;
}

export interface LlmEnv {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_WORKSPACE_ID?: string;
  CLAUDE_MODEL?: string;
  AI?: Ai;
}

const SYSTEM = `You help book clubs have better conversations. Given a book, write discussion material that
references the book's actual characters, events, settings and ideas rather than generic prompts
that could apply to any novel. Assume every member has finished the book, so spoilers are fine.
If you don't know the book well, rely on the provided description and keep questions grounded in it
instead of inventing plot details.`;

function userPrompt(book: BookForPrompt, reviews: string[]): string {
  const lines = [
    `Title: ${book.title}`,
    `Author(s): ${book.authors || 'Unknown'}`,
    book.published ? `Published: ${book.published}` : '',
    book.categories ? `Genres: ${book.categories}` : '',
    book.description ? `Publisher description:\n${book.description}` : '',
    reviews.length ? `Short reviews from club members (use these to tailor a couple of questions):\n${reviews.join('\n')}` : '',
    '',
    'Write talking points for our meeting: an overview, 3-6 themes, an icebreaker, and 10-12 discussion questions.',
  ];
  return lines.filter(Boolean).join('\n');
}

export async function generateTalkingPoints(
  env: LlmEnv,
  book: BookForPrompt,
  reviews: string[],
): Promise<{ points: TalkingPoints; model: string }> {
  if (env.ANTHROPIC_API_KEY) {
    try {
      return await generateWithClaude(env, book, reviews);
    } catch (err) {
      // Keep the feature working if the key is misconfigured or Claude is unavailable.
      if (!env.AI) throw err;
      console.error('Claude failed, falling back to Workers AI:', err);
    }
  }
  if (env.AI) return generateWithWorkersAi(env.AI, book, reviews);
  throw new Error('No LLM configured. Set the ANTHROPIC_API_KEY secret or enable the Workers AI binding.');
}

async function generateWithClaude(env: LlmEnv, book: BookForPrompt, reviews: string[]) {
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    // Needed for API keys that aren't scoped to a single workspace.
    defaultHeaders: env.ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': env.ANTHROPIC_WORKSPACE_ID } : undefined,
  });
  const model = env.CLAUDE_MODEL || 'claude-opus-5';
  const response = await client.beta.messages.parse({
    model,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium', format: betaZodOutputFormat(TalkingPointsSchema) },
    // If the primary model declines, the API retries on a fallback model inside the same call.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    messages: [{ role: 'user', content: userPrompt(book, reviews) }],
  });
  if (response.stop_reason === 'refusal') throw new Error('The model declined to write talking points for this book.');
  if (!response.parsed_output) throw new Error('The model returned talking points in an unexpected format.');
  return { points: response.parsed_output, model: response.model };
}

async function generateWithWorkersAi(ai: Ai, book: BookForPrompt, reviews: string[]) {
  const model = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  const prompt = `${userPrompt(book, reviews)}

Respond with only a JSON object of this shape:
{"overview": string, "themes": string[], "icebreaker": string,
 "questions": [{"category": string, "question": string, "why": string}]}`;
  const out = (await ai.run(model as keyof AiModels, {
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: prompt },
    ],
    max_tokens: 3000,
  } as never)) as { response?: string | object };
  const raw = out.response;
  const obj = typeof raw === 'string' ? JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) : raw;
  const parsed = TalkingPointsSchema.safeParse(obj);
  if (!parsed.success) throw new Error('Workers AI returned talking points in an unexpected format. Try again.');
  return { points: parsed.data, model: model.replace('@cf/', '') };
}
