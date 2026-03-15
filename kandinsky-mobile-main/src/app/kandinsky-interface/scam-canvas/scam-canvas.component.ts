// scam-canvas/scam-canvas.component.ts
import {
  Component, OnInit, OnChanges, SimpleChanges,
  Input, Output, EventEmitter, OnDestroy, NgZone
} from '@angular/core';
import { SocialComment } from 'src/app/models/models';

export interface ScamResultFull {
  label: 'SCAM' | 'HAM';
  score: number;
  tactic?: string;
  signals?: string[];
  debug?: { rule_tags?: string[]; ml_scam_prob?: number };
}

export interface ScamNodeDatum {
  id: string;
  comment: SocialComment;
  result: ScamResultFull;
  color: string;
  tactic: string;
  // Canvas layout
  x: number;
  y: number;
  radius: number;
  pulsePhase: number;   // 0-2π offset so pulses are staggered
  pulseSpeed: number;   // radians per frame, scaled by score
}

const TACTIC_COLORS: Record<string, string> = {
  SCAM_FUNNEL:   '#f59e0b',
  SCAM_CRYPTO:   '#ff0066',
  SCAM_ADULT:    '#ec4899',
  SCAM_ROMANCE:  '#a855f7',
  SCAM_GIVEAWAY: '#06b6d4',
  SCAM_BOT:      '#ef4444',
};

const DEFAULT_SCAM_COLOR = '#ef4444';

