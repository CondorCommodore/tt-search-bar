# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A standalone React component (`src/SymbolSearch.jsx`) for searching equities and futures symbols, extracted from a private tastytrade-style trading dashboard. There is no package.json, build system, or test suite — this is raw source meant to be copied into a larger project.

## Architecture

- Single exported component `SymbolSearch` accepts an `onSelect(symbol)` callback.
- Searches hit two proxy endpoints in parallel: `/api/instruments/equities/search?q=` and `/api/instruments/futures/search?q=`. If both return empty, a fallback `/`-prefixed futures search is attempted.
- All API calls go through an external `logFetch` imported from `../apiLog` (not included in this repo). The component never calls broker APIs directly.
- Results are normalized, deduped by symbol, and sorted by relevance (exact match > prefix > contains, with futures contracts boosted).
- Client-side cache: in-memory Map with 60s TTL and 200-entry LRU eviction.
- Debounce: 250ms on input changes; AbortController cancels in-flight requests on new input.
- In dev mode (`import.meta.env.DEV`), hardcoded stub results are returned when the API returns nothing.

## Key Conventions

- Defensively reads both camelCase and kebab-case field names from API payloads (e.g., `instrument-type` / `instrumentType`) because tastytrade API response shapes vary.
- Futures symbols are always displayed with a leading `/` (e.g., `/ES`, `/MES`).
- The component uses ARIA combobox pattern with full keyboard navigation.
