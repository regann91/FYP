import {
  Component, OnInit, OnChanges, SimpleChanges,
  Input, Output, EventEmitter, OnDestroy
} from '@angular/core';
import * as d3 from 'd3';
import _ from 'lodash';
import { SocialComment } from 'src/app/models/models';
import ColorHash from 'color-hash';

export type SSBRelationshipMode = 'collusion' | 'duplicatePhrases' | 'tacticGroups' | 'burstTiming';

export interface SSBNodeDatum extends d3.SimulationNodeDatum {
  id: string;
  comment: SocialComment;
  result: SSBResultFull;
  radius: number;
  color: string;
  groupKey: string;
}

export interface SSBLinkDatum extends d3.SimulationLinkDatum<SSBNodeDatum> {
  type: SSBRelationshipMode;
  strength: number;
  label?: string;
}

export interface SSBResultFull {
  label: 'SCAM' | 'HAM';
  score: number;
  tactic?: string;
  signals?: string[];
  debug?: { rule_tags?: string[]; ml_scam_prob?: number };
}

const TACTIC_COLORS: Record<string, string> = {
  SCAM_FUNNEL:   '#f59e0b',
  SCAM_CRYPTO:   '#ff0066',
  SCAM_ADULT:    '#ec4899',
  SCAM_ROMANCE:  '#a855f7',
  SCAM_GIVEAWAY: '#06b6d4',
  SCAM_BOT:      '#ef4444',
};