@Component({
  selector: 'ksky-scam-canvas',
  template: `
    <div class="scam-root" (click)="onRootClick()">

      <!-- Canvas -->
      <canvas #scamCanvas class="scam-canvas"></canvas>

      <!-- Toolbar -->
      <div class="scam-toolbar">
        <span class="scam-stat" *ngIf="visibleNodes.length">
          {{ visibleNodes.length }} scam comment{{ visibleNodes.length === 1 ? '' : 's' }}
        </span>
        <span class="scam-stat muted" *ngIf="!visibleNodes.length && resultsReady">
          No scam comments detected
        </span>
        <span class="scam-stat muted" *ngIf="!resultsReady">
          Awaiting analysis…
        </span>
      </div>

      <!-- Hover tooltip -->
      <div class="node-tooltip" *ngIf="hoveredNode"
        [style.left.px]="tooltipX" [style.top.px]="tooltipY">
        <div class="tt-author">
          <span class="tt-avatar" [style.background]="hoveredNode.color">
            {{ (hoveredNode.comment.authorName || '?')[0].toUpperCase() }}
          </span>
          <span>{{ hoveredNode.comment.authorName }}</span>
        </div>
        <div class="tt-tactic">
          <span class="tt-chip" [style.background]="hoveredNode.color + '33'" [style.color]="hoveredNode.color">
            {{ hoveredNode.tactic.replace('SCAM_', '') }}
          </span>
          <span class="tt-score">{{ (hoveredNode.result.score / 2) | number:'1.0-0' }}%</span>
        </div>
        <div class="tt-snippet">
          {{ hoveredNode.comment.content | slice:0:100 }}{{ hoveredNode.comment.content.length > 100 ? '…' : '' }}
        </div>
        <div class="tt-hint" *ngIf="!selectedNode">Click to inspect</div>
      </div>

      <!-- Selected comment detail panel -->
      <div class="detail-panel" *ngIf="selectedNode" (click)="$event.stopPropagation()">
        <div class="detail-header">
          <span class="detail-avatar" [style.background]="selectedNode.color">
            {{ (selectedNode.comment.authorName || '?')[0].toUpperCase() }}
          </span>
          <div class="detail-author-block">
            <span class="detail-author">{{ selectedNode.comment.authorName }}</span>
            <span class="detail-chip" [style.background]="selectedNode.color + '33'" [style.color]="selectedNode.color">
              {{ selectedNode.tactic.replace('SCAM_', '') }}
            </span>
          </div>
          <button class="detail-close" (click)="clearSelection()">✕</button>
        </div>
        <div class="detail-score-row">
          <span class="detail-score-label">Scam score</span>
          <div class="detail-score-bar">
            <div class="score-fill"
              [style.width.%]="selectedNode.result.score / 2"
              [style.background]="selectedNode.color">
            </div>
          </div>
          <span class="detail-score-num">{{ (selectedNode.result.score / 2) | number:'1.0-0' }}%</span>
        </div>
        <div class="detail-signals" *ngIf="selectedNode.result.signals && selectedNode.result.signals.length">
          <span class="detail-label">Signals</span>
          <div class="signal-row" *ngFor="let s of selectedNode.result.signals">
            <span class="signal-dot" [style.background]="selectedNode.color"></span>
            <small>{{ s }}</small>
          </div>
        </div>
        <div class="detail-text">
          <span class="detail-label">Comment</span>
          <p>{{ selectedNode.comment.content }}</p>
        </div>
      </div>

      <!-- Empty pane -->
      <div class="empty-pane" *ngIf="!visibleNodes.length && resultsReady">
        <ion-icon name="shield-checkmark-outline" style="font-size:52px; color:#2e2e2e"></ion-icon>
        <p class="empty-text">No scam comments detected</p>
      </div>

    </div>
  `,
  styles: [`
    :host { display: block; width: 100%; height: 100%; }

    .scam-root {
      position: relative;
      width: 100%;
      height: 100%;
      background: #111;
      overflow: hidden;
    }

    .scam-canvas {
      display: block;
      width: 100%;
      height: 100%;
    }

    /* ── Toolbar ─────────────────────────────────────────────────── */
    .scam-toolbar {
      position: absolute;
      top: 12px; left: 50%;
      transform: translateX(-50%);
      z-index: 10;
      background: rgba(24,24,24,0.92);
      border-radius: 20px; padding: 5px 16px;
      backdrop-filter: blur(8px);
      border: 1px solid rgba(255,255,255,0.06);
      white-space: nowrap;
      pointer-events: none;
    }
    .scam-stat { font-size: 12px; color: #888; }
    .scam-stat.muted { color: #444; }

    /* ── Tooltip ─────────────────────────────────────────────────── */
    .node-tooltip {
      position: absolute; pointer-events: none;
      background: rgba(14,14,14,0.97);
      border: 1px solid #2e2e2e; border-radius: 10px;
      padding: 10px 12px; width: 230px; z-index: 30;
      backdrop-filter: blur(8px);
    }
    .tt-author { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; color: #fff; margin-bottom: 6px; }
    .tt-avatar { width: 22px; height: 22px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 9px; color: #fff; flex-shrink: 0; }
    .tt-tactic { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .tt-chip { font-size: 10px; padding: 2px 8px; border-radius: 8px; }
    .tt-score { font-size: 11px; color: #666; }
    .tt-snippet { font-size: 11px; color: #aaa; line-height: 1.45; margin-bottom: 6px; }
    .tt-hint { font-size: 9px; color: #444; text-align: right; }

    /* ── Detail panel ────────────────────────────────────────────── */
    .detail-panel {
      position: absolute;
      bottom: 90px; left: 16px;
      width: 290px;
      background: rgba(14,14,14,0.97);
      border: 1px solid #252525;
      border-radius: 14px;
      padding: 14px;
      z-index: 25;
      backdrop-filter: blur(10px);
    }
    .detail-header {
      display: flex; align-items: center; gap: 10px; margin-bottom: 10px;
    }
    .detail-avatar {
      width: 30px; height: 30px; border-radius: 50%;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 12px; color: #fff; flex-shrink: 0;
    }
    .detail-author-block { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
    .detail-author { font-size: 12px; font-weight: 700; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .detail-chip { font-size: 9px; padding: 2px 7px; border-radius: 6px; font-weight: 600; align-self: flex-start; }
    .detail-close { margin-left: auto; background: none; border: none; color: #555; font-size: 14px; cursor: pointer; padding: 0 2px; flex-shrink: 0; }
    .detail-score-row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
    .detail-score-label { font-size: 10px; color: #555; white-space: nowrap; }
    .detail-score-bar { flex: 1; height: 4px; background: #2a2a2a; border-radius: 2px; overflow: hidden; }
    .score-fill { height: 100%; border-radius: 2px; transition: width 0.4s; }
    .detail-score-num { font-size: 11px; color: #888; white-space: nowrap; }
    .detail-signals { margin-bottom: 10px; }
    .detail-label { font-size: 9px; font-weight: 700; color: #444; text-transform: uppercase; letter-spacing: 0.6px; display: block; margin-bottom: 5px; }
    .signal-row { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; color: #666; }
    .signal-dot { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; }
    .detail-text p { font-size: 11px; color: #888; line-height: 1.5; margin: 4px 0 0; }

    /* ── Empty state ─────────────────────────────────────────────── */
    .empty-pane {
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      pointer-events: none;
    }
    .empty-text { color: #3a3a3a; margin-top: 12px; font-size: 13px; }
  `]
})
export class ScamCanvasComponent implements OnInit, OnChanges, OnDestroy {

