"""ComfyUI nodes for sending images to Photopea and ingesting edited images and masks."""

import io
import os
import re
import threading

import folder_paths
import numpy as np
import torch
from PIL import Image, ImageOps

NODE_ID_RE = re.compile(r"[A-Za-z0-9_:-]{1,64}")

_LOCK = threading.RLock()
_SEND_STATE = {}
_MASK_STATE = {}


class SendToPhotopea:
    """Previews an input or dropped image and holds it ready to send to Photopea."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {"image": ("IMAGE",)},
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ()
    FUNCTION = "preview"
    CATEGORY = "photopea"
    OUTPUT_NODE = True

    def preview(self, image=None, unique_id="default"):
        node_id = _normalize_node_id(unique_id)
        if image is None:
            entry = get_send_entry(node_id)
            return {"ui": {"images": [entry["preview"]] if entry else []}}
        return {"ui": {"images": [store_send_image(node_id, _encode_tensor_image(image))["preview"]]}}


class PhotopeaMask:
    """Outputs the flattened base image and inpainting mask last ingested from Photopea."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "load"
    CATEGORY = "photopea"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, unique_id="default"):
        entry = get_mask_entry(_normalize_node_id(unique_id))
        if entry is None:
            return float("nan")
        return f"{entry['node_id']}:{entry['revision']}"

    def load(self, unique_id="default"):
        node_id = _normalize_node_id(unique_id)
        entry = get_mask_entry(node_id)
        if entry is None:
            raise ValueError("Photopea Mask has no image ingested from Photopea yet")

        temp_dir = folder_paths.get_temp_directory()
        image_path = os.path.join(temp_dir, entry["image_file"])
        mask_path = os.path.join(temp_dir, entry["mask_file"])
        if not os.path.isfile(image_path) or not os.path.isfile(mask_path):
            raise ValueError("The ingested Photopea files are no longer in the temp directory; ingest again")

        image = _load_image_tensor(image_path)
        mask = _load_mask_tensor(mask_path, image.shape[1], image.shape[2])
        return {"ui": {"images": entry["previews"]}, "result": (image, mask)}


def valid_node_id(node_id):
    return isinstance(node_id, str) and NODE_ID_RE.fullmatch(node_id) is not None


def get_send_entry(node_id):
    with _LOCK:
        if not valid_node_id(node_id):
            return None
        entry = _SEND_STATE.get(node_id)
        if entry is None:
            return None
        path = os.path.join(folder_paths.get_temp_directory(), entry["filename"])
        if not os.path.isfile(path):
            return None
        return dict(entry, path=path)


def store_send_image(node_id, image_bytes):
    with _LOCK:
        if not valid_node_id(node_id):
            raise ValueError("Invalid node id")
        try:
            with Image.open(io.BytesIO(image_bytes)) as opened:
                rgb = ImageOps.exif_transpose(opened).convert("RGB")
                width, height = rgb.size
        except Exception as error:
            raise ValueError(f"Invalid image data: {error}") from error

        previous = _SEND_STATE.get(node_id)
        revision = (previous["revision"] + 1) if previous else 1
        safe_id = _safe_filename_id(node_id)
        filename = f"photopea_send_{safe_id}_v{revision}.png"
        temp_dir = folder_paths.get_temp_directory()
        os.makedirs(temp_dir, exist_ok=True)
        rgb.save(os.path.join(temp_dir, filename), format="PNG")

        if previous and previous["filename"] != filename:
            _remove(os.path.join(temp_dir, previous["filename"]))

        entry = {
            "node_id": node_id,
            "revision": revision,
            "filename": filename,
            "width": width,
            "height": height,
            "preview": {"filename": filename, "subfolder": "", "type": "temp"},
        }
        _SEND_STATE[node_id] = entry
        return dict(entry)


def get_mask_entry(node_id):
    with _LOCK:
        if not valid_node_id(node_id):
            return None
        entry = _MASK_STATE.get(node_id)
        if entry is None:
            return None
        return dict(entry)


