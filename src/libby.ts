// Libby / OverDrive lookups. These use the same public, key-less endpoints the Libby app does:
//   locate.libbyapp.com        - find a library system by name or place
//   thunder.api.overdrive.com  - a library's catalogue, including copies and holds
// Neither is an officially documented API, so everything here is defensive.

const UA = 'BookClubApp/1.0 (Cloudflare Worker)';
const CACHE_SECONDS = 60 * 60;

export interface LibbyLibrary {
  key: string; // e.g. "lapl"; the part after libbyapp.com/library/
  name: string;
}

export type LibbyFormat = 'ebook' | 'audiobook';

export interface LibbyAvailability {
  format: LibbyFormat;
  titleId: string;
  title: string;
  ownedCopies: number;
  availableCopies: number;
  holdsCount: number;
  isAvailable: boolean;
  estimatedWaitDays: number | null;
  url: string;
}

export const LIBRARY_KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i;

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      // Cache on Cloudflare's edge so a busy meeting page doesn't hammer OverDrive.
      cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
    } as RequestInit);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface LocateBranch {
  systems?: { fulfillmentId?: string; name?: string; isConsortium?: boolean }[];
}

/** Find library systems that use Libby, by library name, city or ZIP code. */
export async function findLibraries(query: string): Promise<LibbyLibrary[]> {
  const data = await getJson<{ branches?: LocateBranch[] }>(
    `https://locate.libbyapp.com/autocomplete/${encodeURIComponent(query)}`,
  );
  const seen = new Map<string, LibbyLibrary>();
  for (const branch of data?.branches ?? []) {
    for (const s of branch.systems ?? []) {
      if (s.fulfillmentId && s.name && LIBRARY_KEY_RE.test(s.fulfillmentId) && !seen.has(s.fulfillmentId)) {
        seen.set(s.fulfillmentId, { key: s.fulfillmentId, name: s.name });
      }
    }
  }
  return [...seen.values()].slice(0, 15);
}

/** Validates a library key and returns its display name. */
export async function getLibrary(key: string): Promise<LibbyLibrary | null> {
  if (!LIBRARY_KEY_RE.test(key)) return null;
  const data = await getJson<{ name?: string; preferredKey?: string }>(
    `https://thunder.api.overdrive.com/v2/libraries/${encodeURIComponent(key)}`,
  );
  if (!data?.name) return null;
  return { key: data.preferredKey || key, name: data.name };
}

interface ThunderItem {
  id: string;
  title?: string;
  subtitle?: string;
  type?: { id?: string };
  creators?: { name?: string; role?: string }[];
  isOwned?: boolean;
  isAvailable?: boolean;
  ownedCopies?: number;
  availableCopies?: number;
  holdsCount?: number;
  estimatedWaitDays?: number;
}

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Title without a subtitle, e.g. "Sapiens: A Brief History" -> "sapiens". */
function mainTitle(s: string): string {
  return normalize(s.split(/[:(]/)[0]);
}

function authorMatches(item: ThunderItem, author: string): boolean {
  const last = normalize(author).split(' ').pop();
  if (!last) return true;
  return (item.creators ?? []).some((c) => normalize(c.name ?? '').split(' ').includes(last));
}

/**
 * Libby's own estimate when present; otherwise a rough one assuming 14-day loans with copies
 * turning over at an even rate.
 */
export function waitDays(item: ThunderItem): number | null {
  if (item.isAvailable || (item.availableCopies ?? 0) > 0) return 0;
  if (typeof item.estimatedWaitDays === 'number' && item.estimatedWaitDays >= 0) return item.estimatedWaitDays;
  const copies = item.ownedCopies ?? 0;
  if (copies <= 0) return null;
  return Math.ceil(((item.holdsCount ?? 0) + 1) / copies) * 14;
}

export function pickMatches(items: ThunderItem[], title: string, author: string, libraryKey: string): LibbyAvailability[] {
  const wanted = mainTitle(title);
  const best = new Map<LibbyFormat, ThunderItem>();
  for (const item of items) {
    const format = item.type?.id;
    if (format !== 'ebook' && format !== 'audiobook') continue;
    if (item.isOwned === false) continue;
    if (mainTitle(item.title ?? '') !== wanted || !authorMatches(item, author)) continue;
    const current = best.get(format);
    // With several editions, prefer the one you'd get soonest.
    const better = !current || (waitDays(item) ?? Infinity) < (waitDays(current) ?? Infinity);
    if (better) best.set(format, item);
  }
  return (['ebook', 'audiobook'] as LibbyFormat[])
    .filter((f) => best.has(f))
    .map((format) => {
      const item = best.get(format)!;
      return {
        format,
        titleId: item.id,
        title: item.title ?? title,
        ownedCopies: item.ownedCopies ?? 0,
        availableCopies: item.availableCopies ?? 0,
        holdsCount: item.holdsCount ?? 0,
        isAvailable: !!item.isAvailable || (item.availableCopies ?? 0) > 0,
        estimatedWaitDays: waitDays(item),
        url: titleUrl(libraryKey, item.id),
      };
    });
}

/** Checks one library's Libby catalogue for a book. Returns null when the lookup itself failed. */
export async function checkAvailability(libraryKey: string, title: string, author: string): Promise<LibbyAvailability[] | null> {
  if (!LIBRARY_KEY_RE.test(libraryKey)) return null;
  const q = `${mainTitle(title)} ${author.split(',')[0] ?? ''}`.trim();
  const data = await getJson<{ items?: ThunderItem[] }>(
    `https://thunder.api.overdrive.com/v2/libraries/${encodeURIComponent(libraryKey)}/media?query=${encodeURIComponent(q)}&perPage=24`,
  );
  if (!data) return null;
  return pickMatches(data.items ?? [], title, author, libraryKey);
}

export function titleUrl(libraryKey: string, titleId: string): string {
  return `https://libbyapp.com/library/${encodeURIComponent(libraryKey)}/everything/page-1/${encodeURIComponent(titleId)}`;
}

export function searchUrl(libraryKey: string | null | undefined, title: string, author: string): string {
  const q = encodeURIComponent(`${title.split(':')[0]} ${author.split(',')[0] ?? ''}`.trim());
  return libraryKey
    ? `https://libbyapp.com/search/${encodeURIComponent(libraryKey)}/search/query-${q}/page-1`
    : 'https://libbyapp.com/interview/welcome';
}
