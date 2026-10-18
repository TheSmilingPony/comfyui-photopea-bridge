# comfyui-photopea-bridge
ComfyUI nodes that bridge to a Photopea instance for better inpainting
---
Two Nodes:
### Photopea Mask
Opens Photopea in a new tab (or focuses to it)
Simple - Ingests current canvas as image and selection as mask
Advanced - Ingests current canvas as image, except for any layer named "Mask" to be used as mask (allows user set feathering)

### Send to Photopea
Opens Photopea in a new tab (or focuses to it)
Takes in an input image or loaded image and sends it to bridged Photopea instance (in new canvas if larger)

---
Inspired by https://github.com/yankooliveira/sd-webui-photopea-embed
---
Muck with as you please

https://github.com/Comfy-Org/ComfyUI

https://www.photopea.com/
