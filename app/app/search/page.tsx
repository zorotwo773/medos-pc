import { Suspense } from "react";
import SearchResultsClient from "@/components/search/SearchResultsClient";
import "@/components/search/search-results.css";

function SearchPageFallback() {
  return (
    <main className="search-results-page" aria-busy="true">
      <div className="search-results-shell">
        <div className="search-results-skeleton is-heading" />
        <div className="search-results-skeleton is-card" />
        <div className="search-results-skeleton is-card" />
      </div>
    </main>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={<SearchPageFallback />}>
      <SearchResultsClient />
    </Suspense>
  );
}
