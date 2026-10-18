import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const BRIDGE_URL = new URL("./bridge.html", import.meta.url);

/* The bridge tab answers this with "done" once Photopea is loaded, so a tab that
 * outlived the ComfyUI page can say it is ready again. */
const HELLO = "photopea-bridge:hello";

/* Photopea answers a script with every file and string it produces, then "done".
 * If it ever stays quiet we drop the request so the queue keeps moving. */
const REPLY_TIMEOUT = 120000;

/* How long to wait for Photopea to say it has finished loading. */
const READY_TIMEOUT = 60000;

/* The layer whose greyscale content the advanced ingest reads. */
const MASK_LAYER = "mask";

/* What Photopea echoes back when it will not hand over what was asked for. */
const REFUSALS = {
  "no-document": "There is no document open in Photopea",
  "no-selection": "Nothing is selected, so the mask is empty",
  "no-mask-layer": `There is no layer named "${MASK_LAYER}", so the mask is empty`,
};

/*
 * Scripts that run inside Photopea. saveToOE() sends the outer environment a
 * binary file, echoToOE() sends it a string, which is how a refusal or a canvas
 * size gets back.
 *
 * Photopea only sends its "done" for a script that runs to the end, so nothing
 * may throw out of one: an escaped exception leaves the caller waiting for an
 * answer that never comes.
 */

const QUERY_CANVAS = `
(function () {
  var doc = app.documents && app.documents.length ? app.activeDocument : null;
  if (!doc) { app.echoToOE("none"); return; }
  var width = doc.width, height = doc.height;
  if (width && typeof width === "object") width = width.value;
  if (height && typeof height === "object") height = height.value;
  app.echoToOE("canvas:" + Math.round(Number(width)) + "x" + Math.round(Number(height)));
})();`;

/* The third argument pastes into the open document; without it Photopea would
 * open the image as a document of its own. */
const OPEN_AS_LAYER = (dataUrl) => `
(function () {
  try {
    app.open("${dataUrl}", null, true);
  } catch (error) {
    app.echoToOE("Photopea would not paste the image: " + error);
  }
})();`;

const RASTERIZE_PASTED = `
(function () {
  try {
    var doc = app.activeDocument;
    if (doc && doc.activeLayer) doc.activeLayer.rasterize();
  } catch (error) {
    app.echoToOE("The pasted image stayed a smart object: " + error);
  }
})();`;

/* The flattened image exactly as the user sees it, mask layer and all. */
const EXPORT_FLAT_IMAGE = `
(function () {
  var doc = app.activeDocument;
  if (!doc) { app.echoToOE("no-document"); return; }
  try {
    doc.saveToOE("png");
  } catch (error) {
    app.echoToOE("Photopea could not export the image: " + error);
  }
})();`;

/* Layers in Photopea are ordered top to bottom, and a group holds its own list.
 * Searching in that order means the top-most match wins. */
const LAYER_TREE = `
  function photopeaFind(layers, wanted, ancestors) {
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      if (wanted(layer)) return { layer: layer, ancestors: ancestors };
      var children = null;
      try { children = layer.layers; } catch (error) { children = null; }
      if (children && children.length) {
        var found = photopeaFind(children, wanted, ancestors.concat([layer]));
        if (found) return found;
      }
    }
    return null;
  }

  function photopeaCollect(layers, into) {
    for (var i = 0; i < layers.length; i++) {
      into.push(layers[i]);
      var children = null;
      try { children = layers[i].layers; } catch (error) { children = null; }
      if (children && children.length) photopeaCollect(children, into);
    }
  }
`;

/* The "ant trail" selection, painted black-and-white onto a layer of its own.
 * Every other layer is hidden for the export, so wherever the new layer lands in
 * the stack, whatever is painted underneath can never leak into the mask. The
 * paint, the hiding and the layer itself are all undone afterwards. */