  @Input() comments:     SocialComment[] = [];
  @Input() scamResults:  Map<string, ScamResultFull> = new Map();
  @Input() threshold:    number = 85;
  @Input() tacticFilters: string[] = [];   // empty = show all
  @Input() isActive:     boolean = false;

  @Output() nodeSelected    = new EventEmitter<{ comment: SocialComment; result: ScamResultFull } | null>();
  @Output() scamCountChanged = new EventEmitter<number>();

  // Template refs
  private canvasEl: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  // State
  allScamNodes:   ScamNodeDatum[] = [];
  visibleNodes:   ScamNodeDatum[] = [];
  benignNodes:    Array<{ x: number; y: number; radius: number; alpha: number }> = [];

  selectedNode:   ScamNodeDatum | null = null;
  hoveredNode:    ScamNodeDatum | null = null;
  tooltipX = 0;
  tooltipY = 0;

  resultsReady = false;

  private animFrame: number;
  private frame = 0;
  private width  = 0;
  private height = 0;
  private boundMouseMove: (e: MouseEvent) => void;
  private boundClick: (e: MouseEvent) => void;

  constructor(private zone: NgZone) {}

  ngOnInit() {}

  ngOnChanges(changes: SimpleChanges) {
    if (changes.scamResults && this.scamResults.size > 0) {
      this.buildNodes();
    }
    if (changes.tacticFilters) {
      this.applyFilters();
    }
    if (changes.isActive && this.isActive) {
      // Re-init canvas once tab becomes visible
      setTimeout(() => this.initCanvas(), 60);
    }
  }

  ngOnDestroy() {
    this.stopAnimation();
    if (this.canvasEl) {
      this.canvasEl.removeEventListener('mousemove', this.boundMouseMove);
      this.canvasEl.removeEventListener('click', this.boundClick);
    }
  }

  // ── Bootstrap ────────────────────────────────────────────────────────────
  private initCanvas() {
    this.canvasEl = document.querySelector<HTMLCanvasElement>('canvas.scam-canvas');
    if (!this.canvasEl) return;

    this.ctx = this.canvasEl.getContext('2d');
    this.resize();

    // Re-bind listeners each time tab activates
    if (this.boundMouseMove) {
      this.canvasEl.removeEventListener('mousemove', this.boundMouseMove);
      this.canvasEl.removeEventListener('click', this.boundClick);
    }

    this.boundMouseMove = (e: MouseEvent) => this.zone.run(() => this.onMouseMove(e));
    this.boundClick     = (e: MouseEvent) => this.zone.run(() => this.onCanvasClick(e));

    this.canvasEl.addEventListener('mousemove', this.boundMouseMove);
    this.canvasEl.addEventListener('click', this.boundClick);

    if (this.allScamNodes.length > 0 || this.resultsReady) {
      this.layoutNodes();
    }
    this.startAnimation();
  }

  private resize() {
    if (!this.canvasEl) return;
    const rect = this.canvasEl.getBoundingClientRect();
    this.width  = rect.width  || window.innerWidth;
    this.height = rect.height || window.innerHeight;
    this.canvasEl.width  = this.width  * window.devicePixelRatio;
    this.canvasEl.height = this.height * window.devicePixelRatio;
    this.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  }

