"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, ChevronRight, ZoomIn } from "lucide-react";
import { getBackendUrl } from "@/lib/api";
import { FigureZoom } from "./BonePanelShared";

interface AoSection {
  id: string;
  heading: string;
  html: string;
  figures: { file: string; caption: string }[];
}

interface AoPage {
  title: string;
  sections: AoSection[];
}

const SKIP_CAPTIONS = ["ao milestones", "new content", "newsletter", "course", "login", "register"];

export default function ScrapedContent({ slug, color }: { slug: string; color: string }) {
  const [page, setPage] = useState<AoPage | null>(null);
  const [children, setChildren] = useState<{ slug: string; title: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [childSlug, setChildSlug] = useState<string | null>(null);
  const [zoom, setZoom] = useState<{ src: string; caption: string } | null>(null);

  useEffect(() => {
    setLoading(true);
    setPage(null);
    setChildren([]);
    setChildSlug(null);

    fetch(`${getBackendUrl()}/ao/page?slug=${encodeURIComponent(slug)}`)
      .then(r => (r.ok ? r.json() : null))
      .then((d: AoPage | null) => {
        setPage(d);
        const needsChildren = !d || d.sections.length === 0 || d.sections.every(s => !s.html.trim());
        if (needsChildren) {
          fetch(`${getBackendUrl()}/ao/children?slug=${encodeURIComponent(slug)}`)
            .then(r => (r.ok ? r.json() : { children: [] }))
            .then(c => {
              setChildren(c.children ?? []);
              setLoading(false);
            })
            .catch(() => setLoading(false));
        } else {
          setLoading(false);
        }
      })
      .catch(() => setLoading(false));
  }, [slug]);

  const figUrl = (fig: string) =>
    `${getBackendUrl()}/ao/figure?slug=${encodeURIComponent(slug)}&fig=${encodeURIComponent(fig)}`;

  const isSkipFig = (caption: string) => SKIP_CAPTIONS.some(k => caption.toLowerCase().includes(k));

  if (childSlug) {
    return (
      <div>
        <button
          onClick={() => setChildSlug(null)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            fontSize: 11,
            color: "var(--text-muted)",
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: "0 0 12px",
            fontWeight: 600,
          }}
        >
          <ArrowLeft size={12} /> Back to list
        </button>
        <ScrapedContent slug={childSlug} color={color} />
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ padding: 32, textAlign: "center" }}>
        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Loading...</div>
      </div>
    );
  }

  if (children.length > 0) {
    return (
      <div>
        <p
          style={{
            fontSize: 10,
            fontWeight: 700,
            color: "var(--text-muted)",
            textTransform: "uppercase",
            letterSpacing: "0.07em",
            marginBottom: 10,
          }}
        >
          Select an approach
        </p>
        {children.map(c => (
          <div
            key={c.slug}
            onClick={() => setChildSlug(c.slug)}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 12px",
              marginBottom: 6,
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--bg-card)",
              cursor: "pointer",
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLElement).style.borderColor = color;
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLElement).style.borderColor = "var(--border)";
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>{c.title}</span>
            <ChevronRight size={13} color={color} />
          </div>
        ))}
      </div>
    );
  }

  if (!page) {
    return (
      <div style={{ padding: 32, textAlign: "center", fontSize: 12, color: "var(--text-muted)" }}>
        Content not yet available.
      </div>
    );
  }

  const allFigs = page.sections.flatMap(s => s.figures.filter(f => !isSkipFig(f.caption)));
  const allFigsInLastOnly =
    page.sections.length > 1 &&
    page.sections.slice(0, -1).every(s => s.figures.length === 0) &&
    page.sections[page.sections.length - 1].figures.length > 0;

  const getFigsForSection = (sIdx: number, totalSections: number): typeof allFigs => {
    if (!allFigsInLastOnly) {
      return page.sections[sIdx].figures.filter(f => !isSkipFig(f.caption));
    }
    const perSection = Math.ceil(allFigs.length / totalSections);
    const start = sIdx * perSection;
    return allFigs.slice(start, start + perSection);
  };

  const contentSections = page.sections.filter(s => s.heading || s.html);

  return (
    <div>
      {contentSections.map((section, sIdx) => {
        const figs = getFigsForSection(page.sections.indexOf(section), contentSections.length).filter(
          f => !isSkipFig(f.caption)
        );
        const hasContent = section.html || figs.length > 0;
        if (!hasContent && !section.heading) return null;

        return (
          <div
            key={section.id}
            style={{
              marginBottom: 0,
              borderBottom: sIdx < contentSections.length - 1 ? "1px solid var(--border)" : "none",
              paddingBottom: 16,
              paddingTop: sIdx === 0 ? 0 : 16,
            }}
          >
            {section.heading && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <div
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: "50%",
                    background: color,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <span style={{ fontSize: 9, fontWeight: 800, color: "#fff" }}>{sIdx + 1}</span>
                </div>
                <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)" }}>
                  {section.heading}
                </span>
              </div>
            )}

            {figs.length > 0 ? (
              <div>
                {figs.map((fig, fIdx) => (
                  <div
                    key={fIdx}
                    style={{
                      display: "flex",
                      gap: 10,
                      marginBottom: fIdx < figs.length - 1 ? 12 : 0,
                      alignItems: "flex-start",
                    }}
                  >
                    <div
                      style={{ flexShrink: 0, width: 130, position: "relative" }}
                      onClick={() => setZoom({ src: figUrl(fig.file), caption: fig.caption })}
                    >
                      <img
                        src={figUrl(fig.file)}
                        alt={fig.caption}
                        style={{
                          width: "100%",
                          borderRadius: 6,
                          display: "block",
                          cursor: "zoom-in",
                          border: "1px solid var(--border)",
                        }}
                      />
                      <button
                        style={{
                          position: "absolute",
                          top: 4,
                          right: 4,
                          background: "rgba(0,0,0,0.55)",
                          border: "none",
                          borderRadius: 3,
                          padding: "2px 4px",
                          cursor: "pointer",
                          color: "#fff",
                          display: "flex",
                        }}
                      >
                        <ZoomIn size={9} />
                      </button>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {fIdx === 0 && section.html ? (
                        <div
                          className="ao-prose"
                          style={{ fontSize: 11, lineHeight: 1.65, color: "var(--text-primary)" }}
                          dangerouslySetInnerHTML={{ __html: section.html }}
                        />
                      ) : (
                        fig.caption && (
                          <p
                            style={{
                              fontSize: 10,
                              color: "var(--text-muted)",
                              lineHeight: 1.45,
                              margin: 0,
                              fontStyle: "italic",
                            }}
                          >
                            {fig.caption}
                          </p>
                        )
                      )}
                    </div>
                  </div>
                ))}
                {figs[0]?.caption && section.html && (
                  <p
                    style={{
                      fontSize: 10,
                      color: "var(--text-muted)",
                      marginTop: 5,
                      lineHeight: 1.4,
                      fontStyle: "italic",
                    }}
                  >
                    {figs[0].caption}
                  </p>
                )}
              </div>
            ) : (
              section.html && (
                <div
                  className="ao-prose"
                  style={{ fontSize: 11, lineHeight: 1.65, color: "var(--text-primary)" }}
                  dangerouslySetInnerHTML={{ __html: section.html }}
                />
              )
            )}
          </div>
        );
      })}

      {zoom && <FigureZoom src={zoom.src} caption={zoom.caption} onClose={() => setZoom(null)} />}
    </div>
  );
}
