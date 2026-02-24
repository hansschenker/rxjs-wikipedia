import './style.css'
import { fromEvent, of, Observable } from "rxjs";
import {
  catchError,
  debounceTime,
  distinctUntilChanged,
  filter,
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
const PERSIST_TTL_MS = 30 * 60 * 1000; // 30 minutes

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
    if (Date.now() - parsed.savedAt > PERSIST_TTL_MS) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
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

function renderSuggestions(
  input: HTMLInputElement,
  ul: HTMLUListElement,
  items: Suggestion[],
  activeIndex = -1,
) {
  clear(ul);

  const hasItems = items.length > 0;
  input.setAttribute("aria-expanded", String(hasItems));

  for (let i = 0; i < items.length; i++) {
    const s = items[i];
    const li = document.createElement("li");
    li.id = `suggestion-${i}`;
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(i === activeIndex));

    const href = document.createElement("a");
    href.textContent = s.title;
    href.href = s.url ?? "#";

    // Keep SPA page alive; Wikipedia opens in a new tab.
    href.target = "_blank";
    href.rel = "noopener noreferrer";

    li.appendChild(href);
    ul.appendChild(li);
  }

  // Point aria-activedescendant at the highlighted item, or clear it
  if (activeIndex >= 0 && activeIndex < items.length) {
    input.setAttribute("aria-activedescendant", `suggestion-${activeIndex}`);
  } else {
    input.setAttribute("aria-activedescendant", "");
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
    renderSuggestions(opts.input, opts.suggestionsList, restored.items);
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
        catchError((e: unknown) =>
          of<SuggestState>({
            kind: "error",
            term,
            items: [],
            error: e instanceof Error ? e.message : String(e),
          })
        ),
        startWith({ kind: "loading", term, items: [] } as SuggestState),
      );
    }),
    // Emit restored suggestions first so UI has something immediately on reload/back
    startWith(initialState),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  // Cache the latest state so the click/keyboard handlers can read it without scraping the DOM
  let lastState: SuggestState = initialState;
  let activeIndex = -1;

  function applyActiveIndex(index: number) {
    activeIndex = index;
    renderSuggestions(opts.input, opts.suggestionsList, lastState.items, activeIndex);
  }

  // render + persist
  const sub = state$.subscribe((s) => {
    lastState = s;
    activeIndex = -1;
    renderStatus(opts.status, s);
    renderSuggestions(opts.input, opts.suggestionsList, s.items);

    // Persist only meaningful results
    if (s.kind === "done" && s.items.length > 0) {
      savePersisted({ term: s.term, items: s.items, savedAt: Date.now() });
    }

    // If user clears input (or below min length), drop persisted list
    if (s.kind === "idle" && s.term.length < minLength) {
      clearPersisted();
    }
  });

  // Keyboard navigation: ArrowDown, ArrowUp, Enter, Escape
  const keySub = fromEvent<KeyboardEvent>(opts.input, "keydown").pipe(
    filter((e) =>
      e.key === "ArrowDown" || e.key === "ArrowUp" ||
      e.key === "Enter" || e.key === "Escape"
    )
  ).subscribe((e) => {
    const items = lastState.items;

    if (e.key === "Escape") {
      applyActiveIndex(-1);
      opts.input.blur();
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      applyActiveIndex(Math.min(activeIndex + 1, items.length - 1));
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      applyActiveIndex(Math.max(activeIndex - 1, -1));
      return;
    }

    if (e.key === "Enter" && activeIndex >= 0 && activeIndex < items.length) {
      e.preventDefault();
      const selected = items[activeIndex];
      if (selected.url) window.open(selected.url, "_blank", "noopener,noreferrer");
      opts.input.value = selected.title;
      savePersisted({ term: selected.title, items, savedAt: Date.now() });
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

    // Use cached stream state — avoids DOM scraping and the el.href absolute-URL bug
    if (title && lastState.items.length > 0) {
      savePersisted({ term: title, items: lastState.items, savedAt: Date.now() });
    }
  });

  return {
    unsubscribe() {
      sub.unsubscribe();
      keySub.unsubscribe();
      clickSub.unsubscribe();
    },
  };
}

// --- usage ---
const input = document.querySelector<HTMLInputElement>("#search");
const status = document.querySelector<HTMLElement>("#status");
const suggestionsList = document.querySelector<HTMLUListElement>("#suggestions");

if (!input) throw new Error("Missing required element: #search");
if (!status) throw new Error("Missing required element: #status");
if (!suggestionsList) throw new Error("Missing required element: #suggestions");

const binding = bindWikipediaAutosuggest({ input, status, suggestionsList });
// later: binding.unsubscribe()
