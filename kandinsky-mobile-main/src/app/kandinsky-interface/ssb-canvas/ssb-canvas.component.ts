import {
  Component, OnInit, OnChanges, SimpleChanges,
  Input, Output, EventEmitter, OnDestroy
} from '@angular/core';
import * as d3 from 'd3';
import _ from 'lodash';
import { SocialComment } from 'src/app/models/models';
import ColorHash from 'color-hash';

export type SSBRelationshipMode = 'collusion' | 'duplicatePhrases' | 'commonTopics' | 'burstTiming';

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
    <div class="ssb-canvas-host">
      <div class="ssb-toolbar">
        <select
          class="mode-select"
          [value]="selectedMode"
          (change)="onModeChange($any($event.target).value)">
          <option value="collusion">Collusion</option>
          <option value="duplicatePhrases">Duplicate Phrases</option>
          <option value="commonTopics">Common Topics</option>
          <option value="burstTiming">Burst Timing</option>
        </select>
        <span class="ssb-stat" *ngIf="scamNodes.length">
          {{ scamNodes.length }} scam comments
        </span>
        <span class="ssb-stat muted" *ngIf="!scamNodes.length && resultsReady">
          No scam comments detected
        </span>
        <span class="ssb-stat muted" *ngIf="!resultsReady">
          Awaiting SSB results…
        </span>
      </div>

      <svg class="ssb-svg" width="100%" height="100%"></svg>

      <div class="ssb-legend" *ngIf="scamNodes.length">
        <div class="legend-item" *ngFor="let t of legendTactics">
          <span class="legend-dot" [style.background]="t.color"></span>
          <small>{{ t.label }}</small>
        </div>
        <div class="legend-item" *ngIf="selectedMode === 'collusion'">
          <span class="legend-line"></span><small>Reply chain</small>
        </div>
        <div class="legend-item" *ngIf="selectedMode === 'duplicatePhrases'">
          <span class="legend-line dashed"></span><small>Shared phrase</small>
        </div>
        <div class="legend-item" *ngIf="selectedMode === 'commonTopics'">
          <span class="legend-line" style="background:#fff"></span><small>Same topic group</small>
        </div>
        <div class="legend-item" *ngIf="selectedMode === 'commonTopics'">
          <span class="legend-line" style="background:#ef4444"></span><small>Cross-topic link</small>
        </div>
        <div class="legend-item" *ngIf="selectedMode === 'burstTiming'">
          <span class="legend-line burst"></span><small>Burst window</small>
        </div>
      </div>

      <div class="ssb-detail-panel" *ngIf="selectedNode">
        <div class="panel-header">
          <strong>{{ selectedNode.comment.authorName }}</strong>
          <ion-button fill="clear" size="small" color="medium" (click)="clearSelection()">
            <ion-icon name="close" slot="icon-only"></ion-icon>
          </ion-button>
        </div>
        <p class="panel-content">{{ selectedNode.comment.content }}</p>
        <div class="panel-meta">
          <ion-chip [color]="selectedNode.result.tactic ? 'danger' : 'warning'" size="small">
            {{ selectedNode.result.tactic || selectedNode.result.label }}
          </ion-chip>
          <small class="muted">score {{ selectedNode.result.score }}</small>
        </div>
        <div class="panel-signals" *ngIf="selectedNode.result.signals && selectedNode.result.signals.length">
          <small class="muted">Signals:</small>
          <div *ngFor="let s of selectedNode.result.signals">
            <small>• {{ signalLabel(s) }}</small>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; width: 100%; height: 100%; }

    .ssb-canvas-host {
      position: relative;
      width: 100%;
      height: 100%;
      background: #1a1a1a;
    }

    .ssb-toolbar {
      position: absolute;
      top: 8px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 10;
      display: flex;
      align-items: center;
      gap: 12px;
      background: rgba(30,30,30,0.92);
      border-radius: 20px;
      padding: 4px 14px;
      backdrop-filter: blur(6px);
    }

    .mode-select {
      background: transparent;
      border: 1px solid #444;
      border-radius: 12px;
      color: #fff;
      font-size: 13px;
      min-width: 160px;
      padding: 4px 28px 4px 10px;
      cursor: pointer;
      outline: none;
      appearance: none;
      -webkit-appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23aaa'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 10px center;
    }
    .mode-select option {
      background: #222;
      color: #fff;
    }

    .ssb-stat { font-size: 12px; color: #aaa; }
    .ssb-stat.muted { color: #555; }

    .ssb-svg { display: block; width: 100%; height: 100%; }

    .ssb-legend {
      position: absolute;
      bottom: 80px;
      left: 12px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      background: rgba(20,20,20,0.85);
      border-radius: 8px;
      padding: 8px 10px;
      pointer-events: none;
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
      color: #ccc;
    }

    .legend-dot {
      width: 10px; height: 10px;
      border-radius: 50%;
      display: inline-block;
    }

    .legend-line {
      display: inline-block;
      width: 22px; height: 2px;
      background: #888;
    }
    .legend-line.dashed { background: repeating-linear-gradient(90deg,#888 0 4px,transparent 4px 8px); }
    .legend-line.dotted { background: repeating-linear-gradient(90deg,#888 0 2px,transparent 2px 6px); }
    .legend-line.burst  { background: #f59e0b; }

    .ssb-detail-panel {
      position: absolute;
      bottom: 80px;
      right: 12px;
      width: 260px;
      background: rgba(28,28,28,0.95);
      border-radius: 10px;
      padding: 10px 12px;
      border: 1px solid #333;
      backdrop-filter: blur(6px);
      max-height: 40vh;
      overflow-y: auto;
    }

    .panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
      color: #fff;
      font-size: 13px;
    }

    .panel-content {
      font-size: 12px;
      color: #ccc;
      margin: 6px 0;
      line-height: 1.5;
    }

    .panel-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
    }

    .panel-signals div { color: #aaa; font-size: 11px; }
    .muted { color: #777; }
  `]
})
export class SsbCanvasComponent implements OnInit, OnChanges, OnDestroy {

  @Input() comments: SocialComment[] = [];
  @Input() ssbResults: Map<string, SSBResultFull> = new Map();
  @Input() threshold: number = 0.85;
  @Input() isActive: boolean = false;

  @Output() nodeSelected = new EventEmitter<{ comment: SocialComment; result: SSBResultFull } | null>();
  @Output() scamCountChanged = new EventEmitter<number>();

  selectedMode: SSBRelationshipMode = 'collusion';
  selectedNode: SSBNodeDatum | null = null;
  scamNodes: SSBNodeDatum[] = [];
  resultsReady = false;
  legendTactics: { color: string; label: string }[] = [];

  private svg: d3.Selection<SVGSVGElement, unknown, HTMLElement, any>;
  private container: d3.Selection<SVGGElement, unknown, HTMLElement, any>;
  private simulation: d3.Simulation<SSBNodeDatum, SSBLinkDatum>;
  private zoom: d3.ZoomBehavior<SVGSVGElement, unknown>;
  private colorHash = new ColorHash();
  private width = 0;
  private height = 0;

  private readonly SIGNAL_LABELS: Record<string, string> = {
    'account_very_new_<30d':               'Account < 30 days old',
    'account_new_<90d':                    'Account < 90 days old',
    'zero_subscribers':                    'Zero subscribers',
    'zero_videos':                         'No uploaded videos',
    'zero_likes_new_account':              'Zero likes, new account',
    'duplicate_text_across_authors':       'Identical text across authors',
    'duplicate_tail_across_authors':       'Identical ending phrase across authors',
    'incoherent_tail':                     'Appended phrase unrelated to comment body',
    'burst_timing_new_accounts':           'Coordinated burst with new accounts',
    'collusion_reply_between_new_accounts':'Reply chain between new accounts',
    'explicit_profile_picture':            'Explicit profile picture',
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

  clearSelection() {
    this.selectedNode = null;
    this.nodeSelected.emit(null);
    if (this.container) {
      this.container.selectAll<SVGGElement, SSBNodeDatum>('.ssb-node')
        .attr('opacity', 1);
    }
  }

  signalLabel(s: string): string {
    return this.SIGNAL_LABELS[s] || s;
  }

  // ── init ──────────────────────────────────────────────────────────────────
  private initSvg() {
    const el = document.querySelector<SVGSVGElement>('svg.ssb-svg');
    if (!el) return;

    this.width  = el.clientWidth  || window.innerWidth;
    this.height = el.clientHeight || window.innerHeight - 120;

    this.svg = d3.select<SVGSVGElement, unknown>('svg.ssb-svg');
    this.svg.selectAll('*').remove();

    this.svg.append('defs').append('marker')
      .attr('id', 'arrowhead')
      .attr('viewBox', '-0 -5 10 10')
      .attr('refX', 20)
      .attr('refY', 0)
      .attr('orient', 'auto')
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .append('svg:path')
      .attr('d', 'M 0,-5 L 10 ,0 L 0,5')
      .attr('fill', '#555')
      .style('stroke', 'none');

    this.container = this.svg.append('g').attr('class', 'ssb-container');

    this.zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 4])
      .on('zoom', () => {
        this.container.attr('transform', d3.event.transform);
      });
    this.svg.call(this.zoom);

    if (this.resultsReady) this.rebuild();
  }

  // ── rebuild graph ─────────────────────────────────────────────────────────
  private rebuild() {
    if (!this.container) { this.initSvg(); return; }

    if (this.simulation) this.simulation.stop();
    this.container.selectAll('*').remove();

    const { nodes, links } = this.buildGraphData();
    this.scamNodes = nodes;
    this.scamCountChanged.emit(nodes.length);
    this.updateLegend(nodes);

    if (!nodes.length) return;

    if (this.selectedMode === 'commonTopics') {
      this.drawCommonTopicsLayout(nodes);
    } else {
      this.drawLinks(links);
      this.drawNodes(nodes);
      this.startSimulation(nodes, links);
    }
  }

  // ── graph data builder ────────────────────────────────────────────────────
  private buildGraphData(): { nodes: SSBNodeDatum[]; links: SSBLinkDatum[] } {
    const nodes: SSBNodeDatum[] = [];
    const scamCommentIds = new Set<string>();

    this.comments.forEach(c => {
      const r = this.ssbResults.get(c.id);
      if (!r) return;
      const score = Number(r.score);
      const isScam = r.label === 'SCAM'; // trust backend label; score is raw not 0-100
      if (!isScam) return;

      scamCommentIds.add(c.id);
      const tactic = r.tactic || 'SCAM_BOT';
      nodes.push({
        id: c.id,
        comment: c,
        result: r,
        radius: this.radiusForScore(score),
        color: TACTIC_COLORS[tactic] || '#ef4444',
        groupKey: tactic,
        x: this.width  * (0.2 + Math.random() * 0.6),
        y: this.height * (0.2 + Math.random() * 0.6),
      });
    });

    return { nodes, links: this.buildLinks(nodes, scamCommentIds) };
  }

  private buildLinks(nodes: SSBNodeDatum[], scamIds: Set<string>): SSBLinkDatum[] {
    const links: SSBLinkDatum[] = [];
    const nodeById = new Map(nodes.map(n => [n.id, n]));

    switch (this.selectedMode) {
      case 'collusion':
        nodes.forEach(n => {
          const parentId = n.comment.parentCommentId;
          if (parentId && nodeById.has(parentId)) {
            links.push({ source: n.id, target: parentId, type: 'collusion', strength: 0.8 });
          }
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
          for (let i = 0; i < group.length; i++) {
            for (let j = i + 1; j < group.length; j++) {
              links.push({
                source: group[i].id, target: group[j].id,
                type: 'duplicatePhrases', strength: 0.5, label: 'shared phrase'
              });
            }
          }
        });
        break;
      }

      case 'commonTopics': {
        const topicSets = new Map<SSBNodeDatum, Set<string>>();
        nodes.forEach(n => {
          // FIX: no optional chaining — explicit null guard
          const analytics = n.comment.analytics;
          const topics = (analytics && analytics.topics) ? analytics.topics : {};
          topicSets.set(n, new Set(Object.keys(topics)));
        });
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const a = topicSets.get(nodes[i]);
            const b = topicSets.get(nodes[j]);
            const shared = Array.from(a).filter(t => b.has(t));
            if (shared.length >= 2) {
              links.push({
                source: nodes[i].id, target: nodes[j].id,
                type: 'commonTopics',
                strength: Math.min(shared.length / 5, 0.9),
                label: shared.slice(0, 2).join(', ')
              });
            }
          }
        }
        break;
      }

      case 'burstTiming': {
        const WINDOW_MS = 60000;
        const sorted = nodes.slice().sort((a, b) => a.comment.publishTimestamp - b.comment.publishTimestamp);
        for (let i = 0; i < sorted.length; i++) {
          for (let j = i + 1; j < sorted.length; j++) {
            const diff = sorted[j].comment.publishTimestamp - sorted[i].comment.publishTimestamp;
            if (diff > WINDOW_MS) break;
            links.push({
              source: sorted[i].id, target: sorted[j].id,
              type: 'burstTiming', strength: 0.4,
              label: Math.round(diff / 1000) + 's apart'
            });
          }
        }
        break;
      }
    }

    return links;
  }

  // ── common topics grouped layout ────────────────────────────────────────
  private drawCommonTopicsLayout(nodes: SSBNodeDatum[]) {
    // 1. Build topic → nodes map (dominant topic per node = first key)
    const topicMap = new Map<string, SSBNodeDatum[]>();
    nodes.forEach(n => {
      const analytics = n.comment.analytics;
      const topics = (analytics && analytics.topics) ? analytics.topics : {};
      const keys = Object.keys(topics);
      const dominant = keys.length > 0 ? keys[0] : 'Unknown';
      if (!topicMap.has(dominant)) topicMap.set(dominant, []);
      topicMap.get(dominant).push(n);
    });

    // 2. Layout: arrange group boxes in a grid
    const groups = Array.from(topicMap.entries()); // [topic, nodes[]]
    const cols = Math.ceil(Math.sqrt(groups.length));
    const BOX_W = 220;
    const BOX_H = 180;
    const PAD = 40;
    const GRID_W = cols * (BOX_W + PAD);
    const GRID_H = Math.ceil(groups.length / cols) * (BOX_H + PAD);
    const offsetX = (this.width  - GRID_W) / 2;
    const offsetY = (this.height - GRID_H) / 2;

    // 3. Assign positions inside each box (small circle layout)
    const nodePos = new Map<string, {x: number; y: number}>();
    groups.forEach(function(entry, gi) {
      const topic = entry[0];
      const grpNodes = entry[1];
      const col = gi % cols;
      const row = Math.floor(gi / cols);
      const bx = offsetX + col * (BOX_W + PAD) + BOX_W / 2;
      const by = offsetY + row * (BOX_H + PAD) + BOX_H / 2;
      // place nodes in a small circle inside the box
      const r = Math.min(BOX_W, BOX_H) * 0.3;
      grpNodes.forEach(function(n, i) {
        const angle = (2 * Math.PI * i) / Math.max(grpNodes.length, 1) - Math.PI / 2;
        const px = grpNodes.length === 1 ? bx : bx + r * Math.cos(angle);
        const py = grpNodes.length === 1 ? by : by + r * Math.sin(angle);
        nodePos.set(n.id, { x: px, y: py });
        n.x = px;
        n.y = py;
      });
    });

    // 4. Build intra-group links (white) and inter-group links (red)
    //    Intra: connect all nodes within same group in a ring
    //    Inter: any two nodes sharing 2+ topics across groups
    const intraLinks: Array<{s: SSBNodeDatum; t: SSBNodeDatum; cross: boolean}> = [];

    // intra — ring within each group
    groups.forEach(function(entry) {
      const grpNodes = entry[1];
      for (let i = 0; i < grpNodes.length; i++) {
        const next = grpNodes[(i + 1) % grpNodes.length];
        if (grpNodes.length > 1) {
          intraLinks.push({ s: grpNodes[i], t: next, cross: false });
        }
      }
    });

    // inter — cross-group shared topic links
    const topicSets = new Map<SSBNodeDatum, Set<string>>();
    nodes.forEach(function(n) {
      const analytics = n.comment.analytics;
      const topics = (analytics && analytics.topics) ? analytics.topics : {};
      topicSets.set(n, new Set(Object.keys(topics)));
    });
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const ai = topicSets.get(nodes[i]);
        const bj = topicSets.get(nodes[j]);
        const shared = Array.from(ai).filter(function(t) { return bj.has(t); });
        if (shared.length >= 2) {
          // only draw as cross-link if they are in different dominant groups
          const domI = Array.from(topicMap.entries()).find(function(e) { return e[1].indexOf(nodes[i]) >= 0; });
          const domJ = Array.from(topicMap.entries()).find(function(e) { return e[1].indexOf(nodes[j]) >= 0; });
          if (domI && domJ && domI[0] !== domJ[0]) {
            intraLinks.push({ s: nodes[i], t: nodes[j], cross: true });
          }
        }
      }
    }

    // 5. Draw everything into this.container
    const linkG = this.container.append('g').attr('class', 'links');
    const self = this;

    // Draw links
    linkG.selectAll('line')
      .data(intraLinks)
      .enter()
      .append('line')
      .attr('class', 'ssb-link')
      .attr('x1', function(d) { return d.s.x; })
      .attr('y1', function(d) { return d.s.y; })
      .attr('x2', function(d) { return d.t.x; })
      .attr('y2', function(d) { return d.t.y; })
      .attr('stroke', function(d) { return d.cross ? '#ef4444' : '#fff'; })
      .attr('stroke-width', function(d) { return d.cross ? 1.5 : 1; })
      .attr('stroke-opacity', function(d) { return d.cross ? 0.8 : 0.4; })
      .attr('stroke-dasharray', function(d) { return d.cross ? null : '5,4'; });

    // Draw group boxes
    const boxG = this.container.append('g').attr('class', 'topic-boxes');
    groups.forEach(function(entry, gi) {
      const topic = entry[0];
      const grpNodes = entry[1];
      const col = gi % cols;
      const row = Math.floor(gi / cols);
      const bx = offsetX + col * (BOX_W + PAD);
      const by = offsetY + row * (BOX_H + PAD);

      boxG.append('rect')
        .attr('x', bx)
        .attr('y', by)
        .attr('width', BOX_W)
        .attr('height', BOX_H)
        .attr('rx', 10)
        .attr('fill', 'rgba(255,255,255,0.03)')
        .attr('stroke', '#444')
        .attr('stroke-width', 1);

      boxG.append('text')
        .attr('x', bx + BOX_W / 2)
        .attr('y', by + 16)
        .attr('text-anchor', 'middle')
        .attr('fill', '#888')
        .attr('font-size', 10)
        .text(topic.length > 22 ? topic.slice(0, 20) + '…' : topic);
    });

    // Draw nodes
    const nodeG = this.container.append('g').attr('class', 'nodes');
    const sim = this.simulation;
    const dragBehaviour = d3.drag<SVGGElement, SSBNodeDatum>()
      .on('start', function(d: SSBNodeDatum) {
        if (!d3.event.active && sim) sim.alphaTarget(0.3).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on('drag', function(d: SSBNodeDatum) { d.fx = d3.event.x; d.fy = d3.event.y; })
      .on('end', function(d: SSBNodeDatum) {
        if (!d3.event.active && sim) sim.alphaTarget(0);
        d.fx = null; d.fy = null;
      });

    const nodeEnter = nodeG.selectAll<SVGGElement, SSBNodeDatum>('.ssb-node')
      .data(nodes, function(d) { return d.id; })
      .enter()
      .append('g')
      .attr('class', 'ssb-node')
      .attr('transform', function(d) { return 'translate(' + d.x + ',' + d.y + ')'; })
      .style('cursor', 'pointer')
      .call(dragBehaviour)
      .on('click', function(d: SSBNodeDatum) { self.onNodeClick(d3.event as MouseEvent, d); });

    nodeEnter.append('circle')
      .attr('r', function(d) { return d.radius + 6; })
      .attr('fill', function(d) { return d.color; })
      .attr('opacity', 0.15);

    nodeEnter.append('circle')
      .attr('r', function(d) { return d.radius; })
      .attr('fill', function(d) { return d.color; })
      .attr('stroke', '#fff')
      .attr('stroke-width', 1.2)
      .attr('opacity', 0.9);

    nodeEnter.append('text')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('fill', '#fff')
      .attr('font-size', function(d) { return Math.min(d.radius * 0.7, 12); })
      .attr('pointer-events', 'none')
      .text(function(d) { return (d.comment.authorName || '?')[0].toUpperCase(); });
  }

  // ── draw links ────────────────────────────────────────────────────────────
  private drawLinks(links: SSBLinkDatum[]) {
    const modeColorMap: Record<SSBRelationshipMode, string> = {
      collusion:        '#f87171',
      duplicatePhrases: '#facc15',
      commonTopics:     '#60a5fa',
      burstTiming:      '#f59e0b',
    };
    const color = modeColorMap[this.selectedMode];
    const linkG = this.container.append('g').attr('class', 'links');

    linkG.selectAll<SVGLineElement, SSBLinkDatum>('line')
      .data(links)
      .enter()
      .append('line')
      .attr('class', 'ssb-link')
      .attr('stroke', color)
      .attr('stroke-width', d => 1 + d.strength * 2)
      .attr('stroke-opacity', 0.55)
      .attr('stroke-dasharray',
        this.selectedMode === 'duplicatePhrases' ? '5,4' :
        this.selectedMode === 'commonTopics'     ? '2,4' : null)
      .attr('marker-end', this.selectedMode === 'collusion' ? 'url(#arrowhead)' : null);

    if (this.selectedMode === 'duplicatePhrases' || this.selectedMode === 'commonTopics') {
      linkG.selectAll<SVGTextElement, SSBLinkDatum>('text')
        .data(links.filter(l => !!l.label))
        .enter()
        .append('text')
        .attr('class', 'ssb-link-label')
        .attr('font-size', 9)
        .attr('fill', '#aaa')
        .text(d => d.label);
    }
  }

  // ── draw nodes ────────────────────────────────────────────────────────────
  private drawNodes(nodes: SSBNodeDatum[]) {
    const nodeG = this.container.append('g').attr('class', 'nodes');

    // D3 v5: callbacks are (datum, index, nodes) — no event arg.
    // The current event is accessed via the d3.event global.
    const sim = this.simulation;
    const dragBehaviour = d3.drag<SVGGElement, SSBNodeDatum>()
      .on('start', function(d: SSBNodeDatum) {
        if (!d3.event.active) sim.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', function(d: SSBNodeDatum) {
        d.fx = d3.event.x;
        d.fy = d3.event.y;
      })
      .on('end', function(d: SSBNodeDatum) {
        if (!d3.event.active) sim.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });

    const self = this;
    const nodeEnter = nodeG.selectAll<SVGGElement, SSBNodeDatum>('.ssb-node')
      .data(nodes, d => d.id)
      .enter()
      .append('g')
      .attr('class', 'ssb-node')
      .style('cursor', 'pointer')
      .call(dragBehaviour)
      // D3 v5: click callback is (datum) — raw MouseEvent available via d3.event
      .on('click', function(d: SSBNodeDatum) { self.onNodeClick(d3.event as MouseEvent, d); });

    // Outer glow
    nodeEnter.append('circle')
      .attr('r', d => d.radius + 6)
      .attr('fill', d => d.color)
      .attr('opacity', 0.15);

    // Main circle
    nodeEnter.append('circle')
      .attr('r', d => d.radius)
      .attr('fill', d => d.color)
      .attr('stroke', '#fff')
      .attr('stroke-width', 1.2)
      .attr('opacity', 0.9);

    // Inner ring
    nodeEnter.filter(d => d.radius > 10)
      .append('circle')
      .attr('r', d => d.radius * 0.55)
      .attr('fill', 'none')
      .attr('stroke', '#fff')
      .attr('stroke-width', 0.6)
      .attr('opacity', 0.4);

    // Author initial
    nodeEnter.append('text')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('fill', '#fff')
      .attr('font-size', d => Math.min(d.radius * 0.7, 12))
      .attr('pointer-events', 'none')
      .text(d => (d.comment.authorName || '?')[0].toUpperCase());

    // FIX: tactic badge — replace optional chaining with ternary
    nodeEnter.append('text')
      .attr('text-anchor', 'middle')
      .attr('y', d => d.radius + 14)
      .attr('fill', '#ccc')
      .attr('font-size', 9)
      .attr('pointer-events', 'none')
      .text(d => d.result.tactic ? d.result.tactic.replace('SCAM_', '') : '');
  }

  // ── simulation ────────────────────────────────────────────────────────────
  private startSimulation(nodes: SSBNodeDatum[], links: SSBLinkDatum[]) {
    const nodeById = new Map(nodes.map(n => [n.id, n]));
    const resolvedLinks = links.map(l => ({
      ...l,
      source: nodeById.get(l.source as string) || l.source,
      target: nodeById.get(l.target as string) || l.target,
    }));

    this.simulation = d3.forceSimulation<SSBNodeDatum>(nodes)
      .force('link', d3.forceLink<SSBNodeDatum, any>(resolvedLinks)
        .id(d => d.id)
        .distance(d => 60 + (1 - d.strength) * 80)
        .strength(d => d.strength * 0.4))
      .force('charge', d3.forceManyBody<SSBNodeDatum>().strength(-120))
      .force('center', d3.forceCenter(this.width / 2, this.height / 2))
      .force('collide', d3.forceCollide<SSBNodeDatum>().radius(d => d.radius + 18))
      .alpha(1)
      .on('tick', () => this.ticked(resolvedLinks));
  }

  private ticked(links: any[]) {
    this.container.selectAll<SVGLineElement, any>('.ssb-link')
      .attr('x1', d => (d.source as SSBNodeDatum).x)
      .attr('y1', d => (d.source as SSBNodeDatum).y)
      .attr('x2', d => (d.target as SSBNodeDatum).x)
      .attr('y2', d => (d.target as SSBNodeDatum).y);

    this.container.selectAll<SVGTextElement, any>('.ssb-link-label')
      .attr('x', d => ((d.source as SSBNodeDatum).x + (d.target as SSBNodeDatum).x) / 2)
      .attr('y', d => ((d.source as SSBNodeDatum).y + (d.target as SSBNodeDatum).y) / 2 - 4);

    // FIX: string concatenation instead of template literal (ES2019 compat)
    this.container.selectAll<SVGGElement, SSBNodeDatum>('.ssb-node')
      .attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');
  }

  // ── interaction ───────────────────────────────────────────────────────────
  private onNodeClick(event: MouseEvent, d: SSBNodeDatum) {
    event.stopPropagation();
    this.selectedNode = d;
    this.nodeSelected.emit({ comment: d.comment, result: d.result });

    this.container.selectAll<SVGGElement, SSBNodeDatum>('.ssb-node')
      .attr('opacity', n => n.id === d.id ? 1 : 0.3);
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  private radiusForScore(score: number): number {
    return 8 + (score / 200) * 22;
  }

  private extractTail(text: string): string {
    if (!text) return '';
    const sentences = text.split(/[.!?\n]+/).map(s => s.trim()).filter(s => s.length >= 15);
    const tail = sentences[sentences.length - 1] || '';
    return tail.toLowerCase().slice(-60);
  }

  private updateLegend(nodes: SSBNodeDatum[]) {
    const tacticSet = new Set(nodes.map(n => n.result.tactic || 'SCAM_BOT'));
    this.legendTactics = Array.from(tacticSet).map(t => ({
      color: TACTIC_COLORS[t] || '#ef4444',
      label: t.replace('SCAM_', '')
    }));
  }
}