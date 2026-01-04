# Symbol Search (Equities + Futures)

React symbol search component extracted from a larger private trading dashboard project.

## Files
- `src/SymbolSearch.jsx` — main component

## Overview
A frontend React symbol search component designed for broker-style APIs
(e.g. tastytrade-style instrument metadata).

## Features
- Equities + futures search
- `/ES`, `ESU4`, `AAPL` normalization
- Keyboard navigation
- Client-side caching
- No credentials in the frontend
- Backend-agnostic (proxy required)

## Security Model
This component **does not**:
- Store API keys
- Call broker APIs directly
- Expose account data

All network requests are expected to go through a backend proxy.

## Status
This is an early extraction from a private project.
It’s shared to gauge usefulness and may evolve, change, or be archived.

## Usage
```jsx
<SymbolSearch onSelect={(symbol) => console.log(symbol)} />