const EXPORT_SELECTION_MASK = `
(function () {
  ${LAYER_TREE}

  var doc = app.activeDocument;
  if (!doc) { app.echoToOE("no-document"); return; }

  var selection = doc.selection;
  var hasSelection = false;
  try { hasSelection = selection !== null && selection.bounds !== null; } catch (error) { hasSelection = false; }
  if (!hasSelection) { app.echoToOE("no-selection"); return; }

  var temporary = null;
  var saved = [];
  var failure = null;

  try {
    /* Photopea reports every layer as a fresh wrapper, so the layer is found
     * again by a name of its own rather than by identity. */
    var maskName = "ComfyUI mask " + Date.now();
    temporary = doc.artLayers.add();
    temporary.name = maskName;
    temporary.move(doc, ElementPlacement.PLACEATBEGINNING);
    doc.activeLayer = temporary;

    var black = new SolidColor();
    black.rgb.red = 0; black.rgb.green = 0; black.rgb.blue = 0;
    var white = new SolidColor();
    white.rgb.red = 255; white.rgb.green = 255; white.rgb.blue = 255;

    selection.invert();
    selection.fill(black);
    selection.invert();
    selection.fill(white);

    var found = photopeaFind(doc.layers, function (layer) { return String(layer.name) === maskName; }, []);
    if (!found) throw new Error("the new mask layer is not in the document");

    var every = [];
    photopeaCollect(doc.layers, every);
    for (var i = 0; i < every.length; i++) {
      saved.push([every[i], every[i].visible]);
      every[i].visible = false;
    }
    for (var j = 0; j < found.ancestors.length; j++) found.ancestors[j].visible = true;
    found.layer.visible = true;

    doc.saveToOE("png");
  } catch (error) {
    failure = "Photopea could not build the mask: " + error;
  }

  try {
    for (var k = 0; k < saved.length; k++) saved[k][0].visible = saved[k][1];
  } catch (error) {
    failure = failure || ("Photopea left layer visibility changed: " + error);
  }

  try {
    if (temporary) temporary.remove();
  } catch (error) {
    failure = failure || ("Photopea left its mask layer behind: " + error);
  }

  if (failure) app.echoToOE(failure);
})();`;

/* The "Mask" layer alone, on nothing, so its own greyscale and soft edges are
 * what comes out. Every layer's visibility is put back as it was, and the layer
 * is taken even when the user has hidden it. */
const EXPORT_MASK_LAYER = `
(function () {
  ${LAYER_TREE}

  var doc = app.activeDocument;
  if (!doc) { app.echoToOE("no-document"); return; }
  var found = photopeaFind(doc.layers, function (layer) { return String(layer.name).toLowerCase() === "${MASK_LAYER}"; }, []);
  if (!found) { app.echoToOE("no-mask-layer"); return; }

  var every = [];
  photopeaCollect(doc.layers, every);
  var saved = [];
  for (var i = 0; i < every.length; i++) saved.push([every[i], every[i].visible]);

  var failure = null;
  try {
    for (var j = 0; j < every.length; j++) every[j].visible = false;
    for (var k = 0; k < found.ancestors.length; k++) found.ancestors[k].visible = true;
    found.layer.visible = true;
    doc.saveToOE("png");
  } catch (error) {
    failure = "Photopea could not export the Mask layer: " + error;
  }

  try {
    for (var m = 0; m < saved.length; m++) saved[m][0].visible = saved[m][1];
  } catch (error) {
    failure = failure || ("Photopea left layer visibility changed: " + error);
  }

  if (failure) app.echoToOE(failure);
})();`;

/* The flattened image without the "Mask" layer, so the paint that makes the
 * mask does not show up in the picture. */
const EXPORT_IMAGE_WITHOUT_MASK_LAYER = `
(function () {
  ${LAYER_TREE}

  var doc = app.activeDocument;
  if (!doc) { app.echoToOE("no-document"); return; }
  var found = photopeaFind(doc.layers, function (layer) { return String(layer.name).toLowerCase() === "${MASK_LAYER}"; }, []);

  var wasVisible = null;
  var failure = null;
  try {
    if (found) { wasVisible = found.layer.visible; found.layer.visible = false; }
    doc.saveToOE("png");
  } catch (error) {
    failure = "Photopea could not export the image: " + error;
  }

  try {
    if (found) found.layer.visible = wasVisible;
  } catch (error) {
    failure = failure || ("Photopea left the Mask layer hidden: " + error);
  }

  if (failure) app.echoToOE(failure);
})();`;

/**
 * A live postMessage link to the popped out Photopea tab. Photopea handles one
 * script at a time, so sends are queued and each one is resolved by the "done"
 * that closes its replies.
 */
class Photopea {
  constructor(getWindow, matches) {
    this.getWindow = getWindow;
    this.matches = matches;
    this.pending = [];
    this.queue = Promise.resolve();
    this.isReady = false;
    this.readyWait = null;
    this.readyTimer = 0;
    this.listener = (event) => this.receive(event);
    window.addEventListener("message", this.listener);
  }