@Component({
  selector: 'ksky-ssb-canvas',
  template: `
    <div class="ssb-root">

      <!-- ══ LEFT: Graph pane ══════════════════════════════════════════════ -->
      <div class="graph-pane">

        <div class="ssb-toolbar">
          <select
            class="mode-select"
            [value]="selectedMode"
            (change)="onModeChange($any($event.target).value)">
            <option value="collusion">Collusion</option>
            <option value="duplicatePhrases">Duplicate Phrases</option>
            <option value="tacticGroups">Tactic Groups</option>
            <option value="burstTiming">Burst Timing</option>
          </select>
          <span class="ssb-stat" *ngIf="scamNodes.length">
            {{ scamNodes.length }} scam comment{{ scamNodes.length === 1 ? '' : 's' }}
          </span>
          <span class="ssb-stat muted" *ngIf="!scamNodes.length && resultsReady">No scam comments detected</span>
          <span class="ssb-stat muted" *ngIf="!resultsReady">Awaiting SSB results…</span>
        </div>

        <svg class="ssb-svg" width="100%" height="100%"></svg>

        <!-- Hover tooltip -->
        <div class="node-tooltip" *ngIf="hoveredNode && !selectedNode"
          [style.left.px]="tooltipX" [style.top.px]="tooltipY">
          <div class="tt-author">
            <span class="tt-avatar" [style.background]="hoveredNode.color">
              {{ (hoveredNode.comment.authorName || '?')[0].toUpperCase() }}
            </span>
            <span>{{ hoveredNode.comment.authorName }}</span>
          </div>
          <div class="tt-snippet">{{ hoveredNode.comment.content | slice:0:90 }}{{ hoveredNode.comment.content.length > 90 ? '…' : '' }}</div>
          <div class="tt-meta">
            <span class="tt-chip" [style.background]="hoveredNode.color">
              {{ (hoveredNode.result.tactic || 'SCAM_BOT').replace('SCAM_', '') }}
            </span>
            <span class="tt-score">{{ (hoveredNode.result.score * 100 | number:'1.0-0') }}%</span>
          </div>
          <div class="tt-hint">Click to select</div>
        </div>

        <!-- Legend -->
        <div class="ssb-legend" *ngIf="scamNodes.length">
          <div class="legend-item" *ngFor="let t of legendTactics">
            <span class="legend-dot" [style.background]="t.color"></span>
            <small>{{ t.label }}</small>
          </div>
          <hr class="legend-hr" *ngIf="scamNodes.length">
          <div class="legend-item" *ngIf="selectedMode === 'collusion'">
            <span class="legend-line"></span><small>Reply chain</small>
          </div>
          <div class="legend-item" *ngIf="selectedMode === 'duplicatePhrases'">
            <span class="legend-line dashed"></span><small>Shared phrase</small>
          </div>
          <div class="legend-item" *ngIf="selectedMode === 'tacticGroups'">
            <span class="legend-line white"></span><small>Same tactic</small>
          </div>
          <div class="legend-item" *ngIf="selectedMode === 'burstTiming'">
            <span class="legend-line burst"></span><small>Burst window</small>
          </div>
        </div>
      </div>

      <!-- ══ RIGHT: Comment feed pane ══════════════════════════════════════ -->
      <div class="list-pane" *ngIf="scamNodes.length">

        <div class="list-header">
          <span>Flagged Comments</span>
          <span class="list-count">{{ filteredNodes.length }}/{{ scamNodes.length }}</span>
        </div>

        <!-- Tactic filter pills -->
        <div class="filter-pills">
          <button class="pill" [class.active]="tacticFilter === ''" (click)="setTacticFilter('')">All</button>
          <button
            *ngFor="let t of legendTactics"
            class="pill"
            [class.active]="tacticFilter === t.tactic"
            [style.border-color]="tacticFilter === t.tactic ? t.color : ''"
            [style.color]="tacticFilter === t.tactic ? t.color : ''"
            (click)="setTacticFilter(t.tactic)">
            {{ t.label }}
          </button>
        </div>

        <!-- Comment cards -->
        <div class="comment-list">
          <div
            *ngFor="let n of filteredNodes"
            class="comment-card"
            [id]="'card-' + n.id"
            [class.selected]="selectedNode && selectedNode.id === n.id"
            [style.border-left-color]="n.color"
            (click)="onListItemClick(n)">

            <!-- Row 1: avatar + author + score bar -->
            <div class="card-header">
              <span class="card-avatar" [style.background]="n.color">
                {{ (n.comment.authorName || '?')[0].toUpperCase() }}
              </span>
              <span class="card-author">{{ n.comment.authorName }}</span>
              <div class="card-score-bar">
                <div class="score-fill" [style.width.%]="n.result.score * 100" [style.background]="n.color"></div>
              </div>
              <span class="card-score-num">{{ (n.result.score * 100 | number:'1.0-0') }}%</span>
            </div>

            <!-- Row 2: snippet -->
            <div class="card-snippet">
              {{ n.comment.content | slice:0:120 }}{{ n.comment.content.length > 120 ? '…' : '' }}
            </div>

            <!-- Row 3: tactic chip -->
            <div class="card-meta">
              <span class="card-tactic" [style.background]="n.color + '28'" [style.color]="n.color">
                {{ (n.result.tactic || 'SCAM_BOT').replace('SCAM_', '') }}
              </span>
              <span class="card-expand-hint" *ngIf="!(selectedNode && selectedNode.id === n.id)">
                tap for details
              </span>
            </div>

            <!-- Expanded: signals + topic tags + full text -->
            <div class="card-detail" *ngIf="selectedNode && selectedNode.id === n.id">
              <div class="detail-section" *ngIf="n.result.signals && n.result.signals.length">
                <div class="detail-label">Signals</div>
                <div class="signal-row" *ngFor="let s of n.result.signals">
                  <span class="signal-dot" [style.background]="n.color"></span>
                  <small>{{ signalLabel(s) }}</small>
                </div>
              </div>

              <div class="detail-section" *ngIf="getTopicTags(n).length">
                <div class="detail-label">Topics</div>
                <div class="topic-tags">
                  <span class="topic-tag" *ngFor="let tag of getTopicTags(n)">{{ tag }}</span>
                </div>
              </div>

              <div class="detail-section" *ngIf="n.comment.content.length > 120">
                <div class="detail-label">Full comment</div>
                <p class="full-text">{{ n.comment.content }}</p>
              </div>
            </div>

          </div>

          <div class="empty-state" *ngIf="filteredNodes.length === 0">
            No comments match this filter.
          </div>
        </div>
      </div>

      <!-- Awaiting / empty state -->
      <div class="empty-pane" *ngIf="!scamNodes.length && resultsReady">
        <ion-icon name="shield-checkmark-outline" style="font-size:52px; color:#2e2e2e"></ion-icon>
        <p class="empty-text">No scam comments detected</p>
      </div>

    </div>
  `,
  styles: [`
    :host { display: block; width: 100%; height: 100%; }

    .ssb-root {
      display: flex;
      width: 100%;
      height: 100%;
      background: #181818;
      overflow: hidden;
    }

    /* ── Graph pane ──────────────────────────────────────────────── */
    .graph-pane {
      position: relative;
      flex: 1 1 0;
      min-width: 0;
      height: 100%;
    }
    .ssb-svg { display: block; width: 100%; height: 100%; }

    .ssb-toolbar {
      position: absolute;
      top: 8px; left: 50%;
      transform: translateX(-50%);
      z-index: 10;
      display: flex; align-items: center; gap: 12px;
      background: rgba(28,28,28,0.94);
      border-radius: 20px; padding: 4px 14px;
      backdrop-filter: blur(8px);
      border: 1px solid rgba(255,255,255,0.05);
      white-space: nowrap;
    }
    .mode-select {
      background: transparent;
      border: 1px solid #3a3a3a; border-radius: 12px;
      color: #fff; font-size: 13px; min-width: 148px;
      padding: 4px 28px 4px 10px;
      cursor: pointer; outline: none;
      appearance: none; -webkit-appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23888'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 10px center;
    }
    .mode-select option { background: #1e1e1e; color: #fff; }
    .ssb-stat { font-size: 12px; color: #999; }
    .ssb-stat.muted { color: #444; }

    /* ── Hover tooltip ───────────────────────────────────────────── */
    .node-tooltip {
      position: absolute; pointer-events: none;
      background: rgba(16,16,16,0.97);
      border: 1px solid #2e2e2e; border-radius: 10px;
      padding: 10px 12px; width: 220px; z-index: 20;
      backdrop-filter: blur(8px);
    }
    .tt-author { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; color: #fff; margin-bottom: 6px; }
    .tt-avatar { width: 22px; height: 22px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 9px; color: #fff; flex-shrink: 0; }
    .tt-snippet { font-size: 11px; color: #bbb; line-height: 1.45; margin-bottom: 8px; }
    .tt-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .tt-chip { font-size: 10px; padding: 2px 8px; border-radius: 8px; color: #fff; }
    .tt-score { font-size: 11px; color: #666; }
    .tt-hint { font-size: 9px; color: #383838; text-align: right; }

    /* ── Legend ──────────────────────────────────────────────────── */
    .ssb-legend {
      position: absolute; bottom: 80px; left: 12px;
      display: flex; flex-direction: column; gap: 4px;
      background: rgba(18,18,18,0.88); border-radius: 8px; padding: 8px 10px;
      pointer-events: none; border: 1px solid #232323;
    }
    .legend-hr { border: none; border-top: 1px solid #2a2a2a; margin: 3px 0; }
    .legend-item { display: flex; align-items: center; gap: 6px; color: #bbb; }
    .legend-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
    .legend-line { display: inline-block; width: 22px; height: 2px; background: #555; }
    .legend-line.dashed { background: repeating-linear-gradient(90deg,#777 0 4px,transparent 4px 8px); }
    .legend-line.white  { background: rgba(255,255,255,0.3); }
    .legend-line.burst  { background: #f59e0b; }

    /* ── List pane ───────────────────────────────────────────────── */
    .list-pane {
      width: 305px; flex-shrink: 0; height: 100%;
      display: flex; flex-direction: column;
      border-left: 1px solid #202020;
      background: #141414;
    }
    .list-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 13px 14px 5px;
      font-size: 10px; font-weight: 700; color: #555;
      text-transform: uppercase; letter-spacing: 0.8px; flex-shrink: 0;
    }
    .list-count { background: #1e1e1e; border-radius: 9px; padding: 2px 8px; font-size: 10px; color: #444; }

    /* ── Filter pills ────────────────────────────────────────────── */
    .filter-pills {
      display: flex; flex-wrap: wrap; gap: 5px;
      padding: 4px 12px 9px; flex-shrink: 0;
      border-bottom: 1px solid #1c1c1c;
    }
    .pill {
      font-size: 10px; padding: 2px 9px; border-radius: 9px;
      border: 1px solid #282828; background: transparent; color: #4a4a4a;
      cursor: pointer; transition: all 0.14s;
    }
    .pill.active { background: rgba(255,255,255,0.06); color: #bbb; border-color: #3e3e3e; }

    /* ── Comment list ────────────────────────────────────────────── */
    .comment-list { flex: 1 1 0; overflow-y: auto; padding: 5px 0 16px; }
    .comment-list::-webkit-scrollbar { width: 3px; }
    .comment-list::-webkit-scrollbar-thumb { background: #282828; border-radius: 2px; }

    /* ── Comment card ────────────────────────────────────────────── */
    .comment-card {
      margin: 3px 8px; padding: 9px 11px 8px;
      border-radius: 8px;
      border: 1px solid #1e1e1e;
      border-left: 3px solid transparent;
      background: #191919;
      cursor: pointer;
      transition: background 0.14s, border-color 0.14s;
    }
    .comment-card:hover { background: #1e1e1e; }
    .comment-card.selected { background: #1f1f1f; border-color: #303030; }

    .card-header { display: flex; align-items: center; gap: 7px; margin-bottom: 5px; }
    .card-avatar { width: 20px; height: 20px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 9px; color: #fff; flex-shrink: 0; }
    .card-author { font-size: 11px; font-weight: 600; color: #ccc; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .card-score-bar { width: 42px; height: 3px; background: #252525; border-radius: 2px; overflow: hidden; flex-shrink: 0; }
    .score-fill { height: 100%; border-radius: 2px; opacity: 0.8; }
    .card-score-num { font-size: 10px; color: #4a4a4a; width: 26px; text-align: right; flex-shrink: 0; }

    .card-snippet { font-size: 11px; color: #666; line-height: 1.45; margin-bottom: 6px; }

    .card-meta { display: flex; align-items: center; gap: 6px; }
    .card-tactic { font-size: 9px; padding: 2px 7px; border-radius: 6px; font-weight: 600; letter-spacing: 0.2px; }
    .card-expand-hint { font-size: 9px; color: #303030; margin-left: auto; }

    /* ── Expanded detail ─────────────────────────────────────────── */
    .card-detail { margin-top: 10px; padding-top: 10px; border-top: 1px solid #232323; }
    .detail-section { margin-bottom: 10px; }
    .detail-label { font-size: 9px; font-weight: 700; color: #3e3e3e; text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 5px; }

    .signal-row { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; color: #777; }
    .signal-dot { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; opacity: 0.7; }

    .topic-tags { display: flex; flex-wrap: wrap; gap: 4px; }
    .topic-tag { font-size: 9px; padding: 2px 7px; border-radius: 5px; background: #222; color: #666; border: 1px solid #2a2a2a; }

    .full-text { font-size: 11px; color: #888; line-height: 1.5; margin: 4px 0 0; }

    /* ── Empty states ────────────────────────────────────────────── */
    .empty-state { padding: 28px; text-align: center; font-size: 11px; color: #2e2e2e; }
    .empty-pane { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; }
    .empty-text { color: #3a3a3a; margin-top: 12px; font-size: 13px; }
  `]
})
export class SsbCanvasComponent implements OnInit, OnChanges, OnDestroy {

