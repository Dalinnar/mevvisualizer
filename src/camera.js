const { mat4, vec3 } = glMatrix;

export class InteractiveCanvas {
  constructor(canvas, onRender, center = null, viewDist = 4) {
    this.xRotation = 0.8;
    this.yRotation = 0.5;
    this.onRender = onRender;
    this.center = center || [0, 0, 0];
    this.viewDist = viewDist;
    this.canvas = canvas;
    this.keys = {};
    this.movementSpeed = 0.1;
    this.isAnimating = false;
    this.animationFrameId = null;
    
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
    
    this._onKeyDown = e => {
      this.keys[e.key.toLowerCase()] = true;
      this.startAnimation();
    };
    
    this._onKeyUp = e => {
      this.keys[e.key.toLowerCase()] = false;
    };

    canvas.addEventListener('mousedown', this._onMouseDown);
    canvas.addEventListener('mousemove', this._onMouseMove);
    canvas.addEventListener('mouseup', this._onMouseUp);
    canvas.addEventListener('wheel', this._onWheel);
    document.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('keyup', this._onKeyUp);

    this.redraw();
  }

  destroy() {
    this.canvas.removeEventListener('mousedown', this._onMouseDown);
    this.canvas.removeEventListener('mousemove', this._onMouseMove);
    this.canvas.removeEventListener('mouseup', this._onMouseUp);
    this.canvas.removeEventListener('wheel', this._onWheel);
    document.removeEventListener('keydown', this._onKeyDown);
    document.removeEventListener('keyup', this._onKeyUp);
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
    this.onRender = () => { };
  }

  startAnimation() {
    if (this.isAnimating) return;
    this.isAnimating = true;
    this.animate();
  }

  stopAnimation() {
    this.isAnimating = false;
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  animate() {
    // Check if any movement keys are pressed
    const hasMovement = this.keys['w'] || this.keys['a'] || this.keys['s'] || this.keys['d'] || 
                        this.keys[' '] || this.keys['shift'];
    
    if (!hasMovement) {
      this.stopAnimation();
      return;
    }

    this.render();
    this.animationFrameId = requestAnimationFrame(() => this.animate());
  }

  redraw() {
    requestAnimationFrame(() => this.render());
  }

  render() {
    this.yRotation %= Math.PI * 2;
    this.xRotation = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.xRotation));
    this.viewDist = Math.max(1, this.viewDist);

    // Handle WASD movement relative to camera view
    const movement = vec3.create();
    const speed = this.movementSpeed;

    // Forward/Back (W/S) - along camera's forward axis (negative Z in camera space)
    if (this.keys['w']) movement[2] -= speed;
    if (this.keys['s']) movement[2] += speed;

    // Left/Right (A/D) - along camera's right axis (X in camera space)
    if (this.keys['a']) movement[0] -= speed;
    if (this.keys['d']) movement[0] += speed;

    // Up/Down (Space/Shift) - along camera's up axis (Y in camera space)
    if (this.keys[' ']) movement[1] += speed;
    if (this.keys['shift']) movement[1] -= speed;

    // Transform movement vector to world space relative to camera rotation
    if (movement[0] !== 0 || movement[1] !== 0 || movement[2] !== 0) {
      // Create inverse rotation matrix (apply rotations in REVERSE order with negated angles)
      const rotationMatrix = mat4.create();
      mat4.rotateY(rotationMatrix, rotationMatrix, -this.yRotation);
      mat4.rotateX(rotationMatrix, rotationMatrix, -this.xRotation);

      // Transform movement to world space
      vec3.transformMat4(movement, movement, rotationMatrix);

      // Apply movement to center
      this.center[0] += movement[0];
      this.center[1] += movement[1];
      this.center[2] += movement[2];
    }

    const view = mat4.create();
    mat4.translate(view, view, [0, 0, -this.viewDist]);
    mat4.rotate(view, view, this.xRotation, [1, 0, 0]);
    mat4.rotate(view, view, this.yRotation, [0, 1, 0]);
    mat4.translate(view, view, [-this.center[0], -this.center[1], -this.center[2]]);

    this.onRender(view);
  }
}