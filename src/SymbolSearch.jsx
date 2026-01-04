import { useEffect, useMemo, useRef, useState } from "react";
import { logFetch } from "../apiLog";

const normalizeSymbol = (value) =>
  String(value || "")
    .trim()
    .toUpperCase();

const extractInstrumentSymbol = (item) =>
  item?.symbol ||
  item?.["symbol"] ||
  item?.["future-symbol"] ||
  item?.["equity-symbol"] ||
  item?.underlyingSymbol ||
  item?.["underlying-symbol"] ||
  item?.rootSymbol ||
  item?.["root-symbol"];

// TODO: Verify mixed futures/equities results still render correctly once API search returns real data.
const formatResultSymbol = (value, item = {}) => {
  const rawSym = String(value || "").trim();
  const normalized = normalizeSymbol(rawSym);
  if (!normalized) {
    return normalized;
  }
  const instrumentType =
    item?.instrumentType ||
    item?.["instrument-type"] ||
    item?.type ||
    item?.["type"] ||
    "";
  const typeLabel = String(instrumentType).toLowerCase();
  const isFuture = typeLabel === "future" || typeLabel === "futures";
  const hadSlash = rawSym.startsWith("/");
  if ((isFuture || hadSlash) && !normalized.startsWith("/")) {
    return `/${normalized}`;
  }
  return normalized;
};

function buildEndpoint(type, query) {
  const q = encodeURIComponent(query);
  return type === "equities"
    ? `/api/instruments/equities/search?q=${q}`
    : `/api/instruments/futures/search?q=${q}`;
}

function getItemsFromPayload(payload) {
  const candidates = [
    payload?.data?.items,
    payload?.data?.data?.items,
    payload?.items,
    payload?.data,
    payload?.data?.data,
  ];

  for (const entry of candidates) {
    if (!entry) continue;
    if (Array.isArray(entry)) return entry;
    if (typeof entry === "object") return [entry];
  }

  return [];
}

/**
 * Tries to pull a human-friendly description + a short meta line from common TT-ish fields.
 * Keeps this defensive because payload shapes vary by instrument type and SDK version.
 */
function describeInstrument(item) {
  const raw = item || {};
  const instrumentType =
    raw?.instrumentType ||
    raw?.["instrument-type"] ||
    raw?.type ||
    raw?.["type"] ||
    "";
  const typeLabel = String(instrumentType).toLowerCase();

  const symbol = normalizeSymbol(
    extractInstrumentSymbol(raw) ||
      raw?.symbol ||
      raw?.["root-symbol"] ||
      raw?.rootSymbol ||
      raw?.["streamer-symbol"] ||
      raw?.streamerSymbol ||
      ""
  );

  const title =
    raw?.description ||
    raw?.["short-description"] ||
    raw?.name ||
    raw?.displayName ||
    raw?.["display-name"] ||
    symbol;

  if (typeLabel === "equity") {
    const metaBits = ["Equity"];
    if (raw?.["listed-market"]) metaBits.push(raw["listed-market"]);
    if (raw?.["is-etf"]) metaBits.push("ETF");
    if (raw?.["is-index"]) metaBits.push("Index");
    if (raw?.lendability) metaBits.push(raw.lendability);
    return { symbol, title, meta: metaBits.join(" • ") };
  }

  const isFuture = typeLabel === "future" || typeLabel === "futures" || symbol.startsWith("/");
  if (isFuture) {
    const exchange = raw?.exchange || raw?.["exchange"] || "";
    const marketSector =
      raw?.["market-sector"] ||
      raw?.marketSector ||
      raw?.["future-product"]?.["market-sector"] ||
      "";
    const productType =
      raw?.["product-type"] ||
      raw?.["future-product"]?.["product-type"] ||
      "";
    const expiresAt = raw?.["expires-at"] || raw?.expiresAt || "";
    const expirationDate = raw?.["expiration-date"] || raw?.expirationDate || "";
    const isFutureContract = Boolean(expiresAt || expirationDate);

    if (isFutureContract) {
      const exp = String(expirationDate || expiresAt).slice(0, 10);
      const productCode = raw?.["product-code"] || raw?.productCode || "";
      const productDesc = raw?.["future-product"]?.description || "";
      const closingOnly = raw?.["is-closing-only"] ? "Closing Only" : "";
      const tradeable = raw?.["is-tradeable"] === false ? "Not Tradeable" : "";
      const metaBits = ["Future"];
      if (exchange) metaBits.push(exchange);
      if (productCode) metaBits.push(productCode);
      if (exp) metaBits.push(`Exp ${exp}`);
      if (closingOnly) metaBits.push(closingOnly);
      if (tradeable) metaBits.push(tradeable);
      return { symbol, title: productDesc || title, meta: metaBits.join(" • ") };
    }

    const metaBits = ["Future"];
    if (exchange) metaBits.push(exchange);
    if (marketSector) metaBits.push(marketSector);
    if (productType) metaBits.push(productType);
    return { symbol, title, meta: metaBits.join(" • ") };
  }

  return { symbol, title, meta: instrumentType ? String(instrumentType) : "" };
}

