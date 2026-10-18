"""Simple bridge nodes between ComfyUI and Photopea for inpainting workflows."""

from . import routes
from .nodes import PhotopeaMask, SendToPhotopea

WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {
    "PhotopeaMask": PhotopeaMask,
    "SendToPhotopea": SendToPhotopea,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PhotopeaMask": "Photopea Mask",
    "SendToPhotopea": "Send to Photopea",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
