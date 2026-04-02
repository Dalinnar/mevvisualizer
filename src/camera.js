const { mat4 } = glMatrix;

export class InteractiveCanvas {
  constructor(canvas, onRender, center = null, viewDist = 4) {
    this.xRotation = 0.8;
    this.yRotation = 0.5;
    this.onRender = onRender;
    this.center = center;
    this.viewDist = viewDist;
    this.canvas = canvas; // store reference
    let dragPos = null;

    this._onMouseDown = e => {
      if (e.button === 0) dragPos = [e.clientX, e.clientY];
    };
    this._onMouseMove = e => {
      if (dragPos) {
        this.yRotation += (e.clientX - dragPos[0]) / 100;
        this.xRotation += (e.clientY - dragPos[1]) / 100;
        dragPos = [e.clientX, e.clientY];
        this.redraw();
      }
    };
    this._onMouseUp = () => dragPos = null;
    this._onWheel = e => {
      e.preventDefault();
      this.viewDist += e.deltaY / 100;
      this.redraw();
    };

    canvas.addEventListener('mousedown', this._onMouseDown);
    canvas.addEventListener('mousemove', this._onMouseMove);
    canvas.addEventListener('mouseup', this._onMouseUp);
    canvas.addEventListener('wheel', this._onWheel);

    this.redraw();
  }

  destroy() {
    this.canvas.removeEventListener('mousedown', this._onMouseDown);
    this.canvas.removeEventListener('mousemove', this._onMouseMove);
    this.canvas.removeEventListener('mouseup', this._onMouseUp);
    this.canvas.removeEventListener('wheel', this._onWheel);
    this.onRender = () => { }; // neutralize any in-flight rAF
  }

  redraw() {
    requestAnimationFrame(() => this.render());
  }

  render() {
    this.yRotation %= Math.PI * 2;
    this.xRotation = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.xRotation));
    this.viewDist = Math.max(1, this.viewDist);

    const view = mat4.create();
    mat4.translate(view, view, [0, 0, -this.viewDist]);
    mat4.rotate(view, view, this.xRotation, [1, 0, 0]);
    mat4.rotate(view, view, this.yRotation, [0, 1, 0]);

    if (this.center) {
      mat4.translate(view, view, [-this.center[0], -this.center[1], -this.center[2]]);
    }
    this.onRender(view);
  }
}
