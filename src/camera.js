const { mat4 } = glMatrix;

export class InteractiveCanvas {
  constructor(canvas, onRender, center = null, viewDist = 4) {
    this.xRotation = 0.8;
    this.yRotation = 0.5;
    this.onRender = onRender;
    this.center = center;
    this.viewDist = viewDist;
    let dragPos = null;

    canvas.addEventListener('mousedown', e => {
      if (e.button === 0) dragPos = [e.clientX, e.clientY];
    });

    canvas.addEventListener('mousemove', e => {
      if (dragPos) {
        this.yRotation += (e.clientX - dragPos[0]) / 100;
        this.xRotation += (e.clientY - dragPos[1]) / 100;
        dragPos = [e.clientX, e.clientY];
        this.redraw();
      }
    });

    canvas.addEventListener('mouseup', () => dragPos = null);

    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      this.viewDist += e.deltaY / 100;
      this.redraw();
    });

    this.redraw();
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
