"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { getBackendUrl } from "@/lib/api";
import { Layers, Link2, ArrowLeft } from "lucide-react";
import RouteFallback from "@/components/common/RouteFallback";

// useSearchParams() must sit inside a <Suspense> boundary or Next 16 fails static
// generation of this route (the frontend build stalls). Split: content + wrapper.
function UtdDdxHome() {
  const [topics, setTopics] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${getBackendUrl()}/utdddx/browse`)
      .then(r => r.json())
      .then(d => setTopics(d.topics || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const filtered = topics.filter(t => t.title.toLowerCase().includes(search.toLowerCase()));

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", padding: 30 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 15, marginBottom: 20 }}>
        <Layers size={28} color="var(--mod-utdddx)" />
        <h1 style={{ fontSize: 24, fontWeight: 800, margin: 0, color: "var(--text-primary)" }}>UpToDate DDx</h1>
      </div>

      <input
        type="text"
        placeholder="Search presenting diagnoses..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{
          width: "100%", maxWidth: 400, padding: "10px 14px", borderRadius: 8,
          border: "1px solid var(--border)", background: "var(--bg-card)",
          fontSize: 14, color: "var(--text-primary)", marginBottom: 20
        }}
      />

      {loading ? (
        <RouteFallback label="Loading topics..." />
      ) : (
        <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 8, paddingBottom: 40 }}>
          {filtered.map(t => (
            <button
              key={t.id}
              onClick={() => {
                window.dispatchEvent(new CustomEvent("TabBar:open", {
                  detail: { href: `/utdddx?id=${t.id}`, title: `DDx: ${t.title}` }
                }));
              }}
              style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "12px 16px", borderRadius: 8, background: "var(--bg-card)",
                border: "1px solid var(--border)", cursor: "pointer", textAlign: "left"
              }}
            >
              <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text-secondary)" }}>{t.title}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", background: "var(--bg-subtle)", padding: "2px 8px", borderRadius: 12 }}>
                {t.differential_count} differentials
              </span>
            </button>
          ))}
          {filtered.length === 0 && (
            <div style={{ color: "var(--text-muted)", marginTop: 20 }}>No topics found.</div>
          )}
        </div>
      )}
    </div>
  );
}

function UtdDdxContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const id = searchParams?.get("id");
  const utdId = searchParams?.get("utd_id");

  const [topic, setTopic] = useState<any>(null);
  const [cuis, setCuis] = useState<string[]>([]);
  const [utdLinks, setUtdLinks] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!id && !utdId) return;

    let isMounted = true;
    setLoading(true);

    if (utdId && !id) {
      // Handle the bidirectional utd_id case
      fetch(`${getBackendUrl()}/utdddx/by-utd?utd_id=${utdId}`)
        .then(r => r.ok ? r.json() : { topics: [] })
        .then(d => {
          if (!isMounted) return;
          if (d.topics && d.topics.length > 0) {
            const firstId = d.topics[0].id;
            // Now fetch the actual topic
            Promise.all([
              fetch(`${getBackendUrl()}/utdddx/topic/${firstId}`).then(r => r.ok ? r.json() : null),
              fetch(`${getBackendUrl()}/utdddx/cui?id=${firstId}`).then(r => r.ok ? r.json() : { cuis: [] }),
              fetch(`${getBackendUrl()}/utdddx/utd-links?id=${firstId}`).then(r => r.ok ? r.json() : { utd_topic_ids: [] })
            ]).then(([topicData, cuiData, utdLinksData]) => {
              if (!isMounted) return;
              setTopic(topicData);
              setCuis(cuiData?.cuis || []);
              setUtdLinks(utdLinksData?.utd_topic_ids || []);
              setLoading(false);
            });
          } else {
            setLoading(false);
          }
        })
        .catch(() => {
          if (isMounted) setLoading(false);
        });
      return () => { isMounted = false; };
    }

    // Normal ID fetch
    Promise.all([
      fetch(`${getBackendUrl()}/utdddx/topic/${id}`).then(r => r.ok ? r.json() : null),
      fetch(`${getBackendUrl()}/utdddx/cui?id=${id}`).then(r => r.ok ? r.json() : { cuis: [] }),
      fetch(`${getBackendUrl()}/utdddx/utd-links?id=${id}`).then(r => r.ok ? r.json() : { utd_topic_ids: [] })
    ])
      .then(([topicData, cuiData, utdLinksData]) => {
        if (!isMounted) return;
        setTopic(topicData);
        setCuis(cuiData?.cuis || []);
        setUtdLinks(utdLinksData?.utd_topic_ids || []);
      })
      .catch(console.error)
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => { isMounted = false; };
  }, [id, utdId]);

  function openUtd(topicId: string) {
    window.dispatchEvent(new CustomEvent("TabBar:open", {
      detail: { href: `/uptodate?t=${topicId}`, title: "UpToDate" }
    }));
  }

  function openUmls(cui: string) {
    window.dispatchEvent(new CustomEvent("TabBar:open", {
      detail: { href: `/umls?cui=${cui}`, title: "UMLS" }
    }));
  }

  if (!id && !utdId) {
    return <UtdDdxHome />;
  }

  if (loading) {
    return <RouteFallback label="Loading UpToDate DDx" />;
  }

  if (!topic) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--text-muted)" }}>
        <Layers size={32} />
        <h2 style={{ marginTop: 10, fontSize: 16 }}>UpToDate DDx</h2>
        <p style={{ fontSize: 13 }}>Topic not found or could not be loaded.</p>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "auto", padding: 30 }}>
      <button
        onClick={() => router.push('/utdddx')}
        style={{
          display: "inline-flex", alignItems: "center", gap: 5,
          background: "none", border: "none", color: "var(--text-muted)",
          cursor: "pointer", fontSize: 13, fontWeight: 600, padding: 0,
          marginBottom: 15, alignSelf: "flex-start"
        }}
      >
        <ArrowLeft size={16} />
        Back to Differentials
      </button>

      <h1 style={{ fontSize: 24, fontWeight: 800, color: "var(--text-primary)", marginBottom: 10 }}>
        {topic.title}
      </h1>

      <div style={{ display: "flex", gap: 20, marginBottom: 20 }}>
        {/* UMLS Links */}
        {cuis.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", marginRight: 5, alignSelf: "center" }}>UMLS CUIs:</span>
            {cuis.map(cui => (
              <button
                key={cui}
                onClick={() => openUmls(cui)}
                style={{
                  background: "rgba(20, 184, 166, 0.12)", color: "#0f766e",
                  border: "1px solid rgba(20, 184, 166, 0.28)", borderRadius: 4,
                  padding: "2px 8px", fontSize: 11, fontWeight: 600, cursor: "pointer"
                }}
              >
                {cui}
              </button>
            ))}
          </div>
        )}

        {/* UTD Links */}
        {utdLinks.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", marginRight: 5, alignSelf: "center" }}>Related UpToDate Articles:</span>
            {utdLinks.map(utdId => (
              <button
                key={utdId}
                onClick={() => openUtd(utdId)}
                style={{
                  display: "flex", alignItems: "center", gap: 4,
                  background: "rgba(0, 133, 124, 0.1)", color: "#00857c",
                  border: "1px solid rgba(0, 133, 124, 0.3)", borderRadius: 4,
                  padding: "2px 8px", fontSize: 11, fontWeight: 600, cursor: "pointer"
                }}
              >
                <Link2 size={10} />
                {utdId}
              </button>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 15 }}>
        {(topic.differentials || []).map((diff: any, idx: number) => (
          <div key={idx} style={{ padding: 16, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-card)" }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 10px 0", color: "var(--text-primary)" }}>{diff.diagnosis}</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
              <div>
                <h4 style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 5 }}>Clinical Signs</h4>
                <div style={{ fontSize: 14, color: "var(--text-secondary)" }} dangerouslySetInnerHTML={{ __html: diff.signs }} />
              </div>
              <div>
                <h4 style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 5 }}>Tests / Findings</h4>
                <div style={{ fontSize: 14, color: "var(--text-secondary)" }} dangerouslySetInnerHTML={{ __html: diff.tests }} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function UtdDdxPage() {
  return (
    <Suspense fallback={<RouteFallback label="Loading UpToDate DDx" />}>
      <UtdDdxContent />
    </Suspense>
  );
}
