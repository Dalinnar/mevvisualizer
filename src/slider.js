class DoubleRangeSlider {
  constructor(containerId, options) {
    this.container = document.getElementById(containerId);
    this.min = options.min;
    this.max = options.max;
    this.currentMin = options.currentMin ?? options.min;
    this.currentMax = options.currentMax ?? options.max;
    this.onChange = options.onChange;
    this.render();
  }

  _pct(v) {
    return 100 - ((v - this.min) / (this.max - this.min)) * 100;
  }

  render() {
    const maxPct = this._pct(this.currentMax);
    const minPct = this._pct(this.currentMin);

    this.container.innerHTML = `
      <input class="slider-value-input" id="input-max" type="number" value="${this.currentMax}">
      <div class="slider-track" id="slider-track">
        <div class="slider-track-line"></div>
        <div class="slider-range" id="slider-range" style="top:${maxPct}%;bottom:${100 - minPct}%;"></div>
        <div class="slider-thumb" id="thumb-max" style="top:${maxPct}%;"></div>
        <div class="slider-thumb" id="thumb-min" style="top:${minPct}%;"></div>
      </div>
      <input class="slider-value-input" id="input-min" type="number" value="${this.currentMin}">
    `;

    this._bindDrag('thumb-min', 'min');
    this._bindDrag('thumb-max', 'max');
    this._bindInputs();
  }

  _bindInputs() {
    const inputMin = document.getElementById('input-min');
    const inputMax = document.getElementById('input-max');

    const commit = (which, raw) => {
      let val = parseInt(raw);
      if (isNaN(val)) return;
      val = Math.max(this.min, Math.min(this.max, val));

      if (which === 'min') {
        this.currentMin = Math.min(val, this.currentMax);
        inputMin.value = this.currentMin;
      } else {
        this.currentMax = Math.max(val, this.currentMin);
        inputMax.value = this.currentMax;
      }

      this._update();
      this.onChange(this.currentMin, this.currentMax);
    };

    inputMin.addEventListener('keydown', e => { if (e.key === 'Enter') commit('min', inputMin.value); });
    inputMin.addEventListener('blur', () => commit('min', inputMin.value));
    inputMax.addEventListener('keydown', e => { if (e.key === 'Enter') commit('max', inputMax.value); });
    inputMax.addEventListener('blur', () => commit('max', inputMax.value));
  }

  _bindDrag(thumbId, which) {
    const thumb = document.getElementById(thumbId);

    const onMove = e => {
      const track = document.getElementById('slider-track');
      const rect = track.getBoundingClientRect();
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      let ratio = (clientY - rect.top) / rect.height;
      ratio = Math.max(0, Math.min(1, ratio));
      const rawVal = Math.round(this.max - ratio * (this.max - this.min));

      if (which === 'min') {
        this.currentMin = Math.min(rawVal, this.currentMax);
      } else {
        this.currentMax = Math.max(rawVal, this.currentMin);
      }

      this._update();
    };

    const onUp = () => {
      this.onChange(this.currentMin, this.currentMax);
      
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
    };

    thumb.addEventListener('mousedown', e => {
      e.preventDefault();
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    thumb.addEventListener('touchstart', e => {
      e.preventDefault();
      document.addEventListener('touchmove', onMove);
      document.addEventListener('touchend', onUp);
    });
  }

  _update() {
    const maxPct = this._pct(this.currentMax);
    const minPct = this._pct(this.currentMin);

    const thumbMax = document.getElementById('thumb-max');
    const thumbMin = document.getElementById('thumb-min');

    const overlap = Math.abs(maxPct - minPct) < 15;

    if (overlap) {
      thumbMax.style.top = `calc(${maxPct}% - 8px)`;
      thumbMin.style.top = `calc(${minPct}% + 8px)`;
      thumbMax.classList.add('thumb-offset-max');
      thumbMin.classList.add('thumb-offset-min');
    } else {
      thumbMax.style.top = `${maxPct}%`;
      thumbMin.style.top = `${minPct}%`;
      thumbMax.classList.remove('thumb-offset-max');
      thumbMin.classList.remove('thumb-offset-min');
    }

    document.getElementById('slider-range').style.top = `${maxPct}%`;
    document.getElementById('slider-range').style.bottom = `${100 - minPct}%`;
    document.getElementById('input-min').value = this.currentMin;
    document.getElementById('input-max').value = this.currentMax;
  }

  setRange(min, max) {
    this.min = min;
    this.max = max;
    this.currentMin = min;
    this.currentMax = max;
    this.render();
  }
}

export { DoubleRangeSlider };