  // ── Build node data from scamResults ─────────────────────────────────────
  private buildNodes() {
    this.allScamNodes = [];
    this.benignNodes  = [];

    this.comments.forEach(c => {
      const r = this.scamResults.get(c.id);
      const isScam = r && r.label === 'SCAM' && Number(r.score) >= this.threshold;

      if (isScam) {
        const tactic = r.tactic || 'SCAM_BOT';
        const score  = Number(r.score);
        // Radius scales with score: 8–28px
        const radius = 8 + Math.min(20, (score / 200) * 20);
        this.allScamNodes.push({
          id: c.id, comment: c, result: r,
          color: TACTIC_COLORS[tactic] || DEFAULT_SCAM_COLOR,
          tactic,
          x: 0, y: 0, radius,
          pulsePhase: Math.random() * Math.PI * 2,
          pulseSpeed: 0.018 + (score / 200) * 0.04   // faster pulse = higher score
        });
      } else {
        // Placeholder benign node — placed in layout but drawn dimly
        this.benignNodes.push({ x: 0, y: 0, radius: 5, alpha: 0.07 });
      }
    });

    this.resultsReady = true;
    this.scamCountChanged.emit(this.allScamNodes.length);
    this.applyFilters();
    this.layoutNodes();
    if (this.isActive && !this.animFrame) {
      setTimeout(() => this.initCanvas(), 60);
    }
  }

  // ── Apply tactic filters ─────────────────────────────────────────────────
  private applyFilters() {
    if (!this.tacticFilters || this.tacticFilters.length === 0) {
      this.visibleNodes = this.allScamNodes.slice();
    } else {
      this.visibleNodes = this.allScamNodes.filter(n =>
        this.tacticFilters.includes(n.tactic)
      );
    }
    this.scamCountChanged.emit(this.visibleNodes.length);
  }

  // ── Layout: pack nodes in a loose cluster ─────────────────────────────────
  private layoutNodes() {
    if (!this.width || !this.height) return;

    const allNodes = [...this.allScamNodes, ...this.benignNodes];
    const total    = allNodes.length;
    if (!total) return;

    // Simple sunflower/Fibonacci spiral layout
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    const area = this.width * this.height * 0.65;
    const spacing = Math.sqrt(area / total);

    allNodes.forEach((n, i) => {
      const r   = spacing * Math.sqrt(i + 0.5);
      const theta = i * goldenAngle;
      n.x = this.width  / 2 + r * Math.cos(theta);
      n.y = this.height / 2 + r * Math.sin(theta);
      // Clamp to canvas bounds with padding
      const pad = (n as ScamNodeDatum).radius || 6;
      n.x = Math.max(pad + 20, Math.min(this.width  - pad - 20, n.x));
      n.y = Math.max(pad + 60, Math.min(this.height - pad - 20, n.y));
    });
  }

  // ── Animation loop ────────────────────────────────────────────────────────
  private startAnimation() {
    this.stopAnimation();
    const loop = () => {
      this.drawFrame();
      this.animFrame = requestAnimationFrame(loop);
    };
    this.animFrame = requestAnimationFrame(loop);
  }

  private stopAnimation() {
    if (this.animFrame) {
      cancelAnimationFrame(this.animFrame);
      this.animFrame = null;
    }
  }

