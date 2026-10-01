/**
 * Seitenansicht: Canvas + Ebene, Koordinatenumrechnung Client <-> Ebene <-> PDF.
 */

export class PageView {
  constructor(key) {
    this.key = key;
    this.el = document.createElement('div');
    this.el.className = 'page';
    this.el.dataset.key = key;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pc';
    this.layer = document.createElement('div');
    this.layer.className = 'layer';
    this.el.append(this.canvas, this.layer);
    this.index = -1;
    this.info = null;
    this.scale = 1;
    this.sig = null;
    this.rendered = null;
    this.visible = false;
    this.bitmaps = [];
  }
  setGeometry(info, scale) {
    this.info = info;
    this.scale = scale;
    const width = info.w * scale;
    const height = info.h * scale;
    const rotation = ((info.rotate % 360) + 360) % 360;
    this.rot = rotation;
    const displayWidth = rotation % 180 ? height : width;
    const displayHeight = rotation % 180 ? width : height;
    this.dw = displayWidth;
    this.dh = displayHeight;
    this.W = width;
    this.H = height;
    this.el.style.width = displayWidth + 'px';
    this.el.style.height = displayHeight + 'px';
    this.layer.style.width = width + 'px';
    this.layer.style.height = height + 'px';
    this.layer.style.transform =
      rotation === 90
        ? `rotate(90deg) translate(0,${-height}px)`
        : rotation === 180
          ? `rotate(180deg) translate(${-width}px,${-height}px)`
          : rotation === 270
            ? `rotate(270deg) translate(${-width}px,0)`
            : '';
  }
  pdfToLayer(x, y) {
    return [(x - this.info.x) * this.scale, (this.info.y + this.info.h - y) * this.scale];
  }
  layerToPdf(x, y) {
    return [this.info.x + x / this.scale, this.info.y + this.info.h - y / this.scale];
  }
  clientToLayer(clientX, clientY) {
    const rect = this.el.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const width = this.W;
    const height = this.H;
    switch (this.rot) {
      case 90:
        return [y, height - x];
      case 180:
        return [width - x, height - y];
      case 270:
        return [width - y, x];
      default:
        return [x, y];
    }
  }
  layerToClient(x, y) {
    const rect = this.el.getBoundingClientRect();
    const width = this.W;
    const height = this.H;
    let dx;
    let dy;
    switch (this.rot) {
      case 90:
        dx = height - y;
        dy = x;
        break;
      case 180:
        dx = width - x;
        dy = height - y;
        break;
      case 270:
        dx = y;
        dy = width - x;
        break;
      default:
        dx = x;
        dy = y;
    }
    return [rect.left + dx, rect.top + dy];
  }
  clientDeltaToLayer(dx, dy) {
    switch (this.rot) {
      case 90:
        return [dy, -dx];
      case 180:
        return [-dx, -dy];
      case 270:
        return [-dy, dx];
      default:
        return [dx, dy];
    }
  }
  clientToLayerRect(rect) {
    const topLeft = this.clientToLayer(rect.left, rect.top);
    const bottomRight = this.clientToLayer(rect.right, rect.bottom);
    return [
      Math.min(topLeft[0], bottomRight[0]),
      Math.min(topLeft[1], bottomRight[1]),
      Math.max(topLeft[0], bottomRight[0]),
      Math.max(topLeft[1], bottomRight[1]),
    ];
  }
  clientToPdf(clientX, clientY) {
    const [x, y] = this.clientToLayer(clientX, clientY);
    return this.layerToPdf(x, y);
  }
  boxOf(bbox) {
    const [left, top] = this.pdfToLayer(bbox[0], bbox[3]);
    const [right, bottom] = this.pdfToLayer(bbox[2], bbox[1]);
    return { left, top, width: right - left, height: bottom - top };
  }
  remember(sig, scale) {
    const canvas = document.createElement('canvas');
    canvas.width = this.canvas.width;
    canvas.height = this.canvas.height;
    canvas.getContext('2d').drawImage(this.canvas, 0, 0);
    this.bitmaps = [{ sig, scale, canvas }, ...this.bitmaps.filter((bitmap) => bitmap.sig !== sig)].slice(
      0,
      2,
    );
  }
  restoreFrom(sig, scale) {
    const cached = this.bitmaps.find((bitmap) => bitmap.sig === sig && bitmap.scale === scale);
    return cached
      ? ((this.canvas.width = cached.canvas.width),
        (this.canvas.height = cached.canvas.height),
        this.canvas.getContext('2d').drawImage(cached.canvas, 0, 0),
        (this.rendered = { sig, scale }),
        true)
      : false;
  }
}