  @Input() comments:   SocialComment[] = [];
  @Input() ssbResults: Map<string, SSBResultFull> = new Map();
  @Input() threshold:  number = 0.85;
  @Input() isActive:   boolean = false;

  @Output() nodeSelected    = new EventEmitter<{ comment: SocialComment; result: SSBResultFull } | null>();
  @Output() scamCountChanged = new EventEmitter<number>();

  selectedMode:  SSBRelationshipMode = 'collusion';
  selectedNode:  SSBNodeDatum | null = null;
  hoveredNode:   SSBNodeDatum | null = null;
  tooltipX = 0;
  tooltipY = 0;

  scamNodes:     SSBNodeDatum[] = [];
  filteredNodes: SSBNodeDatum[] = [];
  resultsReady   = false;
  legendTactics: { color: string; label: string; tactic: string }[] = [];
  tacticFilter   = '';

  private svg:       d3.Selection<SVGSVGElement, unknown, HTMLElement, any>;
  private container: d3.Selection<SVGGElement,   unknown, HTMLElement, any>;
  private simulation: d3.Simulation<SSBNodeDatum, SSBLinkDatum>;
  private zoom:       d3.ZoomBehavior<SVGSVGElement, unknown>;
  private colorHash  = new ColorHash();
  private width  = 0;
  private height = 0;

