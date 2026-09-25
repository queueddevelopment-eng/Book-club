export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  AI?: Ai;
  CLUB_NAME?: string;
  CLUB_PASSCODE?: string;
  READ_PENALTY?: string;
  CLAUDE_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
  GOOGLE_BOOKS_API_KEY?: string;
}

export interface AppEnv {
  Bindings: Env;
  Variables: { member: { id: number; name: string } };
}
