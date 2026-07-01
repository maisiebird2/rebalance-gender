#!/bin/bash
set -e

cd "$(dirname "$0")"

git add src/app/api/search-miss/route.ts
git add src/components/DiscoverResultsGrid.tsx
git add src/components/SearchMissResults.tsx
git add src/app/page.tsx
git add src/app/discover/page.tsx

git commit -m "feat: save search misses and show similar artists on zero results

When a homepage search returns no results:
- POST to /api/search-miss saves the artist name as a pending entry
  (skips if a record with that name already exists)
- SearchMissResults component fires /api/search-miss and /api/discover
  in parallel, then renders similar artists from the directory
- Shared DiscoverResultsGrid component replaces duplicated avatar grid
  in both /discover and the new SearchMissResults component"
