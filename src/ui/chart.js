/**
 * Memory timeline chart.
 *
 * Two views over the same session:
 *
 *   total      — one line per device, for comparing devices against each other
 *   breakdown  — a stacked area of where the memory actually is, per device
 *
 * The breakdown is the one a developer needs. Unity's Memory Profiler shows
 * everything at once, which is powerful and hard to read; this deliberately
 * answers one question — *what is holding the most memory at this instant* — by
 * stacking the categories and sorting every readout largest-first.
 *
 * Categories come from `dumpsys meminfo`'s App Summary, which is authoritative:
 * the seven values sum to total PSS, so the stack height is the real number
 * rather than an approximation.
 *
 * Canvas rather than a charting library: a session runs for tens of minutes at
 * 1 Hz across two devices, and this has to stay responsive while the analysis
 * server is busy. It also keeps the console dependency-free, which matters on a
 * test bench with no network.
 */
(function () {
  const MB = 1024 * 1024;

  /**
   * Stack order, bottom to top.
   *
   * Deliberately not alphabetical: the largest and most stable categories sit at
   * the bottom so the bands above them do not wobble, which is what makes growth
   * in a smaller category visible at all.
   */
  const CATEGORIES = [
    { key: 'nativeHeap', label: 'Native Heap', varName: '--cat-native' },
    { key: 'graphics', label: 'Graphics', varName: '--cat-graphics' },
    { key: 'code', label: 'Code', varName: '--cat-code' },
    { key: 'javaHeap', label: 'Java Heap', varName: '--cat-java' },
    { key: 'stack', label: 'Stack', varName: '--cat-stack' },
    { key: 'privateOther', label: 'Private Other', varName: '--cat-other' },
    { key: 'system', label: 'System', varName: '--cat-system' },
  ];

  const PAD = { left: 58, right: 14, top: 16, bottom: 28 };

  /**
   * How close the app has to get to device RAM before the ceiling is worth
   * putting on the axis. At 2.5x the peak the headroom still reads clearly; much
   * beyond that and the app's own curve becomes a flat line at the bottom.
   */
  const RAM_SCALE_LIMIT = 2.5;

  /**
   * A colour with an alpha applied, whatever notation the theme used.
   *
   * Theme values arrive as whatever the stylesheet wrote - `#4f9cf9`, or an
   * `rgb()` triple - so a gradient stop cannot just append two hex digits and
   * hope. Anything unrecognised falls back to the colour unchanged, which loses
   * the fade but never paints something invalid and blanks the chart.
   */
  function withAlpha(color, alpha) {
    const value = String(color).trim();
    // An empty value would be an invalid fillStyle, which paints nothing and
    // leaves a blank chart rather than an unfaded one.
    if (!value) return `rgba(79, 156, 249, ${alpha})`;

    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
    if (hex) {
      const h = hex[1];
      const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
      const r = parseInt(full.slice(0, 2), 16);
      const g = parseInt(full.slice(2, 4), 16);
      const b = parseInt(full.slice(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    const rgb = /^rgba?\(([^)]+)\)$/i.exec(value);
    if (rgb) {
      const parts = rgb[1].split(',').map((p) => p.trim());
      if (parts.length >= 3) return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
    }

    return value;
  }

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function fmt(bytes) {
    if (bytes == null) return '—';
    const abs = Math.abs(bytes);
    if (abs >= 1024 * MB) return `${(bytes / (1024 * MB)).toFixed(2)} GB`;
    if (abs >= MB) return `${Math.round(bytes / MB)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
  }

  function formatClock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }

  /** Nice round axis maximum, so gridlines land on readable numbers. */
  function axisMax(peak) {
    const mb = Math.max(peak / MB, 64);
    const step = mb > 4000 ? 1000 : mb > 2000 ? 500 : mb > 800 ? 200 : mb > 400 ? 100 : 50;
    return Math.ceil((mb * 1.1) / step) * step * MB;
  }

  /**
   * Draw one device's timeline.
   *
   * Returns the readout for the hovered instant, so the caller can render it as
   * HTML rather than having it painted into the bitmap — selectable text, and it
   * survives a redraw.
   */
  function draw(canvas, opts) {
    const {
      mode = 'breakdown',
      stacks = [],
      line = [],
      events = [],
      deviceRamBytes = null,
      hoverX = null,
      durationMs = 0,
      memoryEvents = [],
      selectedEvent = null,
    } = opts;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight || 240;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const grid = cssVar('--border', '#2a323d');
    const muted = cssVar('--muted', '#8b98a5');
    const bad = cssVar('--bad', '#f85149');
    const text = cssVar('--text', '#e6edf3');

    const usable = mode === 'breakdown' ? stacks : line;
    if (usable.length === 0) {
      ctx.fillStyle = muted;
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText(
        mode === 'breakdown'
          ? 'Waiting for the detailed breakdown (sampled every few seconds)…'
          : 'Waiting for telemetry…',
        PAD.left,
        height / 2,
      );
      return null;
    }

    const plotW = width - PAD.left - PAD.right;
    const plotH = height - PAD.top - PAD.bottom;

    const maxT = Math.max(durationMs, ...usable.map((p) => p.elapsedMs), 30_000);
    const peak =
      mode === 'breakdown'
        ? Math.max(...stacks.map((s) => s.total))
        : Math.max(...line.map((p) => p.value));
    /**
     * Include the device RAM ceiling in the scale when the app is anywhere near
     * it, so the remaining headroom is visible - that is exactly the situation
     * worth seeing. When RAM is far above the peak, scaling to it would waste
     * most of the plot and flatten the variation, so the data wins and the
     * reference line is dropped.
     */
    const ramInScope = deviceRamBytes !== null && deviceRamBytes <= peak * RAM_SCALE_LIMIT;
    const maxV = axisMax(ramInScope ? Math.max(peak, deviceRamBytes) : peak);

    const x = (t) => PAD.left + (t / maxT) * plotW;
    const y = (v) => PAD.top + plotH - (v / maxV) * plotH;

    // ---- gridlines and Y axis -------------------------------------------
    ctx.strokeStyle = grid;
    ctx.fillStyle = muted;
    ctx.lineWidth = 1;
    ctx.font = '10.5px ui-monospace, monospace';
    ctx.textAlign = 'right';

    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const value = (maxV / steps) * i;
      const yy = Math.round(y(value)) + 0.5;
      ctx.globalAlpha = i === 0 ? 1 : 0.45;
      ctx.beginPath();
      ctx.moveTo(PAD.left, yy);
      ctx.lineTo(width - PAD.right, yy);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(fmt(value), PAD.left - 8, yy + 3.5);
    }
    ctx.textAlign = 'left';

    // Device RAM reference line, when it fits on the scale. Gives the reader a
    // sense of how close the app is to the hardware limit.
    if (ramInScope && deviceRamBytes <= maxV) {
      const yy = Math.round(y(deviceRamBytes)) + 0.5;
      ctx.strokeStyle = bad;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(PAD.left, yy);
      ctx.lineTo(width - PAD.right, yy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = bad;
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(`device RAM ${fmt(deviceRamBytes)}`, PAD.left + 4, yy - 4);
    }

    // ---- the data --------------------------------------------------------
    if (mode === 'breakdown') drawStack(ctx, stacks, x, y, maxV);
    else drawLine(ctx, line, x, y, cssVar('--accent', '#4f9cf9'));

    // Geometry is stashed so click hit-testing uses exactly what was drawn.
    canvas._oomGeometry = { x, y, maxV, events: memoryEvents, stacks };

    // ---- operator markers ------------------------------------------------
    for (const event of events) {
      if (event.source === 'system' && !String(event.type).startsWith('process')) continue;
      const xx = Math.round(x(event.elapsedMs)) + 0.5;
      if (xx < PAD.left || xx > width - PAD.right) continue;

      const danger = String(event.type).startsWith('process');
      ctx.strokeStyle = danger ? bad : muted;
      ctx.globalAlpha = danger ? 0.9 : 0.5;
      ctx.setLineDash(danger ? [] : [2, 3]);
      ctx.beginPath();
      ctx.moveTo(xx, PAD.top);
      ctx.lineTo(xx, PAD.top + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      ctx.save();
      ctx.translate(xx + 3, PAD.top + 3);
      ctx.rotate(Math.PI / 2);
      ctx.fillStyle = danger ? bad : muted;
      ctx.font = '9.5px system-ui, sans-serif';
      ctx.fillText(String(event.label ?? '').slice(0, 26), 0, 0);
      ctx.restore();
    }

    // ---- the selected instant --------------------------------------------
    // Drawn for any selection, not only for a marked one: a click on empty
    // curve opens the same panel, so it needs the same "you are here" line.
    if (selectedEvent) {
      const sx = Math.round(x(selectedEvent.elapsedMs)) + 0.5;
      if (sx >= PAD.left && sx <= width - PAD.right) {
        ctx.strokeStyle = cssVar('--accent', '#4f9cf9');
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.75;
        ctx.beginPath();
        ctx.moveTo(sx, PAD.top);
        ctx.lineTo(sx, PAD.top + plotH);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // ---- memory events, above everything so they stay clickable ----------
    if (memoryEvents.length > 0) {
      drawEventMarkers(ctx, memoryEvents, x, y, maxV, selectedEvent);
    }

    // ---- X axis ----------------------------------------------------------
    ctx.fillStyle = muted;
    ctx.font = '10.5px ui-monospace, monospace';
    ctx.fillText(formatClock(0), PAD.left, height - 9);
    ctx.textAlign = 'right';
    ctx.fillText(formatClock(maxT), width - PAD.right, height - 9);
    ctx.textAlign = 'left';

    // ---- hover crosshair + readout --------------------------------------
    if (hoverX === null || hoverX < PAD.left || hoverX > width - PAD.right) return null;

    const targetT = ((hoverX - PAD.left) / plotW) * maxT;
    const point = nearest(usable, targetT);
    if (!point) return null;

    const px = Math.round(x(point.elapsedMs)) + 0.5;
    ctx.strokeStyle = text;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.moveTo(px, PAD.top);
    ctx.lineTo(px, PAD.top + plotH);
    ctx.stroke();
    ctx.globalAlpha = 1;

    if (mode === 'breakdown') {
      // Largest first — the whole point of the view.
      const rows = CATEGORIES.map((c) => ({
        label: c.label,
        color: cssVar(c.varName, muted),
        bytes: point.cats[c.key] ?? 0,
      }))
        .filter((r) => r.bytes > 0)
        .sort((a, b) => b.bytes - a.bytes);

      return { elapsedMs: point.elapsedMs, total: point.total, rows };
    }

    return { elapsedMs: point.elapsedMs, total: point.value, rows: [] };
  }

  function drawStack(ctx, stacks, x, y, maxV) {
    // Painted top band first so each fill covers the one beneath it, which means
    // no seams between adjacent areas at any device pixel ratio.
    const cumulative = stacks.map(() => 0);

    for (const category of CATEGORIES) {
      const color = cssVar(category.varName, '#888');

      ctx.beginPath();
      // Upper edge, left to right.
      stacks.forEach((s, i) => {
        cumulative[i] += s.cats[category.key] ?? 0;
        const px = x(s.elapsedMs);
        const py = y(Math.min(cumulative[i], maxV));
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      // Lower edge, right to left — the previous cumulative total.
      for (let i = stacks.length - 1; i >= 0; i--) {
        const below = cumulative[i] - (stacks[i].cats[category.key] ?? 0);
        ctx.lineTo(x(stacks[i].elapsedMs), y(Math.min(below, maxV)));
      }
      ctx.closePath();

      ctx.fillStyle = color;
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // A crisp line on the total, so the overall shape stays readable through the
    // translucent fills.
    ctx.beginPath();
    stacks.forEach((s, i) => {
      const px = x(s.elapsedMs);
      const py = y(Math.min(s.total, maxV));
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.strokeStyle = cssVar('--text', '#e6edf3');
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1.25;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawLine(ctx, points, x, y, color) {
    ctx.beginPath();
    points.forEach((p, i) => {
      const px = x(p.elapsedMs);
      const py = y(p.value);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function nearest(points, targetT) {
    let best = null;
    let bestDelta = Infinity;
    for (const p of points) {
      const delta = Math.abs(p.elapsedMs - targetT);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = p;
      }
    }
    return best;
  }

  /**
   * Turn a deep sample into a stack point.
   *
   * Returns null for fast-tier samples: they carry no category data, and
   * inventing a breakdown from a total would be a fabrication.
   */
  function toStackPoint(sample) {
    const s = sample.summary;
    if (!s) return null;

    const cats = {};
    let total = 0;
    for (const category of CATEGORIES) {
      const value = s[category.key];
      if (typeof value === 'number' && value > 0) {
        cats[category.key] = value;
        total += value;
      }
    }
    if (total === 0) return null;

    return {
      elapsedMs: sample.elapsedMs,
      cats,
      total,
      // Private rather than PSS: the summary categories above are sums of
      // private memory, so a breakdown built from PSS would not add up to them.
      detail: sample.breakdownPrivate ?? null,
      mappings: sample.mappings ?? null,
      engine: sample.engine ?? null,
    };
  }


  // -------------------------------------------------------------------------
  // Memory events on the curve
  // -------------------------------------------------------------------------

  /**
   * What kind of work a step in memory implies.
   *
   * Inferred from *which category* moved, which is the one thing the OS data can
   * honestly tell us. Android reports memory by mapping, not by engine object, so
   * this names the kind of activity - never the specific asset. Attributing a
   * jump to `hero_atlas.png` is the static analysis's job, via correlation.
   */
  const EVENT_KINDS = {
    asset_upload: {
      label: 'Asset upload',
      means: 'Graphics memory grew, which is textures or render targets being uploaded to the GPU.',
      varName: '--cat-graphics',
    },
    content_load: {
      label: 'Content load',
      means:
        'Native heap grew. This is where Unity keeps meshes, decoded audio and most engine ' +
        'allocations, so it is usually a scene or asset bundle loading.',
      varName: '--cat-native',
    },
    code_load: {
      label: 'Code load',
      means: 'Code memory grew, which is native libraries or dex being mapped in.',
      varName: '--cat-code',
    },
    managed_alloc: {
      label: 'Managed allocation',
      means: 'Java heap grew, which is C# on Mono or the Android side of the app allocating.',
      varName: '--cat-java',
    },
    release: {
      label: 'Memory released',
      means: 'Memory went back. Worth checking against what was loaded - a partial release is retention.',
      varName: '--cat-java',
    },
    mixed: {
      label: 'Mixed growth',
      means: 'Several categories grew together, which usually means a scene load doing many things at once.',
      varName: '--cat-other',
    },
  };

  /**
   * Find the points on the curve worth looking at.
   *
   * A step between consecutive deep samples above the threshold. The deep tier is
   * ~0.2 Hz, so a step covers a few seconds of activity rather than one frame -
   * enough to spot a scene load, not enough to blame a single call.
   */
  function detectEvents(stacks, opts = {}) {
    if (stacks.length < 2) return [];

    const minDelta = opts.minDeltaBytes ?? 20 * MB;
    const events = [];

    for (let i = 1; i < stacks.length; i++) {
      const step = buildStep(stacks[i - 1], stacks[i]);
      if (Math.abs(step.delta) < minDelta) continue;
      events.push(step);
    }

    return letterTheBiggest(events, opts.letterCount ?? 6);
  }

  /**
   * Name the biggest jumps A, B, C...
   *
   * Letters are assigned by size, not by time, so A is always the largest jump
   * in the session wherever it happened. That is what makes the letter useful as
   * a reference: the report's table of jumps is ordered the same way, so "look
   * at B" means the same thing on the graph and on the page.
   *
   * Only the largest few get one. Lettering every step would put a dozen badges
   * on the curve and none of them would stand out.
   */
  function letterTheBiggest(events, count) {
    const ranked = [...events]
      .filter((e) => e.delta > 0)
      .sort((a, b) => b.delta - a.delta)
      .slice(0, count);

    ranked.forEach((event, index) => {
      event.letter = String.fromCharCode(65 + index);
    });

    return events;
  }

  /**
   * One step between consecutive deep samples.
   *
   * Shared by event detection and by clicking the curve, so a point the operator
   * picked opens exactly the same panel as a point the tool marked. The only
   * difference is `notable`: a detected event crossed the threshold, a clicked
   * one may not have, and the panel must not describe an ordinary sample as
   * though something happened at it.
   */
  function buildStep(previous, current) {
    const delta = current.total - previous.total;

    // Per-category movement, largest first - this is what names the kind.
    const moved = CATEGORIES.map((c) => ({
      key: c.key,
      label: c.label,
      varName: c.varName,
      delta: (current.cats[c.key] ?? 0) - (previous.cats[c.key] ?? 0),
    }))
      .filter((m) => Math.abs(m.delta) >= 1 * MB)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    return {
      elapsedMs: current.elapsedMs,
      fromMs: previous.elapsedMs,
      total: current.total,
      delta,
      moved,
      kind: classifyEvent(delta, moved),
      // The two samples themselves, so a category can be opened up after the
      // fact without re-deriving which points the step ran between.
      from: previous,
      to: current,
    };
  }

  /**
   * The step under an arbitrary click on the chart.
   *
   * Every deep sample already has everything the detail panel needs; a detected
   * event is just the subset where the change was large enough to be worth a
   * marker. So a click anywhere resolves to the nearest sample and opens the
   * same breakdown - the markers stay as signposts rather than as the only way in.
   *
   * Resolution is by x only. Matching the y position too would make the curve
   * hard to hit, and there is exactly one sample per x anyway.
   */
  function stepAtX(canvas, clientX) {
    const geometry = canvas._oomGeometry;
    const stacks = geometry?.stacks;
    if (!geometry || !stacks || stacks.length < 2) return null;

    const px = clientX - canvas.getBoundingClientRect().left;

    let index = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < stacks.length; i++) {
      const distance = Math.abs(geometry.x(stacks[i].elapsedMs) - px);
      if (distance < bestDistance) {
        bestDistance = distance;
        index = i;
      }
    }
    if (index <= 0) {
      // The first sample has no predecessor, so there is no step to describe;
      // the second one is the earliest that can be opened.
      index = stacks.length > 1 ? 1 : -1;
    }
    if (index < 1) return null;

    // A detected event for this instant is returned as itself, so clicking a
    // marker and clicking beside it do not produce two different objects.
    const existing = (geometry.events ?? []).find(
      (e) => e.elapsedMs === stacks[index].elapsedMs,
    );
    if (existing) return existing;

    return { ...buildStep(stacks[index - 1], stacks[index]), notable: false };
  }

  function classifyEvent(delta, moved) {
    if (delta < 0) return 'release';

    const dominant = moved[0];
    if (!dominant) return 'mixed';

    // One category accounting for most of the growth is attributable; a spread
    // across several is not, and saying so is more useful than guessing.
    const share = Math.abs(dominant.delta) / Math.abs(delta);
    if (share < 0.6) return 'mixed';

    switch (dominant.key) {
      case 'graphics':
        return 'asset_upload';
      case 'nativeHeap':
        return 'content_load';
      case 'code':
        return 'code_load';
      case 'javaHeap':
        return 'managed_alloc';
      default:
        return 'mixed';
    }
  }

  /** Draw a clickable dot per event, on the total line. */
  function drawEventMarkers(ctx, events, x, y, maxV, selected) {
    for (const event of events) {
      const px = x(event.elapsedMs);
      const py = y(Math.min(event.total, maxV));
      const isSelected = selected && selected.elapsedMs === event.elapsedMs;

      const colour = cssVar(EVENT_KINDS[event.kind].varName, '#888');
      // A lettered checkpoint is drawn larger, because it is the one a reader is
      // being pointed at from elsewhere.
      const radius = isSelected ? 7.5 : event.letter ? 6.5 : 4.5;

      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fillStyle = cssVar('--panel', '#161b22');
      ctx.fill();
      ctx.lineWidth = isSelected ? 3 : 2;
      ctx.strokeStyle = colour;
      ctx.stroke();

      if (isSelected) {
        ctx.beginPath();
        ctx.arc(px, py, 2, 0, Math.PI * 2);
        ctx.fillStyle = colour;
        ctx.fill();
      }

      // The letter goes above the point, in a filled badge, so it stays legible
      // over whichever category band happens to be underneath it.
      if (event.letter) {
        const by = Math.max(11, py - radius - 9);
        ctx.beginPath();
        ctx.arc(px, by, 8, 0, Math.PI * 2);
        ctx.fillStyle = colour;
        ctx.fill();

        ctx.fillStyle = cssVar('--panel', '#161b22');
        ctx.font = '700 10px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(event.letter, px, by + 0.5);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
      }
    }
  }

  /**
   * Which event, if any, is under a click.
   *
   * Uses the geometry stashed by the last draw, so hit testing cannot drift out
   * of step with what is on screen.
   */
  function hitTestEvent(canvas, clientX, clientY) {
    const geometry = canvas._oomGeometry;
    if (!geometry) return null;

    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;

    const HIT_RADIUS = 11;
    let best = null;
    let bestDistance = Infinity;

    for (const event of geometry.events) {
      const ex = geometry.x(event.elapsedMs);
      const ey = geometry.y(Math.min(event.total, geometry.maxV));
      const distance = Math.hypot(ex - px, ey - py);
      if (distance < HIT_RADIUS && distance < bestDistance) {
        bestDistance = distance;
        best = event;
      }
    }

    return best;
  }

  function describeEventKind(kind) {
    return EVENT_KINDS[kind] ?? EVENT_KINDS.mixed;
  }

  // -------------------------------------------------------------------------
  // What is inside a category
  // -------------------------------------------------------------------------

  /*
   * An App Summary category is a sum of named rows from the same dumpsys output,
   * so "what is inside Graphics" is a question the OS already answers - it is
   * just never shown. These are the constituent rows, with what each one means
   * for a Unity game, because "Gfx dev" tells a developer nothing and "GPU
   * driver memory: textures and render targets" tells them where to look.
   *
   * The rows are built from *private* memory, because that is what the summary
   * categories are sums of. Using the PSS column here would produce a list that
   * does not add up to the number above it.
   */
  const CATEGORY_DETAIL = {
    graphics: [
      {
        key: 'gfxDev',
        label: 'GPU driver memory',
        means:
          'Textures, render targets and vertex buffers the driver is holding. In a Unity game ' +
          'this is dominated by texture memory: atlas size, mip settings and compression format ' +
          'move this number more than anything else.',
      },
      {
        key: 'eglMtrack',
        label: 'EGL surfaces',
        means:
          'The window surfaces the app draws into - swapchain buffers and any offscreen render ' +
          'targets. Scales with screen resolution and how many RenderTextures are alive.',
      },
      {
        key: 'glMtrack',
        label: 'GL driver objects',
        means:
          'Driver-side objects behind GL handles: shader programs, framebuffer objects and ' +
          'texture views. A large value usually means many shader variants compiled at runtime.',
      },
    ],
    javaHeap: [
      {
        key: 'dalvikHeap',
        label: 'Dalvik heap',
        means:
          'Java objects. In a Unity game this is the Android side: plugins, ad SDKs, analytics ' +
          'and anything reached through AndroidJavaObject - not your C# game objects.',
      },
      {
        key: 'artMmap',
        label: 'ART runtime images (.art)',
        means:
          'The Android runtime’s preloaded class images. Largely fixed cost; it grows with the ' +
          'number of Java classes the app and its SDKs load.',
      },
    ],
    code: [
      {
        key: 'soMmap',
        label: 'Native libraries (.so)',
        means:
          'Mapped native code: libunity.so, libil2cpp.so and every native plugin. IL2CPP builds ' +
          'put your compiled C# here, so it grows with the amount of code actually shipped.',
      },
      {
        key: 'dexMmap',
        label: 'Dex bytecode (.dex)',
        means: 'Java bytecode for the app and its SDKs, mapped from the APK.',
      },
      {
        key: 'oatMmap',
        label: 'Compiled Java (.oat)',
        means: 'Ahead-of-time compiled Java code produced by the device when the app installed.',
      },
      {
        key: 'apkMmap',
        label: 'APK contents (.apk)',
        means:
          'Pages read straight out of the APK. For a Unity game this is where uncompressed ' +
          'assets and any AssetBundles left inside the package are read from.',
      },
      {
        key: 'jarMmap',
        label: 'Jar archives (.jar)',
        means: 'Framework and library archives mapped in by the runtime.',
      },
      {
        key: 'ttfMmap',
        label: 'Fonts (.ttf)',
        means:
          'Mapped font files. Notable only when the game ships large CJK fonts or builds dynamic ' +
          'font atlases.',
      },
    ],
    nativeHeap: [
      {
        key: 'nativeHeap',
        label: 'Native allocations',
        means:
          'Where Unity keeps almost everything it owns: meshes, decoded audio, animation clips, ' +
          'AssetBundle contents and the engine’s own objects. Android reports it as one opaque ' +
          'number, so a jump here means content was loaded, not which content.',
      },
    ],
    stack: [
      {
        key: 'stack',
        label: 'Thread stacks',
        means:
          'One stack per thread. It grows with thread count - job workers, audio, networking - ' +
          'rather than with anything the player did.',
      },
    ],
    privateOther: [
      {
        key: 'ashmem',
        label: 'Shared memory (ashmem)',
        means:
          'Anonymous shared memory. Usually graphics buffers, media codecs, or an SDK’s shared ' +
          'cache; it is memory the app shares with a system process.',
      },
      {
        key: 'otherDev',
        label: 'Other device memory',
        means:
          'Mappings of device nodes other than the GPU - camera, codecs, sensors. Often an ad or ' +
          'video SDK holding a hardware buffer.',
      },
      {
        key: 'otherMmap',
        label: 'Other mapped files',
        means:
          'Mapped files that are not code: on-disk caches, downloaded AssetBundles, save data ' +
          'and anything the game memory-maps itself.',
      },
      {
        key: 'dalvikOther',
        label: 'Dalvik overhead',
        means:
          'The Java runtime’s own bookkeeping - JIT caches, class metadata, GC structures - ' +
          'rather than objects the app allocated.',
      },
      {
        key: 'unknown',
        label: 'Unattributed',
        means:
          'Anonymous memory the kernel could not attribute to a file. For Unity this is usually ' +
          'the native allocator’s arenas: real game memory that the OS simply cannot name.',
      },
    ],
    system: [],
  };

  /** Which mapping kinds belong under which summary category. */
  const CATEGORY_MAPPING_KINDS = {
    graphics: ['graphics'],
    code: ['unity-engine', 'game-code', 'native-library', 'app-package', 'android-runtime'],
    javaHeap: ['java-heap'],
    nativeHeap: ['native-alloc'],
    stack: ['stack'],
    privateOther: ['shared', 'unity-content', 'other'],
    system: [],
  };

  /*
   * Unity's own accounting of its own memory.
   *
   * The OS reports one anonymous mapping for Unity's native allocator, so
   * "Unattributed" is where textures, meshes and audio disappear from view.
   * These figures come from inside the engine, which is the only place that
   * knows how those bytes divide - see scripts/unity/PerformanceShieldReporter.cs.
   *
   * They are shown *beside* the OS rows rather than inside them, because the two
   * accountings overlap and neither contains the other: Unity's texture figure
   * includes GPU-side memory that Android reports under Graphics, and the OS's
   * native-allocator figure includes engine bookkeeping Unity does not attribute
   * to any asset type. Presenting them as a decomposition would be a lie that
   * happens to add up.
   */
  const ENGINE_BUCKETS = [
    {
      key: 'textures',
      label: 'Textures',
      means:
        'Every Texture2D, RenderTexture and sprite atlas the engine currently holds, counting ' +
        'both the CPU copy and the GPU upload. Import settings move this more than anything ' +
        'else: max size, compression format, mip maps and Read/Write Enabled.',
    },
    {
      key: 'meshes',
      label: 'Meshes',
      means:
        'Vertex and index buffers for every loaded Mesh. Read/Write Enabled doubles a mesh, ' +
        'because the engine then keeps a CPU copy alongside the GPU one.',
    },
    {
      key: 'audio',
      label: 'Audio',
      means:
        'Decoded audio and streaming buffers. A clip set to Decompress On Load holds its full ' +
        'PCM size in memory for as long as it is loaded.',
    },
    {
      key: 'shaders',
      label: 'Shaders and materials',
      means:
        'Material instances and the shader variants compiled for them. Grows when materials are ' +
        'instanced at runtime rather than shared.',
    },
    {
      key: 'animation',
      label: 'Animation',
      means: 'AnimationClip data held by the engine.',
    },
    {
      key: 'managedUsed',
      label: 'C# managed heap (in use)',
      means:
        'Your own C# objects. The engine never returns this to the OS once taken, so the ' +
        'reserved figure is the high-water mark rather than the current need.',
    },
  ];

  /**
   * The engine's own totals over one step, ranked by movement.
   *
   * Returns `available: false` rather than zeroes when the build carries no
   * reporter, so the console can explain the absence instead of showing a
   * breakdown that reads as "no textures".
   */
  function explainEngineDelta(fromPoint, toPoint) {
    const before = fromPoint?.engine ?? null;
    const after = toPoint?.engine ?? null;
    if (!after) return { rows: [], available: false, unavailable: [] };

    const rows = ENGINE_BUCKETS.map((b) => ({
      ...b,
      bytes: after[b.key] ?? null,
      delta: typeof after[b.key] === 'number' && typeof before?.[b.key] === 'number'
        ? after[b.key] - before[b.key]
        : 0,
    }))
      .filter((r) => r.bytes !== null)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.bytes - a.bytes);

    return { rows, available: rows.length > 0, unavailable: after.unavailable ?? [] };
  }

  /** What a mapping is, said once, in Unity's vocabulary. */
  const MAPPING_KINDS = {
    'unity-engine': 'The Unity engine itself (libunity.so). A fixed cost of shipping Unity.',
    'game-code':
      'Your game’s own code: C# compiled to native by IL2CPP, or the Mono runtime executing it. ' +
      'It grows with how much code is actually reachable in the build.',
    'unity-content':
      'Unity content on disk being read: AssetBundles, resources files or a downloaded catalogue.',
    'native-library': 'A native plugin or third-party SDK shipped as a shared library.',
    'app-package': 'The APK itself, read in place. Assets stored uncompressed are paged from here.',
    'android-runtime': 'Android runtime files - bytecode, compiled Java and runtime class images.',
    graphics:
      'GPU memory: the driver’s allocations for textures, render targets and buffers, or a ' +
      'shared graphics buffer.',
    'java-heap': 'Java heap regions belonging to the Android runtime.',
    'native-alloc':
      'The native allocator’s arenas. For a Unity game this is where meshes, decoded audio and ' +
      'engine objects live - the single most common place a leak accumulates.',
    stack: 'A thread stack.',
    shared: 'Shared memory with another process.',
    other: 'Not identifiable from the mapping name alone.',
  };

  function describeMappingKind(kind) {
    return MAPPING_KINDS[kind] ?? MAPPING_KINDS.other;
  }

  /**
   * Break one category down into its constituent rows for a single sample.
   *
   * Returns rows plus whatever the rows do not account for, because a breakdown
   * that silently loses memory is worse than no breakdown: it invites the reader
   * to conclude the named rows are the whole story.
   */
  function explainCategory(stackPoint, categoryKey) {
    const spec = CATEGORY_DETAIL[categoryKey] ?? [];
    const detail = stackPoint?.detail ?? null;
    const total = stackPoint?.cats?.[categoryKey] ?? 0;

    if (!detail || spec.length === 0) return { rows: [], total, residual: 0, hasDetail: false };

    const rows = spec
      .map((s) => ({ ...s, bytes: detail[s.key] ?? 0 }))
      .filter((r) => r.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes);

    const accounted = rows.reduce((sum, r) => sum + r.bytes, 0);
    return { rows, total, residual: Math.max(0, total - accounted), hasDetail: rows.length > 0 };
  }

  /**
   * The same breakdown, but as movement between the two ends of an event.
   *
   * This is the question the panel actually asks - "Graphics grew 137 MB, what
   * inside it grew?" - so rows are ranked by how much they moved rather than by
   * how big they are.
   */
  function explainCategoryDelta(fromPoint, toPoint, categoryKey) {
    const spec = CATEGORY_DETAIL[categoryKey] ?? [];
    const before = fromPoint?.detail ?? null;
    const after = toPoint?.detail ?? null;
    if (!before || !after || spec.length === 0) return { rows: [], hasDetail: false };

    const rows = spec
      .map((s) => ({
        ...s,
        bytes: after[s.key] ?? 0,
        delta: (after[s.key] ?? 0) - (before[s.key] ?? 0),
      }))
      .filter((r) => Math.abs(r.delta) >= 512 * 1024 || r.bytes > 0)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    return { rows, hasDetail: rows.length > 0 };
  }

  /**
   * Per-mapping movement inside one category, when smaps was readable.
   *
   * This is the layer that names things: `libil2cpp.so`, `base.apk`,
   * `/dev/kgsl-3d0`. Rows with no movement are kept - a mapping that is large
   * and static is still the answer to "what is holding this memory".
   */
  function explainMappingDelta(fromPoint, toPoint, categoryKey) {
    const kinds = CATEGORY_MAPPING_KINDS[categoryKey] ?? [];
    const after = toPoint?.mappings ?? null;
    if (!after || kinds.length === 0) return { rows: [], available: false };

    const beforeByName = new Map((fromPoint?.mappings ?? []).map((m) => [m.name, m]));

    const rows = after
      .filter((m) => kinds.includes(m.kind))
      .map((m) => ({
        name: m.name,
        kind: m.kind,
        regions: m.regions,
        bytes: m.privateBytes || m.pssBytes,
        delta:
          (m.privateBytes || m.pssBytes) -
          ((beforeByName.get(m.name)?.privateBytes || beforeByName.get(m.name)?.pssBytes) ?? 0),
      }))
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.bytes - a.bytes);

    return { rows, available: true };
  }


  /* ======================================================================
   * Frame rate
   * ======================================================================
   *
   * The memory curve had a chart from the start and the frame rate had a
   * number in the corner, which made a stutter something the operator had to
   * catch as it went past. Both are now drawn on the same time axis, and a drop
   * on one lines up with a jump on the other - which is the single most useful
   * thing this tool can put on screen while a session is still running.
   *
   * Detection here is a preview, not the verdict. `src/analysis/fpsEvents.ts`
   * decides what the report says, using the same thresholds and rather more
   * care; this exists so the operator can see a drop and click it a second
   * after it happened, while the moment is still worth marking. Where they
   * disagree, the report is right. (The memory chart does the same thing for
   * spikes, for the same reason.)
   */

  /*
   * The same left and right inset as the memory chart's PAD.
   *
   * The two charts are stacked, the same width and the same height, and read
   * against each other on one clock - so their plot areas have to start and end
   * at the same pixel. With a narrower left inset here, 1:30 on this chart sat
   * 18 px away from 1:30 on the one above it, which is exactly the comparison
   * the stacking exists to make. The vertical insets can differ; only the time
   * axis has to agree.
   */
  const FPS_PAD = { left: 58, right: 14, top: 14, bottom: 24 };

  /** Same defaults as the report's detector, so the two rarely disagree. */
  const FPS_COLLAPSE_FRACTION = 0.65;
  const FPS_MIN_DROP = 5;
  const FPS_BASELINE_WINDOWS = 10;

  function fpsMedian(values) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  /**
   * Group the collapsed windows into events, worst first, lettered.
   *
   * Deliberately the same shape the report uses - letter, before, lowest,
   * after, duration - so the panel that opens on a click can say the same
   * things the report will say about the same moment.
   */
  function detectFpsEvents(points, opts = {}) {
    const collapseFraction = opts.collapseFraction ?? FPS_COLLAPSE_FRACTION;
    const minDrop = opts.minDropFps ?? FPS_MIN_DROP;
    const target = opts.targetFps ?? null;
    if (points.length < 3) return [];

    const sessionMedian = fpsMedian(points.map((p) => p.fps));
    if (!(sessionMedian > 0)) return [];

    const gap = points.length > 1 ? points[1].elapsedMs - points[0].elapsedMs : 1000;
    const windowMs = gap > 0 ? gap : 1000;

    const events = [];
    let open = null;

    const close = (endIndex) => {
      if (!open) return;
      const after = points[endIndex]?.fps ?? open.reference;
      const lastMs = points[Math.max(0, endIndex - 1)]?.elapsedMs ?? open.fromMs;
      events.push({
        kind: 'drop',
        letter: '',
        atMs: open.lowestAtMs,
        fromMs: open.fromMs,
        toMs: lastMs + windowMs,
        durationMs: Math.max(windowMs, lastMs - open.fromMs + windowMs),
        beforeFps: Math.round(open.reference * 10) / 10,
        lowestFps: Math.round(open.lowest * 10) / 10,
        afterFps: Math.round(after * 10) / 10,
        changePercent:
          open.reference > 0
            ? Math.round(((open.lowest - open.reference) / open.reference) * 1000) / 10
            : 0,
        windows: open.windows,
        janks: open.janks,
      });
      open = null;
    };

    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      const from = Math.max(0, i - FPS_BASELINE_WINDOWS);
      const recent = points.slice(from, i).map((p) => p.fps);
      const recentMedian = recent.length >= 3 ? fpsMedian(recent) : 0;

      let reference = Math.max(recentMedian, sessionMedian);
      if (target != null && target > 0 && target < reference) reference = target;

      const threshold = Math.min(reference * collapseFraction, reference - minDrop);
      if (threshold > 0 && point.fps <= threshold) {
        if (!open) {
          open = {
            fromMs: point.elapsedMs,
            lowest: point.fps,
            lowestAtMs: point.elapsedMs,
            janks: point.janks || 0,
            windows: 1,
            reference,
          };
        } else {
          open.windows++;
          open.janks += point.janks || 0;
          if (point.fps < open.lowest) {
            open.lowest = point.fps;
            open.lowestAtMs = point.elapsedMs;
          }
        }
      } else if (open) {
        close(i);
      }
    }
    if (open) close(points.length);

    events.sort((a, b) => a.lowestFps - b.lowestFps || a.atMs - b.atMs);
    const kept = events.slice(0, 8);
    kept.forEach((e, i) => {
      e.letter = String.fromCharCode(65 + i);
    });
    return kept;
  }

  /**
   * Draw the frame-rate curve.
   *
   * Returns the instant under the crosshair, so the header can show the hovered
   * moment rather than the live value - the same contract `draw` has, so both
   * charts can describe one moment together.
   */
  function drawFps(canvas, opts) {
    const {
      points = [],
      displayHz = null,
      targetFps = null,
      durationMs = 0,
      hoverX = null,
      events = [],
      /** Ads opening, leaving the game, returning - dashed labeled guide lines. */
      contextEvents = [],
      selectedEvent = null,
    } = opts;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight || 240;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const grid = cssVar('--border', '#2a323d');
    const muted = cssVar('--muted', '#8b98a5');
    const bad = cssVar('--bad', '#f85149');
    const text = cssVar('--text', '#e6edf3');
    const ok = cssVar('--ok', '#3fb950');

    if (points.length === 0) {
      ctx.fillStyle = muted;
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText('Waiting for frame-rate samples…', FPS_PAD.left, height / 2);
      canvas._oomFpsGeometry = null;
      return null;
    }

    const plotW = width - FPS_PAD.left - FPS_PAD.right;
    const plotH = height - FPS_PAD.top - FPS_PAD.bottom;
    const maxT = Math.max(durationMs, points[points.length - 1].elapsedMs, 1);

    /*
     * Scaled to the panel where it is known, so a 30 fps game on a 60 Hz screen
     * sits visibly at half height instead of filling the chart and looking as
     * though it were maxed out.
     */
    /*
     * The axis leaves one step of headroom above the panel rate.
     *
     * It topped out at the panel rate itself, which put the whole chart against
     * the ceiling: on a 60 Hz phone the curve rode the top edge, the dashed
     * 60 Hz reference had nothing above it to be a reference against, and
     * anything the game submitted faster than the panel - which TimeStats does
     * measure, particularly while loading - was clipped flat and read as a cap
     * being respected.
     *
     * So a 60 Hz device gets a 0-90 axis. The rate is still judged against the
     * labelled 60 Hz line rather than against the top of the chart, which is
     * why the headroom costs nothing: a game holding 60 sits two thirds up and
     * on its line, and a game overshooting is visibly above it instead of
     * invisibly against the frame.
     */
    const observed = Math.max(...points.map((p) => p.fps));
    const panelRate = Math.max(displayHz || 0, targetFps || 0);

    /*
     * The axis is built out from the panel rate, not fitted to it afterwards.
     *
     * Choosing a round top and then hunting for gridlines that suit it left the
     * reference line floating between two labelled ticks on 90, 120 and 144 Hz
     * devices - and that line is the one the whole chart is judged against, so
     * it is the one thing a gridline has to land on. Stepping in halves of the
     * panel rate puts a tick on it by construction: 60 Hz gives 0/30/60/90,
     * 90 Hz gives 0/45/90/135, 144 Hz gives 0/72/144/216.
     *
     * The top is one step above the panel rate, extended in whole steps if the
     * game submitted frames faster than the screen could show them - which
     * TimeStats does measure, especially while loading. Extending in steps
     * rather than to a round number keeps the tick on the panel rate.
     */
    const step = panelRate > 0 ? panelRate / 2 : 0;
    const axisTop =
      step > 0
        ? Math.max(panelRate + step, Math.ceil(observed / step) * step)
        : ([30, 60, 90, 120, 144, 180, 240].find((b) => b > observed + 0.5) ??
          Math.ceil(observed / 30) * 30);
    const maxV = axisTop;

    /**
     * Gridlines, coarsened until there are few enough to read.
     *
     * Both candidate steps divide the panel rate, so whichever is used keeps a
     * tick on it. A step of twice the panel rate would not, which is why the
     * ladder stops there and falls back to thirds - by then the axis is more
     * than five times the refresh rate, the line is still drawn and labelled,
     * and losing its gridline is the lesser problem.
     */
    const ticksFor = (top) => {
      for (const candidate of step > 0 ? [step, panelRate] : []) {
        const count = Math.round(top / candidate) + 1;
        if (count > 6) continue;
        if (Math.abs(top / candidate - Math.round(top / candidate)) > 1e-9) continue;
        const out = [];
        for (let v = 0; v <= top + 1e-9; v += candidate) out.push(Math.round(v));
        return out;
      }
      const third = top / 3;
      return [0, third, third * 2, top].map((v) => Math.round(v));
    };

    const x = (ms) => FPS_PAD.left + (ms / maxT) * plotW;
    const y = (fps) => FPS_PAD.top + plotH - (Math.min(fps, maxV) / maxV) * plotH;

    // ---- grid and labels --------------------------------------------------
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const value of ticksFor(maxV)) {
      if (value > maxV) continue;
      const yy = Math.round(y(value)) + 0.5;
      ctx.strokeStyle = grid;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(FPS_PAD.left, yy);
      ctx.lineTo(width - FPS_PAD.right, yy);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = muted;
      ctx.textAlign = 'right';
      ctx.fillText(String(Math.round(value)), FPS_PAD.left - 6, yy);
    }

    // The ceiling the hardware allows, so the curve has something to be judged
    // against rather than only itself.
    if (displayHz) {
      const yy = Math.round(y(displayHz)) + 0.5;
      ctx.strokeStyle = ok;
      ctx.globalAlpha = 0.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(FPS_PAD.left, yy);
      ctx.lineTo(width - FPS_PAD.right, yy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      // Named, because an unlabelled dashed line is a mystery rather than a
      // reference - and this is the line the whole chart is judged against.
      ctx.fillStyle = ok;
      ctx.font = '9px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.globalAlpha = 0.85;
      ctx.fillText(`${displayHz} Hz screen`, width - FPS_PAD.right - 3, yy - 6);
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
    }

    /*
     * ---- context lines: ads, home, return -----------------------------------
     *
     * Drawn under the curve: they are not findings, they are what explains one.
     * Labels alternate between two rows so an ad and its return seconds later
     * do not overwrite each other.
     */
    let contextRow = 0;
    for (const event of contextEvents) {
      if (event.elapsedMs > maxT) continue;
      const cx = Math.round(x(event.elapsedMs)) + 0.5;
      ctx.strokeStyle = muted;
      ctx.globalAlpha = 0.7;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(cx, FPS_PAD.top);
      ctx.lineTo(cx, FPS_PAD.top + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      if (event.label) {
        const short = event.label.length > 22 ? `${event.label.slice(0, 21)}…` : event.label;
        ctx.font = '9px system-ui, sans-serif';
        ctx.fillStyle = muted;
        const nearRight = cx > width - FPS_PAD.right - 90;
        ctx.textAlign = nearRight ? 'right' : 'left';
        ctx.fillText(short, nearRight ? cx - 3 : cx + 3, FPS_PAD.top + 7 + (contextRow % 2) * 11);
        contextRow++;
      }
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
    }

    /*
     * ---- the curve, as a filled area ---------------------------------------
     *
     * Filled rather than a bare line, which is how a frame-rate chart is
     * usually read: the eye takes the *height* of the band as the rate and the
     * notches out of its top edge as the drops, and both are easier to see
     * against a solid shape than along a 1 px stroke. It also matches the
     * memory chart directly above it, so the two read as one instrument.
     */
    const area = ctx.createLinearGradient(0, FPS_PAD.top, 0, FPS_PAD.top + plotH);
    const accent = cssVar('--accent', '#4f9cf9');
    area.addColorStop(0, withAlpha(accent, 0.34));
    area.addColorStop(1, withAlpha(accent, 0.04));

    ctx.beginPath();
    ctx.moveTo(x(points[0].elapsedMs), FPS_PAD.top + plotH);
    for (const p of points) ctx.lineTo(x(p.elapsedMs), y(p.fps));
    ctx.lineTo(x(points[points.length - 1].elapsedMs), FPS_PAD.top + plotH);
    ctx.closePath();
    ctx.fillStyle = area;
    ctx.fill();

    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    points.forEach((p, i) => {
      const px = x(p.elapsedMs);
      const py = y(p.fps);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();

    /*
     * The mean, as a faint line across the plot.
     *
     * One number a reader would otherwise have to estimate by eye, and the line
     * makes the shape of the session legible at a glance: a curve mostly above
     * its own mean is a game that holds its rate and occasionally falls, which
     * is a different problem from one that sits below and occasionally recovers.
     */
    if (points.length >= 5) {
      const mean = points.reduce((sum, p) => sum + p.fps, 0) / points.length;
      const my = Math.round(y(mean)) + 0.5;
      ctx.strokeStyle = text;
      ctx.globalAlpha = 0.28;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(FPS_PAD.left, my);
      ctx.lineTo(width - FPS_PAD.right, my);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      ctx.fillStyle = muted;
      ctx.font = '9px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`avg ${mean.toFixed(0)}`, FPS_PAD.left + 4, my - 2);
      ctx.textBaseline = 'middle';
    }

    // Geometry stashed so hit-testing uses exactly what was drawn.
    canvas._oomFpsGeometry = { x, y, maxV, maxT, points, events };

    // ---- jank ticks -------------------------------------------------------
    for (const p of points) {
      if (!p.janks) continue;
      const px = Math.round(x(p.elapsedMs)) + 0.5;
      ctx.strokeStyle = bad;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, FPS_PAD.top + plotH);
      ctx.lineTo(px, FPS_PAD.top + plotH - 6);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // ---- hover crosshair --------------------------------------------------
    let readout = null;
    if (hoverX != null) {
      const t = ((hoverX - FPS_PAD.left) / plotW) * maxT;
      const near = nearest(points, t);
      if (near) {
        const px = Math.round(x(near.elapsedMs)) + 0.5;
        ctx.strokeStyle = muted;
        ctx.globalAlpha = 0.6;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(px, FPS_PAD.top);
        ctx.lineTo(px, FPS_PAD.top + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;

        ctx.fillStyle = text;
        ctx.beginPath();
        ctx.arc(x(near.elapsedMs), y(near.fps), 3, 0, Math.PI * 2);
        ctx.fill();
        readout = near;
      }
    }

    // ---- lettered events, last so nothing is drawn over them --------------
    for (const event of events) {
      if (!event.letter || event.elapsedMs > maxT) continue;
      const cx = Math.min(
        width - FPS_PAD.right - 9,
        Math.max(FPS_PAD.left + 9, x(event.atMs ?? event.elapsedMs)),
      );
      const near = nearest(points, event.atMs ?? event.elapsedMs);
      const cy = Math.max(FPS_PAD.top + 9, y(near ? near.fps : 0) - 12);
      const isSelected = selectedEvent && selectedEvent.atMs === event.atMs;

      ctx.beginPath();
      ctx.arc(cx, cy, isSelected ? 9.5 : 8, 0, Math.PI * 2);
      ctx.fillStyle = bad;
      ctx.fill();
      if (isSelected) {
        ctx.strokeStyle = text;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      ctx.fillStyle = cssVar('--panel', '#161b22');
      ctx.font = '700 10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(event.letter, cx, cy);
    }

    // ---- axis -------------------------------------------------------------
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(FPS_PAD.left, Math.round(FPS_PAD.top + plotH) + 0.5);
    ctx.lineTo(width - FPS_PAD.right, Math.round(FPS_PAD.top + plotH) + 0.5);
    ctx.stroke();

    ctx.fillStyle = muted;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillText('0:00', FPS_PAD.left, height - 6);
    ctx.textAlign = 'right';
    ctx.fillText(formatClock(maxT), width - FPS_PAD.right, height - 6);
    ctx.textAlign = 'center';
    ctx.fillStyle = text;
    ctx.fillText('frames per second', (FPS_PAD.left + width - FPS_PAD.right) / 2, height - 6);

    return readout;
  }

  /** Which lettered drop, if any, is under a click. */
  function hitTestFpsEvent(canvas, clientX, clientY) {
    const geometry = canvas._oomFpsGeometry;
    if (!geometry) return null;

    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;

    const HIT_RADIUS = 12;
    let best = null;
    let bestDistance = Infinity;

    for (const event of geometry.events) {
      const at = event.atMs ?? event.elapsedMs;
      const near = nearest(geometry.points, at);
      const ex = geometry.x(at);
      const ey = Math.max(FPS_PAD.top + 9, geometry.y(near ? near.fps : 0) - 12);
      const distance = Math.hypot(ex - px, ey - py);
      if (distance < HIT_RADIUS && distance < bestDistance) {
        bestDistance = distance;
        best = event;
      }
    }
    return best;
  }

  /**
   * The instant under an arbitrary click on the frame-rate curve.
   *
   * Anywhere on the curve is clickable, not only the lettered dots - the same
   * rule the memory chart follows, and for the same reason: restricting the
   * drill-down to flagged moments hides the data behind the tool's own opinion
   * of what mattered. A click on a marker returns that marker, so clicking the
   * dot and clicking beside it never produce two different answers.
   */
  function fpsAtX(canvas, clientX) {
    const geometry = canvas._oomFpsGeometry;
    if (!geometry) return null;

    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const width = canvas.clientWidth;
    const plotW = width - FPS_PAD.left - FPS_PAD.right;
    const t = ((px - FPS_PAD.left) / plotW) * geometry.maxT;

    const near = nearest(geometry.points, t);
    if (!near) return null;

    const marked = geometry.events.find(
      (e) => Math.abs((e.atMs ?? e.elapsedMs) - near.elapsedMs) < 1,
    );
    if (marked) return marked;

    // An unflagged instant, described the same way a flagged one is, so the
    // panel that opens does not have two shapes to handle.
    return {
      kind: 'sample',
      letter: '',
      atMs: near.elapsedMs,
      fromMs: near.elapsedMs,
      toMs: near.elapsedMs,
      durationMs: 0,
      beforeFps: null,
      lowestFps: Math.round(near.fps * 10) / 10,
      afterFps: null,
      changePercent: 0,
      windows: 1,
      janks: near.janks || 0,
    };
  }

  window.OomChart = {
    draw,
    drawFps,
    detectFpsEvents,
    hitTestFpsEvent,
    fpsAtX,
    toStackPoint,
    detectEvents,
    hitTestEvent,
    stepAtX,
    buildStep,
    describeEventKind,
    explainCategory,
    explainCategoryDelta,
    explainMappingDelta,
    explainEngineDelta,
    describeMappingKind,
    ENGINE_BUCKETS,
    CATEGORY_DETAIL,
    CATEGORIES,
    fmt,
    formatClock,
  };
})();
