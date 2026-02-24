import './style.css'
import { fromEvent, of, Observable } from "rxjs";
import {
  catchError,
  debounceTime,
  distinctUntilChanged,
  map,
  shareReplay,
  startWith,
  switchMap,
} from "rxjs/operators";
import { ajax } from "rxjs/ajax";

type WikiOpenSearch = [string, string[], string[], string[]];

type Suggestion = {
  title: string;
  description?: string;
  url?: string;
};

type SuggestState =
  | { kind: "idle"; term: string; items: Suggestion[] }
  | { kind: "loading"; term: string; items: Suggestion[] }
  | { kind: "done"; term: string; items: Suggestion[] }
  | { kind: "error"; term: string; items: Suggestion[]; error: string };

// -----------------------------
// Option B: persist + restore
// -----------------------------

type PersistedSuggestions = {
  term: string;
  items: Suggestion[];
  savedAt: number;
};

const STORAGE_KEY = "wiki_autosuggest_v1";

function savePersisted(v: PersistedSuggestions) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    // ignore storage errors (private mode/quota)
  }
}

function loadPersisted(): PersistedSuggestions | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedSuggestions;
    if (!parsed || typeof parsed.term !== "string" || !Array.isArray(parsed.items)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function clearPersisted() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function searchWikipedia(term: string, limit = 10): Observable<WikiOpenSearch> {
  const params = new URLSearchParams({
    action: "opensearch",
    format: "json",
    origin: "*",
    search: term,
    limit: String(limit),
    namespace: "0",
  });

  // Using Vite proxy
  const url = `/wiki/w/api.php?${params.toString()}`;
  return ajax.getJSON<WikiOpenSearch>(url);
}

function toSuggestions(data: WikiOpenSearch): Suggestion[] {
  const [, titles, descriptions, urls] = data;
  const n = Math.min(titles.length, descriptions.length, urls.length);

  const out: Suggestion[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ title: titles[i], description: descriptions[i], url: urls[i] });
  }
  return out;
}

function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function renderSuggestions(ul: HTMLUListElement, items: Suggestion[]) {
  clear(ul);

  for (const s of items) {
    const li = document.createElement("li");
    const href = document.createElement("a");
    href.textContent = s.title;
    href.href = s.url ?? "#";

    // Keep SPA page alive; Wikipedia opens in a new tab.
    href.target = "_blank";
    href.rel = "noopener noreferrer";

    li.appendChild(href);
    ul.appendChild(li);
  }
}

function renderStatus(div: HTMLElement, state: SuggestState) {
  div.textContent =
    state.kind === "loading" ? "Loading…" :
    state.kind === "error"   ? `Error: ${state.error}` :
    "";
}

export function bindWikipediaAutosuggest(opts: {
  input: HTMLInputElement;
  suggestionsList: HTMLUListElement;
  status: HTMLElement;
  minLength?: number;
  debounceMs?: number;
  limit?: number;
}) {
  const minLength = opts.minLength ?? 3;
  const debounceMs = opts.debounceMs ?? 500;
  const limit = opts.limit ?? 10;

  // Restore previously saved suggestions immediately (without refetching)
  const restored = loadPersisted();
  const initialState: SuggestState = restored
    ? { kind: "done", term: restored.term, items: restored.items }
    : { kind: "idle", term: "", items: [] };

  if (restored) {
    opts.input.value = restored.term;
    renderStatus(opts.status, initialState);
    renderSuggestions(opts.suggestionsList, restored.items);
  }

  // text over time (emits even when empty, so we can clear the UI)
  const term$ = fromEvent(opts.input, "input").pipe(
    map(() => opts.input.value.trim()),
    debounceTime(debounceMs),
    distinctUntilChanged()
  );

  // request state over time (atomic UI package)
  const state$ = term$.pipe(
    switchMap((term) => {
      if (term.length < minLength) {
        return of<SuggestState>({ kind: "idle", term, items: [] });
      }

      return searchWikipedia(term, limit).pipe(
        map((data) => ({ kind: "done", term, items: toSuggestions(data) }) as SuggestState),
        startWith({ kind: "loading", term, items: [] } as SuggestState),
        catchError((e: unknown) =>
          of<SuggestState>({
            kind: "error",
            term,
            items: [],
            error: e instanceof Error ? e.message : String(e),
          })
        )
      );
    }),
    // Emit restored suggestions first so UI has something immediately on reload/back
    startWith(initialState),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  // render + persist
  const sub = state$.subscribe((s) => {
    renderStatus(opts.status, s);
    renderSuggestions(opts.suggestionsList, s.items);

    // Persist only meaningful results
    if (s.kind === "done" && s.items.length > 0) {
      savePersisted({ term: s.term, items: s.items, savedAt: Date.now() });
    }

    // If user clears input (or below min length), drop persisted list
    if (s.kind === "idle" && s.term.length < minLength) {
      clearPersisted();
    }
  });

  // Optional: click behavior (do NOT clear list; let anchor handle navigation)
  const clickSub = fromEvent<MouseEvent>(opts.suggestionsList, "click").subscribe((ev) => {
    const target = ev.target as HTMLElement | null;
    const a = target?.closest("a") as HTMLAnchorElement | null;
    if (!a) return;

    // Keep input in sync with clicked title (nice UX)
    const title = a.textContent ?? "";
    if (title) opts.input.value = title;

    // Ensure the current rendered list is persisted (in case nothing was typed after restore)
    const items = Array.from(opts.suggestionsList.querySelectorAll("a")).map((el) => ({
      title: el.textContent ?? "",
      url: (el as HTMLAnchorElement).href,
    })) as Suggestion[];

    if (title && items.length > 0) {
      savePersisted({ term: title, items, savedAt: Date.now() });
    }
  });

  return {
    unsubscribe() {
      sub.unsubscribe();
      clickSub.unsubscribe();
    },
  };
}

// --- usage ---
const input = document.querySelector<HTMLInputElement>("#search")!;
const status = document.querySelector<HTMLElement>("#status")!;
const suggestionsList = document.querySelector<HTMLUListElement>("#suggestions")!;

const binding = bindWikipediaAutosuggest({ input, status, suggestionsList });
// later: binding.unsubscribe()