  dispose() {
    window.removeEventListener("message", this.listener);
    window.clearTimeout(this.readyTimer);
    for (const request of this.pending.splice(0)) {
      window.clearTimeout(request.timer);
      request.reject(new Error("The Photopea editor was closed"));
    }
  }

  markReady() {
    this.isReady = true;
    window.clearTimeout(this.readyTimer);
    this.readyWait?.();
    this.readyWait = null;
  }

  /** Waits for Photopea to say it has loaded. A timeout only fails this one try. */
  waitForReady() {
    if (this.isReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.readyWait = resolve;
      this.readyTimer = window.setTimeout(() => {
        this.readyWait = null;
        reject(new Error("Photopea has not finished loading"));
      }, READY_TIMEOUT);
    });
  }

  receive(event) {
    if (!this.matches(event)) return;
    if (this.pending.length === 0) {
      if (event.data === "done") this.markReady();
      return;
    }
    const request = this.pending[0];
    if (event.data === "done") {
      this.pending.shift();
      window.clearTimeout(request.timer);
      request.resolve(request.responses);
    } else {
      request.responses.push(event.data);
    }
  }

  /** Runs one script, or opens one file; `prepare` may fetch it first. */
  run(message, prepare = null) {
    const next = this.queue
      .then(() => this.waitForReady())
      .then(() => (prepare ? prepare() : message))
      .then((prepared) => this.send(prepared));
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  send(message) {
    return new Promise((resolve, reject) => {
      const request = { resolve, reject, responses: [] };
      request.timer = window.setTimeout(() => {
        this.pending.shift();
        reject(new Error("Photopea stopped answering"));
      }, REPLY_TIMEOUT);
      this.pending.push(request);
      this.getWindow().postMessage(message, "*");
    });
  }
}

/* ---------------------------------------------------- the popped out tab -- */

let detached = null;
let detachedLink = null;
let detachedTimer = null;

/** The bridged Photopea tab, opened and focused when it is not there yet. */
function source() {
  if (detached && !detached.closed) {
    detached.focus();
    return detachedLink;
  }
  const opened = window.open(BRIDGE_URL.href, "comfyui-photopea");
  if (!opened) throw new Error("The browser blocked the Photopea tab");
  detached = opened;
  detachedLink = new Photopea(() => detached, (event) => event.source === detached);
  detached.postMessage(HELLO, window.location.origin);
  detachedTimer = window.setInterval(watchDetached, 1000);
  return detachedLink;
}

/** The tab that is already there, left where it is: the user is coming back to ComfyUI. */
function bridged() {
  if (detached && !detached.closed) return detachedLink;
  throw new Error('Photopea is not open: press "Open Photopea" first');
}

function watchDetached() {
  if (detached && !detached.closed) return;
  window.clearInterval(detachedTimer);
  detachedTimer = null;
  detachedLink?.dispose();
  detachedLink = null;
  detached = null;
}

/* --------------------------------------------------------------- helpers -- */

async function call(path, options) {
  const response = await api.fetchApi(path, options);
  if (!response.ok) throw new Error((await response.text()) || response.statusText);
  return response.json();
}

/** The first complaint Photopea echoed back, or null. */
function complaint(responses) {
  return responses.find((response) => typeof response === "string") ?? null;
}

/** The file a script produced, or null when it refused. */
function produced(responses) {
  return responses.find((response) => response instanceof ArrayBuffer && response.byteLength > 0) ?? null;
}

/** The captured image has to travel to Photopea inside a script, as a data URI. */
function toDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("The image could not be read"));
    reader.readAsDataURL(blob);
  });
}

function toast(severity, summary, detail) {
  app.extensionManager?.toast?.add?.({ severity, summary, detail, life: severity === "error" ? 8000 : 4000 });
}

async function guard(action) {
  try {
    await action();
  } catch (error) {
    console.warn("[photopea]", error);
    toast("error", "Photopea", error.message);
  }
}

/* --------------------------------------------------------------- actions -- */