export default function SymbolSearch({ onSelect }) {
  const [symbolQuery, setSymbolQuery] = useState("");
  const [symbolResults, setSymbolResults] = useState([]);
  const [symbolError, setSymbolError] = useState("");
  const [symbolLoading, setSymbolLoading] = useState(false);

  // Debounce + request control
  const symbolQueryTimerRef = useRef(null);
  const symbolRequestRef = useRef(0);
  const abortRef = useRef(null);
  const CACHE_TTL_MS = 60_000;
  const MAX_CACHE_ENTRIES = 200;
  const cacheRef = useRef(new Map());

  // Keyboard navigation state
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef(null);

  const visibleResults = useMemo(
    () => symbolResults.slice(0, 12),
    [symbolResults]
  );

  const clearResults = () => {
    abortRef.current?.abort?.();
    setSymbolLoading(false);
    setSymbolError("");
    setSymbolResults([]);
    setActiveIndex(-1);
  };

  const selectResult = (idx) => {
    const item = visibleResults[idx];
    if (!item) return;
    onSelect?.(item.symbol);
    // Keep query (optional). If you prefer to clear after select, uncomment:
    // setSymbolQuery("");
    setActiveIndex(-1);
  };

  const makeCacheKey = (value) => normalizeSymbol(value);


  const cacheGet = (key) => {
    const entry = cacheRef.current.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
      cacheRef.current.delete(key);
      return null;
    }
    return entry.results;
  };

  const cacheSet = (key, results) => {
    if (cacheRef.current.size >= MAX_CACHE_ENTRIES) {
      let oldestKey = null;
      let oldestTs = Infinity;
      for (const [entryKey, entryValue] of cacheRef.current.entries()) {
        if (entryValue.ts < oldestTs) {
          oldestTs = entryValue.ts;
          oldestKey = entryKey;
        }
      }
      if (oldestKey) cacheRef.current.delete(oldestKey);
    }
    cacheRef.current.set(key, { ts: Date.now(), results });
  };

  const runSymbolSearch = async (rawQuery) => {
    let query = rawQuery.trim();

    if (query.length < 2) {
      clearResults();
      return;
    }
    const cacheKey = makeCacheKey(query).replace(/^\/+/, "");
    const cached = cacheGet(cacheKey);
    if (cached) {
      abortRef.current?.abort?.();
      setSymbolResults(cached);
      setActiveIndex(cached.length ? 0 : -1);
      setSymbolError("");
      setSymbolLoading(false);
      return;
    }
    const futuresQuery = query;

    const requestId = symbolRequestRef.current + 1;
    symbolRequestRef.current = requestId;

    abortRef.current?.abort?.();
    const controller = new AbortController();
    abortRef.current = controller;

    setSymbolLoading(true);
    setSymbolError("");

    try {
      const equitiesPromise = query.startsWith("/")
        ? Promise.resolve(null)
        : logFetch(buildEndpoint("equities", query), {
            cache: "no-store",
            signal: controller.signal,
          });

      const futuresPromise = logFetch(buildEndpoint("futures", futuresQuery), {
        cache: "no-store",
        signal: controller.signal,
      });

      const [equitiesRes, futuresRes] = await Promise.all([
        equitiesPromise,
        futuresPromise,
      ]);

      const [equitiesPayload, futuresPayload] = await Promise.all([
        equitiesRes?.json?.().catch(() => ({})) ?? {},
        futuresRes.json().catch(() => ({})),
      ]);

      // stale response guard
      if (symbolRequestRef.current !== requestId) return;

      const equitiesOk = equitiesRes ? equitiesRes.ok : true;
      if (!equitiesOk && !futuresRes.ok) {
        setSymbolError(
          equitiesPayload?.error ||
            futuresPayload?.error ||
            "Symbol search failed."
        );
        setSymbolResults([]);
        setActiveIndex(-1);
        return;
      }

      let items = [
        ...getItemsFromPayload(equitiesPayload),
        ...getItemsFromPayload(futuresPayload),
      ];
      if (!items.length && query.length >= 2 && !query.startsWith("/")) {
        const slashRes = await logFetch(buildEndpoint("futures", `/${query}`), {
          cache: "no-store",
          signal: controller.signal,
        });
        const slashPayload = await slashRes.json().catch(() => ({}));
        if (symbolRequestRef.current !== requestId) return;
        if (slashRes.ok) {
          items = getItemsFromPayload(slashPayload);
        }
      }
      if (!items.length && import.meta?.env?.DEV) {
        items = [
          { symbol: "/ES", description: "E-mini S&P 500" },
          { symbol: "/MES", description: "Micro E-mini S&P 500" },
          { symbol: "AAPL", description: "Apple Inc." },
        ];
      }

      // Normalize + dedupe by symbol
      const deduped = new Map();
      for (const raw of items) {
        const formatted = formatResultSymbol(
          extractInstrumentSymbol(raw),
          raw
        );
        if (!formatted) continue;
        if (!deduped.has(formatted)) {
          const info = describeInstrument(raw);
          deduped.set(formatted, {
            symbol: formatted,
            raw,
            info: { ...info, symbol: formatted },
          });
        }
      }

      const next = [...deduped.values()];
      const sortToken = normalizeSymbol(rawQuery).replace(/^\/+/, "");
      const ordered = next
        .map((item) => {
          const rawSymbol = String(item.symbol || "");
          const symbolCore = rawSymbol.replace(/^\/+/, "");
          const raw = item.raw || {};
          const isContract = Boolean(
            raw?.["expiration-date"] ||
              raw?.expirationDate ||
              raw?.["expires-at"] ||
              raw?.expiresAt
          );
          let score = 0;
          if (sortToken) {
            if (symbolCore === sortToken) {
              score = 300;
            } else if (symbolCore.startsWith(sortToken)) {
              score = 200;
            } else if (symbolCore.includes(sortToken)) {
              score = 100;
            }
          }
          if (isContract) {
            score += 25;
          }
          return { item, score, symbolCore, rawSymbol };
        })
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          if (a.symbolCore.length !== b.symbolCore.length) {
            return a.symbolCore.length - b.symbolCore.length;
          }
          return a.rawSymbol.localeCompare(b.rawSymbol);
        })
        .map((entry) => entry.item);
      if (ordered.length) cacheSet(cacheKey, ordered);
      setSymbolResults(ordered);
      setActiveIndex(ordered.length ? 0 : -1);
    } catch (err) {
      if (symbolRequestRef.current !== requestId) return;
      if (err?.name === "AbortError") return;

      setSymbolError(err?.message || "Symbol search failed.");
      setSymbolResults([]);
      setActiveIndex(-1);
    } finally {
      if (symbolRequestRef.current === requestId) {
        setSymbolLoading(false);
      }
    }
  };

  // Debounced search
  useEffect(() => {
    if (symbolQueryTimerRef.current) clearTimeout(symbolQueryTimerRef.current);

    const query = symbolQuery.trim();
    if (query.length < 2) {
      clearResults();
      return;
    }

    symbolQueryTimerRef.current = setTimeout(() => {
      runSymbolSearch(query);
    }, 250);

    return () => {
      if (symbolQueryTimerRef.current) clearTimeout(symbolQueryTimerRef.current);
      abortRef.current?.abort?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbolQuery]);

  const listboxId = "symbol-search-listbox";

  const handleInputKeyDown = (event) => {
    if (!visibleResults.length) {
      if (event.key === "Escape") {
        // Esc clears even if no results
        setSymbolQuery("");
        clearResults();
      }
      return;
    }

    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        setActiveIndex((prev) => {
          const next = prev < 0 ? 0 : (prev + 1) % visibleResults.length;
          return next;
        });
        break;
      }
      case "ArrowUp": {
        event.preventDefault();
        setActiveIndex((prev) => {
          if (prev < 0) return visibleResults.length - 1;
          const next = (prev - 1 + visibleResults.length) % visibleResults.length;
          return next;
        });
        break;
      }
      case "Enter": {
        // If user is submitting the form while an item is highlighted, select it.
        if (activeIndex >= 0) {
          event.preventDefault();
          selectResult(activeIndex);
        }
        break;
      }
      case "Escape": {
        event.preventDefault();
        setSymbolQuery("");
        clearResults();
        break;
      }
      default:
        break;
    }
  };

  return (
    <div className="broker-card">
      <div className="broker-section-title">Symbol Finder</div>

      <form
        className="broker-symbol-search"
        onSubmit={(event) => {
          event.preventDefault();

          // If an item is highlighted, treat submit as "select"
          if (activeIndex >= 0 && visibleResults.length) {
            selectResult(activeIndex);
            return;
          }

          runSymbolSearch(symbolQuery);
        }}
      >
        <div className="broker-search-row symbol-search-row">
          <div className="symbol-search-box">
            <input
              ref={inputRef}
              type="text"
              value={symbolQuery}
              onChange={(event) => setSymbolQuery(event.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder="Search symbols or names (AAPL, /ES)"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={visibleResults.length > 0}
              aria-controls={listboxId}
              aria-activedescendant={
                activeIndex >= 0 ? `symbol-option-${activeIndex}` : undefined
              }
            />

            {visibleResults.length > 0 ? (
              <div
                className="symbol-dropdown"
                id={listboxId}
                role="listbox"
                aria-label="Symbol search results"
              >
                {visibleResults.map((item, idx) => {
                  const info = item.info || describeInstrument(item.raw);
                  const isActive = idx === activeIndex;

                  return (
                    <button
                      key={item.symbol}
                      id={`symbol-option-${idx}`}
                      type="button"
                      className={`symbol-dropdown-item ${
                        isActive ? "is-active" : ""
                      }`}
                      role="option"
                      aria-selected={isActive}
                      onMouseEnter={() => setActiveIndex(idx)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => selectResult(idx)}
                      title={info.title}
                    >
                      <div className="symbol-dropdown-left">
                        <div className="symbol-dropdown-symbol">
                          {item.symbol}
                        </div>
                        {info.title && info.title !== item.symbol ? (
                          <div className="symbol-dropdown-title">
                            {info.title}
                          </div>
                        ) : null}
                      </div>

                      {info.meta ? (
                        <div className="symbol-dropdown-meta">{info.meta}</div>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

          <button type="submit" disabled={symbolLoading}>
            {symbolLoading ? "Searching..." : "Search"}
          </button>
        </div>
      </form>

      {symbolError ? <div className="broker-error-text">{symbolError}</div> : null}

      {visibleResults.length === 0 &&
      symbolQuery.trim().length >= 2 &&
      !symbolLoading ? (
        <div className="broker-error-text">No matches yet.</div>
      ) : null}
    </div>
  );
}

