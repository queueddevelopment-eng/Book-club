// Book metadata lookup: Google Books first, Open Library as a fallback, and
// Wikipedia / Open Library for author bios. None of these need an API key.

const UA = 'BookClubApp/1.0 (Cloudflare Worker)';

export interface BookSearchResult {
  sourceId: string; // "google:<volumeId>" or "ol:<workKey>"
  title: string;
  authors: string[];
  published?: string;
  coverUrl?: string;
  isbn?: string;
  pageCount?: number;
  snippet?: string;
}

export interface BookDetails extends BookSearchResult {
  description?: string;
  categories?: string[];
  authorBio?: string;
  authorPhotoUrl?: string;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function stripHtml(s: string | undefined): string | undefined {
  if (!s) return s;
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function httpsify(url: string | undefined): string | undefined {
  return url?.replace(/^http:\/\//, 'https://');
}

// ---------- Google Books ----------

interface GVolume {
  id: string;
  volumeInfo: {
    title?: string;
    subtitle?: string;
    authors?: string[];
    publishedDate?: string;
    description?: string;
    pageCount?: number;
    categories?: string[];
    imageLinks?: Record<string, string>;
    industryIdentifiers?: { type: string; identifier: string }[];
  };
  searchInfo?: { textSnippet?: string };
}

function fromGoogle(v: GVolume): BookDetails {
  const info = v.volumeInfo;
  const ids = info.industryIdentifiers ?? [];
  const isbn = ids.find((i) => i.type === 'ISBN_13')?.identifier ?? ids.find((i) => i.type === 'ISBN_10')?.identifier;
  const img = info.imageLinks ?? {};
  const cover = img.large ?? img.medium ?? img.small ?? img.thumbnail ?? img.smallThumbnail;
  return {
    sourceId: `google:${v.id}`,
    title: info.subtitle ? `${info.title}: ${info.subtitle}` : info.title ?? 'Untitled',
    authors: info.authors ?? [],
    published: info.publishedDate,
    coverUrl: httpsify(cover)?.replace('&edge=curl', ''),
    isbn,
    pageCount: info.pageCount,
    snippet: stripHtml(v.searchInfo?.textSnippet),
    description: stripHtml(info.description),
    categories: info.categories,
  };
}

function googleKey(apiKey?: string): string {
  return apiKey ? `&key=${encodeURIComponent(apiKey)}` : '';
}

async function searchGoogle(q: string, apiKey?: string): Promise<BookSearchResult[] | null> {
  const data = await getJson<{ items?: GVolume[] }>(
    `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=12&printType=books${googleKey(apiKey)}`,
  );
  if (!data) return null;
  return (data.items ?? []).map(fromGoogle);
}

// ---------- Open Library ----------

interface OLDoc {
  key: string;
  title: string;
  author_name?: string[];
  first_publish_year?: number;
  cover_i?: number;
  isbn?: string[];
  number_of_pages_median?: number;
}

function fromOpenLibrary(d: OLDoc): BookSearchResult {
  return {
    sourceId: `ol:${d.key}`,
    title: d.title,
    authors: d.author_name ?? [],
    published: d.first_publish_year?.toString(),
    coverUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : undefined,
    isbn: d.isbn?.find((i) => i.length === 13) ?? d.isbn?.[0],
    pageCount: d.number_of_pages_median,
  };
}

async function searchOpenLibrary(q: string): Promise<BookSearchResult[]> {
  const fields = 'key,title,author_name,first_publish_year,cover_i,isbn,number_of_pages_median';
  const data = await getJson<{ docs?: OLDoc[] }>(
    `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=12&fields=${fields}`,
  );
  return (data?.docs ?? []).map(fromOpenLibrary);
}

// ---------- Public API ----------

export async function searchBooks(q: string, googleApiKey?: string): Promise<BookSearchResult[]> {
  const google = await searchGoogle(q, googleApiKey);
  if (google && google.length > 0) return google;
  return searchOpenLibrary(q);
}

export async function getBookDetails(sourceId: string, googleApiKey?: string): Promise<BookDetails | null> {
  let details: BookDetails | null = null;
  if (sourceId.startsWith('google:')) {
    const id = sourceId.slice('google:'.length);
    const v = await getJson<GVolume>(
      `https://www.googleapis.com/books/v1/volumes/${encodeURIComponent(id)}?projection=full${googleKey(googleApiKey)}`,
    );
    if (v) details = fromGoogle(v);
  } else if (sourceId.startsWith('ol:')) {
    const key = sourceId.slice('ol:'.length);
    if (!/^\/works\/OL\w+$/.test(key)) return null;
    const work = await getJson<{
      title: string;
      description?: string | { value: string };
      covers?: number[];
      subjects?: string[];
      first_publish_date?: string;
      authors?: { author: { key: string } }[];
    }>(`https://openlibrary.org${key}.json`);
    if (work) {
      const authorNames = await Promise.all(
        (work.authors ?? []).slice(0, 3).map(async (a) => (await getJson<{ name?: string }>(`https://openlibrary.org${a.author.key}.json`))?.name),
      );
      details = {
        sourceId,
        title: work.title,
        authors: authorNames.filter((n): n is string => !!n),
        published: work.first_publish_date,
        coverUrl: work.covers?.[0] ? `https://covers.openlibrary.org/b/id/${work.covers[0]}-L.jpg` : undefined,
        description: typeof work.description === 'string' ? work.description : work.description?.value,
        categories: work.subjects?.slice(0, 5),
      };
    }
  }
  if (!details) return null;

  if (details.authors[0]) {
    const bio = await getAuthorBio(details.authors[0]);
    details.authorBio = bio?.bio;
    details.authorPhotoUrl = bio?.photoUrl;
  }
  return details;
}

export async function getAuthorBio(name: string): Promise<{ bio: string; photoUrl?: string } | null> {
  const wiki = await getJson<{ type?: string; extract?: string; description?: string; thumbnail?: { source: string } }>(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name.replace(/ /g, '_'))}`,
  );
  // Only trust the Wikipedia page if it looks like it's about a writer.
  const looksLikeAuthor = /writer|author|novelist|poet|journalist|essayist|historian|playwright/i.test(
    `${wiki?.description ?? ''} ${wiki?.extract?.slice(0, 300) ?? ''}`,
  );
  if (wiki?.extract && wiki.type !== 'disambiguation' && looksLikeAuthor) {
    return { bio: wiki.extract, photoUrl: wiki.thumbnail?.source };
  }

  const search = await getJson<{ docs?: { key: string }[] }>(
    `https://openlibrary.org/search/authors.json?q=${encodeURIComponent(name)}&limit=1`,
  );
  const key = search?.docs?.[0]?.key;
  if (!key) return null;
  const author = await getJson<{ bio?: string | { value: string }; photos?: number[] }>(
    `https://openlibrary.org/authors/${key}.json`,
  );
  const bio = typeof author?.bio === 'string' ? author.bio : author?.bio?.value;
  if (!bio) return null;
  const photo = author?.photos?.find((p) => p > 0);
  return { bio, photoUrl: photo ? `https://covers.openlibrary.org/a/id/${photo}-M.jpg` : undefined };
}

/** Search links for stores that don't offer a public catalogue API. */
export function storeLinks(title: string, authors: string): { audible: string; kindle: string } {
  const q = encodeURIComponent(`${title} ${authors.split(',')[0] ?? ''}`.trim());
  return {
    audible: `https://www.audible.com/search?keywords=${q}`,
    kindle: `https://www.amazon.com/s?k=${q}&i=digital-text`,
  };
}