/** The image this node is holding, or null when it has none yet. */
async function heldImage(node) {
  const response = await api.fetchApi(`/photopea/nodes/${node.id}/send`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("The held image could not be read");
  return {
    blob: await response.blob(),
    width: Number(response.headers.get("X-Image-Width")),
    height: Number(response.headers.get("X-Image-Height")),
  };
}

/** The size of the open document, `{open: false}` for none, or null if unknown. */
async function queryCanvas(link) {
  const reply = complaint(await link.run(QUERY_CANVAS));
  if (reply === "none") return { open: false };
  const match = /^canvas:(\d+)x(\d+)$/.exec(reply ?? "");
  return match ? { open: true, width: Number(match[1]), height: Number(match[2]) } : null;
}

function openInPhotopea() {
  source();
}

async function sendToPhotopea(node) {
  const link = source();
  const held = await heldImage(node);
  if (!held) {
    toast("warn", "Photopea", "Nothing to send yet: connect an image or drop one on this node");
    return;
  }

  const canvas = await queryCanvas(link);
  const fits = canvas?.open && held.width <= canvas.width && held.height <= canvas.height;
  if (!fits) {
    // A file posted on its own always becomes a document of its own.
    await link.run(null, () => held.blob.arrayBuffer());
    toast("success", "Photopea", "Opened the image as a new document");
    return;
  }

  const pasted = complaint(await link.run(OPEN_AS_LAYER(await toDataUrl(held.blob))));
  if (pasted) throw new Error(pasted);
  // A smart object is still usable, so this one only warns.
  const warning = complaint(await link.run(RASTERIZE_PASTED));
  if (warning) console.warn("[photopea]", warning);
  toast("success", "Photopea", "Pasted the image into the open document");
}

async function ingest(node, advanced) {
  const link = bridged();

  // The mask is exported first: it is the only part that depends on the live
  // selection, which the image export gives the user time to change.
  const maskResponses = await link.run(advanced ? EXPORT_MASK_LAYER : EXPORT_SELECTION_MASK);
  const maskNote = complaint(maskResponses);
  if (maskNote && !REFUSALS[maskNote]) throw new Error(maskNote);
  const mask = maskNote ? null : produced(maskResponses);

  const imageResponses = await link.run(advanced ? EXPORT_IMAGE_WITHOUT_MASK_LAYER : EXPORT_FLAT_IMAGE);
  const imageNote = complaint(imageResponses);
  if (imageNote) throw new Error(REFUSALS[imageNote] ?? imageNote);
  const image = produced(imageResponses);
  if (!image) throw new Error("Photopea returned an empty image");

  const form = new FormData();
  form.append("image", new Blob([image], { type: "image/png" }), "image.png");
  if (mask) form.append("mask", new Blob([mask], { type: "image/png" }), "mask.png");
  form.append("mode", advanced ? "layer" : "selection");
  await call(`/photopea/nodes/${node.id}/ingest`, { method: "POST", body: form });

  if (maskNote) toast("warn", "Photopea", REFUSALS[maskNote]);
  else toast("success", "Photopea", "Ingested the image and mask");
}

/** Keeps a dropped image as what this node will send, and previews it. */
async function dropImage(node, files) {
  const file = Array.from(files).find((entry) => entry.type?.startsWith("image/"));
  if (!file) return false;
  const form = new FormData();
  form.append("image", file, file.name);
  await call(`/photopea/nodes/${node.id}/send`, { method: "POST", body: form });
  toast("success", "Photopea", `${file.name} loaded; press "Send to Photopea" when ready`);
  return true;
}

/* ------------------------------------------------------------ extension -- */

function addButtons(node, kind) {
  const created = node.onNodeCreated;
  node.onNodeCreated = function () {
    created?.apply(this, arguments);
    const self = this;
    self.addWidget("button", "Open Photopea", null, () => guard(() => openInPhotopea()));
    if (kind === "SendToPhotopea") {
      self.addWidget("button", "Send to Photopea", null, () => guard(() => sendToPhotopea(self)));
      // Claiming the drag keeps the canvas from turning the drop into a LoadImage node.
      self.onDragOver = (event) => Boolean(event.dataTransfer?.types?.includes("Files"));
      self.onDragDrop = async (event) => {
        try {
          return await dropImage(self, event.dataTransfer?.files ?? []);
        } catch (error) {
          console.warn("[photopea]", error);
          toast("error", "Photopea", error.message);
          return true;
        }
      };
      return;
    }
    self.addWidget("button", "Ingest from Photopea", null, () => guard(() => ingest(self, false)));
    self.addWidget("button", "Ingest from Photopea (Adv.)", null, () => guard(() => ingest(self, true)));
  };
}

app.registerExtension({
  name: "photopea.bridge",

  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name === "SendToPhotopea" || nodeData.name === "PhotopeaMask") addButtons(nodeType.prototype, nodeData.name);
  },
});
