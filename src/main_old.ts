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

export function searchWikipedia(term: string, limit = 10): Observable<WikiOpenSearch> {
  const params = new URLSearchParams({
    action: "opensearch",
    format: "json",
    origin: "*",
    search: term,
    limit: String(limit),
    namespace: "0",
  });

  //const url = `https://en.wikipedia.org/w/api.php?${params.toString()}`;
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
    href.target = "_blank";
    href.rel = "noopener noreferrer";
    li.appendChild(href);
    console.log("Suggestion:", s);
    // li.textContent = s.title;
    // if (s.url) li.dataset.url = s.url;
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

  // text over time (always emits, even when empty, so we can clear the UI)
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
    shareReplay({ bufferSize: 1, refCount: true })
  );

  // render
  const sub = state$.subscribe((s) => {
    renderStatus(opts.status, s);
    renderSuggestions(opts.suggestionsList, s.items);
  });

  // click a suggestion (event delegation)
  const clickSub = fromEvent<MouseEvent>(opts.suggestionsList, "click").subscribe((ev) => {
    const target = ev.target as HTMLElement | null;
    const li = target?.closest("li") as HTMLLIElement | null;
    if (!li) return;

    const url = li.dataset.url;
    const title = li.textContent ?? "";

    // choose policy: fill input + clear list
    opts.input.value = title;
    renderSuggestions(opts.suggestionsList, []);
    renderStatus(opts.status, { kind: "idle", term: title, items: [] });

    // optional: navigate
    if (url) window.open(url, "_blank", "noopener,noreferrer");
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