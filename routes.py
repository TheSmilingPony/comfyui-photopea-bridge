"""HTTP API for transferring images and masks between Photopea and ComfyUI nodes."""

from aiohttp import web

from server import PromptServer

from . import nodes

routes = PromptServer.instance.routes


def _error(status, message):
    return web.json_response({"error": message}, status=status)


def _notify_previews(node_id, images):
    PromptServer.instance.send_sync("executed", {"node": node_id, "display_node": node_id, "output": {"images": images}})


@routes.post("/photopea/nodes/{node_id}/send")
async def upload_send_image(request):
    node_id = request.match_info["node_id"]
    if not nodes.valid_node_id(node_id):
        return _error(400, "invalid node id")

    data = await request.post()
    image = data.get("image")
    if not hasattr(image, "file"):
        return _error(400, "an image file is required")

    try:
        entry = nodes.store_send_image(node_id, image.file.read())
    except ValueError as error:
        return _error(400, str(error))

    _notify_previews(node_id, [entry["preview"]])
    return web.json_response(entry)


@routes.get("/photopea/nodes/{node_id}/send")
async def get_send_image(request):
    node_id = request.match_info["node_id"]
    entry = nodes.get_send_entry(node_id)
    if entry is None:
        return _error(404, "no image on this node yet")
    return web.FileResponse(
        entry["path"],
        headers={
            "X-Image-Width": str(entry["width"]),
            "X-Image-Height": str(entry["height"]),
        },
    )


@routes.post("/photopea/nodes/{node_id}/ingest")
async def ingest_from_photopea(request):
    node_id = request.match_info["node_id"]
    if not nodes.valid_node_id(node_id):
        return _error(400, "invalid node id")

    data = await request.post()
    image = data.get("image")
    if not hasattr(image, "file"):
        return _error(400, "an image file is required")

    mask = data.get("mask")
    mode = data.get("mode", "selection")
    try:
        entry = nodes.store_ingested_mask(
            node_id,
            image.file.read(),
            mask.file.read() if hasattr(mask, "file") else None,
            binary=(mode != "layer"),
        )
    except ValueError as error:
        return _error(400, str(error))

    _notify_previews(node_id, entry["previews"])
    return web.json_response(entry)