  private drawFrame() {
    if (!this.ctx || !this.width) return;
    this.frame++;
    const ctx = this.ctx;
    const W = this.width, H = this.height;

    // Clear with slight trail for glow effect
    ctx.fillStyle = 'rgba(17,17,17,0.82)';
    ctx.fillRect(0, 0, W, H);

    // 1. Draw benign nodes (very dim)
    this.benignNodes.forEach(n => {
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(60,60,60,${n.alpha})`;
      ctx.fill();
    });

    // 2. Draw scam nodes — all slightly dim if filter active
    const hasFilter = this.tacticFilters && this.tacticFilters.length > 0;
    const visibleSet = new Set(this.visibleNodes.map(n => n.id));

    this.allScamNodes.forEach(n => {
      n.pulsePhase += n.pulseSpeed;
      const pulse = (Math.sin(n.pulsePhase) + 1) / 2;   // 0–1

      const isVisible = !hasFilter || visibleSet.has(n.id);
      const isSelected = this.selectedNode && this.selectedNode.id === n.id;

      if (!isVisible) {
        // Draw dimmed
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.radius * 0.65, 0, Math.PI * 2);
        ctx.fillStyle = n.color + '1a';
        ctx.fill();
        return;
      }

      // ── Outer glow rings ──────────────────────────────────────────
      const glowRadius = n.radius + 8 + pulse * 18;
      const glowAlpha  = 0.08 + pulse * 0.18;
      const grd = ctx.createRadialGradient(n.x, n.y, n.radius * 0.5, n.x, n.y, glowRadius);
      grd.addColorStop(0, this.hexToRgba(n.color, glowAlpha * 2.2));
      grd.addColorStop(1, this.hexToRgba(n.color, 0));
      ctx.beginPath();
      ctx.arc(n.x, n.y, glowRadius, 0, Math.PI * 2);
      ctx.fillStyle = grd;
      ctx.fill();

      // Second outer ring for selected
      if (isSelected) {
        const selGlow = n.radius + 20 + pulse * 26;
        const selGrd = ctx.createRadialGradient(n.x, n.y, n.radius, n.x, n.y, selGlow);
        selGrd.addColorStop(0, this.hexToRgba(n.color, 0.18));
        selGrd.addColorStop(1, this.hexToRgba(n.color, 0));
        ctx.beginPath();
        ctx.arc(n.x, n.y, selGlow, 0, Math.PI * 2);
        ctx.fillStyle = selGrd;
        ctx.fill();
      }

      // ── Core circle ───────────────────────────────────────────────
      const coreGrd = ctx.createRadialGradient(n.x - n.radius * 0.3, n.y - n.radius * 0.3, 0, n.x, n.y, n.radius);
      coreGrd.addColorStop(0, this.lighten(n.color, 0.55));
      coreGrd.addColorStop(1, n.color);
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
      ctx.fillStyle = coreGrd;
      ctx.fill();

      // ── Selected ring ─────────────────────────────────────────────
      if (isSelected) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.radius + 4, 0, Math.PI * 2);
        ctx.strokeStyle = n.color;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // ── Author initial ────────────────────────────────────────────
      if (n.radius >= 10) {
        ctx.fillStyle = 'rgba(255,255,255,0.88)';
        ctx.font = `bold ${Math.max(8, n.radius * 0.55)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText((n.comment.authorName || '?')[0].toUpperCase(), n.x, n.y);
      }
    });
  }

  // ── Mouse events ─────────────────────────────────────────────────────────
  private onMouseMove(e: MouseEvent) {
    if (!this.canvasEl) return;
    const rect = this.canvasEl.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const hit = this.hitTest(mx, my);
    this.hoveredNode = hit;

    if (hit) {
      // Position tooltip — keep inside bounds
      let tx = mx + 16;
      let ty = my - 8;
      if (tx + 244 > this.width)  tx = mx - 248;
      if (ty + 160 > this.height) ty = this.height - 164;
      if (ty < 0) ty = 4;
      this.tooltipX = tx;
      this.tooltipY = ty;
    }
  }

  private onCanvasClick(e: MouseEvent) {
    if (!this.canvasEl) return;
    const rect = this.canvasEl.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const hit = this.hitTest(mx, my);
    if (hit) {
      e.stopPropagation();
      if (this.selectedNode && this.selectedNode.id === hit.id) {
        this.clearSelection();
      } else {
        this.selectedNode = hit;
        this.nodeSelected.emit({ comment: hit.comment, result: hit.result });
      }
    }
  }

  onRootClick() {
    this.clearSelection();
  }

  clearSelection() {
    this.selectedNode = null;
    this.nodeSelected.emit(null);
  }

  private hitTest(mx: number, my: number): ScamNodeDatum | null {
    // Test visible nodes first, largest radius first
    const sorted = [...this.visibleNodes].sort((a, b) => b.radius - a.radius);
    for (const n of sorted) {
      const dx = mx - n.x, dy = my - n.y;
      if (dx * dx + dy * dy <= (n.radius + 8) * (n.radius + 8)) return n;
    }
    return null;
  }

  // ── Colour helpers ────────────────────────────────────────────────────────
  private hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  private lighten(hex: string, amount: number): string {
    const r = Math.min(255, parseInt(hex.slice(1, 3), 16) + Math.round(255 * amount));
    const g = Math.min(255, parseInt(hex.slice(3, 5), 16) + Math.round(255 * amount));
    const b = Math.min(255, parseInt(hex.slice(5, 7), 16) + Math.round(255 * amount));
    return `rgb(${r},${g},${b})`;
  }
}