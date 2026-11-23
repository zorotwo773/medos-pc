"""
/custom — the user's own library: nested folders, saved article links,
editable copies, free-form notes, text annotations, and embedded images.

Everything here is scoped to the signed-in user (require_user) and stored in
custom_library.sqlite3 under MedOS/data so it survives application updates.
The React app talks to this router through the Next.js /api proxy, which keeps
session cookies working from both localhost and LAN clients.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile
from pydantic import BaseModel, field_validator

from auth import require_user
import custom_library as CL

router = APIRouter(prefix="/custom", tags=["Custom Library"])


class _RefIdMixin(BaseModel):
    """`refId` is a string in the DB, but callers may send a bare article id.

    Pydantic v2 refuses to coerce int -> str, so a reader passing
    `refId: 123` used to fail with HTTP 422 before reaching the store.
    """

    refId: str

    @field_validator("refId", mode="before")
    @classmethod
    def _coerce_ref_id(cls, value):
        if value is None:
            return ""
        if isinstance(value, bool):
            return str(int(value))
        return value if isinstance(value, str) else str(value)


class FolderBody(BaseModel):
    name: str
    parentId: Optional[str] = None


class ItemBody(_RefIdMixin):
    source: str
    title: str
    href: Optional[str] = None
    parentId: Optional[str] = None


class DocBody(BaseModel):
    title: str = "Untitled"
    bodyHtml: str = ""
    parentId: Optional[str] = None


class NodeUpdate(BaseModel):
    title: Optional[str] = None
    parentId: Optional[str] = None
    hasParentField: bool = False
    position: Optional[float] = None
    bodyHtml: Optional[str] = None
    href: Optional[str] = None


class CopyBody(_RefIdMixin):
    source: str
    title: Optional[str] = None
    parentId: Optional[str] = None


class AnnotationBody(_RefIdMixin):
    source: str
    quote: str
    prefix: str = ""
    suffix: str = ""
    start: int = -1
    end: int = -1
    color: str = "yellow"
    note: str = ""


class AnnotationUpdate(BaseModel):
    color: Optional[str] = None
    note: Optional[str] = None


# ─── Tree / nodes ───────────────────────────────────────────────────────────

@router.get("/tree")
def tree(user_email: str = Depends(require_user)):
    conn = CL.connect()
    try:
        return {
            "nodes": CL.list_nodes(conn, user_email),
            "annotationCount": CL.annotation_count(conn, user_email),
        }
    finally:
        conn.close()


@router.get("/folders")
def folders(user_email: str = Depends(require_user)):
    conn = CL.connect()
    try:
        return {"nodes": [n for n in CL.list_nodes(conn, user_email) if n["kind"] == "folder"]}
    finally:
        conn.close()


@router.post("/folders")
def create_folder(body: FolderBody, user_email: str = Depends(require_user)):
    conn = CL.connect()
    try:
        node_id = CL.create_node(
            conn, user_email, kind="folder", title=body.name, parent_id=body.parentId
        )
        conn.commit()
        row = CL.get_node(conn, user_email, node_id)
        return {"node": CL.node_to_public(row)}
    except ValueError as error:
        raise HTTPException(400, str(error))
    finally:
        conn.close()


@router.post("/items")
def create_item(body: ItemBody, user_email: str = Depends(require_user)):
    conn = CL.connect()
    try:
        existing = CL.find_link(conn, user_email, body.source, body.refId)
        if existing:
            return {"node": CL.node_to_public(existing), "alreadySaved": True}
        node_id = CL.create_node(
            conn, user_email, kind="link", title=body.title,
            parent_id=body.parentId, source=body.source, ref_id=body.refId,
            href=body.href, meta={"savedFrom": "reader"},
        )
        conn.commit()
        row = CL.get_node(conn, user_email, node_id)
        return {"node": CL.node_to_public(row), "alreadySaved": False}
    except ValueError as error:
        raise HTTPException(400, str(error))
    finally:
        conn.close()


@router.post("/docs")
def create_doc(body: DocBody, user_email: str = Depends(require_user)):
    conn = CL.connect()
    try:
        node_id = CL.create_node(
            conn, user_email, kind="doc", title=body.title,
            parent_id=body.parentId, body_html=CL.sanitize_doc_html(body.bodyHtml),
            meta={"origin": "note"},
        )
        conn.commit()
        row = CL.get_node(conn, user_email, node_id)
        return {"node": CL.node_to_public(row)}
    except ValueError as error:
        raise HTTPException(400, str(error))
    finally:
        conn.close()


@router.get("/nodes/{node_id}")
def get_node(node_id: str, user_email: str = Depends(require_user)):
    conn = CL.connect()
    try:
        row = CL.get_node(conn, user_email, node_id)
        if not row:
            raise HTTPException(404, "Node not found")
        return {"node": CL.node_to_public(row, include_body=True)}
    finally:
        conn.close()


@router.patch("/nodes/{node_id}")
def patch_node(node_id: str, body: NodeUpdate, user_email: str = Depends(require_user)):
    conn = CL.connect()
    try:
        payload = body.model_dump(exclude_unset=True)
        updated = CL.update_node(
            conn, user_email, node_id,
            title=payload.get("title"),
            parent_id=payload.get("parentId"),
            has_parent_field=bool(payload.get("hasParentField")),
            position=payload.get("position"),
            body_html=(
                CL.sanitize_doc_html(payload["bodyHtml"])
                if payload.get("bodyHtml") is not None
                else None
            ),
            href=payload.get("href"),
        )
        if not updated:
            raise HTTPException(404, "Node not found")
        conn.commit()
        row = CL.get_node(conn, user_email, node_id)
        return {"ok": True, "node": CL.node_to_public(row)}
    except ValueError as error:
        raise HTTPException(400, str(error))
    finally:
        conn.close()


@router.delete("/nodes/{node_id}")
def delete_node(node_id: str, user_email: str = Depends(require_user)):
    conn = CL.connect()
    try:
        removed = CL.delete_node(conn, user_email, node_id)
        conn.commit()
        if not removed:
            raise HTTPException(404, "Node not found")
        return {"ok": True, "removed": removed}
    finally:
        conn.close()


# ─── Editable copies ────────────────────────────────────────────────────────

@router.post("/copy")
def make_copy(body: CopyBody, user_email: str = Depends(require_user)):
    """Create (or reopen) a private editable copy of one vendor article."""
    conn = CL.connect()
    try:
        existing = CL.find_copy(conn, user_email, body.source, body.refId)
        if existing:
            return {"node": CL.node_to_public(existing, include_body=True), "created": False}

        title, body_html, origin_href = CL.extract_source_article(body.source, body.refId)
        copy_title = (body.title or title).strip() or "Untitled copy"
        node_id = CL.create_node(
            conn, user_email, kind="doc", title=f"{copy_title} (editable copy)",
            parent_id=body.parentId, body_html=CL.sanitize_doc_html(body_html),
            meta={
                "origin": "copy",
                "originSource": body.source,
                "originRefId": str(body.refId),
                "originHref": origin_href,
            },
        )
        conn.commit()
        row = CL.get_node(conn, user_email, node_id)
        return {"node": CL.node_to_public(row, include_body=True), "created": True}
    except ValueError as error:
        raise HTTPException(400, str(error))
    except Exception as error:  # vendor decryption / lookup problems
        raise HTTPException(500, f"Could not create a copy: {error}")
    finally:
        conn.close()


# ─── Images ─────────────────────────────────────────────────────────────────

@router.post("/images")
async def upload_image(
    file: UploadFile = File(...),
    user_email: str = Depends(require_user),
):
    data = await file.read()
    conn = CL.connect()
    try:
        image_id = CL.save_image(
            conn, user_email, file.filename or "image", file.content_type or "image/png", data
        )
        conn.commit()
        return {"id": image_id, "url": f"/api/custom/images/{image_id}"}
    except ValueError as error:
        raise HTTPException(400, str(error))
    finally:
        conn.close()


@router.get("/images/{image_id}")
def image(image_id: str, user_email: str = Depends(require_user)):
    conn = CL.connect()
    try:
        row = CL.get_image(conn, image_id)
        if not row or row["user_email"] != user_email:
            raise HTTPException(404, "Image not found")
        return Response(
            content=bytes(row["data"]),
            media_type=row["mime"] or "application/octet-stream",
            headers={"Cache-Control": "public, max-age=31536000, immutable"},
        )
    finally:
        conn.close()


# ─── Annotations ────────────────────────────────────────────────────────────

@router.get("/annotations")
def get_annotations(
    source: str = Query(...),
    ref_id: str = Query(...),
    user_email: str = Depends(require_user),
):
    conn = CL.connect()
    try:
        return {"annotations": CL.list_annotations(conn, user_email, source, ref_id)}
    finally:
        conn.close()


@router.post("/annotations")
def post_annotation(body: AnnotationBody, user_email: str = Depends(require_user)):
    conn = CL.connect()
    try:
        annotation_id = CL.create_annotation(
            conn, user_email,
            source=body.source, ref_id=body.refId, quote=body.quote,
            prefix=body.prefix, suffix=body.suffix, start=body.start, end=body.end,
            color=body.color, note=body.note,
        )
        conn.commit()
        rows = CL.list_annotations(conn, user_email, body.source, body.refId)
        created = next((a for a in rows if a["id"] == annotation_id), None)
        return {"annotation": created}
    finally:
        conn.close()


@router.patch("/annotations/{annotation_id}")
def patch_annotation(
    annotation_id: str, body: AnnotationUpdate, user_email: str = Depends(require_user)
):
    conn = CL.connect()
    try:
        ok = CL.update_annotation(
            conn, user_email, annotation_id, color=body.color, note=body.note
        )
        conn.commit()
        if not ok:
            raise HTTPException(404, "Annotation not found")
        return {"ok": True}
    finally:
        conn.close()


@router.delete("/annotations/{annotation_id}")
def remove_annotation(annotation_id: str, user_email: str = Depends(require_user)):
    conn = CL.connect()
    try:
        ok = CL.delete_annotation(conn, user_email, annotation_id)
        conn.commit()
        if not ok:
            raise HTTPException(404, "Annotation not found")
        return {"ok": True}
    finally:
        conn.close()