def store_ingested_mask(node_id, image_bytes, mask_bytes=None, binary=True):
    with _LOCK:
        if not valid_node_id(node_id):
            raise ValueError("Invalid node id")
        try:
            with Image.open(io.BytesIO(image_bytes)) as opened:
                base_image = ImageOps.exif_transpose(opened).convert("RGB")
                width, height = base_image.size
        except Exception as error:
            raise ValueError(f"Invalid base image data: {error}") from error

        mask_image = _decode_mask_image(mask_bytes, width, height, binary=binary)

        previous = _MASK_STATE.get(node_id)
        revision = (previous["revision"] + 1) if previous else 1
        safe_id = _safe_filename_id(node_id)
        image_filename = f"photopea_mask_{safe_id}_v{revision}.png"
        mask_filename = f"photopea_mask_{safe_id}_v{revision}.mask.png"

        temp_dir = folder_paths.get_temp_directory()
        os.makedirs(temp_dir, exist_ok=True)
        base_image.save(os.path.join(temp_dir, image_filename), format="PNG")
        mask_image.save(os.path.join(temp_dir, mask_filename), format="PNG")

        if previous:
            if previous["image_file"] != image_filename:
                _remove(os.path.join(temp_dir, previous["image_file"]))
            if previous["mask_file"] != mask_filename:
                _remove(os.path.join(temp_dir, previous["mask_file"]))

        entry = {
            "node_id": node_id,
            "revision": revision,
            "has_mask": mask_bytes is not None,
            "image_file": image_filename,
            "mask_file": mask_filename,
            "previews": [
                {"filename": image_filename, "subfolder": "", "type": "temp"},
                {"filename": mask_filename, "subfolder": "", "type": "temp"},
            ],
        }
        _MASK_STATE[node_id] = entry
        return dict(entry)


def _normalize_node_id(unique_id):
    text = str(unique_id) if unique_id is not None else "default"
    return text if valid_node_id(text) else "default"


def _safe_filename_id(node_id):
    return re.sub(r"[^A-Za-z0-9_-]", "_", node_id)


def _encode_tensor_image(image):
    buffer = io.BytesIO()
    array = np.clip(255.0 * image[0].cpu().numpy(), 0, 255).astype(np.uint8)
    Image.fromarray(array, mode="RGB").save(buffer, format="PNG")
    return buffer.getvalue()


def _decode_mask_image(mask_bytes, width, height, binary):
    if mask_bytes is None:
        return Image.new("L", (width, height), 0)

    try:
        with Image.open(io.BytesIO(mask_bytes)) as opened:
            transposed = ImageOps.exif_transpose(opened)
            if transposed.mode in ("RGBA", "LA") or "transparency" in transposed.info:
                rgba = transposed.convert("RGBA")
                background = Image.new("RGBA", rgba.size, (0, 0, 0, 255))
                background.alpha_composite(rgba)
                transposed = background
            mask_array = np.array(transposed.convert("L"))
    except Exception as error:
        raise ValueError(f"Invalid mask image data: {error}") from error

    if mask_array.shape != (height, width):
        raise ValueError(f"Photopea mask is {mask_array.shape[1]}x{mask_array.shape[0]}, expected {width}x{height}")

    if binary:
        mask_array = np.where(mask_array >= 128, 255, 0).astype(np.uint8)

    return Image.fromarray(mask_array, mode="L")


def _load_image_tensor(path):
    with Image.open(path) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")
        return torch.from_numpy(np.array(image).astype(np.float32) / 255.0)[None,]


def _load_mask_tensor(path, height, width):
    with Image.open(path) as opened:
        mask = np.array(ImageOps.exif_transpose(opened).convert("L"))
    if mask.shape != (height, width):
        raise ValueError(f"Photopea mask is {mask.shape[1]}x{mask.shape[0]}, expected {width}x{height}")
    return torch.from_numpy(mask.astype(np.float32) / 255.0)[None,]


def _remove(path):
    if os.path.isfile(path):
        os.remove(path)