  private readonly SIGNAL_LABELS: Record<string, string> = {
    'account_very_new_<30d':                'Account < 30 days old',
    'account_new_<90d':                     'Account < 90 days old',
    'zero_subscribers':                     'Zero subscribers',
    'zero_videos':                          'No uploaded videos',
    'zero_likes_new_account':               'Zero likes, new account',
    'duplicate_text_across_authors':        'Identical text across authors',
    'duplicate_tail_across_authors':        'Identical ending phrase across authors',
    'incoherent_tail':                      'Appended phrase unrelated to comment body',
    'burst_timing_new_accounts':            'Coordinated burst with new accounts',
    'collusion_reply_between_new_accounts': 'Reply chain between new accounts',
    'explicit_profile_picture':             'Explicit profile picture',
  };

  ngOnInit() {}

  ngOnChanges(changes: SimpleChanges) {
    if (changes.isActive && this.isActive) {
      setTimeout(() => this.initSvg(), 50);
    }
    if ((changes.ssbResults || changes.comments || changes.threshold) && this.isActive) {
      this.resultsReady = this.ssbResults.size > 0;
      if (this.resultsReady) this.rebuild();
    }
  }

  ngOnDestroy() {
    if (this.simulation) this.simulation.stop();
  }

  onModeChange(mode: SSBRelationshipMode) {
    this.selectedMode = mode;
    this.rebuild();
  }

  setTacticFilter(tactic: string) {
    this.tacticFilter = tactic;
    this.applyFilter();
    if (!this.container) return;
    this.container.selectAll<SVGGElement, SSBNodeDatum>('.ssb-node')
      .attr('opacity', (n: SSBNodeDatum) => {
        if (!tactic) return 1;
        return (n.result.tactic || 'SCAM_BOT') === tactic ? 1 : 0.1;
      });
  }

  onListItemClick(n: SSBNodeDatum) {
    if (this.selectedNode && this.selectedNode.id === n.id) {
      this.selectedNode = null;
      this.nodeSelected.emit(null);
      if (this.container)
        this.container.selectAll<SVGGElement, SSBNodeDatum>('.ssb-node').attr('opacity', 1);
    } else {
      this.selectedNode = n;
      this.nodeSelected.emit({ comment: n.comment, result: n.result });
      this.highlightNode(n.id);
      this.pulseNode(n.id);
    }
  }

  clearSelection() {
    this.selectedNode = null;
    this.nodeSelected.emit(null);
    if (this.container)
      this.container.selectAll<SVGGElement, SSBNodeDatum>('.ssb-node').attr('opacity', 1);
  }

  signalLabel(s: string): string { return this.SIGNAL_LABELS[s] || s; }

  getTopicTags(n: SSBNodeDatum): string[] {
    const analytics = n.comment.analytics;
    if (!analytics || !analytics.topics) return [];
    return Object.keys(analytics.topics).slice(0, 6);
  }

