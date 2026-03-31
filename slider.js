class DoubleRangeSlider {
  constructor(container, options = {}) {
    this.container = typeof container === 'string' ? document.getElementById(container) : container;
    this.min = options.min || 0;
    this.max = options.max || 100;
    this.currentMin = options.currentMin ?? this.min;
    this.currentMax = options.currentMax ?? this.max;
    this.onChange = options.onChange || (() => { });

    this.isDraggingMin = false;
    this.isDraggingMax = false;

    this.build();
    this.attachEvents();
    this.update();
  }

  build() {
    // Clean structure: Label -> Track -> Label
    this.container.classList.add('slider-wrapper');
    this.container.innerHTML = `
      <div class="label-box" id="max-label">${this.currentMax}</div>
      <div class="slider-track" id="track">
        <div class="slider-range" id="range"></div>
        <div class="slider-thumb" id="thumb-max"></div>
        <div class="slider-thumb" id="thumb-min"></div>
      </div>
      <div class="label-box" id="min-label">${this.currentMin}</div>
    `;

    this.track = this.container.querySelector('#track');
    this.range = this.container.querySelector('#range');
    this.thumbMin = this.container.querySelector('#thumb-min');
    this.thumbMax = this.container.querySelector('#thumb-max');
    this.minLabel = this.container.querySelector('#min-label');
    this.maxLabel = this.container.querySelector('#max-label');
  }

  attachEvents() {
    const startDragMin = (e) => {
      e.preventDefault();
      this.isDraggingMin = true;
    };
    const startDragMax = (e) => {
      e.preventDefault();
      this.isDraggingMax = true;
    };

    this.thumbMin.addEventListener('mousedown', startDragMin);
    this.thumbMax.addEventListener('mousedown', startDragMax);

    document.addEventListener('mousemove', (e) => this.handleDrag(e));

    document.addEventListener('mouseup', () => {
      // Stop dragging
      const wasDragging = this.isDraggingMin || this.isDraggingMax;
      this.isDraggingMin = false;
      this.isDraggingMax = false;

      // Trigger onChange only when dragging finished
      if (wasDragging) {
        this.onChange(this.currentMin, this.currentMax);
      }
    });
  }

  handleDrag(e) {
    if (!this.isDraggingMin && !this.isDraggingMax) return;

    const rect = this.track.getBoundingClientRect();
    let percentage = 1 - ((e.clientY - rect.top) / rect.height);
    percentage = Math.max(0, Math.min(1, percentage));

    const value = Math.round(this.min + percentage * (this.max - this.min));

    if (this.isDraggingMin) {
      this.currentMin = Math.min(value, this.currentMax);
    } else if (this.isDraggingMax) {
      this.currentMax = Math.max(value, this.currentMin);
    }

    this.update();
    // Removed onChange from here
  }

  update() {
    const total = this.max - this.min;
    let minP = ((this.currentMin - this.min) / total) * 100;
    let maxP = ((this.currentMax - this.min) / total) * 100;

    // If they are equal, slightly offset for display
    if (this.currentMin === this.currentMax) {
      minP -= 1; // thumbMin slightly below
      maxP += 1; // thumbMax slightly above
    }

    // UI positions
    this.thumbMin.style.bottom = `${minP}%`;
    this.thumbMax.style.bottom = `${maxP}%`;

    this.range.style.bottom = `${minP}%`;
    this.range.style.height = `${maxP - minP}%`;

    // Only update labels if user is NOT editing
    if (document.activeElement !== this.minLabel) {
      this.minLabel.textContent = this.currentMin;
    }
    if (document.activeElement !== this.maxLabel) {
      this.maxLabel.textContent = this.currentMax;
    }
  }

  attachEvents() {
    // Dragging thumbs (same as before)
    const startDragMin = (e) => {
      e.preventDefault();
      this.isDraggingMin = true;
    };
    const startDragMax = (e) => {
      e.preventDefault();
      this.isDraggingMax = true;
    };

    this.thumbMin.addEventListener('mousedown', startDragMin);
    this.thumbMax.addEventListener('mousedown', startDragMax);

    document.addEventListener('mousemove', (e) => this.handleDrag(e));
    document.addEventListener('mouseup', () => {
      const wasDragging = this.isDraggingMin || this.isDraggingMax;
      this.isDraggingMin = false;
      this.isDraggingMax = false;
      if (wasDragging) this.onChange(this.currentMin, this.currentMax);
    });

    // Make labels editable
    this.minLabel.contentEditable = true;
    this.maxLabel.contentEditable = true;

    const handleLabelChange = (label, isMin) => {
      const value = parseInt(label.textContent);
      if (!isNaN(value)) {
        if (isMin) this.currentMin = Math.min(Math.max(this.min, value), this.currentMax);
        else this.currentMax = Math.max(Math.min(this.max, value), this.currentMin);
        this.update();
        this.onChange(this.currentMin, this.currentMax);
      } else {
        label.textContent = isMin ? this.currentMin : this.currentMax;
      }
    };

    this.minLabel.addEventListener('blur', () => handleLabelChange(this.minLabel, true));
    this.maxLabel.addEventListener('blur', () => handleLabelChange(this.maxLabel, false));

    const handleEnter = (e, label) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        label.blur(); // triggers blur handler
      }
    };

    this.minLabel.addEventListener('keydown', (e) => handleEnter(e, this.minLabel));
    this.maxLabel.addEventListener('keydown', (e) => handleEnter(e, this.maxLabel));
  }
}