"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Filter, RotateCcw, X } from "lucide-react";
import { buildSearchHref } from "@/lib/searchResultsState.mjs";
import type { SearchFilters as Filters } from "@/lib/searchResultsState";

const SOURCE_FILTERS = [
  ["uptodate", "UpToDate"],
  ["amboss", "AMBOSS"],
  ["uworld", "UWorld"],
  ["firstaid", "First Aid"],
  ["books", "Books"],
  ["umls", "UMLS"],
  ["qbank", "Q-Bank"],
  ["sanford", "Sanford"],
  ["utdddx", "UTD DDx"],
  ["drugs", "Drugs"],
  ["calc", "Calculators"],
] as const;

const KIND_FILTERS = [
  ["articles", "Articles"],
  ["books", "Books / PDF"],
  ["images", "Images"],
  ["tables", "Tables"],
  ["concepts", "Concepts"],
  ["drugs", "Drugs"],
  ["questions", "Questions"],
  ["calculator", "Calculator"],
] as const;

interface Props {
  filters: Filters;
  facets: {
    sources: Record<string, number>;
    kinds: Record<string, number>;
  };
  relatedMedia?: { images: number; tables: number };
}

function facetCount(facets: Record<string, number>, value: string, relatedMedia?: Props["relatedMedia"]) {
  if (value === "uptodate") return facets.uptodate ?? facets.utd;
  if (value === "articles") return (facets.article || 0) + (facets.topic || 0);
  if (value === "books") return (facets.book || 0) + (facets.chapter || 0);
  if (value === "images") return Math.max(facets.clinic_image || 0, relatedMedia?.images || 0);
  if (value === "tables") return Math.max(facets.uworld_table || 0, relatedMedia?.tables || 0);
  if (value === "questions") return facets.question;
  if (value === "drugs") return facets.drug;
  if (value === "calculator") return facets.calculator;
  return facets[value];
}

export default function SearchFilters({ filters, facets, relatedMedia }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  function navigate(next: Filters) {
    router.push(buildSearchHref(next), { scroll: false });
  }

  function toggle(group: "scopes" | "kinds", value: string) {
    const active = filters[group];
    navigate({
      ...filters,
      [group]: active.includes(value)
        ? active.filter((entry) => entry !== value)
        : [...active, value],
    });
  }

  function options(
    title: string,
    group: "scopes" | "kinds",
    values: readonly (readonly [string, string])[],
    available: Record<string, number>,
  ) {
    return (
      <fieldset className="search-results-filter-group">
        <legend>{title}</legend>
        {values.map(([value, label]) => {
          const checked = filters[group].includes(value);
          const count = facetCount(available, value, relatedMedia);
          return (
            <label key={value} className={checked ? "is-active" : undefined}>
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(group, value)}
              />
              <span>{label}</span>
              {typeof count === "number" && <small aria-label={`${count} available for this search`}>{count}</small>}
            </label>
          );
        })}
      </fieldset>
    );
  }

  return (
    <>
      <button
        type="button"
        className="search-results-filter-toggle"
        aria-expanded={open}
        aria-controls="search-results-filters"
        onClick={() => setOpen((value) => !value)}
      >
        <Filter size={17} aria-hidden="true" />
        Filters
      </button>
      <aside
        id="search-results-filters"
        className={`search-results-filters${open ? " is-open" : ""}`}
        aria-label="Search filters"
      >
        <header>
          <div>
            <strong>Refine results</strong>
            <span>Counts include linked concept media</span>
          </div>
          <button type="button" className="search-results-filter-close" onClick={() => setOpen(false)} aria-label="Close filters">
            <X size={18} />
          </button>
        </header>
        {options("Sources", "scopes", SOURCE_FILTERS, facets.sources)}
        {options("Types", "kinds", KIND_FILTERS, facets.kinds)}
        {(filters.scopes.length > 0 || filters.kinds.length > 0) && (
          <button
            type="button"
            className="search-results-clear-filters"
            onClick={() => navigate({ ...filters, scopes: [], kinds: [] })}
          >
            <RotateCcw size={15} aria-hidden="true" />
            Clear filters
          </button>
        )}
      </aside>
    </>
  );
}
