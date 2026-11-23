import { NextRequest, NextResponse } from "next/server";

// Proxy Anki media files from the backend so they work from any network device.
// Card HTML uses /api/anki/media/filename → this route → http://127.0.0.1:8002/anki/media/filename
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  const filename  = path.map(encodeURIComponent).join("/");
  const backendUrl = process.env.BACKEND_URL ?? "http://127.0.0.1:8002";

  try {
    const res = await fetch(`${backendUrl}/anki/media/${filename}`, {
      cache: "force-cache",
    });
    if (!res.ok) return new NextResponse(null, { status: res.status });

    const buf  = await res.arrayBuffer();
    const ct   = res.headers.get("content-type") ?? "application/octet-stream";
    return new NextResponse(buf, {
      headers: {
        "Content-Type": ct,
        "Cache-Control": "public, max-age=86400, immutable",
      },
    });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
}