  // ── init SVG ──────────────────────────────────────────────────────────────
  private initSvg() {
    const el = document.querySelector<SVGSVGElement>('svg.ssb-svg');
    if (!el) return;
    this.width  = el.clientWidth  || window.innerWidth * 0.6;
    this.height = el.clientHeight || window.innerHeight - 120;

    this.svg = d3.select<SVGSVGElement, unknown>('svg.ssb-svg');
    this.svg.selectAll('*').remove();

    this.svg.append('defs').append('marker')
      .attr('id', 'ssb-arrow')
      .attr('viewBox', '-0 -5 10 10').attr('refX', 20).attr('refY', 0)
      .attr('orient', 'auto').attr('markerWidth', 6).attr('markerHeight', 6)
      .append('svg:path').attr('d', 'M 0,-5 L 10,0 L 0,5')
      .attr('fill', '#555').style('stroke', 'none');

    this.container = this.svg.append('g').attr('class', 'ssb-container');

    this.zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 5])
      .on('zoom', () => { this.container.attr('transform', d3.event.transform); });
    this.svg.call(this.zoom);

    if (this.resultsReady) this.rebuild();
  }

  // ── rebuild ───────────────────────────────────────────────────────────────
  private rebuild() {
    if (!this.container) { this.initSvg(); return; }
    if (this.simulation) this.simulation.stop();
    this.container.selectAll('*').remove();
    this.selectedNode = null;
    this.hoveredNode  = null;

    const { nodes, links } = this.buildGraphData();
    this.scamNodes = nodes;
    this.scamCountChanged.emit(nodes.length);
    this.updateLegend(nodes);
    this.applyFilter();

    if (!nodes.length) return;

    if (this.selectedMode === 'tacticGroups') {
      this.drawTacticGroupsLayout(nodes);
    } else {
      this.drawLinks(links);
      this.drawNodes(nodes, false);
      this.startSimulation(nodes, links);
    }
  }

  // ── filter ────────────────────────────────────────────────────────────────
  private applyFilter() {
    this.filteredNodes = this.tacticFilter
      ? this.scamNodes.filter(n => (n.result.tactic || 'SCAM_BOT') === this.tacticFilter)
      : this.scamNodes.slice();
  }

  // ── graph data ────────────────────────────────────────────────────────────
  private buildGraphData(): { nodes: SSBNodeDatum[]; links: SSBLinkDatum[] } {
    const nodes: SSBNodeDatum[] = [];
    const scamCommentIds = new Set<string>();

    this.comments.forEach(c => {
      const r = this.ssbResults.get(c.id);
      if (!r || r.label !== 'SCAM') return;
      scamCommentIds.add(c.id);
      const tactic = r.tactic || 'SCAM_BOT';
      nodes.push({
        id: c.id, comment: c, result: r,
        radius: this.radiusForScore(Number(r.score)),
        color:  TACTIC_COLORS[tactic] || '#ef4444',
        groupKey: tactic,
        x: this.width  * (0.2 + Math.random() * 0.6),
        y: this.height * (0.2 + Math.random() * 0.6),
      });
    });

    return { nodes, links: this.buildLinks(nodes, scamCommentIds) };
  }

  private buildLinks(nodes: SSBNodeDatum[], scamIds: Set<string>): SSBLinkDatum[] {
    const links: SSBLinkDatum[] = [];
    const byId = new Map(nodes.map(n => [n.id, n]));

    switch (this.selectedMode) {
      case 'collusion':
        nodes.forEach(n => {
          const p = n.comment.parentCommentId;
          if (p && byId.has(p))
            links.push({ source: n.id, target: p, type: 'collusion', strength: 0.8 });
        });
        break;

      case 'duplicatePhrases': {
        const tailMap = new Map<string, SSBNodeDatum[]>();
        nodes.forEach(n => {
          const tail = this.extractTail(n.comment.content);
          if (!tail) return;
          if (!tailMap.has(tail)) tailMap.set(tail, []);
          tailMap.get(tail).push(n);
        });
        tailMap.forEach(group => {
          if (group.length < 2) return;
          for (let i = 0; i < group.length; i++)
            for (let j = i + 1; j < group.length; j++)
              links.push({ source: group[i].id, target: group[j].id,
                type: 'duplicatePhrases', strength: 0.5, label: 'shared phrase' });
        });
        break;
      }

      case 'burstTiming': {
        const WINDOW_MS = 60000;
        const sorted = nodes.slice().sort((a, b) => a.comment.publishTimestamp - b.comment.publishTimestamp);
        for (let i = 0; i < sorted.length; i++)
          for (let j = i + 1; j < sorted.length; j++) {
            const diff = sorted[j].comment.publishTimestamp - sorted[i].comment.publishTimestamp;
            if (diff > WINDOW_MS) break;
            links.push({ source: sorted[i].id, target: sorted[j].id,
              type: 'burstTiming', strength: 0.4, label: Math.round(diff / 1000) + 's apart' });
          }
        break;
      }
    }
    return links;
  }

  // ── tactic groups layout ──────────────────────────────────────────────────
  // Fixes vs old version:
  //   • Box size scales with node count — large groups get more space
  //   • Nodes use force-directed micro-simulation per group (no overlapping ring)
  //   • Score-based node sizing is clamped so small groups stay legible
  //   • Tactic label + count are on the same left-aligned header line
  //   • Box fill and stroke are perceptually distinct from background
  //   • Topic keyword tags are centred and spill onto a second row if needed
  //   • A "scroll to zoom" hint fades in after 1.5 s
  private drawTacticGroupsLayout(nodes: SSBNodeDatum[]) {
    // ── 1. Build d3 hierarchy ─────────────────────────────────────────────
    // Root → tactic groups → individual comment nodes
    // Child value = scam score (drives circle size within the pack)
    const tacticMap = new Map<string, SSBNodeDatum[]>();
    nodes.forEach(function(n) {
      var t = n.result.tactic || 'SCAM_BOT';
      if (!tacticMap.has(t)) tacticMap.set(t, []);
      tacticMap.get(t).push(n);
    });

    // ── 2. Collect top LDA topic keywords per tactic ──────────────────────
    const tacticTopics = new Map<string, string[]>();
    tacticMap.forEach(function(grpNodes, tactic) {
      var freq: { [k: string]: number } = {};
      grpNodes.forEach(function(n) {
        var analytics = (n.comment as any).analytics;
        var topics = (analytics && analytics.topics) ? analytics.topics : {};
        Object.keys(topics).forEach(function(k) { freq[k] = (freq[k] || 0) + 1; });
      });
      var sorted = Object.entries(freq)
        .sort(function(a, b) { return b[1] - a[1]; })
        .slice(0, 5).map(function(e) { return e[0]; });
      tacticTopics.set(tactic, sorted);
    });

    // ── 3. Build the hierarchy object d3.pack expects ─────────────────────
    // { name, children: [ { name: tactic, children: [ { node, value } ] } ] }
    const hierarchyData = {
      name: 'root',
      children: Array.from(tacticMap.entries()).map(function(entry) {
        var tactic   = entry[0];
        var grpNodes = entry[1];
        return {
          name: tactic,
          children: grpNodes.map(function(n) {
            return { name: n.id, value: Math.max(n.result.score, 0.15), node: n };
          })
        };
      })
    };

    // ── 4. Run d3.pack ────────────────────────────────────────────────────
    // Pack into the full SVG viewport so zoom/pan works naturally
    const W = this.width;
    const H = this.height;
    const PACK_PAD_ROOT  = 24;   // padding around the whole layout
    const PACK_PAD_GROUP = 18;   // padding between group circle and its children
    const PACK_PAD_LEAF  = 3;    // padding between leaf circles

    const root = d3.hierarchy(hierarchyData)
      .sum(function(d: any) { return d.value || 0; })
      .sort(function(a, b) { return (b.value || 0) - (a.value || 0); });

    const packLayout = d3.pack()
      .size([W - PACK_PAD_ROOT * 2, H - PACK_PAD_ROOT * 2])
      .padding(function(d: any) {
        if (d.depth === 0) return PACK_PAD_ROOT;
        if (d.depth === 1) return PACK_PAD_GROUP;
        return PACK_PAD_LEAF;
      });

    packLayout(root as any);

    // Offset so layout is centred in the SVG
    const descendants = (root as any).descendants() as any[];
    const leaves      = (root as any).leaves()       as any[];

    // ── 5. Draw group (tactic) circles ────────────────────────────────────
    const groupNodes = descendants.filter(function(d: any) { return d.depth === 1; });

    // Add per-group radial gradient to defs
    const defs = this.svg.select<SVGDefsElement>('defs');

    const groupG = this.container.append('g').attr('class', 'tactic-groups');

    groupNodes.forEach(function(d: any) {
      var tactic = d.data.name;
      var color  = TACTIC_COLORS[tactic] || '#ef4444';
      var cx     = d.x + PACK_PAD_ROOT;
      var cy     = d.y + PACK_PAD_ROOT;
      var r      = d.r;

      // Radial gradient: bright centre fading out
      var gradId = 'pack-grad-' + tactic.replace('SCAM_', '');
      var grad   = defs.append('radialGradient')
        .attr('id', gradId)
        .attr('cx', '50%').attr('cy', '50%').attr('r', '50%');
      grad.append('stop').attr('offset', '0%')
        .attr('stop-color', color).attr('stop-opacity', 0.22);
      grad.append('stop').attr('offset', '100%')
        .attr('stop-color', color).attr('stop-opacity', 0.04);

      // Group circle
      groupG.append('circle')
        .attr('cx', cx).attr('cy', cy).attr('r', r)
        .attr('fill', 'url(#' + gradId + ')')
        .attr('stroke', color).attr('stroke-opacity', 0.5).attr('stroke-width', 1.5);

      // Tactic label — positioned at top of circle, inside
      var labelY = cy - r + 22;
      groupG.append('text')
        .attr('x', cx).attr('y', labelY)
        .attr('text-anchor', 'middle')
        .attr('fill', color).attr('font-size', 13).attr('font-weight', '700')
        .attr('letter-spacing', '0.6')
        .attr('pointer-events', 'none')
        .text(tactic.replace('SCAM_', ''));

      // Comment count — just below the label
      groupG.append('text')
        .attr('x', cx).attr('y', labelY + 15)
        .attr('text-anchor', 'middle')
        .attr('fill', color).attr('font-size', 10).attr('opacity', 0.5)
        .attr('pointer-events', 'none')
        .text(d.children.length + ' comment' + (d.children.length === 1 ? '' : 's'));

      // Topic keyword tags — arc along the bottom inside of the circle
      var topics = tacticTopics.get(tactic) || [];
      if (topics.length) {
        var TAG_H    = 15;
        var TAG_GAP  = 5;
        var TAG_FONT = 9;
        // Measure tags and centre them
        var tagWidths = topics.map(function(t: string) {
          return Math.min(t.length * TAG_FONT * 0.6 + 16, 72);
        });
        var totalW = tagWidths.reduce(function(s: number, w: number) { return s + w; }, 0)
                     + TAG_GAP * (topics.length - 1);
        var maxTotalW = r * 1.4;
        // If they don't fit, drop trailing ones
        var fittingTopics: string[] = [];
        var fittingWidths: number[] = [];
        var usedW = 0;
        topics.forEach(function(tag: string, i: number) {
          var tw = tagWidths[i];
          var addW = tw + (fittingTopics.length > 0 ? TAG_GAP : 0);
          if (usedW + addW <= maxTotalW) {
            fittingTopics.push(tag);
            fittingWidths.push(tw);
            usedW += addW;
          }
        });
        var tagRowTotalW = fittingWidths.reduce(function(s: number, w: number) { return s + w; }, 0)
                           + TAG_GAP * (fittingTopics.length - 1);
        var tagStartX = cx - tagRowTotalW / 2;
        var tagY      = cy + r - 30;
        var txCursor  = tagStartX;
        fittingTopics.forEach(function(tag: string, i: number) {
          var tw = fittingWidths[i];
          var tagG = groupG.append('g').attr('pointer-events', 'none');
          tagG.append('rect')
            .attr('x', txCursor).attr('y', tagY)
            .attr('width', tw).attr('height', TAG_H).attr('rx', 5)
            .attr('fill', color + '22').attr('stroke', color + '55').attr('stroke-width', 0.8);
          tagG.append('text')
            .attr('x', txCursor + tw / 2).attr('y', tagY + TAG_H / 2)
            .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
            .attr('fill', color + 'dd').attr('font-size', TAG_FONT)
            .text(tag.length > 10 ? tag.slice(0, 9) + '\u2026' : tag);
          txCursor += tw + TAG_GAP;
        });
      }
    });

    // ── 6. Draw leaf (comment) circles ────────────────────────────────────
    // Write back pack-computed positions into SSBNodeDatum so the
    // existing drawNodes / highlight / pulse / list-sync all work unchanged
    leaves.forEach(function(d: any) {
      var n: SSBNodeDatum = d.data.node;
      n.x      = d.x + PACK_PAD_ROOT;
      n.y      = d.y + PACK_PAD_ROOT;
      n.radius = Math.max(d.r - 1, 3);   // slight inset so leaf doesn't kiss group border
    });

    // Reuse the existing drawNodes (staticLayout = true → no sim, just translate)
    this.drawNodes(nodes, true);

    // ── 7. Scroll-to-zoom hint ────────────────────────────────────────────
    var hint = this.svg.append('text')
      .attr('x', W / 2).attr('y', H - 12)
      .attr('text-anchor', 'middle')
      .attr('fill', '#444').attr('font-size', 11)
      .attr('pointer-events', 'none').attr('opacity', 0)
      .text('Scroll to zoom \u00b7 Drag to pan');
    hint.transition().delay(1500).duration(600).attr('opacity', 1)
      .transition().delay(2500).duration(700).attr('opacity', 0)
      .on('end', function() { d3.select(hint.node()).remove(); });
  }

  // ── draw links ────────────────────────────────────────────────────────────
  private drawLinks(links: SSBLinkDatum[]) {
    const colorMap: Record<string, string> = {
      collusion:        '#f87171',
      duplicatePhrases: '#facc15',
      burstTiming:      '#f59e0b',
    };
    const color = colorMap[this.selectedMode] || '#60a5fa';
    const linkG = this.container.append('g').attr('class', 'links');

    linkG.selectAll<SVGLineElement, SSBLinkDatum>('line')
      .data(links).enter().append('line')
      .attr('class', 'ssb-link')
      .attr('stroke', color)
      .attr('stroke-width', d => 1 + d.strength * 2)
      .attr('stroke-opacity', 0.48)
      .attr('stroke-dasharray', this.selectedMode === 'duplicatePhrases' ? '5,4' : null)
      .attr('marker-end', this.selectedMode === 'collusion' ? 'url(#ssb-arrow)' : null);
  }

  // ── draw nodes ────────────────────────────────────────────────────────────
  private drawNodes(nodes: SSBNodeDatum[], staticLayout: boolean) {
    const nodeG = this.container.append('g').attr('class', 'nodes');
    const sim   = this.simulation;
    const self  = this;

    const drag = d3.drag<SVGGElement, SSBNodeDatum>()
      .on('start', function(d) {
        if (!d3.event.active && sim) sim.alphaTarget(0.3).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on('drag', function(d) { d.fx = d3.event.x; d.fy = d3.event.y; })
      .on('end',  function(d) {
        if (!d3.event.active && sim) sim.alphaTarget(0);
        d.fx = null; d.fy = null;
      });

    const enter = nodeG.selectAll<SVGGElement, SSBNodeDatum>('.ssb-node')
      .data(nodes, d => d.id).enter()
      .append('g').attr('class', 'ssb-node')
      .style('cursor', 'pointer')
      .call(drag)
      .on('click',     function(d) { self.onNodeClick(d3.event as MouseEvent, d); })
      .on('mouseover', function(d) { self.onNodeHover(d3.event as MouseEvent, d); })
      .on('mousemove', function()  { self.onNodeHoverMove(d3.event as MouseEvent); })
      .on('mouseout',  function()  { self.hoveredNode = null; });

    if (staticLayout)
      enter.attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');

    // Outer glow
    enter.append('circle')
      .attr('r', d => d.radius + 7).attr('fill', d => d.color).attr('opacity', 0.1);

    // Main circle
    enter.append('circle')
      .attr('r', d => d.radius).attr('fill', d => d.color)
      .attr('stroke', '#fff').attr('stroke-width', 1.2).attr('opacity', 0.92);

    // Inner ring (bigger nodes)
    enter.filter(d => d.radius > 10).append('circle')
      .attr('r', d => d.radius * 0.48).attr('fill', 'none')
      .attr('stroke', '#fff').attr('stroke-width', 0.5).attr('opacity', 0.28);

    // Author initial
    enter.append('text')
      .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
      .attr('fill', '#fff').attr('font-size', d => Math.min(d.radius * 0.7, 12))
      .attr('pointer-events', 'none')
      .text(d => (d.comment.authorName || '?')[0].toUpperCase());
  }

  // ── simulation ────────────────────────────────────────────────────────────
  private startSimulation(nodes: SSBNodeDatum[], links: SSBLinkDatum[]) {
    const byId = new Map(nodes.map(n => [n.id, n]));
    const resolved = links.map(l => ({
      ...l,
      source: byId.get(l.source as string) || l.source,
      target: byId.get(l.target as string) || l.target,
    }));

    this.simulation = d3.forceSimulation<SSBNodeDatum>(nodes)
      .force('link', d3.forceLink<SSBNodeDatum, any>(resolved)
        .id(d => d.id)
        .distance(d => 60 + (1 - d.strength) * 80)
        .strength(d => d.strength * 0.4))
      .force('charge', d3.forceManyBody<SSBNodeDatum>().strength(-120))
      .force('center',  d3.forceCenter(this.width / 2, this.height / 2))
      .force('collide', d3.forceCollide<SSBNodeDatum>().radius(d => d.radius + 18))
      .alpha(1)
      .on('tick', () => this.ticked(resolved));
  }

  private ticked(links: any[]) {
    this.container.selectAll<SVGLineElement, any>('.ssb-link')
      .attr('x1', d => (d.source as SSBNodeDatum).x)
      .attr('y1', d => (d.source as SSBNodeDatum).y)
      .attr('x2', d => (d.target as SSBNodeDatum).x)
      .attr('y2', d => (d.target as SSBNodeDatum).y);

    this.container.selectAll<SVGGElement, SSBNodeDatum>('.ssb-node')
      .attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');
  }

  // ── node interaction ──────────────────────────────────────────────────────
  private onNodeClick(event: MouseEvent, d: SSBNodeDatum) {
    event.stopPropagation();
    if (this.selectedNode && this.selectedNode.id === d.id) {
      this.clearSelection();
    } else {
      this.selectedNode = d;
      this.nodeSelected.emit({ comment: d.comment, result: d.result });
      this.highlightNode(d.id);
      this.pulseNode(d.id);
      setTimeout(() => {
        const card = document.getElementById('card-' + d.id);
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 60);
    }
  }

  private onNodeHover(event: MouseEvent, d: SSBNodeDatum) {
    this.hoveredNode = d;
    this.updateTooltipPos(event);
  }
  private onNodeHoverMove(event: MouseEvent) { this.updateTooltipPos(event); }

  private updateTooltipPos(event: MouseEvent) {
    const pane = document.querySelector('.graph-pane') as HTMLElement;
    if (!pane) return;
    const rect = pane.getBoundingClientRect();
    let x = event.clientX - rect.left + 14;
    let y = event.clientY - rect.top  - 8;
    if (x + 232 > rect.width) x = event.clientX - rect.left - 234;
    if (y < 0) y = 4;
    this.tooltipX = x;
    this.tooltipY = y;
  }

  private highlightNode(nodeId: string) {
    if (!this.container) return;
    this.container.selectAll<SVGGElement, SSBNodeDatum>('.ssb-node')
      .attr('opacity', (n: SSBNodeDatum) => n.id === nodeId ? 1 : 0.18);
  }

  private pulseNode(nodeId: string) {
    this.container.selectAll<SVGGElement, SSBNodeDatum>('.ssb-node')
      .filter((n: SSBNodeDatum) => n.id === nodeId)
      .select('circle:nth-child(2)')
      .transition().duration(100).attr('r', (d: SSBNodeDatum) => d.radius * 1.7)
      .transition().duration(120).attr('r', (d: SSBNodeDatum) => d.radius);
  }

  // ── misc helpers ──────────────────────────────────────────────────────────
  private radiusForScore(score: number): number { return 8 + score * 20; }

  private extractTail(text: string): string {
    if (!text) return '';
    const s = text.split(/[.!?\n]+/).map(t => t.trim()).filter(t => t.length >= 15);
    return (s[s.length - 1] || '').toLowerCase().slice(-60);
  }

  private updateLegend(nodes: SSBNodeDatum[]) {
    const seen = new Set<string>();
    this.legendTactics = nodes
      .map(n => n.result.tactic || 'SCAM_BOT')
      .filter(t => { if (seen.has(t)) return false; seen.add(t); return true; })
      .map(t => ({ color: TACTIC_COLORS[t] || '#ef4444', label: t.replace('SCAM_', ''), tactic: t }));
  }
}